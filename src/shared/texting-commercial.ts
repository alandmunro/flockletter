import { z } from 'zod';

export const textPlanId = z.enum(['text_300', 'text_1000', 'text_2500']);
export type TextPlan = z.infer<typeof textPlanId>;
export const practiceTextPlans = {
  text_300: { name: 'Text 300', segments: 300, monthly: 1900, setup: 4900, tier: 'low_volume' },
  text_1000: { name: 'Text 1000', segments: 1000, monthly: 3900, setup: 4900, tier: 'low_volume' },
  text_2500: { name: 'Text 2500', segments: 2500, monthly: 7900, setup: 9900, tier: 'standard' },
} as const;
export function setupFeeFor(plan: TextPlan = 'text_300') {
  return { amount: practiceTextPlans[plan].setup, currency: 'USD' as const };
}
const mutation = { operationKey: z.uuid(), expectedRevision: z.number().int().positive() };
export const textingPlanCommands = {
  'sms.planStatus': { description: 'Read the captured texting agreement and current UTC calendar-month usage.', scope: 'owner', mutation: false, schema: z.strictObject({}) },
  'sms.planChange': { description: 'Accept a new practice texting plan. Increases take effect on eligibility and decreases at renewal.', scope: 'owner', mutation: true,
    schema: z.strictObject({ ...mutation, plan: textPlanId, acceptedMonthlyUsdCents: z.number().int().nonnegative() }) },
  'sms.planCap': { description: 'Set or clear the monthly cap on simulated texting charges.', scope: 'owner', mutation: true,
    schema: z.strictObject({ ...mutation, capUsdCents: z.number().int().min(0).max(100_000_000).nullable() }) },
  'sms.planReactivate': { description: 'Reactivate a cancelled practice texting plan within its recovery period.', scope: 'owner', mutation: true,
    schema: z.strictObject({ ...mutation, acceptedMonthlyUsdCents: z.number().int().nonnegative() }) },
  'sms.planCancel': { description: 'Cancel the workspace practice texting add-on immediately, preserving newsletter access.', scope: 'owner', mutation: true,
    schema: z.strictObject({ ...mutation, confirm: z.literal(true) }) },
} as const;
export type TextPlanCommand = keyof typeof textingPlanCommands;
export type PracticePlanStatus = {
  revision: number; active: TextPlan | null; requested: TextPlan; state: 'pending_registration' | 'active' | 'cancelled';
  change: 'standard_review' | 'renewal' | null; capUsdCents: number | null; month: string; spendUsdCents: number;
  canReactivate: boolean; upgradeFailure: string | null; monthlyFeeUsdCents: number; setupFeeUsdCents: number; used: number; reserved: number; allowance: number; hold: string | null;
};
