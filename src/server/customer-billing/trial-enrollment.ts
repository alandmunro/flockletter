import {trialAllowance} from './policy.js';
import {hostedPolicies} from '../../shared/hosted-policies.js';
import {lockWorkspace} from '../workspace-lock.js';
import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import type { Actor } from '../service.js';
import { requireCondition } from '../errors.js';
import { digest } from '../content.js';
import { plans } from '../../shared/contracts.js';
import type { CustomerPlan, TrialReview } from '../../shared/customer-billing.js';
import { TrialRegistry, type TrialIdentity, type TrialSource } from '../customer-abuse/registry.js';
import type { CustomerBillingProvider, ProviderIntent, ProviderTrialActivation } from './provider.js';

type Setup = {
  workspace_id: string;
  id: string;
  actor_id: string;
  operation_key: string;
  plan: CustomerPlan;
  source: TrialSource;
  provider_account: string;
  registry_namespace: string;
  registry_workspace_digest: string;
  owner_digest: string;
  card_digest: string | null;
  state: string;
  revision: number;
  checkout_id: string | null;
  customer_id: string | null;
  payment_method_id: string | null;
  setup_intent_id: string | null;
  review: TrialReview | null;
  review_hash: string | null;
  review_expires_at: Date | null;
  activation_key: string | null;
  approved_at: Date | null;
  trial_end_at: Date | null;
  subscription_id: string | null;
  failure_code: string | null;
  created_at: Date;
};
export type TrialEnrollmentOptions = {
  planAvailable?:(plan:ProviderIntent['plan'])=>boolean;
  registry?: TrialRegistry;
  gateway: CustomerBillingProvider;
  now: () => Date;
  requireOwner: (actor: Actor, sql?: Sql) => Promise<void>;
};
const identity = (s: Setup): TrialIdentity => ({
  namespace: s.registry_namespace,
  workspaceDigest: s.registry_workspace_digest,
  ownerDigest: s.owner_digest,
});
const intent = (s: Setup): ProviderIntent => ({
  id: s.id,
  workspace: s.workspace_id,
  plan: s.plan,
  createdAt: s.created_at,
  reference: s.checkout_id,
});
const projection = (s: Setup) => ({
  id: s.id,
  state: s.state,
  plan: s.plan,
  revision: s.revision,
  review: s.review,
  activationKey: s.activation_key,
});
export async function trialSetupStatus(sql: Sql) {
  const s = (
    await sql.query<Setup>(
      'SELECT * FROM customer_trial_setups ORDER BY created_at DESC,id DESC LIMIT 1',
    )
  ).rows[0];
  return s ? projection(s) : undefined;
}
export async function trialEligibility(
  sql: Sql,
  workspace: string,
  registry: TrialRegistry | undefined,
) {
  const s = (
    await sql.query<Setup>(
      "SELECT * FROM customer_trial_setups WHERE state IN ('activation_pending','active') ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0];
  // Existing subscriptions are grandfathered only when no new enrollment exists.
  if (!s) return true;
  if (
    !registry ||
    s.provider_account !== registry.config.account ||
    s.source !== registry.config.source ||
    !s.card_digest
  )
    return false;
  return (
    (await registry.claim(sql, workspace, identity(s), s.id, 'status', s.card_digest)) === 'allowed'
  );
}
export class TrialEnrollment {
  constructor(
    readonly db: Database,
    readonly options: TrialEnrollmentOptions,
  ) {}
  private registry() {
    const r = this.options.registry,
      g = this.options.gateway;
    requireCondition(
      r &&
        r.config.account === g.account &&
        r.config.source === (g.live ? 'stripe_live' : 'stripe_test'),
      503,
      'trial_protection_required',
      'New trials require configured private eligibility protection and an approved retention policy.',
    );
    return r;
  }
  private async requireClear(sql: Sql, workspace: string) {
    requireCondition(
      !(
        await sql.query<{ held: boolean }>('SELECT public.flockletter_platform_hold($1) held', [
          workspace,
        ])
      ).rows[0]?.held,
      409,
      'platform_review_required',
      'This workspace requires a platform review.',
    );
  }
  private async locked<T>(actor: Actor, fn: (sql: Sql) => Promise<T>, allowHeld = false) {
    return this.db.tenant(actor.workspaceId, async (sql) => {
      await lockWorkspace(sql,actor.workspaceId);
      await this.options.requireOwner(actor, sql);
      if (!allowHeld) await this.requireClear(sql, actor.workspaceId);
      return fn(sql);
    });
  }
  private async setup(sql: Sql, actor: Actor, id: string) {
    const s = (
      await sql.query<Setup>('SELECT * FROM customer_trial_setups WHERE id=$1 FOR UPDATE', [id])
    ).rows[0];
    requireCondition(
      s &&
        s.actor_id === actor.actorId &&
        s.provider_account === this.options.gateway.account &&
        s.source === (this.options.gateway.live ? 'stripe_live' : 'stripe_test'),
      409,
      'trial_setup_unavailable',
      'Use the original owner and current card setup.',
    );
    const expected = this.registry().identity(actor.workspaceId, actor.userId);
    requireCondition(
      s.registry_namespace === expected.namespace &&
        s.registry_workspace_digest === expected.workspaceDigest &&
        s.owner_digest === expected.ownerDigest,
      409,
      'trial_setup_unavailable',
      'The card setup requires protected identity review.',
    );
    return s;
  }
  async checkout(actor: Actor, input: { operationKey: string; plan: CustomerPlan }) {
    const registry = this.registry(),
      g = this.options.gateway;
    requireCondition(
      g.setupCheckout && g.lookupSetupCheckout,
      503,
      'trial_provider_unavailable',
      'Card-only setup is unavailable.',
    );
    const prepared = await this.locked(actor, async (sql) => {
      requireCondition(
        !(await sql.query('SELECT FROM customer_subscriptions')).rowCount,
        409,
        'subscription_exists',
        'Use the current billing subscription.',
      );
      requireCondition(
        !(await sql.query('SELECT plan FROM workspace_access_events ORDER BY revision DESC LIMIT 1'))
          .rows[0]?.plan,
        409,
        'complimentary_account',
        'Complimentary access bypasses billing.',
      );
      let s = (
        await sql.query<Setup>(
          'SELECT * FROM customer_trial_setups WHERE actor_id=$1 AND operation_key=$2',
          [actor.actorId, input.operationKey],
        )
      ).rows[0];
      if (s) {
        requireCondition(
          s.plan === input.plan,
          409,
          'operation_conflict',
          'Retry the original plan with its original key.',
        );
        return { s: await this.setup(sql, actor, s.id), fresh: false };
      }
      const existing = (
        await sql.query<Setup>(
          "SELECT * FROM customer_trial_setups WHERE state NOT IN ('expired','denied') ORDER BY created_at DESC LIMIT 1",
        )
      ).rows[0];
      if (existing) {
        s = await this.setup(sql, actor, existing.id);
        if (s.state === 'activation_pending' || s.state === 'active') return { s, fresh: false };
        const observed = await g.lookupSetupCheckout!(intent(s));
        const absentAfterLease =
          !observed && this.options.now().getTime() - s.created_at.getTime() >= 36 * 60000;
        // A null result must be an exhaustive authenticated lookup. Card-only sessions
        // can live at most 33 minutes from preparation and cannot create an agreement.
        // Only after the 35-minute lease plus margin may a distinct intent recover.
        if (observed?.state !== 'expired' && !absentAfterLease) {
          requireCondition(
            s.plan === input.plan,
            409,
            'trial_setup_pending',
            'Resume or review the existing plan’s card setup before selecting another.',
          );
          return { s, fresh: false };
        }
        await sql.query(
          "UPDATE customer_trial_setups SET state='expired',revision=revision+1 WHERE id=$1",
          [s.id],
        );
      }
      const id = randomUUID(),
        who = registry.identity(actor.workspaceId, actor.userId);
      const decision = await registry.claim(sql, actor.workspaceId, who, id, 'reserve');
      if (decision !== 'allowed') return { denied: true };
      s = (
        await sql.query<Setup>(
          `INSERT INTO customer_trial_setups(workspace_id,id,actor_id,operation_key,plan,source,provider_account,registry_namespace,registry_workspace_digest,owner_digest,state,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11) RETURNING *`,
          [
            actor.workspaceId,
            id,
            actor.actorId,
            input.operationKey,
            input.plan,
            registry.config.source,
            g.account,
            who.namespace,
            who.workspaceDigest,
            who.ownerDigest,
            this.options.now(),
          ],
        )
      ).rows[0]!;
      return { s, fresh: true };
    });
    if ('denied' in prepared) return { state: 'trial_unavailable' };
    const { s, fresh } = prepared;
    if (['active', 'activation_pending'].includes(s.state)) return { state: s.state };
    // The intent above is committed before this provider boundary. Hold writes use the
    // same workspace lock, so no new setup can cross a subsequently committed hold.
    return this.locked(actor, async (sql) => {
      const current = await this.setup(sql, actor, s.id);
      let observed;
      try {
        observed = fresh
          ? await g.setupCheckout!(intent(current))
          : await g.lookupSetupCheckout!(intent(current));
      } catch {
        return { state: 'awaiting_reconciliation' };
      }
      if (!observed) return { state: 'awaiting_reconciliation' };
      requireCondition(
        !current.checkout_id || current.checkout_id === observed.id,
        409,
        'trial_setup_changed',
        'The card setup changed.',
      );
      await sql.query(
        `UPDATE customer_trial_setups SET checkout_id=$2,state=CASE WHEN $3='expired' THEN 'expired' ELSE state END WHERE id=$1`,
        [s.id, observed.id, observed.state],
      );
      return {
        state:
          observed.state === 'open'
            ? 'checkout_ready'
            : observed.state === 'expired'
              ? 'trial_setup_expired'
              : 'card_setup_complete',
        url: observed.url ?? undefined,
      };
    });
  }
  async review(actor: Actor, setupId: string) {
    this.registry();
    const g = this.options.gateway;
    requireCondition(
      g.inspectSetup,
      503,
      'trial_provider_unavailable',
      'Card verification is unavailable.',
    );
    return this.locked(actor, async (sql) => {
      const s = await this.setup(sql, actor, setupId);
      requireCondition(
        ['pending', 'card_verified', 'reviewed'].includes(s.state),
        409,
        'trial_review_unavailable',
        'Resolve the current trial setup before reviewing again.',
      );
      const proof = await g.inspectSetup!(intent(s));
      requireCondition(
        proof && proof.checkout === s.checkout_id,
        409,
        'card_setup_incomplete',
        'Complete the card-only setup before reviewing the trial.',
      );
      await this.options.requireOwner(actor, sql);
      const at = this.options.now(),
        revision = s.revision + 1;
      const base = {
        version: 1 as const,
        policyVersion:hostedPolicies.version,
        limits: trialAllowance,
        ...(proof.locationDigest?{locationDigest:proof.locationDigest,tax:'exclusive' as const}:{}),
        setupId: s.id,
        revision,
        plan: s.plan,
        priceMinor: plans.find((p) => p.id === s.plan)!.priceMinor,
        currency: 'USD' as const,
        trialDays: 14 as const,
        firstChargeAt:
          new Date(at.getTime() + 14 * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000Z',
        expiresAt: new Date(at.getTime() + 10 * 60000).toISOString(),
      };
      const review = { ...base, hash: digest(JSON.stringify([actor.workspaceId, actor.actorId, base])) };
      await sql.query(
        `UPDATE customer_trial_setups SET state='reviewed',revision=$2,customer_id=$3,payment_method_id=$4,setup_intent_id=$5,card_digest=$6,review=$7,review_hash=$8,review_expires_at=$9 WHERE id=$1`,
        [
          s.id,
          revision,
          proof.customer,
          proof.paymentMethod,
          proof.setupIntent,
          this.registry().card(proof.fingerprint),
          JSON.stringify(review),
          review.hash,
          base.expiresAt,
        ],
      );
      return { state: 'trial_review_ready', review };
    });
  }
  async activate(
    actor: Actor,
    input: {
      operationKey: string;
      setupId: string;
      expectedRevision: number;
      reviewHash: string;
      accepted: true;
    },
  ) {
    const registry = this.registry(),
      g = this.options.gateway;
    requireCondition(
      g.inspectSetup && g.createTrial && g.lookupTrial,
      503,
      'trial_provider_unavailable',
      'Trial activation is unavailable.',
    );
    const prepared = await this.locked(
      actor,
      async (sql) => {
        const s = await this.setup(sql, actor, input.setupId);
        if(!s.activation_key)requireCondition(this.options.planAvailable?.(s.plan)!==false,409,'plan_enrollment_paused','New subscriptions to this tier are paused. Select an offered tier before starting.');
        if (s.activation_key) {
          requireCondition(
            s.activation_key === input.operationKey &&
              s.review_hash === input.reviewHash &&
              s.revision === input.expectedRevision,
            409,
            'operation_conflict',
            'Retry the original approved trial activation.',
          );
          return { s, fresh: false };
        }
        await this.requireClear(sql, actor.workspaceId);
        requireCondition(
          s.state === 'reviewed' &&
            s.revision === input.expectedRevision &&
            s.review_hash === input.reviewHash &&
            input.accepted &&
            s.review_expires_at &&
            s.review_expires_at > this.options.now() &&
            s.review?.firstChargeAt && s.review.policyVersion===hostedPolicies.version,
          409,
          'trial_review_changed',
          'Review the current trial terms again before accepting.',
        );
        requireCondition(
          !(await sql.query('SELECT FROM customer_subscriptions')).rowCount,
          409,
          'subscription_exists',
          'Resolve the existing subscription.',
        );
        const proof = await g.inspectSetup!(intent(s));
        requireCondition(
          proof &&
            proof.checkout === s.checkout_id &&
            proof.customer === s.customer_id &&
            proof.paymentMethod === s.payment_method_id &&
            proof.setupIntent === s.setup_intent_id &&
            registry.card(proof.fingerprint) === s.card_digest && (!s.review.locationDigest || proof.locationDigest===s.review.locationDigest),
          409,
          'card_setup_changed',
          'Review the current verified card setup again.',
        );
        await this.options.requireOwner(actor, sql);
        const decision = await registry.claim(
          sql,
          actor.workspaceId,
          identity(s),
          s.id,
          'consume',
          s.card_digest,
        );
        if (decision !== 'allowed') {
          await sql.query(
            "UPDATE customer_trial_setups SET state='denied',failure_code='trial_unavailable' WHERE id=$1",
            [s.id],
          );
          return { denied: true };
        }
        const approved = this.options.now(),
          end = new Date(Math.floor(approved.getTime() / 1000) * 1000 + 14 * 86400000);
        requireCondition(
          end.toISOString().slice(0, 10) === s.review.firstChargeAt.slice(0, 10),
          409,
          'trial_review_changed',
          'The first charge date changed. Review the terms again.',
        );
        await sql.query(
          `UPDATE customer_trial_setups SET state='activation_pending',activation_key=$2,approved_at=$3,trial_end_at=$4 WHERE id=$1`,
          [s.id, input.operationKey, approved, end],
        );
        await sql.query(
          `INSERT INTO customer_billing_intents(workspace_id,id,actor_id,operation_key,command,request_hash,state,provider_account,result)
        VALUES($1,$2,$3,$4,'customerBilling.activateTrial',$5,'unknown',$6,$7)`,
          [
            actor.workspaceId,
            s.id,
            actor.actorId,
            input.operationKey,
            digest(JSON.stringify(input)),
            g.account,
            JSON.stringify({ plan: s.plan, trialDays: 14, setupId: s.id, reviewHash: s.review_hash,policyVersion:hostedPolicies.version }),
          ],
        );
        s.activation_key = input.operationKey;
        s.approved_at = approved;
        s.trial_end_at = end;
        s.state = 'activation_pending';
        return { s, fresh: true };
      },
      true,
    );
    if ('denied' in prepared) return { state: 'trial_unavailable' };
    const { s, fresh } = prepared;
    if (s.state === 'active') return { state: 'awaiting_verification' };
    requireCondition(
      s.customer_id && s.payment_method_id && s.activation_key && s.trial_end_at,
      409,
      'trial_activation_incomplete',
      'The saved approval requires support review.',
    );
    const activate: ProviderTrialActivation = {
      ...intent(s),
      customer: s.customer_id,
      paymentMethod: s.payment_method_id,
      activationKey: s.activation_key,
      trialEnd: s.trial_end_at,
      ...(s.review?.locationDigest?{locationDigest:s.review.locationDigest}:{}),
    };
    // Saved approval/claim is already committed. New agreement creation and hold
    // writes serialize on this same lock. Read-only lookup remains available while held.
    return this.locked(
      actor,
      async (sql) => {
        const current = await this.setup(sql, actor, s.id);
        if (fresh) await this.requireClear(sql, actor.workspaceId);
        let subscription;
        try {
          subscription = fresh ? await g.createTrial!(activate) : await g.lookupTrial!(activate);
        } catch {
          return { state: 'awaiting_reconciliation' };
        }
        if (!subscription) return { state: 'awaiting_reconciliation' };
        requireCondition(
          subscription.customer === s.customer_id &&
            subscription.workspaceHint === actor.workspaceId &&
            subscription.intentHint === s.id &&
            subscription.plan === s.plan &&
            subscription.cardVerified &&
            subscription.trialEnd?.getTime() === s.trial_end_at?.getTime(),
          409,
          'trial_binding_changed',
          'The provider trial requires support review.',
        );
        requireCondition(
          !current.subscription_id || current.subscription_id === subscription.id,
          409,
          'trial_binding_changed',
          'The trial subscription binding changed.',
        );
        await sql.query(
          "UPDATE customer_trial_setups SET state='active',subscription_id=$2 WHERE id=$1",
          [s.id, subscription.id],
        );
        await sql.query(
          "UPDATE customer_billing_intents SET state='completed',provider_reference=$2 WHERE id=$1",
          [s.id, subscription.id],
        );
        await sql.query(
          'INSERT INTO audit(workspace_id,id,actor_id,action,resource_id) VALUES($1,$2,$3,$4,$5)',
          [actor.workspaceId, randomUUID(), actor.actorId, 'customerBilling.activateTrial', s.id],
        );
        return { state: 'awaiting_verification' };
      },
      true,
    );
  }
}
