import { randomUUID } from 'node:crypto';
import { practiceTextPlans, textingPlanCommands, type PracticePlanStatus, type TextPlan, type TextPlanCommand } from '../../shared/texting-commercial.js';
import type { Database, Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import type { Actor } from '../service.js';
import { lockWorkspace } from '../workspace-lock.js';
import { audit, once, requestHash, type Interface, type SettingValues } from './storage.js';
import { reviewPracticeUpgrade } from './standard-upgrade.js';

// The staging agreement and its changes share the tenant's append-only SMS audit history. It is
// created only by explicit plan acceptance in captured enrollment, never from a newsletter grant.
const event = 'texting.practice_plan';
const planLedgerActor = 'system:texting-practice-plan';
type Agreement = {
  revision: number; registrationId: string; companyId: string; active: TextPlan | null; requested: TextPlan;
  standard: boolean; cancelled: boolean; cancelledAt?: string; upgradeFailure?: string | null; change: 'renewal' | 'standard_review' | null; requestId: string | null;
  capUsdCents: number | null; period: string; fees: number; setup: number;
};
const month = (now: Date) => now.toISOString().slice(0, 7);
const nextMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
async function agreement(sql: Sql, workspace: string) {
  return (await sql.query<{ state: Agreement }>(`SELECT result AS state FROM operations WHERE workspace_id=$1 AND actor_id=$2
    ORDER BY operation_key DESC LIMIT 1`, [workspace, planLedgerActor])).rows[0]?.state ?? null;
}
function advancePeriod(state: Agreement, now: Date): Agreement {
  if (month(now) <= state.period) return state;
  const active = state.change === 'renewal' ? state.requested : state.active;
  return { ...state, active, period: month(now), fees: active && !state.cancelled ? practiceTextPlans[active].monthly : 0,
    setup: 0, change: state.change === 'renewal' ? null : state.change };
}
async function record(sql: Sql, workspace: string, original: Agreement | null, update: Agreement, actor: string, via: Interface) {
  const next = { ...update, revision: (original?.revision ?? 0) + 1 };
  // Zero-padded sequence numbers allow an indexed latest-record lookup at worker admission.
  await sql.query(`INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4,$5)`,
    [workspace, planLedgerActor, String(next.revision).padStart(16, '0'), requestHash([original?.revision, next]), JSON.stringify(next)]);
  await audit(sql, workspace, actor, via, event, next.registrationId, original, next);
  return next;
}
export async function acceptEnrollmentPlan(sql: Sql, workspace: string, companyId: string, plan: TextPlan | undefined,
  actor: string, via: Interface, now: Date, registrationId: string) {
  if (!plan) return;
  const prior = await agreement(sql, workspace);
  if (prior) {
    requireCondition(!prior.cancelled, 409, 'texting_plan_cancelled', 'The workspace texting plan has been cancelled.');
    if (prior.registrationId === registrationId) return;
    requireCondition(prior.requested === plan, 409, 'texting_plan_conflict', 'Choose the existing workspace texting plan when registering another company.');
  }
  const seen = await sql.query(`SELECT 1 FROM sms_audit WHERE workspace_id=$1 AND action='texting.practice_setup' AND target=$2`, [workspace, registrationId]);
  if (seen.rowCount) return;
  const fee = practiceTextPlans[plan].setup;
  const state: Agreement = prior ? advancePeriod(prior, now) : {
    revision: 0, companyId, registrationId, active: null, requested: plan, standard: false, cancelled: false,
    change: null, requestId: null, capUsdCents: null, period: month(now), fees: 0, setup: 0,
  };
  await audit(sql, workspace, actor, via, 'texting.practice_setup', registrationId, null, { plan, amount: fee, currency: 'USD', month: month(now), source: 'capture' });
  await record(sql, workspace, prior, { ...state, setup: state.setup + fee }, actor, via);
}
function hold(state: Agreement): string | null {
  if (state.cancelled) return 'texting_plan_cancelled';
  if (!state.active) return 'texting_plan_pending';
  if (state.capUsdCents !== null && state.fees + state.setup >= state.capUsdCents) return 'texting_spend_cap';
  return null;
}
// Daily usage is workspace-wide. With multiple active senders, use the lowest approved
// tier limit. An unrecognized or manually managed sender still needs an operator cap.
async function practiceDailyLimit(sql: Sql, workspace: string, state: Agreement, settings: SettingValues) {
  const operatorCap = settings.carrier_daily_limit;
  if (!state.active || state.cancelled || (settings.mock_sole_proprietor_daily_limit === undefined &&
      settings.mock_low_volume_daily_limit === undefined && settings.mock_standard_daily_limit === undefined)) return operatorCap;
  const { rows } = await sql.query<{ company_id: string; tier: string | null }>(`SELECT b.company_id,
    CASE WHEN b.profile ? 'onboarding' THEN s.facts->>'tier' END tier
    FROM sms_registrations r JOIN sms_carrier_brands b ON b.id=r.carrier_brand_id
    LEFT JOIN sms_registration_steps s ON s.registration_id=r.id AND s.revision=r.revision AND s.step='brand' AND s.state='done'
    WHERE r.workspace_id=$1 AND r.state='approved' AND EXISTS
      (SELECT 1 FROM sms_numbers n WHERE n.carrier_brand_id=b.id AND n.state='active')`, [workspace]);
  let daily = operatorCap;
  let incomplete = false;
  for (const row of rows) {
    const tier = row.company_id === state.companyId && state.standard && row.tier === 'low_volume' ? 'standard' : row.tier;
    const tierCap = tier === 'standard' ? settings.mock_standard_daily_limit :
      tier === 'sole_proprietor' ? settings.mock_sole_proprietor_daily_limit :
      tier === 'low_volume' ? settings.mock_low_volume_daily_limit : undefined;
    if (tierCap === undefined) incomplete = true;
    else daily = Math.min(daily ?? tierCap, tierCap);
  }
  return incomplete && operatorCap === undefined ? undefined : daily;
}

export async function practicePlanLimits(sql: Sql, workspace: string, now: Date, settings: SettingValues, messageCreatedAt?: Date) {
  const original = await agreement(sql, workspace);
  if (!original) return { allowance: settings.monthly_segment_allowance, daily: settings.carrier_daily_limit, hold: null };
  const state = advancePeriod(original, now);
  const segments = state.active && !state.cancelled ? practiceTextPlans[state.active].segments : 0;
  const cancelledWork = messageCreatedAt && state.cancelledAt && +messageCreatedAt <= Date.parse(state.cancelledAt);
  return { allowance: Math.min(settings.monthly_segment_allowance ?? segments, segments),
    daily: await practiceDailyLimit(sql, workspace, state, settings), hold: cancelledWork ? 'texting_plan_cancelled' : hold(state) };
}
async function view(sql: Sql, workspace: string, state: Agreement, now: Date): Promise<PracticePlanStatus> {
  const current = advancePeriod(state, now);
  const usage = (await sql.query<{ used: number; reserved: number }>(`SELECT segments_used used, segments_reserved reserved
    FROM sms_usage WHERE workspace_id=$1 AND period_month=$2::date`, [workspace, current.period + '-01'])).rows[0];
  return { revision: current.revision, active: current.active, requested: current.requested,
    state: current.cancelled ? 'cancelled' : current.active ? 'active' : 'pending_registration', change: current.change,
    upgradeFailure: current.upgradeFailure ?? null, canReactivate: current.cancelled && !!current.cancelledAt && +now - Date.parse(current.cancelledAt) < 30 * 86400000,
    capUsdCents: current.capUsdCents, month: current.period, spendUsdCents: current.fees + current.setup,
    monthlyFeeUsdCents: current.fees, setupFeeUsdCents: current.setup,
    used: usage?.used ?? 0, reserved: usage?.reserved ?? 0, allowance: current.active && !current.cancelled ? practiceTextPlans[current.active].segments : 0, hold: hold(current) };
}
function activate(state: Agreement, plan: TextPlan, now: Date): Agreement {
  const price = practiceTextPlans[plan].monthly;
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), end = +nextMonth(now);
  // Only the incremental simulated fee is prorated. The authoritative monthly segment ledger stays intact.
  const fee = state.active ? Math.round((price - practiceTextPlans[state.active].monthly) * (end - +now) / (end - start)) : price;
  return { ...state, active: plan, requested: plan, fees: state.fees + fee, change: null, requestId: null };
}
export async function practicePlanStatus(sql: Sql, workspace: string, now: Date) {
  const state = await agreement(sql, workspace);
  return state && view(sql, workspace, state, now);
}
export class PracticeTextBilling {
  constructor(private readonly db: Database, private readonly now: () => Date, private readonly origin: string) {}
  async execute(name: TextPlanCommand, raw: unknown, actor: Actor, via: Interface) {
    const w = actor.workspaceId;
    if (name === 'sms.planStatus') {
      return this.db.read(w, sql => practicePlanStatus(sql, w, this.now()));
    }
    const input = textingPlanCommands[name].schema.parse(raw);
    return this.db.tenant(w, async sql => {
      await lockWorkspace(sql, w);
      return once(sql, w, actor.actorId, input.operationKey, [name, input], async () => {
        const now = this.now(), original = await agreement(sql, w);
        requireCondition(original && (!original.cancelled || name === 'sms.planReactivate'), 409, 'texting_plan_unavailable', 'An enrolled practice texting plan is required.');
        requireCondition(input.expectedRevision === original.revision, 409, 'revision_conflict', 'The plan changed. Reload it before making another change.');
        let state = advancePeriod(original, now);
        if (name === 'sms.planCancel') {
          state = { ...state, cancelled: true, cancelledAt: now.toISOString(), requested: state.active ?? state.requested, change: null, requestId: null, upgradeFailure: null };
          // Uncertain messages remain reconcilable. Never resurrect scheduled work on reactivation.
          await sql.query(`UPDATE sms_messages SET state='cancelled',reason='texting_plan_cancelled',updated_at=clock_timestamp()
            WHERE workspace_id=$1 AND state IN ('pending','admitted') AND reserved_segments=0`, [w]);
          await sql.query(`UPDATE sms_sends s SET state='cancelled',updated_at=clock_timestamp() WHERE workspace_id=$1
            AND state IN ('confirmed','running','scheduled','paused') AND NOT EXISTS (SELECT 1 FROM sms_messages m
              WHERE m.send_id=s.id AND m.state IN ('calling','uncertain','admitted'))`, [w]);
        } else if (name === 'sms.planReactivate') {
          requireCondition(state.cancelled && state.cancelledAt && +now - Date.parse(state.cancelledAt) < 30 * 86400000,
            409, 'reactivation_unavailable', 'The practice reactivation period has ended.');
          const price = practiceTextPlans[state.active ?? state.requested].monthly;
          requireCondition('acceptedMonthlyUsdCents' in input && input.acceptedMonthlyUsdCents === price,
            409, 'plan_price_changed', 'Review and accept the current practice price.');
          state = { ...state, cancelled: false, fees: state.active && state.fees === 0 ? price : state.fees };
        } else if ('capUsdCents' in input) {
          state = { ...state, capUsdCents: input.capUsdCents };
        } else if (name === 'sms.planChange') {
          const input = textingPlanCommands['sms.planChange'].schema.parse(raw);
          const plan = practiceTextPlans[input.plan];
          requireCondition(state.active, 409, 'registration_pending', 'Wait for the first registration to be approved before changing plans.');
          requireCondition(input.acceptedMonthlyUsdCents === plan.monthly, 409, 'plan_price_changed', 'Review and accept the current practice price.');
          requireCondition(state.requested !== input.plan, 409, 'plan_already_selected', 'This plan is already selected.');
          if (input.plan === state.active) state = { ...state, requested: input.plan, change: null, requestId: null };
          else if (plan.segments < practiceTextPlans[state.active].segments) state = { ...state, requested: input.plan, change: 'renewal', requestId: null };
          else if (plan.tier === 'standard' && !state.standard) {
            const eligible = await sql.query(`SELECT 1 FROM sms_carrier_brands WHERE workspace_id=$1 AND company_id=$2
              AND coalesce(profile->>'registrationType','ein')='ein' AND entity_type<>'sole_proprietor'`, [w, state.companyId]);
            requireCondition(eligible.rowCount, 409, 'standard_ein_required', 'Standard registration requires an EIN-based business.');
            state = { ...state, requested: input.plan, change: 'standard_review', requestId: randomUUID(), upgradeFailure: null };
          } else state = activate(state, input.plan, now);
        }
        return view(sql, w, await record(sql, w, original, state, actor.actorId, via), now);
      });
    });
  }
  async tick(workspace: string): Promise<Date | null> {
    return this.db.tenant(workspace, async sql => {
      await lockWorkspace(sql, workspace);
      const original = await agreement(sql, workspace);
      if (!original || original.cancelled) return null;
      const now = this.now();
      let state = advancePeriod(original, now), next: Date | null = nextMonth(now);
      if (!state.active || state.change === 'standard_review') {
        const registration = (await sql.query<{ account: string; brand: string; tier: string }>(`SELECT r.account_sid account,r.brand_sid brand,s.facts->>'tier' tier
          FROM sms_registrations r JOIN sms_carrier_brands b ON b.id=r.carrier_brand_id
          JOIN sms_numbers n ON n.carrier_brand_id=b.id AND n.state='active' JOIN sms_registration_steps s ON s.registration_id=r.id
            AND s.revision=r.revision AND s.step='brand' AND s.state='done'
          WHERE r.workspace_id=$1 AND r.id=$2 AND b.company_id=$3 AND r.state='approved' AND r.brand_status IN ('APPROVED','VERIFIED')
          AND r.campaign_status IN ('APPROVED','VERIFIED') AND b.profile ? 'onboarding'`, [workspace, state.registrationId, state.companyId])).rows[0];
        if (registration && (!state.active && (practiceTextPlans[state.requested].tier !== 'standard' || registration.tier === 'standard'))) {
          state = activate({ ...state, standard: registration.tier === 'standard' }, state.requested, now);
        } else if (registration && state.change === 'standard_review' && state.requestId) {
          const verdict = await reviewPracticeUpgrade(this.db, sql, workspace, state.registrationId, state.companyId, state.requestId, now, this.origin);
          if (verdict.state === 'approved') state = activate({ ...state, standard: true }, state.requested, now);
          else if (verdict.state === 'pending') next = verdict.next;
          else state = { ...state, requested: state.active!, change: null, requestId: null, upgradeFailure: verdict.reason };
        }
      }
      if (state !== original) await record(sql, workspace, original, state, 'worker', 'worker');
      return next;
    });
  }
}
