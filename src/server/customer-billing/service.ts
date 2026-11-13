import {preparationContactLimit} from '../../shared/trial.js';
import {hostedPolicies} from '../../shared/hosted-policies.js';
import {publicSubscriptionOffers,proEnrollmentNotice} from '../../shared/subscription-offers.js';
import { lockWorkspace } from '../workspace-lock.js';
import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import { digest } from '../content.js';
import { AppError, requireCondition } from '../errors.js';
import type { Actor } from '../service.js';
import {
  customerBillingCommands,
  type CustomerBillingCommandName,
  type CustomerBillingState,
  type CustomerBillingStatus,
  type CustomerPlan,
} from '../../shared/customer-billing.js';
import {
  dueState,
  millisecondsPerDay,
  nextMonth,
  planAllowance,
  trialAllowance,
  utcMonth,
} from './policy.js';
import type { CustomerBillingEvents, CustomerBillingProvider, ProviderIntent } from './provider.js';
import { TrialEnrollment, trialSetupStatus, trialEligibility } from './trial-enrollment.js';
import type { TrialRegistry } from '../customer-abuse/registry.js';
import { plans } from '../../shared/contracts.js';

export type BillingOptions = {
  environment: 'local' | 'test' | 'staging' | 'production';
  exerciseEnabled: boolean;
  now?: () => Date;
  gateway?: CustomerBillingProvider;
  eventGateway?: CustomerBillingEvents;
  trialRegistry?: TrialRegistry;
  checkOwner?: (userId: string, workspace: string) => Promise<boolean>;
};
type Subscription = {
  workspace_id: string;
  id: string;
  source: 'exercise' | 'stripe';
  state: CustomerBillingState;
  plan: CustomerPlan;
  pending_plan: CustomerPlan | null;
  revision: number;
  trial_started_at: Date | null;
  trial_end_at: Date | null;
  period_start_at: Date | null;
  period_end_at: Date | null;
  cancel_at: Date | null;
  failed_since: Date | null;
  effective_end_at: Date | null;
  clock_offset_days: number;
  observed_at: Date | null;
  risk_hold: boolean;
  risk_reason: string | null;
  provider_account?: string | null;
  provider_customer?: string | null;
  provider_subscription?: string | null;
};
export type BillingEligibility = CustomerBillingStatus;
type RejoinBinding = { account: string; customer: string; subscription: string; revision: number };
type Reservation = {
  operation_key: string;
  campaign_id: string;
  brand_id: string;
  recipients: number;
  accepted: number;
  excluded: number;
  state: 'reserved' | 'settled' | 'released';
  period: string;
  request_hash: string;
  slots: number;
};
const emptyUsage = (period: string) => ({
  period,
  campaigns: 0,
  emails: 0,
  reservedCampaigns: 0,
  reservedEmails: 0,
});
const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;
async function row(sql: Sql, lock = false) {
  return (
    await sql.query<Subscription>('SELECT * FROM customer_subscriptions' + (lock ? ' FOR UPDATE' : ''))
  ).rows[0];
}
async function requireScope(sql: Sql, workspace: string) {
  requireCondition(
    (await sql.query<{ workspace: string }>("SELECT current_setting('app.workspace_id',true) workspace"))
      .rows[0]?.workspace === workspace,
    403,
    'workspace_scope',
    'Use the authenticated workspace transaction.',
  );
}
async function requireNotErased(sql: Sql) {
  requireCondition(
    !(await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount,
    410,
    'workspace_erased',
    'This workspace has completed its retention erasure.',
  );
}
function effective(before: Subscription, clock: Date): Subscription {
  const s = { ...before };
  if (s.cancel_at && clock >= s.cancel_at) {
    s.state = 'canceled';
    s.effective_end_at = s.cancel_at;
    return s;
  }
  const end = s.state === 'trialing' ? s.trial_end_at : s.state === 'active' ? s.period_end_at : null;
  if (end && clock >= end) {
    s.state = 'past_due';
    s.failed_since ??= end;
  }
  s.state = dueState(s.state, s.failed_since, clock);
  if (s.state === 'closed')
    s.effective_end_at ??= new Date(s.failed_since!.getTime() + 30 * millisecondsPerDay);
  // A provider-applied renewal records its current plan. An exercise downgrade becomes
  // the selected plan at the agreed boundary, even when payment still needs recovery.
  if (s.pending_plan && s.period_end_at && clock >= s.period_end_at) {
    s.plan = s.pending_plan;
    s.pending_plan = null;
  }
  return s;
}
export async function usage(sql: Sql, period: string): Promise<CustomerBillingStatus['usage']> {
  const result = (
    await sql.query<{
      campaigns: number;
      emails: number;
      reserved_campaigns: number;
      reserved_emails: number;
    }>(
      `
    SELECT coalesce(sum(CASE WHEN accepted>0 THEN slots ELSE 0 END),0)::int campaigns,
    coalesce(sum(accepted),0)::int emails,
    coalesce(sum(CASE WHEN state='reserved' AND accepted=0 THEN slots ELSE 0 END),0)::int reserved_campaigns,
    coalesce(sum(CASE WHEN state='reserved' THEN recipients-accepted-excluded ELSE 0 END),0)::int reserved_emails
    FROM customer_usage_reservations WHERE period=$1`,
      [period],
    )
  ).rows[0];
  return result
    ? {
        period,
        campaigns: result.campaigns,
        emails: result.emails,
        reservedCampaigns: result.reserved_campaigns,
        reservedEmails: result.reserved_emails,
      }
    : emptyUsage(period);
}
export async function customerEligibility(
  sql: Sql,
  workspace: string,
  options?: Partial<BillingOptions>,
  at = options?.now?.() ?? new Date(),
): Promise<BillingEligibility> {
  await requireScope(sql, workspace);
  const grant = (
    await sql.query<{ plan: CustomerPlan | null; revision: number }>(
      'SELECT plan,revision FROM workspace_access_events ORDER BY revision DESC LIMIT 1',
    )
  ).rows[0];
  const stored = await row(sql);
  const now =
    !grant?.plan && stored?.source === 'exercise'
      ? new Date(at.getTime() + stored.clock_offset_days * millisecondsPerDay)
      : at;
  const s = stored && effective(stored, now);
  const complimentary = !!grant?.plan;
  const source = complimentary ? 'complimentary' : (s?.source ?? 'preparation');
  const state: CustomerBillingState = complimentary ? 'active' : (s?.state ?? 'preparation');
  const plan = complimentary ? grant!.plan : (s?.plan ?? null);
  const trial = state === 'trialing';
  const period = trial && s ? 'trial:' + s.id : utcMonth(now);
  const reasons: string[] = [];
  if ((await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount)
    reasons.push('This workspace has completed its retention erasure.');
  if (!plan) reasons.push('Choose a plan and complete its required activation.');
  if (!complimentary && (!s || (s.source === 'stripe' && !s.observed_at)))
    reasons.push('A verified provider event is required.');
  if (!['trialing', 'active', 'past_due'].includes(state))
    reasons.push(
      state === 'suspended'
        ? 'Sending is suspended after six days of unsuccessful payment.'
        : state === 'closed' || state === 'canceled'
          ? 'This subscription has ended.'
          : 'This workspace is in preparation.',
    );
  const exerciseEnabled = options?.exerciseEnabled === true && options.environment !== 'production';
  if (!complimentary && s?.source === 'exercise' && !exerciseEnabled)
    reasons.push('Captured billing exercises are disabled for this environment.');
  if (!complimentary && s?.source === 'stripe' && !options?.gateway)
    reasons.push('This environment’s dedicated billing provider is disabled.');
  if (s?.risk_hold) reasons.push('A billing risk signal requires operator review.');
  if (
    (await sql.query<{ held: boolean }>('SELECT public.flockletter_platform_hold($1) held', [workspace]))
      .rows[0]?.held
  )
    reasons.push('This workspace requires a platform review.');
  if (!complimentary && trial && !(await trialEligibility(sql, workspace, options?.trialRegistry)))
    reasons.push('The trial’s protected eligibility requires review.');
  const limits = plan ? (trial ? trialAllowance : planAllowance(plan)) : null;
  if (limits) {
    const capacity = await customerCapacity(sql);
    if (capacity.companies > limits.companies)
      reasons.push('This workspace exceeds the plan’s company allowance.');
    if (capacity.brands > limits.brands)
      reasons.push('This workspace exceeds the plan’s brand allowance.');
    if (capacity.contacts > limits.contacts)
      reasons.push('This workspace exceeds the plan’s active contact allowance.');
  }
  return {
    mode: source === 'stripe' || options?.gateway ? 'stripe' : exerciseEnabled ? 'exercise' : 'off',
    source,
    state,
    plan,
    pendingPlan: complimentary ? null : (s?.pending_plan ?? null),
    revision: complimentary ? grant!.revision : (s?.revision ?? 0),
    eligible: reasons.length === 0,
    reasons,
    now: now.toISOString(),
    trialEnd: complimentary ? null : iso(s?.trial_end_at),
    periodStart: complimentary ? null : iso(s?.period_start_at),
    periodEnd: complimentary ? null : iso(s?.period_end_at),
    cancelAt: complimentary ? null : iso(s?.cancel_at),
    failedSince: complimentary ? null : iso(s?.failed_since),
    limits,
    usage: await usage(sql, period),
    exerciseEnabled,
    trialSetup: await trialSetupStatus(sql),
    trialProtectionReady: !!options?.trialRegistry,
    legacyCheckout: !!(
      await sql.query(
        "SELECT FROM customer_billing_intents WHERE command='customerBilling.checkout' LIMIT 1",
      )
    ).rowCount,
  };
}
export async function customerCapacity(sql: Sql) {
  const selected =
    (await sql.query<{ brand: string }>("SELECT current_setting('app.intake_brand_id',true) brand"))
      .rows[0]?.brand ?? '';
  const brands = (await sql.query<{ id: string }>('SELECT id FROM brands')).rows;
  const companies = (await sql.query<{ count: number }>('SELECT count(*)::int count FROM companies')).rows[0]!.count;
  let scopedBrand = selected;
  try {
    // Trial and Starter have one brand, where the per-brand email uniqueness constraint
    // lets PostgreSQL count contacts without transferring every address on each send check.
    if (brands.length === 1) {
      const brand = brands[0]!.id;
      if (scopedBrand !== brand) {
        await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [brand]);
        scopedBrand = brand;
      }
      const count = await sql.query<{ contacts: number }>(
        "SELECT count(*)::int contacts FROM subscribers WHERE state='confirmed'",
      );
      return { brands: 1, companies, contacts: count.rows[0]!.contacts };
    }
    const contacts = new Set<string>();
    for (const brand of brands) {
      await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [brand.id]);
      scopedBrand = brand.id;
      for (const row of (
        await sql.query<{ email_normalized: string }>(
          "SELECT email_normalized FROM subscribers WHERE state='confirmed'",
        )
      ).rows)
        contacts.add(row.email_normalized);
    }
    return { brands: brands.length, companies, contacts: contacts.size };
  } finally {
    if (scopedBrand !== selected) await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [selected]);
  }
}
export async function customerContactLimit(
  sql: Sql,
  workspace: string,
  options?: Partial<BillingOptions>,
) {
  const status = await customerEligibility(sql, workspace, options);
  return status.eligible ? status.limits!.contacts : preparationContactLimit;
}
export async function customerSeatLimit(sql: Sql, workspace: string, options?: Partial<BillingOptions>) {
  const status = await customerEligibility(sql, workspace, options);
  return status.eligible ? status.limits!.users : trialAllowance.users;
}
// Retention planning needs authoritative lifecycle facts, not sending authorization.
// Keep this projection SELECT-only so the independent planner can remain read-only;
// customerEligibility continues to enforce every hold, quota and trial registry check.
async function retentionLifecycle(sql: Sql, workspace: string, at: Date) {
  await requireScope(sql, workspace);
  const grant = (
    await sql.query<{ plan: CustomerPlan | null; revision: number }>(
      'SELECT plan,revision FROM workspace_access_events ORDER BY revision DESC LIMIT 1',
    )
  ).rows[0];
  const stored = await row(sql);
  const complimentary = !!grant?.plan;
  const now =
    !complimentary && stored?.source === 'exercise'
      ? new Date(at.getTime() + stored.clock_offset_days * millisecondsPerDay)
      : at;
  const current = stored && effective(stored, now);
  return {
    now,
    current,
    source: complimentary ? ('complimentary' as const) : (current?.source ?? ('preparation' as const)),
    state: complimentary ? ('active' as const) : (current?.state ?? ('preparation' as const)),
    revision: complimentary ? grant!.revision : (current?.revision ?? 0),
  };
}
export async function retentionClockSql(
  sql: Sql,
  workspace: string,
  options?: Partial<BillingOptions>,
  at = options?.now?.() ?? new Date(),
) {
  return (await retentionLifecycle(sql, workspace, at)).now;
}
export async function retentionServiceEndSql(
  sql: Sql,
  workspace: string,
  options?: Partial<BillingOptions>,
  at = options?.now?.() ?? new Date(),
) {
  const { source, state, current, revision } = await retentionLifecycle(sql, workspace, at);
  return {
    source: source === 'preparation' ? ('exercise' as const) : source,
    status: state,
    effectiveEnd: ['canceled', 'closed'].includes(state)
      ? (iso(current?.effective_end_at) ??
        iso(current?.cancel_at) ??
        (current?.failed_since
          ? new Date(current.failed_since.getTime() + 30 * millisecondsPerDay).toISOString()
          : null))
      : null,
    version: String(revision),
  };
}
export class CustomerBilling {
  constructor(
    readonly db: Database,
    readonly options: BillingOptions,
  ) {
    if (options.environment === 'production' && options.exerciseEnabled)
      throw Error('Production cannot enable captured billing.');
  }
  private clock() {
    return this.options.now?.() ?? new Date();
  }
  private async requireOwner(actor: Actor, sql?: Sql) {
    requireCondition(
      actor.kind === 'session' &&
        actor.owner &&
        (!this.options.checkOwner || (await this.options.checkOwner(actor.userId, actor.workspaceId))),
      403,
      'owner_required',
      'Use a current workspace owner session.',
    );
    if (sql) await requireNotErased(sql);
    else await this.db.tenant(actor.workspaceId, requireNotErased);
  }
  private async locked<T>(workspace: string, run: (sql: Sql) => Promise<T>) {
    return this.db.tenant(workspace, async (sql) => {
      await lockWorkspace(sql, workspace);
      return run(sql);
    });
  }
  async status(workspace: string) {
    const status=await this.db.tenant(workspace,sql=>customerEligibility(sql,workspace,this.options,this.clock()));
    return {...status,newSubscriptions:this.options.environment==='production'?publicSubscriptionOffers:{starter:true,growth:true,pro:true}};
  }
  async eligibility(workspace: string, at = this.clock()) {
    return this.db.tenant(workspace, (sql) => customerEligibility(sql, workspace, this.options, at));
  }
  async retentionServiceEnd(workspace: string) {
    return this.db.tenant(workspace, (sql) =>
      retentionServiceEndSql(sql, workspace, this.options, this.clock()),
    );
  }
  async retentionClock(workspace: string) {
    return this.db.tenant(workspace, (sql) =>
      retentionClockSql(sql, workspace, this.options, this.clock()),
    );
  }
  async execute(name: string, raw: unknown, actor: Actor) {
    requireCondition(
      actor.kind === 'session' && actor.owner,
      403,
      'owner_required',
      'Use a current workspace owner session.',
    );
    requireCondition(
      name in customerBillingCommands,
      404,
      'unknown_command',
      'This billing command is unavailable.',
    );
    const command = name as CustomerBillingCommandName;
    const input = customerBillingCommands[command].schema.parse(raw);
    await this.requireOwner(actor);
    if(this.options.environment==='production'&&'plan' in input&&input.plan&&['customerBilling.checkout','customerBilling.paidCheckout','customerBilling.restartCheckout','customerBilling.rejoin','customerBilling.portal'].includes(command))requireCondition(publicSubscriptionOffers[input.plan],409,'plan_enrollment_paused',proEnrollmentNotice);
    if(this.options.environment==='production'&&['customerBilling.paidCheckout','customerBilling.restartCheckout','customerBilling.rejoin'].includes(command))requireCondition('policyVersion' in input&&input.policyVersion===hostedPolicies.version&&'accepted' in input&&input.accepted===true,409,'policy_review_required','Accept the current hosted terms, sending policy and recurring price before continuing.');
    if (command === 'customerBilling.status') return this.status(actor.workspaceId);
    if (command === 'customerBilling.trialReview')
      return this.trials().review(actor, customerBillingCommands[command].schema.parse(raw).setupId);
    if (command === 'customerBilling.activateTrial')
      return this.trials().activate(actor, customerBillingCommands[command].schema.parse(raw));
    if (command === 'customerBilling.paidCheckout') {
      const accepted = customerBillingCommands[command].schema.parse(raw);
      requireCondition(
        plans.find((p) => p.id === accepted.plan)?.priceMinor === accepted.priceMinor,
        409,
        'price_changed',
        'Review the current recurring plan price.',
      );
      await this.db.tenant(actor.workspaceId, async (sql) => {
        requireCondition(
          !(
            await sql.query(
              "SELECT FROM customer_trial_setups WHERE state NOT IN ('denied','expired') LIMIT 1",
            )
          ).rowCount,
          409,
          'trial_setup_pending',
          'Resolve the existing card setup or approved trial before choosing paid checkout.',
        );
      });
      return this.checkout(actor, accepted, false, {
        priceMinor: accepted.priceMinor,
        currency: 'USD',
        acceptedAt: this.clock().toISOString(),
        policyVersion:hostedPolicies.version,
      });
    }
    if (command === 'customerBilling.checkout') {
      const legacy = await this.db.tenant(
        actor.workspaceId,
        async (sql) =>
          (
            await sql.query(
              "SELECT FROM customer_billing_intents WHERE command='customerBilling.checkout' LIMIT 1",
            )
          ).rowCount,
      );
      return legacy
        ? this.checkout(actor, customerBillingCommands[command].schema.parse(raw))
        : this.trials().checkout(actor, customerBillingCommands[command].schema.parse(raw));
    }
    if (command === 'customerBilling.restartCheckout') {
      const legacy = await this.db.tenant(
        actor.workspaceId,
        async (sql) =>
          (
            await sql.query(
              "SELECT FROM customer_billing_intents WHERE command='customerBilling.checkout' LIMIT 1",
            )
          ).rowCount,
      );
      return legacy
        ? this.checkout(actor, customerBillingCommands[command].schema.parse(raw), true)
        : this.trials().checkout(actor, customerBillingCommands[command].schema.parse(raw));
    }
    if (command === 'customerBilling.rejoin')
      return this.rejoin(actor, customerBillingCommands[command].schema.parse(raw));
    if (command === 'customerBilling.portal') {
      const request = customerBillingCommands[command].schema.parse(raw);
      return this.portal(actor, request.operationKey, request.plan);
    }
    requireCondition(
      this.options.exerciseEnabled && this.options.environment !== 'production',
      503,
      'exercise_disabled',
      'Captured billing is unavailable. Configure the billing provider to activate ordinary service.',
    );
    const key = (input as { operationKey: string }).operationKey,
      hash = digest(JSON.stringify([command, input]));
    return this.locked(actor.workspaceId, async (sql) => {
      await this.requireOwner(actor, sql);
      const prior = (
        await sql.query<{ request_hash: string; result: unknown }>(
          'SELECT request_hash,result FROM customer_billing_intents WHERE actor_id=$1 AND operation_key=$2',
          [actor.actorId, key],
        )
      ).rows[0];
      if (prior) {
        requireCondition(
          prior.request_hash === hash,
          409,
          'operation_conflict',
          'Retry the original billing request with its original key.',
        );
        return prior.result;
      }
      requireCondition(
        (await sql.query('SELECT FROM workspaces WHERE workspace_id=$1', [actor.workspaceId])).rowCount,
        409,
        'workspace_required',
        'Create the workspace first.',
      );
      const before = await row(sql),
        at = this.clock();
      const now = new Date(at.getTime() + (before?.clock_offset_days ?? 0) * millisecondsPerDay);
      const current = before && effective(before, now);
      const grant = (
        await sql.query('SELECT plan FROM workspace_access_events ORDER BY revision DESC LIMIT 1')
      ).rows[0];
      requireCondition(
        !grant?.plan,
        409,
        'complimentary_account',
        'Complimentary access bypasses card billing.',
      );
      requireCondition(
        !before || before.source === 'exercise',
        409,
        'provider_managed',
        'This subscription is managed by its verified payment provider.',
      );
      if (command === 'customerBilling.startTrial') {
        requireCondition(
          !(
            await sql.query<{ held: boolean }>('SELECT public.flockletter_platform_hold($1) held', [
              actor.workspaceId,
            ])
          ).rows[0]?.held,
          409,
          'platform_review_required',
          'This workspace requires a platform review.',
        );
        requireCondition(
          !before,
          409,
          'trial_already_used',
          'This workspace has already used or started its trial.',
        );
        const request = customerBillingCommands[command].schema.parse(raw),
          end = new Date(now.getTime() + 14 * millisecondsPerDay);
        if (this.options.trialRegistry) {
          const registry = this.options.trialRegistry;
          requireCondition(
            registry.config.source === 'exercise',
            503,
            'exercise_registry_required',
            'Use the separate synthetic eligibility registry.',
          );
          const identity = registry.identity(actor.workspaceId, actor.userId),
            id = randomUUID();
          const card = registry.card('synthetic:' + (request.simulatedCardReference ?? actor.userId));
          requireCondition(
            (await registry.claim(sql, actor.workspaceId, identity, id, 'reserve')) === 'allowed' &&
              (await registry.claim(sql, actor.workspaceId, identity, id, 'consume', card)) ===
                'allowed',
            409,
            'trial_unavailable',
            'This synthetic setup is not eligible for another captured trial.',
          );
          await sql.query(
            `INSERT INTO customer_trial_setups(workspace_id,id,actor_id,operation_key,plan,source,provider_account,registry_namespace,registry_workspace_digest,owner_digest,card_digest,state,created_at)
            VALUES($1,$2,$3,$4,$5,'exercise',$6,$7,$8,$9,$10,'active',$11)`,
            [
              actor.workspaceId,
              id,
              actor.actorId,
              key,
              request.plan,
              registry.config.account,
              identity.namespace,
              identity.workspaceDigest,
              identity.ownerDigest,
              card,
              now,
            ],
          );
        }
        await sql.query(
          `INSERT INTO customer_subscriptions(workspace_id,id,source,state,plan,trial_started_at,trial_end_at,period_start_at,period_end_at,observed_at)
          VALUES($1,$2,'exercise','trialing',$3,$4,$5,$4,$5,$4)`,
          [actor.workspaceId, randomUUID(), request.plan, now, end],
        );
      } else {
        requireCondition(current, 409, 'subscription_required', 'Start the captured trial first.');
        if (command === 'customerBilling.advanceExercise') {
          const days = customerBillingCommands[command].schema.parse(raw).days;
          requireCondition(
            current.clock_offset_days + days <= 3650,
            422,
            'exercise_clock_limit',
            'The captured billing clock cannot advance further.',
          );
          current.clock_offset_days += days;
        }
        if (command === 'customerBilling.changePlan') {
          const plan = customerBillingCommands[command].schema.parse(raw).plan;
          requireCondition(
            ['trialing', 'active', 'past_due'].includes(current.state),
            409,
            'subscription_inactive',
            'Recover this subscription before changing its plan.',
          );
          const prices = { starter: 1500, growth: 2500, pro: 3900 };
          if (prices[plan] >= prices[current.plan]) {
            current.plan = plan;
            current.pending_plan = null;
          } else current.pending_plan = plan;
        }
        if (command === 'customerBilling.cancel') {
          requireCondition(
            !['canceled', 'closed'].includes(current.state),
            409,
            'subscription_ended',
            'This subscription has already ended.',
          );
          current.cancel_at =
            current.state === 'trialing' ? current.trial_end_at : current.period_end_at;
        }
        if (command === 'customerBilling.resume') {
          requireCondition(
            current.cancel_at && now < current.cancel_at,
            409,
            'resume_unavailable',
            'The cancellation can be resumed only before its effective end.',
          );
          current.cancel_at = null;
        }
        if (command === 'customerBilling.exercisePayment') {
          const result = customerBillingCommands[command].schema.parse(raw).result;
          requireCondition(
            !current.effective_end_at ||
              now.getTime() < current.effective_end_at.getTime() + 90 * millisecondsPerDay,
            409,
            'recovery_expired',
            'The account recovery window has ended.',
          );
          if (result === 'failed') {
            requireCondition(
              !['canceled', 'closed'].includes(current.state),
              409,
              'subscription_ended',
              'Recover the account before recording another payment attempt.',
            );
            current.failed_since ??= now;
            current.state = dueState('past_due', current.failed_since, now);
          } else {
            current.state = 'active';
            current.failed_since = null;
            current.effective_end_at = null;
            current.cancel_at = null;
            if (current.pending_plan && current.period_end_at && now >= current.period_end_at) {
              current.plan = current.pending_plan;
              current.pending_plan = null;
            }
            current.period_start_at = now;
            current.period_end_at = nextMonth(now);
          }
        }
        const after = effective(
          current,
          new Date(at.getTime() + current.clock_offset_days * millisecondsPerDay),
        );
        await sql.query(
          `UPDATE customer_subscriptions SET state=$2,plan=$3,pending_plan=$4,revision=revision+1,
          cancel_at=$5,failed_since=$6,effective_end_at=$7,period_start_at=$8,period_end_at=$9,
          clock_offset_days=$10,observed_at=$11 WHERE workspace_id=$1`,
          [
            actor.workspaceId,
            after.state,
            after.plan,
            after.pending_plan,
            after.cancel_at,
            after.failed_since,
            after.effective_end_at,
            after.period_start_at,
            after.period_end_at,
            after.clock_offset_days,
            now,
          ],
        );
      }
      await sql.query(
        `INSERT INTO customer_billing_events(workspace_id,source,event_id,digest,event_kind,finished)
        VALUES($1,'exercise',$2,$3,$4,true)`,
        [actor.workspaceId, key, hash, command],
      );
      const status = await customerEligibility(sql, actor.workspaceId, this.options, at);
      await sql.query(
        `INSERT INTO customer_billing_intents(workspace_id,id,actor_id,operation_key,command,request_hash,state,result)
        VALUES($1,$2,$3,$4,$5,$6,'completed',$7)`,
        [actor.workspaceId, randomUUID(), actor.actorId, key, command, hash, JSON.stringify(status)],
      );
      await sql.query('INSERT INTO audit(workspace_id,id,actor_id,action) VALUES($1,$2,$3,$4)', [
        actor.workspaceId,
        randomUUID(),
        actor.actorId,
        command,
      ]);
      return status;
    });
  }
  private provider() {
    requireCondition(
      this.options.gateway,
      503,
      'billing_provider_unavailable',
      'Connect this environment’s dedicated Flockletter billing provider.',
    );
    return this.options.gateway;
  }
  private trials() {
    return new TrialEnrollment(this.db, {
      registry: this.options.trialRegistry,
      gateway: this.provider(),
      now: () => this.clock(),
      planAvailable:plan=>this.options.environment!=='production'||publicSubscriptionOffers[plan],requireOwner: (actor, sql) => this.requireOwner(actor, sql),
    });
  }
  private async checkout(
    actor: Actor,
    input: { operationKey: string; plan: CustomerPlan },
    restartExpired = false,
    paidAcceptance?: { priceMinor: number; currency: 'USD'; acceptedAt: string; policyVersion:string },
  ) {
    const gateway = this.provider(),
      workspace = actor.workspaceId;
    const prepared = await this.locked(workspace, async (sql) => {
      await this.requireOwner(actor, sql);
      const grant = (
        await sql.query('SELECT plan FROM workspace_access_events ORDER BY revision DESC LIMIT 1')
      ).rows[0];
      requireCondition(
        !grant?.plan,
        409,
        'complimentary_account',
        'Complimentary access bypasses card billing.',
      );
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
      requireCondition(
        !(
          await sql.query(
            "SELECT FROM customer_trial_setups WHERE state NOT IN ('denied','expired') LIMIT 1",
          )
        ).rowCount,
        409,
        'trial_setup_pending',
        'Resolve the existing trial setup before opening paid checkout.',
      );
      const subscription = await row(sql);
      requireCondition(
        !subscription,
        409,
        'subscription_exists',
        'Use the billing portal for the existing subscription.',
      );
      const prior = (
        await sql.query<{
          id: string;
          actor_id: string;
          operation_key: string;
          request_hash: string;
          provider_account: string;
          provider_reference: string | null;
          created_at: Date;
          result: { plan: CustomerPlan; checkoutExpired?: boolean; trialDays?: 0 | 14 };
        }>(
          `SELECT * FROM customer_billing_intents WHERE command='customerBilling.checkout'
          ORDER BY (actor_id=$1 AND operation_key=$2) DESC, coalesce(result->>'checkoutExpired','false'),created_at DESC,id LIMIT 1`,
          [actor.actorId, input.operationKey],
        )
      ).rows[0];
      if (prior) {
        const trialDays = prior.result.trialDays ?? 14;
        requireCondition(
          prior.actor_id === actor.actorId &&
            ['starter', 'growth', 'pro'].includes(prior.result.plan) &&
            (trialDays === 0 || trialDays === 14) &&
            prior.request_hash ===
              digest(
                JSON.stringify(
                  prior.result.trialDays === undefined
                    ? [prior.result.plan, actor.actorId]
                    : [prior.result.plan, actor.actorId, trialDays],
                ),
              ) &&
            prior.provider_account === gateway.account,
          409,
          'checkout_exists',
          'An existing checkout must be resolved before creating another.',
        );
        requireCondition(
          prior.result.plan === input.plan ||
            (restartExpired && prior.operation_key !== input.operationKey),
          409,
          'checkout_exists',
          'Resume the existing ' + prior.result.plan + ' checkout before selecting a different plan.',
        );
        const intent = {
          id: prior.id,
          workspace,
          plan: prior.result.plan,
          createdAt: prior.created_at,
          reference: prior.provider_reference,
          trialDays,
        } satisfies ProviderIntent;
        if (!restartExpired || prior.operation_key === input.operationKey)
          return { fresh: false, intent };
        const observed = await gateway.lookupCheckout(intent);
        requireCondition(
          observed?.state === 'expired' &&
            !observed.url &&
            (!prior.provider_reference || observed.id === prior.provider_reference),
          409,
          'checkout_unresolved',
          'The previous checkout must be verified expired before it can be replaced.',
        );
        await this.requireOwner(actor, sql);
        await sql.query(
          `UPDATE customer_billing_intents SET provider_reference=$2,state='completed',
          result=result||'{"checkoutExpired":true}'::jsonb WHERE id=$1`,
          [prior.id, observed.id],
        );
      }
      requireCondition(
        !restartExpired || prior,
        409,
        'checkout_missing',
        'Start the initial checkout first.',
      );
      const intent: ProviderIntent = {
        id: randomUUID(),
        workspace,
        plan: input.plan,
        createdAt: this.clock(),
        reference: null,
        // Only pre-existing legacy intents may retain their saved trial agreement.
        // Every new ordinary Checkout is explicitly selected paid service.
        trialDays: 0,
      };
      const requestHash = digest(JSON.stringify([input.plan, actor.actorId, intent.trialDays]));
      await sql.query(
        `INSERT INTO customer_billing_intents(workspace_id,id,actor_id,operation_key,command,request_hash,state,provider_account,created_at,result)
        VALUES($1,$2,$3,$4,'customerBilling.checkout',$5,'unknown',$6,$7,$8)`,
        [
          workspace,
          intent.id,
          actor.actorId,
          input.operationKey,
          requestHash,
          gateway.account,
          intent.createdAt,
          JSON.stringify({
            plan: input.plan,
            trialDays: intent.trialDays,
            ...(intent.trialDays===0?{policyVersion:hostedPolicies.version}:{}),
            ...(paidAcceptance ? { paidAcceptance } : {}),
          }),
        ],
      );
      await sql.query(
        'INSERT INTO audit(workspace_id,id,actor_id,action,resource_id) VALUES($1,$2,$3,$4,$5)',
        [
          workspace,
          randomUUID(),
          actor.actorId,
          restartExpired ? 'customerBilling.restartCheckout' : 'customerBilling.checkout',
          intent.id,
        ],
      );
      return { fresh: true, intent };
    });
    return this.finishCheckout(actor, prepared);
  }
  private async rejoin(
    actor: Actor,
    input: { operationKey: string; plan: CustomerPlan; expectedRevision: number },
  ) {
    const gateway = this.provider(),
      workspace = actor.workspaceId;
    const prepared = await this.locked(workspace, async (sql) => {
      await this.requireOwner(actor, sql);
      requireCondition(
        !(await sql.query('SELECT plan FROM workspace_access_events ORDER BY revision DESC LIMIT 1'))
          .rows[0]?.plan,
        409,
        'complimentary_account',
        'Complimentary access bypasses card billing.',
      );
      const current = await row(sql);
      const prior = (
        await sql.query<{
          id: string;
          actor_id: string;
          operation_key: string;
          request_hash: string;
          provider_account: string;
          provider_reference: string | null;
          created_at: Date;
          result: { plan: CustomerPlan; trialDays: 0; rejoin: RejoinBinding; rejoinApplied?: boolean };
        }>(
          `SELECT * FROM customer_billing_intents WHERE command='customerBilling.rejoin'
        AND ((result->>'rejoinApplied' IS DISTINCT FROM 'true' AND result->>'checkoutExpired' IS DISTINCT FROM 'true') OR (actor_id=$1 AND operation_key=$2))
        ORDER BY (actor_id=$1 AND operation_key=$2) DESC,coalesce(result->>'checkoutExpired','false'),created_at DESC,id LIMIT 1`,
          [actor.actorId, input.operationKey],
        )
      ).rows[0];
      if (prior) {
        const binding = prior.result.rejoin;
        requireCondition(
          binding &&
            prior.actor_id === actor.actorId &&
            prior.result.plan === input.plan &&
            binding.revision === input.expectedRevision &&
            prior.result.trialDays === 0 &&
            prior.provider_account === gateway.account &&
            prior.request_hash ===
              digest(
                JSON.stringify([
                  'rejoin',
                  input.plan,
                  actor.actorId,
                  binding.account,
                  binding.customer,
                  binding.subscription,
                  binding.revision,
                  0,
                ]),
              ),
          409,
          'rejoin_pending',
          'Resolve the original paid rejoin request before starting another.',
        );
        if (prior.result.rejoinApplied) return null;
        requireCondition(
          current &&
            current.provider_account === binding.account &&
            current.provider_customer === binding.customer &&
            current.provider_subscription === binding.subscription &&
            current.revision === binding.revision,
          409,
          'rejoin_changed',
          'The previous subscription changed. Resolve the pending checkout with support before retrying.',
        );
        const intent: ProviderIntent = {
          id: prior.id,
          workspace,
          plan: prior.result.plan,
          trialDays: 0,
          customer: binding.customer,
          previousSubscription: binding.subscription,
          previousRevision: binding.revision,
          createdAt: prior.created_at,
          reference: prior.provider_reference,
        };
        if (prior.operation_key === input.operationKey) return { fresh: false, intent };
        const observed = await gateway.lookupCheckout(intent);
        if (observed?.state !== 'expired') return { fresh: false, intent };
        requireCondition(
          !observed.url && (!intent.reference || observed.id === intent.reference),
          409,
          'rejoin_pending',
          'Resolve the original checkout first.',
        );
        await sql.query(
          `UPDATE customer_billing_intents SET result=result||'{"checkoutExpired":true}'::jsonb WHERE id=$1`,
          [prior.id],
        );
      }
      requireCondition(
        current?.source === 'stripe' &&
          current.observed_at &&
          current.provider_account === gateway.account &&
          current.provider_customer &&
          current.provider_subscription &&
          !current.risk_hold,
        409,
        'rejoin_unavailable',
        'Use a verified ended subscription without an unresolved billing hold.',
      );
      requireCondition(
        current.revision === input.expectedRevision,
        409,
        'version_conflict',
        'Reload the current subscription before rejoining.',
      );
      const status = effective(current, this.clock());
      requireCondition(
        ['canceled', 'closed'].includes(status.state),
        409,
        'subscription_not_ended',
        'The current subscription must end before rejoining.',
      );
      requireCondition(
        gateway.inspectSubscription,
        503,
        'rejoin_verification_unavailable',
        'Configure current provider subscription verification.',
      );
      const verified = await gateway.inspectSubscription(current.provider_subscription);
      requireCondition(
        verified.id === current.provider_subscription &&
          verified.customer === current.provider_customer &&
          verified.state === 'canceled' &&
          verified.endedAt &&
          verified.endedAt <= this.clock() &&
          this.clock().getTime() < verified.endedAt.getTime() + 90 * millisecondsPerDay,
        409,
        'subscription_not_ended',
        'The provider must confirm the prior service ended within the recovery window.',
      );
      await this.requireOwner(actor, sql);
      const binding: RejoinBinding = {
        account: current.provider_account,
        customer: current.provider_customer,
        subscription: current.provider_subscription,
        revision: current.revision,
      };
      const intent: ProviderIntent = {
        id: randomUUID(),
        workspace,
        plan: input.plan,
        trialDays: 0,
        customer: binding.customer,
        previousSubscription: binding.subscription,
        previousRevision: binding.revision,
        createdAt: this.clock(),
        reference: null,
      };
      const hash = digest(
        JSON.stringify([
          'rejoin',
          input.plan,
          actor.actorId,
          binding.account,
          binding.customer,
          binding.subscription,
          binding.revision,
          0,
        ]),
      );
      await sql.query(
        `INSERT INTO customer_billing_intents(workspace_id,id,actor_id,operation_key,command,request_hash,state,provider_account,created_at,result)
        VALUES($1,$2,$3,$4,'customerBilling.rejoin',$5,'unknown',$6,$7,$8)`,
        [
          workspace,
          intent.id,
          actor.actorId,
          input.operationKey,
          hash,
          gateway.account,
          intent.createdAt,
          JSON.stringify({ plan: input.plan, trialDays: 0, rejoin: binding, policyVersion:hostedPolicies.version }),
        ],
      );
      await sql.query(
        'INSERT INTO audit(workspace_id,id,actor_id,action,resource_id) VALUES($1,$2,$3,$4,$5)',
        [workspace, randomUUID(), actor.actorId, 'customerBilling.rejoin', intent.id],
      );
      return { fresh: true, intent };
    });
    return prepared ? this.finishCheckout(actor, prepared) : { state: 'rejoined', url: null };
  }
  private async finishCheckout(actor: Actor, prepared: { fresh: boolean; intent: ProviderIntent }) {
    const gateway = this.provider(),
      workspace = actor.workspaceId;
    let result;
    await this.requireOwner(actor);
    try {
      result = prepared.fresh
        ? await gateway.checkout(prepared.intent)
        : await gateway.lookupCheckout(prepared.intent);
    } catch {
      return { state: 'awaiting_reconciliation', url: null };
    }
    if (!result) return { state: 'awaiting_reconciliation', url: null };
    if (result.url)
      requireCondition(
        new URL(result.url).origin === 'https://checkout.stripe.com',
        503,
        'billing_destination',
        'The checkout destination could not be verified.',
      );
    await this.locked(workspace, (sql) =>
      sql.query(
        `UPDATE customer_billing_intents SET provider_reference=$2,state='completed',
      result=result||jsonb_build_object('checkoutRecorded',true,'checkoutExpired',$4::boolean)
      WHERE id=$1 AND provider_account=$3`,
        [prepared.intent.id, result.id, gateway.account, result.state === 'expired'],
      ),
    );
    await this.requireOwner(actor);
    return {
      state:
        result.state === 'expired'
          ? 'checkout_expired'
          : result.state === 'complete'
            ? 'awaiting_verification'
            : 'checkout_ready',
      url: result.url,
    };
  }
  private async portal(actor: Actor, key: string, plan?: CustomerPlan) {
    const gateway = this.provider(),
      workspace = actor.workspaceId;
    const intent = await this.locked(workspace, async (sql) => {
      await this.requireOwner(actor, sql);
      let subscription = (
        await sql.query<{
          provider_customer: string;
          provider_account: string;
          provider_subscription: string;
        }>("SELECT provider_customer,provider_account,provider_subscription FROM customer_subscriptions WHERE source='stripe'")
      ).rows[0];
      if (!subscription) {
        const setup = (
          await sql.query<{
            id: string;
            plan: CustomerPlan;
            customer_id: string;
            subscription_id: string;
            trial_end_at: Date;
          }>(
            `SELECT id,plan,customer_id,subscription_id,trial_end_at FROM customer_trial_setups
          WHERE state='active' AND approved_at IS NOT NULL AND review_hash IS NOT NULL AND subscription_id IS NOT NULL
          AND provider_account=$1 AND source=$2 ORDER BY created_at DESC LIMIT 1`,
            [gateway.account, gateway.live ? 'stripe_live' : 'stripe_test'],
          )
        ).rows[0];
        requireCondition(
          setup && gateway.inspectSubscription,
          409,
          'subscription_required',
          'The pending agreement must be verified before opening billing management.',
        );
        const verified = await gateway.inspectSubscription(setup.subscription_id);
        requireCondition(
          verified.id === setup.subscription_id &&
            verified.customer === setup.customer_id &&
            verified.workspaceHint === workspace &&
            verified.intentHint === setup.id &&
            verified.plan === setup.plan &&
            verified.trialEnd?.getTime() === setup.trial_end_at?.getTime(),
          409,
          'pending_agreement_unverified',
          'The pending billing agreement requires support review.',
        );
        await this.requireOwner(actor, sql);
        subscription = { provider_customer: verified.customer, provider_account: gateway.account, provider_subscription: verified.id };
      }
      requireCondition(
        subscription?.provider_account === gateway.account,
        409,
        'subscription_required',
        'A verified billing subscription is required.',
      );
      // Preserve historical management-operation hashes, while binding each new
      // destination selection to the same durable operation and retry key.
      const hash = digest(plan ? JSON.stringify([subscription.provider_customer, subscription.provider_subscription, plan]) : subscription.provider_customer);
      const previous = (
        await sql.query<{
          request_hash: string;
          state: string;
          created_at: Date;
        }>(
          'SELECT request_hash,state,created_at FROM customer_billing_intents WHERE actor_id=$1 AND operation_key=$2',
          [actor.actorId, key],
        )
      ).rows[0];
      if (previous) {
        requireCondition(
          previous.request_hash === hash,
          409,
          'operation_conflict',
          'Use the original portal operation.',
        );
        return {
          customer: subscription.provider_customer,
          subscription: subscription.provider_subscription,
          ready: previous.state === 'completed',
          createdAt: previous.created_at,
        };
      }
      const createdAt = this.clock();
      const id = randomUUID();
      await sql.query(
        `INSERT INTO customer_billing_intents(workspace_id,id,actor_id,operation_key,command,request_hash,state,provider_account,created_at)
        VALUES($1,$2,$3,$4,'customerBilling.portal',$5,'unknown',$6,$7)`,
        [workspace, id, actor.actorId, key, hash, gateway.account, createdAt],
      );
      await sql.query(
        'INSERT INTO audit(workspace_id,id,actor_id,action,resource_id) VALUES($1,$2,$3,$4,$5)',
        [workspace, randomUUID(), actor.actorId, 'customerBilling.portal', id],
      );
      return {
        customer: subscription.provider_customer,
        subscription: subscription.provider_subscription,
        ready: false,
        createdAt,
      };
    });
    if (intent.ready) return { url: null, alreadyIssued: true };
    requireCondition(
      this.clock().getTime() - intent.createdAt.getTime() < 23 * 3600000,
      409,
      'portal_expired',
      'Create a new portal request.',
    );
    let url: string;
    await this.requireOwner(actor);
    try {
      url = await gateway.portal(intent.customer, key, plan, intent.subscription);
    } catch {
      throw new AppError(503, 'portal_pending', 'Retry this same portal request.');
    }
    requireCondition(
      new URL(url).origin === 'https://billing.stripe.com',
      503,
      'billing_destination',
      'The billing portal destination could not be verified.',
    );
    await this.locked(workspace, (sql) =>
      sql.query(
        "UPDATE customer_billing_intents SET state='completed',result='{\"issued\":true}'::jsonb WHERE actor_id=$1 AND operation_key=$2",
        [actor.actorId, key],
      ),
    );
    await this.requireOwner(actor);
    return { url };
  }
  async webhook(raw: Buffer, signature: string) {
    const gateway = this.options.eventGateway ?? this.provider();
    let notice;
    try {
      notice = gateway.verify(raw, signature);
    } catch {
      throw new AppError(400, 'invalid_signature', 'The billing event could not be authenticated.');
    }
    if (!notice) return;
    const routed = await gateway.resolve(notice);
    if (!routed.subscription) return;
    // The hint only chooses a tenant transaction. Exact provider IDs and the pre-recorded
    // Checkout intent establish the binding before a provider fact can affect eligibility.
    const workspace = routed.workspace ?? routed.subscription.workspaceHint;
    if (!workspace || !/^org_[A-Za-z0-9_-]{1,120}$/.test(workspace)) return;
    return this.locked(workspace, async (sql) => {
      // Serialize retrieval with application: concurrent older event handlers must not
      // overwrite a newer snapshot fetched by another handler while waiting for this lock.
      const resolved = await gateway.resolve(notice),
        snapshot = resolved.subscription;
      if (!snapshot || (resolved.workspace ?? snapshot.workspaceHint) !== workspace) return;
      const current = await row(sql, true);
      const retired = (
        await sql.query(
          'SELECT FROM customer_subscription_history WHERE provider_account=$1 AND provider_subscription=$2 LIMIT 1',
          [gateway.account, snapshot.id],
        )
      ).rowCount;
      if (retired) {
        const prior = (
          await sql.query<{ digest: string }>(
            "SELECT digest FROM customer_billing_events WHERE source='stripe' AND event_id=$1",
            [notice.id],
          )
        ).rows[0];
        requireCondition(
          !prior || prior.digest === digest(raw),
          409,
          'event_conflict',
          'This billing event was reused with different content.',
        );
        if (!prior)
          await sql.query(
            `INSERT INTO customer_billing_events(workspace_id,source,event_id,digest,provider_account,provider_subscription,event_kind,finished)
          VALUES($1,'stripe',$2,$3,$4,$5,$6,true)`,
            [
              workspace,
              notice.id,
              digest(raw),
              gateway.account,
              snapshot.id,
              'ignored_retired:' + notice.kind,
            ],
          );
        return;
      }
      requireCondition(
        snapshot.state !== 'trialing' || snapshot.cardVerified,
        409,
        'card_required',
        'A verified provider-held card is required for the trial.',
      );
      const binding = (
        await sql.query<{
          id: string;
          command: string;
          provider_reference: string | null;
          created_at: Date;
          plan: CustomerPlan;
          trial_days: string | null;
          rejoin: RejoinBinding | null;
        }>(
          `SELECT id,command,provider_reference,created_at,result->>'plan' AS plan,result->>'trialDays' AS trial_days,result->'rejoin' AS rejoin
        FROM customer_billing_intents WHERE command IN ('customerBilling.checkout','customerBilling.rejoin','customerBilling.activateTrial') AND provider_account=$1 AND id=$2`,
          [gateway.account, resolved.intentId ?? snapshot.intentHint],
        )
      ).rows[0];
      const mapped = (
        await sql.query(
          "SELECT 1 FROM customer_subscriptions WHERE source='stripe' AND provider_account=$1 AND provider_subscription=$2 AND provider_customer=$3",
          [gateway.account, snapshot.id, snapshot.customer],
        )
      ).rowCount;
      let replacing = false;
      if (!mapped) {
        if (
          !binding ||
          binding.plan !== snapshot.plan ||
          (binding.trial_days === '0' && snapshot.trialStart !== null)
        )
          return;
        if (binding.command === 'customerBilling.activateTrial') {
          const setup = (
            await sql.query<{
              state: string;
              customer_id: string;
              trial_end_at: Date;
              subscription_id: string | null;
              approved_at: Date | null;
              review_hash: string | null;
            }>(
              'SELECT state,customer_id,trial_end_at,subscription_id,approved_at,review_hash FROM customer_trial_setups WHERE id=$1',
              [binding.id],
            )
          ).rows[0];
          if (
            current ||
            !setup ||
            !['activation_pending', 'active'].includes(setup.state) ||
            !setup.approved_at ||
            !setup.review_hash ||
            setup.customer_id !== snapshot.customer ||
            setup.trial_end_at?.getTime() !== snapshot.trialEnd?.getTime() ||
            (setup.subscription_id && setup.subscription_id !== snapshot.id) ||
            !(await trialEligibility(sql, workspace, this.options.trialRegistry))
          )
            return;
        } else if (binding.command === 'customerBilling.rejoin') {
          const previous = binding.rejoin;
          requireCondition(
            previous &&
              current?.source === 'stripe' &&
              current.provider_account === previous.account &&
              current.provider_customer === previous.customer &&
              current.provider_subscription === previous.subscription &&
              current.revision === previous.revision &&
              ['canceled', 'closed'].includes(effective(current, this.clock()).state) &&
              snapshot.customer === previous.customer &&
              snapshot.previousSubscription === previous.subscription &&
              snapshot.previousRevision === String(previous.revision) &&
              binding.trial_days === '0' &&
              !snapshot.trialStart,
            409,
            'rejoin_changed',
            'The prior subscription binding changed; resolve this paid checkout with support.',
          );
          requireCondition(
            snapshot.state === 'active',
            503,
            'rejoin_payment_pending',
            'Await the verified paid subscription before rejoining.',
          );
          let checkoutId = resolved.checkoutId;
          if (!checkoutId) {
            const checked = await gateway.lookupCheckout({
              id: binding.id,
              workspace,
              plan: binding.plan,
              trialDays: 0,
              customer: previous.customer,
              previousSubscription: previous.subscription,
              previousRevision: previous.revision,
              createdAt: binding.created_at,
              reference: binding.provider_reference,
            });
            requireCondition(
              checked?.state === 'complete' &&
                checked.subscription === snapshot.id &&
                checked.customer === snapshot.customer,
              503,
              'rejoin_verification_pending',
              'Await the exact completed Checkout session.',
            );
            checkoutId = checked.id;
          }
          requireCondition(
            !binding.provider_reference || binding.provider_reference === checkoutId,
            409,
            'rejoin_changed',
            'The Checkout binding changed.',
          );
          replacing = true;
        } else if (
          current ||
          !resolved.checkoutId ||
          (binding.provider_reference && binding.provider_reference !== resolved.checkoutId)
        )
          return;
      }
      const hash = digest(raw),
        old = (
          await sql.query<{ digest: string; finished: boolean }>(
            "SELECT digest,finished FROM customer_billing_events WHERE source='stripe' AND event_id=$1",
            [notice.id],
          )
        ).rows[0];
      if (old) {
        requireCondition(
          old.digest === hash,
          409,
          'event_conflict',
          'This billing event was reused with different content.',
        );
        if (old.finished) return;
      } else
        await sql.query(
          `INSERT INTO customer_billing_events(workspace_id,source,event_id,digest,provider_account,provider_subscription,event_kind)
        VALUES($1,'stripe',$2,$3,$4,$5,$6)`,
          [workspace, notice.id, hash, gateway.account, snapshot.id, notice.kind],
        );
      if (replacing && binding?.rejoin) {
        await sql.query(
          `INSERT INTO customer_subscription_history(workspace_id,provider_account,provider_subscription,revision,provider_customer,replaced_by,snapshot)
          SELECT workspace_id,provider_account,provider_subscription,revision,provider_customer,$2,to_jsonb(s)
          FROM customer_subscriptions s WHERE workspace_id=$1 AND revision=$3`,
          [workspace, snapshot.id, binding.rejoin.revision],
        );
      }
      const applied = await sql.query(
        `INSERT INTO customer_subscriptions(workspace_id,id,source,state,plan,trial_started_at,trial_end_at,period_start_at,period_end_at,
        cancel_at,failed_since,effective_end_at,provider_account,provider_customer,provider_subscription,observed_at,risk_hold,risk_reason,pending_plan)
        VALUES($1,$2,'stripe',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15,$16,$19)
        ON CONFLICT(workspace_id) DO UPDATE SET state=excluded.state,plan=excluded.plan,revision=customer_subscriptions.revision+1,
        trial_started_at=excluded.trial_started_at,trial_end_at=excluded.trial_end_at,period_start_at=excluded.period_start_at,
        period_end_at=excluded.period_end_at,cancel_at=excluded.cancel_at,
        failed_since=CASE WHEN excluded.state IN ('past_due','suspended') THEN coalesce(customer_subscriptions.failed_since,excluded.failed_since,now()) ELSE NULL END,
        effective_end_at=excluded.effective_end_at,observed_at=now(),pending_plan=excluded.pending_plan,
        provider_account=excluded.provider_account,provider_customer=excluded.provider_customer,provider_subscription=excluded.provider_subscription,
        risk_hold=customer_subscriptions.risk_hold OR excluded.risk_hold,
        risk_reason=coalesce(excluded.risk_reason,customer_subscriptions.risk_reason)
        WHERE NOT $17::boolean OR customer_subscriptions.revision=$18::integer RETURNING id`,
        [
          workspace,
          current?.id ?? randomUUID(),
          snapshot.state,
          snapshot.plan,
          snapshot.trialStart,
          snapshot.trialEnd,
          snapshot.periodStart,
          snapshot.periodEnd,
          snapshot.cancelAt,
          snapshot.failedSince,
          snapshot.endedAt,
          gateway.account,
          snapshot.customer,
          snapshot.id,
          notice.risk,
          notice.risk ? notice.kind : null,
          replacing,
          binding?.rejoin?.revision ?? null,
          snapshot.pendingPlan ?? null,
        ],
      );
      requireCondition(
        applied.rowCount,
        409,
        'rejoin_changed',
        'The subscription changed before its verified replacement.',
      );
      if (replacing && binding)
        await sql.query(
          `UPDATE customer_billing_intents SET result=result||'{"rejoinApplied":true}'::jsonb,state='completed' WHERE id=$1`,
          [binding.id],
        );
      await sql.query(
        "UPDATE customer_billing_events SET finished=true WHERE source='stripe' AND event_id=$1",
        [notice.id],
      );
    });
  }
  async reserve(
    sql: Sql,
    workspace: string,
    input: {
      operationKey: string;
      campaignId: string;
      brandId: string;
      recipients: number;
      dueAt?: Date;
      campaignSlot?: boolean;
    },
  ) {
    await requireScope(sql, workspace);
    await requireNotErased(sql);
    await lockWorkspace(sql, workspace);
    requireCondition(
      Number.isSafeInteger(input.recipients) && input.recipients > 0 && input.recipients <= 10000,
      422,
      'recipient_count',
      'Choose a finite recipient count.',
    );
    const slots = input.campaignSlot === false ? 0 : 1;
    const hash = digest(
      JSON.stringify([
        input.campaignId,
        input.brandId,
        input.recipients,
        input.dueAt?.toISOString() ?? null,
        slots,
      ]),
    );
    requireCondition(
      /^[A-Za-z0-9_-]{1,128}$/.test(input.operationKey),
      422,
      'operation_key',
      'Use a stable send reservation key.',
    );
    const old = (
      await sql.query<Reservation>('SELECT * FROM customer_usage_reservations WHERE operation_key=$1', [
        input.operationKey,
      ])
    ).rows[0];
    if (old) {
      requireCondition(
        old.request_hash === hash,
        409,
        'reservation_conflict',
        'The send key belongs to a different recipient reservation.',
      );
      return old;
    }
    const status = await customerEligibility(sql, workspace, this.options, this.clock());
    requireCondition(
      status.eligible && status.limits,
      422,
      'subscription_ineligible',
      status.reasons.join(' '),
    );
    const due = input.dueAt ?? new Date(status.now);
    requireCondition(
      !status.trialEnd || status.state !== 'trialing' || due < new Date(status.trialEnd),
      422,
      'trial_schedule',
      'Schedule the campaign within the active trial.',
    );
    requireCondition(
      !status.cancelAt || due < new Date(status.cancelAt),
      422,
      'cancellation_schedule',
      'Schedule the campaign before the effective service end.',
    );
    const period = status.state === 'trialing' ? status.usage.period : utcMonth(due);
    const used = await usage(sql, period),
      limits =
        status.pendingPlan && status.periodEnd && due >= new Date(status.periodEnd)
          ? planAllowance(status.pendingPlan)
          : status.limits;
    requireCondition(
      (
        await sql.query('SELECT id FROM campaigns WHERE id=$1 AND brand_id=$2', [
          input.campaignId,
          input.brandId,
        ])
      ).rowCount,
      404,
      'campaign_unavailable',
      'This campaign is unavailable in the selected brand.',
    );
    requireCondition(
      input.recipients <= limits.recipients &&
        used.emails + used.reservedEmails + input.recipients <= limits.emails &&
        used.campaigns + used.reservedCampaigns + slots <= limits.campaigns,
      422,
      'allowance_exceeded',
      'This campaign exceeds the shared remaining allowance.',
    );
    const inserted = await sql.query<Reservation>(
      `INSERT INTO customer_usage_reservations(workspace_id,operation_key,campaign_id,brand_id,period,recipients,request_hash,slots)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        workspace,
        input.operationKey,
        input.campaignId,
        input.brandId,
        period,
        input.recipients,
        hash,
        slots,
      ],
    );
    return inserted.rows[0]!;
  }
  async settle(
    sql: Sql,
    workspace: string,
    key: string,
    totals: { accepted: number; excluded: number },
  ) {
    await requireScope(sql, workspace);
    await lockWorkspace(sql, workspace);
    const old = (
      await sql.query<Reservation>(
        'SELECT * FROM customer_usage_reservations WHERE operation_key=$1 FOR UPDATE',
        [key],
      )
    ).rows[0];
    requireCondition(old, 404, 'reservation_missing', 'This recipient reservation is unavailable.');
    requireCondition(
      Number.isSafeInteger(totals.accepted) &&
        Number.isSafeInteger(totals.excluded) &&
        totals.accepted >= old.accepted &&
        totals.excluded >= old.excluded &&
        totals.accepted + totals.excluded <= old.recipients,
      409,
      'usage_conflict',
      'Usage totals cannot reverse a recorded provider fact.',
    );
    if (old.state !== 'reserved') {
      requireCondition(
        old.accepted === totals.accepted && old.excluded === totals.excluded,
        409,
        'usage_settled',
        'This reservation is already final.',
      );
      return old;
    }
    const complete = totals.accepted + totals.excluded === old.recipients;
    return (
      await sql.query<Reservation>(
        `UPDATE customer_usage_reservations SET accepted=$2,excluded=$3,
      state=$4,settled_at=CASE WHEN $5 THEN now() ELSE NULL END WHERE operation_key=$1 RETURNING *`,
        [key, totals.accepted, totals.excluded, complete ? 'settled' : 'reserved', complete],
      )
    ).rows[0]!;
  }
  async release(sql: Sql, workspace: string, key: string) {
    await requireScope(sql, workspace);
    await lockWorkspace(sql, workspace);
    const current = (
      await sql.query<Reservation>('SELECT * FROM customer_usage_reservations WHERE operation_key=$1', [
        key,
      ])
    ).rows[0];
    requireCondition(current, 404, 'reservation_missing', 'This recipient reservation is unavailable.');
    requireCondition(
      current.accepted === 0,
      409,
      'provider_already_accepted',
      'A provider acceptance cannot be released.',
    );
    await this.settle(sql, workspace, key, {
      accepted: 0,
      excluded: current.recipients,
    });
    return (
      await sql.query<Reservation>(
        "UPDATE customer_usage_reservations SET state='released' WHERE operation_key=$1 RETURNING *",
        [key],
      )
    ).rows[0]!;
  }
}
