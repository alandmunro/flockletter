import { z } from 'zod';
import { commandDefinition } from './command-definition.js';

export const customerPlan = z.enum(['starter', 'growth', 'pro']);
export type CustomerPlan = z.infer<typeof customerPlan>;
export const customerBillingStates = [
  'preparation',
  'trialing',
  'active',
  'past_due',
  'suspended',
  'canceled',
  'closed',
] as const;
export type CustomerBillingState = (typeof customerBillingStates)[number];
export const customerBillingCommands = {
  'customerBilling.status': commandDefinition(
    'Read this workspace’s subscription eligibility and shared delivery allowance.',
    'owner',
    false,
    {},
  ),
  'customerBilling.checkout': commandDefinition(
    'Open or reconcile provider-hosted checkout for this workspace. Payment follows verified provider events.',
    'owner',
    true,
    { operationKey: z.uuid(), plan: customerPlan },
  ),
  'customerBilling.portal': commandDefinition(
    'Open the billing provider’s customer portal for this workspace.',
    'owner',
    true,
    { operationKey: z.uuid() },
  ),
  'customerBilling.restartCheckout': commandDefinition(
    'Start normal paid checkout only after the exact previous session is verified expired; the trial is not renewed.',
    'owner',
    true,
    { operationKey: z.uuid(), plan: customerPlan },
  ),
  'customerBilling.rejoin': commandDefinition(
    'Rejoin an ended subscription through normal paid checkout after a version-checked provider verification. No new free trial.',
    'owner',
    true,
    { operationKey: z.uuid(), plan: customerPlan, expectedRevision: z.number().int().positive() },
  ),
  'customerBilling.startTrial': commandDefinition(
    'Start one captured 14-day trial in the enabled staging exercise. No card is charged.',
    'owner',
    true,
    {
      operationKey: z.uuid(),
      plan: customerPlan,
      simulatedCardConfirmed: z.literal(true),
    },
  ),
  'customerBilling.changePlan': commandDefinition(
    'Change a captured subscription plan. Upgrades apply immediately and downgrades at renewal.',
    'owner',
    true,
    { operationKey: z.uuid(), plan: customerPlan },
  ),
  'customerBilling.cancel': commandDefinition(
    'Record cancellation at the end of the captured trial or current subscription period.',
    'owner',
    true,
    { operationKey: z.uuid() },
  ),
  'customerBilling.resume': commandDefinition(
    'Remove an effective-end cancellation before the captured subscription closes.',
    'owner',
    true,
    { operationKey: z.uuid() },
  ),
  'customerBilling.exercisePayment': commandDefinition(
    'Record a clearly simulated payment success or failure in staging. No payment is collected.',
    'owner',
    true,
    { operationKey: z.uuid(), result: z.enum(['succeeded', 'failed']) },
  ),
  'customerBilling.advanceExercise': commandDefinition(
    'Advance this workspace’s captured billing clock to exercise a lifecycle boundary.',
    'owner',
    true,
    { operationKey: z.uuid(), days: z.number().int().min(1).max(120) },
  ),
} as const;
export type CustomerBillingCommandName = keyof typeof customerBillingCommands;

export type CustomerAllowance = {
  contacts: number;
  recipients: number;
  campaigns: number;
  emails: number;
  companies: number;
  brands: number;
  users: number | null;
};
export type CustomerBillingStatus = {
  mode: 'off' | 'exercise' | 'stripe';
  source: 'preparation' | 'exercise' | 'stripe' | 'complimentary';
  state: CustomerBillingState;
  plan: CustomerPlan | null;
  pendingPlan: CustomerPlan | null;
  revision: number;
  eligible: boolean;
  reasons: string[];
  now: string;
  trialEnd: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  cancelAt: string | null;
  failedSince: string | null;
  limits: CustomerAllowance | null;
  usage: {
    period: string;
    campaigns: number;
    emails: number;
    reservedCampaigns: number;
    reservedEmails: number;
  };
  exerciseEnabled: boolean;
};
