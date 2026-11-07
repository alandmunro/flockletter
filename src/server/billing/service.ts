import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import { AppError, requireCondition } from '../errors.js';
import { digest } from '../content.js';
import { workspaceAccess } from '../campaign/access.js';
import type { Actor } from '../service.js';
import type { PlanId } from '../../shared/rehearsal.js';
import type { BillingGateway, BillingIntent, SessionResult } from './gateway.js';

const safeWindow = 23 * 3600000;
function isUnusedExpiry(
  intent: BillingIntent | undefined,
): intent is BillingIntent & { session_id: string; observed_at: Date } {
  return (
    !!intent &&
    intent.status === 'expired' &&
    !!intent.observed_at &&
    !!intent.session_id &&
    !intent.customer_id &&
    !intent.subscription_id &&
    !intent.trial_end
  );
}
export class SandboxBilling {
  constructor(
    private db: Database,
    private gateway?: BillingGateway,
    private complimentaryTarget?: string,
  ) {}
  async status(sql: Sql, workspace: string) {
    const intent = await this.intent(sql),
      access = await workspaceAccess(sql);
    return {
      mode: this.gateway ? 'sandbox' : 'off',
      complimentary: !!access.plan || workspace === this.complimentaryTarget,
      status: intent?.status ?? 'not_started',
      plan: intent?.plan ?? null,
      trialEnd: intent?.trial_end?.toISOString() ?? null,
      restartableId: isUnusedExpiry(intent) ? intent.id : null,
      canOpenPortal:
        !!this.gateway && !!intent?.customer_id && !access.plan && workspace !== this.complimentaryTarget,
    };
  }
  private async intent(sql: Sql) {
    return (await sql.query<BillingIntent>('SELECT * FROM sandbox_checkouts')).rows[0];
  }
  private async locked<T>(workspace: string, action: (sql: Sql) => Promise<T>) {
    return this.db.tenant(workspace, async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [workspace]);
      return action(sql);
    });
  }
  private async eligible(sql: Sql, w: string) {
    requireCondition(
      await sql.query('SELECT workspace_id FROM workspaces').then((r) => r.rowCount),
      422,
      'workspace_required',
      'Initialize this workspace first.',
    );
    requireCondition(
      w !== this.complimentaryTarget && !(await workspaceAccess(sql)).plan,
      422,
      'complimentary_workspace',
      'Complimentary workspaces bypass Stripe.',
    );
  }
  private enabled() {
    requireCondition(
      this.gateway,
      503,
      'billing_off',
      'Flockletter’s separate Stripe sandbox is not connected.',
    );
    return this.gateway;
  }
  private async save(sql: Sql, intent: BillingIntent, result: SessionResult, verifiedEvent = false) {
    requireCondition(
      !intent.session_id || intent.session_id === result.id,
      409,
      'billing_mismatch',
      'The sandbox session mapping changed.',
    );
    requireCondition(
      !intent.customer_id || intent.customer_id === result.customer,
      409,
      'billing_mismatch',
      'The sandbox customer mapping changed.',
    );
    requireCondition(
      !intent.subscription_id || intent.subscription_id === result.subscription,
      409,
      'billing_mismatch',
      'The sandbox subscription mapping changed.',
    );
    await sql.query(
      `UPDATE sandbox_checkouts SET session_id=$2,customer_id=$3,subscription_id=$4,
      status=CASE WHEN $7 THEN $5 WHEN observed_at IS NOT NULL THEN status WHEN $5='open' THEN 'open' ELSE 'awaiting_webhook' END,
      trial_end=CASE WHEN $7 THEN $6 ELSE trial_end END,effective_end_at=CASE WHEN $7 THEN $8 ELSE effective_end_at END,
      observed_at=CASE WHEN $7 THEN now() ELSE observed_at END WHERE id=$1`,
      [
        intent.id,
        result.id,
        result.customer,
        result.subscription,
        result.status,
        result.trialEnd,
        verifiedEvent,
        result.effectiveEnd ?? null,
      ],
    );
  }
  async checkout(actor: Actor, plan: PlanId, key: string) {
    const gateway = this.enabled(),
      w = actor.workspaceId;
    const expected = await this.locked(w, async (sql) => {
      await this.eligible(sql, w);
      const existing = await this.intent(sql);
      if (existing) {
        requireCondition(
          existing.plan === plan && existing.actor_id === actor.actorId,
          409,
          'checkout_exists',
          'A sandbox checkout already exists for this workspace. Use its original plan and owner.',
        );
        return existing.id;
      }
      const attempt = randomUUID();
      await sql.query(
        `INSERT INTO sandbox_checkouts(workspace_id,id,operation_key,actor_id,plan,sandbox_account,provider_price) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [w, attempt, key, actor.actorId, plan, gateway.account, gateway.prices[plan]],
      );
      await sql.query('INSERT INTO audit(workspace_id,id,actor_id,action) VALUES($1,$2,$3,$4)', [
        w,
        randomUUID(),
        actor.actorId,
        'billing.checkout',
      ]);
      return attempt;
    });
    return this.openCurrent(w, expected);
  }
  async restart(actor: Actor, plan: PlanId, expiredId: string, key: string) {
    const gateway = this.enabled(),
      w = actor.workspaceId;
    const expected = await this.locked(w, async (sql) => {
      await this.eligible(sql, w);
      const replay = (
        await sql.query<{ id: string; restart_actor: string; restart_plan: string; replacement_id: string }>(
          'SELECT id,restart_actor,restart_plan,replacement_id FROM sandbox_expired_checkouts WHERE restart_key=$1',
          [key],
        )
      ).rows[0];
      if (replay) {
        requireCondition(
          replay.id === expiredId && replay.restart_actor === actor.actorId && replay.restart_plan === plan,
          409,
          'operation_conflict',
          'Use the original checkout restart request.',
        );
        return replay.replacement_id;
      }
      const former = await this.intent(sql);
      requireCondition(
        isUnusedExpiry(former) && former.id === expiredId && former.sandbox_account === gateway.account,
        409,
        'checkout_not_restartable',
        'Only the selected verified expired checkout without a customer or subscription can be restarted.',
      );
      requireCondition(
        former.operation_key !== key,
        409,
        'operation_conflict',
        'Use a new operation key for a checkout restart.',
      );
      const volume = (
        await sql.query<{ n: number }>(
          "SELECT count(*)::int n FROM sandbox_expired_checkouts WHERE archived_at>now()-interval '24 hours'",
        )
      ).rows[0]!;
      requireCondition(volume.n < 5, 429, 'restart_limit', 'Wait before starting another test checkout.');
      const next = randomUUID();
      await sql.query(
        `INSERT INTO sandbox_expired_checkouts(workspace_id,id,operation_key,actor_id,plan,sandbox_account,provider_price,session_id,observed_at,replacement_id,restart_key,restart_actor,restart_plan)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          w,
          former.id,
          former.operation_key,
          former.actor_id,
          former.plan,
          former.sandbox_account,
          former.provider_price,
          former.session_id,
          former.observed_at,
          next,
          key,
          actor.actorId,
          plan,
        ],
      );
      await sql.query(
        `UPDATE sandbox_checkouts SET id=$1,operation_key=$2,actor_id=$3,plan=$4,provider_price=$5,session_id=NULL,customer_id=NULL,subscription_id=NULL,
        status='pending',created_at=now(),observed_at=NULL,trial_end=NULL,effective_end_at=NULL WHERE id=$6`,
        [next, key, actor.actorId, plan, gateway.prices[plan], former.id],
      );
      await sql.query('INSERT INTO audit(workspace_id,id,actor_id,action) VALUES($1,$2,$3,$4)', [
        w,
        randomUUID(),
        actor.actorId,
        'billing.restart',
      ]);
      return next;
    });
    return this.openCurrent(w, expected);
  }
  private async openCurrent(w: string, expected: string) {
    const gateway = this.enabled();
    return this.locked(w, async (sql) => {
      await this.eligible(sql, w);
      const intent = (await this.intent(sql))!;
      requireCondition(
        intent.id === expected,
        409,
        'checkout_replaced',
        'This attempt was replaced. Refresh billing to see the current checkout.',
      );
      requireCondition(
        intent.sandbox_account === gateway.account &&
          (intent.session_id || Date.now() - intent.created_at.getTime() < safeWindow),
        409,
        'reconciliation_required',
        'Reconcile the original sandbox checkout before retrying.',
      );
      let result: SessionResult;
      try {
        result = await gateway.open(intent);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          503,
          'checkout_pending',
          'The sandbox outcome is uncertain. Retry the same checkout for this workspace.',
        );
      }
      await this.save(sql, intent, result);
      if (result.url)
        requireCondition(
          new URL(result.url).origin === 'https://checkout.stripe.com',
          503,
          'sandbox_mismatch',
          'The checkout destination was rejected.',
        );
      return { url: result.url, status: (await this.intent(sql))!.status };
    });
  }
  async portal(actor: Actor, key: string) {
    const gateway = this.enabled(),
      w = actor.workspaceId;
    await this.locked(w, async (sql) => {
      await this.eligible(sql, w);
      const intent = await this.intent(sql);
      requireCondition(
        intent?.customer_id && intent.sandbox_account === gateway.account,
        422,
        'customer_missing',
        'Complete the Flockletter sandbox checkout first.',
      );
      const prior = (
        await sql.query('SELECT actor_id,customer_id FROM sandbox_portal_intents WHERE operation_key=$1', [
          key,
        ])
      ).rows[0];
      if (prior) {
        requireCondition(
          prior.actor_id === actor.actorId && prior.customer_id === intent.customer_id,
          409,
          'operation_conflict',
          'Use a new portal operation key.',
        );
        return;
      }
      const recent = (
        await sql.query(
          "SELECT count(*)::int AS n FROM sandbox_portal_intents WHERE created_at>now()-interval '1 hour'",
        )
      ).rows[0];
      requireCondition(recent.n < 10, 429, 'portal_limit', 'Wait before opening another sandbox portal.');
      await sql.query(
        'INSERT INTO sandbox_portal_intents(workspace_id,operation_key,actor_id,customer_id) VALUES($1,$2,$3,$4)',
        [w, key, actor.actorId, intent.customer_id],
      );
      await sql.query('INSERT INTO audit(workspace_id,id,actor_id,action) VALUES($1,$2,$3,$4)', [
        w,
        randomUUID(),
        actor.actorId,
        'billing.portal',
      ]);
    });
    return this.locked(w, async (sql) => {
      await this.eligible(sql, w);
      const row = (
        await sql.query('SELECT customer_id,created_at FROM sandbox_portal_intents WHERE operation_key=$1', [
          key,
        ])
      ).rows[0]!;
      requireCondition(
        Date.now() - row.created_at.getTime() < safeWindow,
        409,
        'portal_expired',
        'Start a new portal session.',
      );
      try {
        return { url: await gateway.portal(row.customer_id, w + '-' + key) };
      } catch {
        throw new AppError(503, 'portal_pending', 'Retry the same sandbox portal request.');
      }
    });
  }
  async feedback(raw: Buffer, signature: string) {
    const gateway = this.enabled(),
      event = gateway.verify(raw, signature);
    if (!event) return;
    const hash = digest(raw);
    // Record verified receipt before observing current provider state. Redelivery resumes an unfinished receipt.
    const saved = await this.locked(event.workspace, async (sql) => {
      const intent = await this.intent(sql);
      if (!intent || intent.id !== event.intent || intent.sandbox_account !== gateway.account) return false;
      await sql.query(
        'INSERT INTO sandbox_events(workspace_id,event_id,kind,digest) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [event.workspace, event.id, event.kind, hash],
      );
      const prior = (
        await sql.query('SELECT digest,finished FROM sandbox_events WHERE event_id=$1', [event.id])
      ).rows[0]!;
      requireCondition(
        prior.digest === hash,
        409,
        'event_conflict',
        'The sandbox event identity was reused.',
      );
      return !prior.finished;
    });
    if (!saved) return;
    await this.locked(event.workspace, async (sql) => {
      if (
        (await sql.query('SELECT finished FROM sandbox_events WHERE event_id=$1', [event.id])).rows[0]
          ?.finished
      )
        return;
      const intent = (await this.intent(sql))!;
      if (intent.id !== event.intent) {
        await sql.query('UPDATE sandbox_events SET finished=true WHERE event_id=$1', [event.id]);
        return;
      }
      const sessionEvent = event.kind.startsWith('checkout.session.');
      const id = sessionEvent ? event.objectId : intent.session_id;
      requireCondition(id, 503, 'awaiting_checkout', 'Retry after checkout reconciliation.');
      const current = await gateway.observe(intent, id);
      requireCondition(
        sessionEvent || current.subscription === event.objectId,
        409,
        'billing_mismatch',
        'The event is for a different subscription.',
      );
      await this.save(sql, intent, current, true);
      await sql.query('UPDATE sandbox_events SET finished=true WHERE event_id=$1', [event.id]);
    });
  }
}
