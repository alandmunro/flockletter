import type Stripe from 'stripe';
import { plans } from '../../shared/contracts.js';
import type { CustomerPlan } from '../../shared/customer-billing.js';

export type ExpectedSchedule = {
  scheduleId: string;
  subscriptionId: string;
  customerId: string;
  live: boolean;
  /** Unix seconds from the verified current subscription item. */
  periodStart: number;
  periodEnd: number;
  currentPlan: CustomerPlan;
  prices: Record<CustomerPlan, string>;
};

const invalid = () => Error('The Flockletter billing schedule could not be verified.');
const reference = (value: unknown) =>
  typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
      ? value.id
      : undefined;
const timestamp = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Projects only the next renewal downgrade; callers separately verify actual catalogue price facts. */
export function scheduledDowngradePlan(
  schedule: Stripe.SubscriptionSchedule,
  expected: ExpectedSchedule,
): CustomerPlan | null {
  if (
    !schedule ||
    !expected.scheduleId ||
    !expected.subscriptionId ||
    !expected.customerId ||
    schedule.id !== expected.scheduleId ||
    schedule.livemode !== expected.live ||
    schedule.status !== 'active' ||
    reference(schedule.subscription) !== expected.subscriptionId ||
    reference(schedule.customer) !== expected.customerId ||
    !timestamp(expected.periodStart) ||
    !timestamp(expected.periodEnd) ||
    expected.periodEnd <= expected.periodStart ||
    !schedule.current_phase ||
    schedule.current_phase.start_date !== expected.periodStart ||
    schedule.current_phase.end_date !== expected.periodEnd ||
    !Array.isArray(schedule.phases) ||
    !schedule.phases.length ||
    !plans.some((plan) => plan.id === expected.currentPlan) ||
    !expected.prices ||
    !plans.every((plan) => /^price_[A-Za-z0-9]+$/.test(expected.prices[plan.id])) ||
    new Set(plans.map((plan) => expected.prices[plan.id])).size !== plans.length
  )
    throw invalid();

  for (let index = 0; index < schedule.phases.length; index++) {
    const phase = schedule.phases[index]!;
    if (
      !phase ||
      !timestamp(phase.start_date) ||
      !timestamp(phase.end_date) ||
      phase.end_date <= phase.start_date ||
      (index > 0 && schedule.phases[index - 1]!.end_date !== phase.start_date)
    )
      throw invalid();
  }
  const current = schedule.phases.filter(
    (phase) =>
      phase.start_date === expected.periodStart && phase.end_date === expected.periodEnd,
  );
  if (current.length !== 1) throw invalid();

  function phasePlan(phase: Stripe.SubscriptionSchedule.Phase): CustomerPlan {
    if (
      !Array.isArray(phase.items) ||
      phase.items.length !== 1 ||
      !phase.items[0] ||
      phase.items[0].quantity !== 1
    )
      throw invalid();
    const price = reference(phase.items[0]!.price);
    const plan = plans.find((plan) => expected.prices[plan.id] === price);
    if (!plan) throw invalid();
    return plan.id;
  }

  if (phasePlan(current[0]!) !== expected.currentPlan) throw invalid();
  const next = schedule.phases[schedule.phases.indexOf(current[0]!) + 1];
  if (!next) return null;
  if (next.start_date !== expected.periodEnd) throw invalid();
  const nextPlan = phasePlan(next);
  const currentPrice = plans.find((plan) => plan.id === expected.currentPlan)!.priceMinor;
  const nextPrice = plans.find((plan) => plan.id === nextPlan)!.priceMinor;
  if (nextPrice >= currentPrice) throw invalid();
  return nextPlan;
}
