import { createHash } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import type { RecipientOutcome } from '../../shared/rehearsal.js';
import {
  StagingReceiptProvider,
  type DeliveryEnvelope,
  type DeliveryOutcome,
  type DeliveryProvider,
} from './delivery-provider.js';
import {
  eligibleAddress,
  finish,
  rehearsalRow,
  settleReservation,
  submissionBlock,
  type CheckOwner,
} from './rehearsal.js';

type Recipient = RecipientOutcome & { subscriber_id: string | null; email_digest: string | null };
type Work = { id: string; rehearsal: string; attempts: number; submit: boolean };
const maxAttempts = 3;

// Commit the claim before crossing the provider boundary. A crash at any later
// point leaves a submitting row that other workers can only reconcile.
export class DeliveryWorker {
  constructor(
    private db: Database,
    private isOwner: CheckOwner,
    private provider?: DeliveryProvider,
  ) {}

  private scoped<T>(workspace: string, brand: string, run: (sql: Sql) => Promise<T>) {
    return this.db.brand(workspace, brand, async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [workspace]);
      return run(sql);
    });
  }

  async tick(workspace: string, brand: string, rehearsalId?: string) {
    const work = await this.scoped(workspace, brand, async (sql): Promise<Work | undefined> => {
      const row = (
        await sql.query<{ id: string; rehearsal_id: string; attempts: number; state: Recipient['state'] }>(
          `
        SELECT p.id,p.rehearsal_id,p.state,p.attempts FROM rehearsal_recipients p
        JOIN campaign_rehearsals r ON (r.workspace_id,r.brand_id,r.id)=(p.workspace_id,p.brand_id,p.rehearsal_id)
        WHERE r.transport='provider_test' AND ($1::uuid IS NULL OR r.id=$1)
          AND (p.next_check_at IS NULL OR p.next_check_at<=now()) AND
          ((p.state='pending' AND r.state='queued' AND r.due_at<=now()) OR p.state IN ('submitting','uncertain'))
        ORDER BY coalesce(p.next_check_at,r.due_at),r.id,p.id LIMIT 1 FOR UPDATE OF p`,
          [rehearsalId ?? null],
        )
      ).rows[0];
      if (!row) return;
      const submit = row.state === 'pending';
      await sql.query(
        `UPDATE rehearsal_recipients SET state=$2,attempts=$3,
        next_check_at=now()+interval '30 seconds' WHERE id=$1 AND rehearsal_id=$4`,
        [row.id, submit ? 'submitting' : 'uncertain', row.attempts + Number(submit), row.rehearsal_id],
      );
      return { id: row.id, rehearsal: row.rehearsal_id, attempts: row.attempts + Number(submit), submit };
    });
    if (!work) return { processed: false };
    await this.scoped(workspace, brand, async (sql) => {
      const row = await rehearsalRow(sql, work.rehearsal);
      const person = (
        await sql.query<Recipient>(
          'SELECT * FROM rehearsal_recipients WHERE rehearsal_id=$1 AND id=$2 FOR UPDATE',
          [row.id, work.id],
        )
      ).rows[0];
      // A newer claim or an expired claim under reconciliation owns this operation.
      if (
        !person ||
        person.attempts !== work.attempts ||
        person.state !== (work.submit ? 'submitting' : 'uncertain')
      )
        return;
      const provider = this.provider ?? new StagingReceiptProvider(sql, workspace, brand, row.id);
      let outcome: DeliveryOutcome;
      if (work.submit) {
        await sql.query('SELECT enabled FROM subscriber_intake_settings FOR UPDATE');
        const authority =
          row.state === 'queued'
            ? await submissionBlock(sql, row, workspace, brand, this.isOwner)
            : (row.reason ?? 'cancelled_by_owner');
        const reserved = await sql.query(
          "SELECT 1 FROM rehearsal_reservations WHERE rehearsal_id=$1 AND brand_id=$3 AND NOT settled AND (slots=1 OR $2::text='test') AND messages>=1 FOR UPDATE",
          [row.id, row.audience, brand],
        );
        const blocked = authority ?? (reserved.rowCount ? null : 'reservation_unavailable');
        if (blocked) {
          await setRecipient(sql, work, 'cancelled', blocked, true);
          if (row.state === 'queued') await finish(sql, row.id, 'blocked', blocked);
          else await settleReservation(sql, row.id);
          return;
        }
        const address = await eligibleAddress(sql, row.audience, person);
        if (!address) {
          await setRecipient(sql, work, 'excluded', 'ineligible', true);
          await finishIfDone(sql, row.id);
          return;
        }
        const images = await originalImages(sql, brand, row.content.assetIds);
        if (!images) {
          await setRecipient(sql, work, 'cancelled', 'image_unavailable', true);
          await finish(sql, row.id, 'blocked', 'image_unavailable');
          return;
        }
        const message: DeliveryEnvelope = {
          operationKey: work.id,
          workspaceId: workspace,
          brandId: brand,
          to: address,
          subject: row.content.subject,
          html: row.render_html,
          text: row.render_text,
          images,
        };
        try {
          outcome = await provider.submit(message);
        } catch {
          outcome = 'unknown';
        }
      } else {
        // Cancellation or an opt-out stops new submissions. A receipt for an earlier
        // submission must still be checked, even after its actor or grant was revoked.
        try {
          outcome = await provider.lookup(work.id);
        } catch {
          outcome = 'unknown';
        }
      }
      if (outcome === 'unknown') {
        await sql.query(
          `UPDATE rehearsal_recipients SET state='uncertain',reason='provider_unknown',
          next_check_at=CASE WHEN $3::boolean THEN now() ELSE now()+interval '30 seconds' END WHERE id=$1 AND rehearsal_id=$2`,
          [work.id, row.id, work.submit],
        );
      } else if (outcome === 'not_submitted') {
        if (row.state !== 'queued')
          await setRecipient(sql, work, 'cancelled', row.reason ?? 'cancelled_by_owner');
        else if (work.attempts >= maxAttempts) await setRecipient(sql, work, 'rejected', 'retry_exhausted');
        else await setRecipient(sql, work, 'pending', 'verified_not_submitted');
      } else if (outcome === 'accepted') await setRecipient(sql, work, 'accepted', null);
      else await setRecipient(sql, work, 'rejected', 'provider_rejected');
      await finishIfDone(sql, row.id);
    });
    return { processed: true };
  }
}

async function setRecipient(
  sql: Sql,
  work: Work,
  state: Recipient['state'],
  reason: string | null,
  unusedClaim = false,
) {
  await sql.query(
    'UPDATE rehearsal_recipients SET state=$3,reason=$4,next_check_at=NULL,attempts=attempts-$5::int WHERE id=$1 AND rehearsal_id=$2',
    [work.id, work.rehearsal, state, reason, Number(unusedClaim)],
  );
}

async function finishIfDone(sql: Sql, id: string) {
  await settleReservation(sql, id);
  await sql.query(
    `UPDATE campaign_rehearsals SET state='completed',finished_at=now()
    WHERE id=$1 AND state='queued' AND NOT EXISTS (SELECT FROM rehearsal_recipients
      WHERE rehearsal_id=$1 AND state IN ('pending','submitting','uncertain'))`,
    [id],
  );
}

async function originalImages(
  sql: Sql,
  brand: string,
  ids: string[],
): Promise<DeliveryEnvelope['images'] | null> {
  const { rows } = await sql.query<DeliveryEnvelope['images'][number] & { id: string }>(
    'SELECT id,name,mime,sha256,bytes FROM assets WHERE brand_id=$1 AND id=ANY($2::uuid[])',
    [brand, ids],
  );
  const ordered: DeliveryEnvelope['images'] = [];
  for (const id of ids) {
    const image = rows.find((row) => row.id === id);
    if (!image || createHash('sha256').update(image.bytes).digest('hex') !== image.sha256) return null;
    ordered.push(image);
  }
  return ordered;
}
