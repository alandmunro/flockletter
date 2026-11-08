import { createHash, randomUUID } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import { AppError } from '../errors.js';
import { isListmonkMethod, type ListmonkMethod } from '../../shared/rehearsal.js';
import { deliveryBlock, finishIfDone, reviewedEnvelope } from './reviewed-delivery.js';
import { eligibleAddress, finish, rehearsalRow, type CheckOwner } from './rehearsal.js';
import type { DeliveryEnvelope } from './delivery-provider.js';
import { listmonkReference, reviewedListmonkMessage } from './listmonk-callback.js';
import { localFeedbackKind, recordCampaignFeedback, saveProviderReceipt } from './feedback.js';
import { SesSimulatorProvider, simulatorDestination } from './ses-simulator.js';
import { sesScope, type SesRuntime } from './ses-runtime.js';

export interface PrivateEngine {
  render(message: DeliveryEnvelope, reference: string): Promise<void>;
}
export type EngineScope = { workspace: string; brand: string };
export function listmonkBinding(
  workspace: string,
  brand: string,
  method: ListmonkMethod,
  sesFingerprint?: string,
) {
  return createHash('sha256')
    .update(JSON.stringify(['private-listmonk-6.2.0-v1', workspace, brand, method, sesFingerprint ?? null]))
    .digest('hex');
}
type Person = {
  id: string;
  rehearsal_id: string;
  subscriber_id: string | null;
  email_digest: string | null;
  state: string;
  attempts: number;
};
type Reviewed = Awaited<ReturnType<typeof rehearsalRow>>;
type Handoff = {
  reference: string;
  reviewed_address: string;
  render_attempts: number;
  callback_at: Date | null;
  provider_claim: string | null;
};
type Action =
  | { type: 'render'; reference: string; message: DeliveryEnvelope }
  | { type: 'forward'; id: string; rehearsal: string; claim: string }
  | { type: 'settled' };
const callbackMismatch = () =>
  new AppError(
    409,
    'engine_callback_mismatch',
    'The private engine callback does not match its registered review.',
  );

export class PrivateListmonk {
  constructor(
    private db: Database,
    private checkOwner: CheckOwner,
    private scope: EngineScope,
    private engine: PrivateEngine | undefined,
    private ses?: SesRuntime,
  ) {}
  owns(workspace: string, brand: string) {
    return workspace === this.scope.workspace && brand === this.scope.brand;
  }
  binding(workspace: string, brand: string, method: ListmonkMethod): string | null {
    if (!this.engine || !this.owns(workspace, brand)) return null;
    if (method === 'listmonk_test') return listmonkBinding(workspace, brand, method);
    const runtime = sesScope(this.ses, workspace, brand);
    return runtime?.port ? listmonkBinding(workspace, brand, method, runtime.route.fingerprint) : null;
  }
  private locked<T>(run: (sql: Sql) => Promise<T>) {
    return this.db.brand(this.scope.workspace, this.scope.brand, async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [this.scope.workspace]);
      return run(sql);
    });
  }

  async tick(workspace: string, brand: string, rehearsalId?: string) {
    if (workspace !== this.scope.workspace || brand !== this.scope.brand) return { processed: false };
    const action = await this.locked((sql) => this.next(sql, rehearsalId));
    if (!action) return { processed: false };
    if (action.type === 'render') {
      // A synchronous Listmonk callback uses a separate DB connection. The render intent is already
      // committed and no workspace lock is held here. An expired render lease can only repeat rendering.
      try {
        await this.engine?.render(action.message, action.reference);
      } catch (error) {
        // A failed renderer can retry sooner. The predicate preserves a concurrent valid callback.
        const phase =
          error instanceof Error &&
          /^Private Listmonk failed during (database initialization|database setup|Listmonk install|engine configuration|engine listener|configuration)\.$/.test(
            error.message,
          )
            ? error.message
            : 'Private Listmonk rendering did not complete.';
        console.warn(phase);
        await this.locked((sql) =>
          sql.query(
            `UPDATE rehearsal_recipients p SET next_check_at=least(next_check_at,now()+interval '15 seconds')
          FROM listmonk_handoffs h WHERE (p.workspace_id,p.brand_id,p.rehearsal_id,p.id)=(h.workspace_id,h.brand_id,h.rehearsal_id,h.operation_key)
          AND h.operation_key=$1 AND h.callback_at IS NULL AND p.state='submitting'`,
            [action.message.operationKey],
          ),
        );
      }
    } else if (action.type === 'forward') {
      await this.locked((sql) => this.forward(sql, action));
    }
    return { processed: true };
  }

  async receive(raw: unknown) {
    const reference =
      typeof raw === 'object' && raw !== null && 'from_email' in raw ? raw.from_email : undefined;
    if (typeof reference !== 'string' || !/^fl-[a-f0-9]{56}@receipt\.test$/.test(reference))
      throw callbackMismatch();
    await this.locked(async (sql) => {
      const handoff = (
        await sql.query<Handoff & { rehearsal_id: string; operation_key: string }>(
          'SELECT * FROM listmonk_handoffs WHERE reference=$1 FOR UPDATE',
          [reference],
        )
      ).rows[0];
      if (!handoff) throw callbackMismatch();
      const row = await rehearsalRow(sql, handoff.rehearsal_id);
      const message = await reviewedEnvelope(
        sql,
        row,
        this.scope.workspace,
        this.scope.brand,
        handoff.operation_key,
        handoff.reviewed_address,
      );
      if (!message) throw callbackMismatch();
      try {
        reviewedListmonkMessage(raw, message);
      } catch {
        throw callbackMismatch();
      }
      if (handoff.callback_at) return;
      await sql.query('UPDATE listmonk_handoffs SET callback_at=now() WHERE operation_key=$1', [
        handoff.operation_key,
      ]);
      await sql.query(
        "UPDATE rehearsal_recipients SET next_check_at=NULL,reason='awaiting_provider' WHERE id=$1 AND rehearsal_id=$2 AND state='submitting'",
        [handoff.operation_key, row.id],
      );
    });
  }

  private async next(sql: Sql, rehearsalId?: string): Promise<Action | undefined> {
    const p = (
      await sql.query<Person>(
        `SELECT p.* FROM rehearsal_recipients p JOIN campaign_rehearsals r
      ON (r.workspace_id,r.brand_id,r.id)=(p.workspace_id,p.brand_id,p.rehearsal_id)
      LEFT JOIN listmonk_handoffs own ON (own.workspace_id,own.brand_id,own.operation_key)=(p.workspace_id,p.brand_id,p.id)
      WHERE r.transport IN ('listmonk_test','listmonk_ses') AND ($1::uuid IS NULL OR r.id=$1)
      AND (r.state<>'queued' OR own.callback_at IS NOT NULL OR NOT EXISTS (
        SELECT FROM listmonk_handoffs h JOIN rehearsal_recipients busy
          ON (busy.workspace_id,busy.brand_id,busy.rehearsal_id,busy.id)=(h.workspace_id,h.brand_id,h.rehearsal_id,h.operation_key)
        WHERE (h.workspace_id,h.brand_id)=(p.workspace_id,p.brand_id) AND h.operation_key<>p.id
          AND h.callback_at IS NULL AND busy.state='submitting' AND busy.next_check_at>now()
      ))
      AND (p.next_check_at IS NULL OR p.next_check_at<=now())
      AND ((p.state='pending' AND r.state='queued' AND r.due_at<=now()) OR p.state IN ('submitting','uncertain'))
      ORDER BY coalesce(p.next_check_at,r.due_at),p.id LIMIT 1 FOR UPDATE OF p`,
        [rehearsalId ?? null],
      )
    ).rows[0];
    if (!p) return;
    const row = await rehearsalRow(sql, p.rehearsal_id);
    const handoff = (
      await sql.query<Handoff>('SELECT * FROM listmonk_handoffs WHERE operation_key=$1 FOR UPDATE', [p.id])
    ).rows[0];
    if (handoff?.provider_claim) {
      if (await this.hasReceipt(sql, row, p.id)) {
        await this.settle(sql, p, 'accepted', null);
        return { type: 'settled' };
      }
      if (row.transport === 'listmonk_ses') {
        // SES cannot prove a missing receipt means nonacceptance. Only authenticated feedback or a
        // matching saved provider receipt can resolve this attempt.
        await this.uncertain(sql, p);
        return { type: 'settled' };
      }
      // For the local sink, feedback and receipt commit in the same transaction; no receipt
      // authoritatively means no submission. It is safe to resume this claim after a restart.
      return { type: 'forward', id: p.id, rehearsal: row.id, claim: handoff.provider_claim };
    }
    const message = await this.eligibleMessage(sql, row, p, handoff?.reviewed_address);
    if (!message) return { type: 'settled' };
    if (handoff?.callback_at) {
      const claim = randomUUID();
      await sql.query(
        'UPDATE listmonk_handoffs SET provider_claim=$2,started_at=now() WHERE operation_key=$1',
        [p.id, claim],
      );
      await sql.query(
        "UPDATE rehearsal_recipients SET state='submitting',attempts=1,reason='awaiting_provider',next_check_at=now()+interval '60 seconds' WHERE id=$1 AND rehearsal_id=$2",
        [p.id, row.id],
      );
      return { type: 'forward', id: p.id, rehearsal: row.id, claim };
    }
    if (handoff && handoff.render_attempts >= 3) {
      await this.settle(sql, p, 'rejected', 'engine_render_failed');
      return { type: 'settled' };
    }
    const reference = listmonkReference(this.scope.workspace, this.scope.brand, p.id);
    await sql.query(
      `INSERT INTO listmonk_handoffs(workspace_id,brand_id,rehearsal_id,operation_key,reference,reviewed_address,render_attempts)
      VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(workspace_id,brand_id,operation_key) DO UPDATE SET render_attempts=listmonk_handoffs.render_attempts+1`,
      [this.scope.workspace, this.scope.brand, row.id, p.id, reference, message.to],
    );
    await sql.query(
      "UPDATE rehearsal_recipients SET state='submitting',reason='awaiting_engine_callback',next_check_at=now()+interval '3 minutes' WHERE id=$1 AND rehearsal_id=$2",
      [p.id, row.id],
    );
    return { type: 'render', message, reference };
  }

  private async forward(sql: Sql, action: Extract<Action, { type: 'forward' }>) {
    const row = await rehearsalRow(sql, action.rehearsal);
    const p = (
      await sql.query<Person & { reviewed_address: string }>(
        `SELECT p.*,h.reviewed_address FROM rehearsal_recipients p
      JOIN listmonk_handoffs h ON (h.workspace_id,h.brand_id,h.rehearsal_id,h.operation_key)=(p.workspace_id,p.brand_id,p.rehearsal_id,p.id)
      WHERE p.id=$1 AND p.rehearsal_id=$2 AND h.provider_claim=$3 AND h.callback_at IS NOT NULL AND p.state IN ('submitting','uncertain') FOR UPDATE OF p`,
        [action.id, row.id, action.claim],
      )
    ).rows[0];
    if (!p) return;
    if (await this.hasReceipt(sql, row, p.id)) return this.settle(sql, p, 'accepted', null);
    const message = await this.eligibleMessage(sql, row, p, p.reviewed_address);
    if (!message) return;
    const { workspace, brand } = this.scope;
    const binding = row.provider_binding!;
    if (row.transport === 'listmonk_test') {
      await recordCampaignFeedback(sql, {
        workspace,
        brand,
        operation: p.id,
        eventId: 'listmonk-local-event-' + p.id,
        messageId: 'local-' + p.id,
        transport: 'listmonk_test',
        binding,
        kind: localFeedbackKind(message.to),
        destination: message.to,
      });
      return;
    }
    const runtime = sesScope(this.ses, workspace, brand);
    if (!runtime?.port) throw new Error('SES simulator binding is unavailable.');
    const provider = new SesSimulatorProvider(runtime.route, runtime.port, {
      lookup: (key) => this.hasReceipt(sql, row, key),
      record: (key, id) => saveProviderReceipt(sql, workspace, brand, row.id, key, binding, id),
    });
    const outcome = await provider.submit(message);
    if (outcome === 'accepted') await this.settle(sql, p, 'accepted', null);
    else if (outcome === 'rejected') await this.settle(sql, p, 'rejected', 'provider_rejected');
    else await this.uncertain(sql, p);
  }

  private async eligibleMessage(sql: Sql, row: Reviewed, p: Person, frozenAddress?: string) {
    const { workspace, brand } = this.scope;
    let blocked = await deliveryBlock(sql, row, workspace, brand, this.checkOwner);
    if (
      !blocked &&
      (!isListmonkMethod(row.transport) ||
        this.binding(workspace, brand, row.transport) !== row.provider_binding)
    )
      blocked = 'engine_unavailable';
    if (!blocked && row.transport === 'listmonk_ses') {
      const sender = sesScope(this.ses, workspace, brand)?.route.from.split('@')[1];
      const verified = await sql.query(
        "SELECT 1 FROM sender_domains WHERE domain=$1 AND verified_at>now()-interval '24 hours'",
        [sender],
      );
      if (!verified.rowCount) blocked = 'simulator_unavailable';
    }
    if (blocked) {
      await this.settle(sql, p, 'cancelled', blocked, true);
      if (row.state === 'queued') await finish(sql, row.id, 'blocked', blocked);
      return null;
    }
    const addr = await eligibleAddress(sql, row.audience, p);
    if (
      !addr ||
      (frozenAddress && addr !== frozenAddress) ||
      (row.transport === 'listmonk_ses' && !simulatorDestination(addr))
    ) {
      await this.settle(sql, p, 'excluded', 'ineligible', true);
      return null;
    }
    const message = await reviewedEnvelope(sql, row, workspace, brand, p.id, addr);
    if (!message) {
      await this.settle(sql, p, 'cancelled', 'image_unavailable', true);
      await finish(sql, row.id, 'blocked', 'image_unavailable');
    }
    return message;
  }
  private async hasReceipt(sql: Sql, row: Reviewed, operation: string) {
    return Boolean(
      (
        await sql.query(
          'SELECT 1 FROM campaign_provider_receipts WHERE rehearsal_id=$1 AND operation_key=$2 AND provider_binding=$3',
          [row.id, operation, row.provider_binding],
        )
      ).rowCount,
    );
  }
  private async uncertain(sql: Sql, p: Person) {
    await sql.query(
      "UPDATE rehearsal_recipients SET state='uncertain',reason='provider_unknown',next_check_at=now()+interval '30 seconds' WHERE id=$1 AND rehearsal_id=$2",
      [p.id, p.rehearsal_id],
    );
  }
  private async settle(
    sql: Sql,
    p: Person,
    state: 'accepted' | 'rejected' | 'excluded' | 'cancelled',
    reason: string | null,
    unused = false,
  ) {
    await sql.query(
      'UPDATE rehearsal_recipients SET state=$3,reason=$4,next_check_at=NULL,attempts=CASE WHEN $5 THEN 0 ELSE attempts END WHERE id=$1 AND rehearsal_id=$2',
      [p.id, p.rehearsal_id, state, reason, unused],
    );
    await finishIfDone(sql, p.rehearsal_id);
  }
}
