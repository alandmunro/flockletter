import { z } from 'zod';
import {billingTaxModes} from './billing-tax.js';
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
  'customerBilling.trialReview': commandDefinition(
    'Verify the completed card-only setup and review the exact 14-day trial and recurring price. Does not start a subscription.',
    'owner',
    true,
    { operationKey: z.uuid(), setupId: z.uuid() },
  ),
  'customerBilling.activateTrial': commandDefinition(
    'Accept the current trial review and activate the version-bound recurring agreement after private eligibility checks.',
    'owner',
    true,
    {
      operationKey: z.uuid(),
      setupId: z.uuid(),
      expectedRevision: z.number().int().positive(),
      reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
      accepted: z.literal(true),
    },
  ),
  'customerBilling.paidCheckout': commandDefinition(
    'Explicitly accept the selected normal monthly plan without a free trial. Payment still requires verified provider eligibility.',
    'owner',
    true,
    {
      operationKey: z.uuid(),
      plan: customerPlan,
      accepted: z.literal(true),
      priceMinor: z.number().int().positive(),
      policyVersion: z.string().max(100).optional(),
      taxMode:z.enum(billingTaxModes).optional(),
    },
  ),
  'customerBilling.portal': commandDefinition(
    'Open workspace billing management or review a selected destination plan in the provider portal. Access changes require verified provider facts.',
    'owner',
    true,
    { operationKey: z.uuid(), plan: customerPlan.optional() },
  ),
  'customerBilling.restartCheckout': commandDefinition(
    'Start normal paid checkout only after the exact previous session is verified expired; the trial is not renewed.',
    'owner',
    true,
    { operationKey: z.uuid(), plan: customerPlan, accepted:z.literal(true).optional(), policyVersion:z.string().max(100).optional(),taxMode:z.enum(billingTaxModes).optional() },
  ),
  'customerBilling.rejoin': commandDefinition(
    'Rejoin an ended subscription through normal paid checkout after a version-checked provider verification. No new free trial.',
    'owner',
    true,
    { operationKey: z.uuid(), plan: customerPlan, expectedRevision: z.number().int().positive(), accepted:z.literal(true).optional(), policyVersion:z.string().max(100).optional(),taxMode:z.enum(billingTaxModes).optional() },
  ),
  'customerBilling.startTrial': commandDefinition(
    'Start one captured 14-day trial in the enabled staging exercise. No card is charged.',
    'owner',
    true,
    {
      operationKey: z.uuid(),
      plan: customerPlan,
      simulatedCardConfirmed: z.literal(true),
      simulatedCardReference: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,100}$/)
        .optional(),
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
  taxMode?: import('./billing-tax.js').BillingTaxMode;
  newSubscriptions?:Record<CustomerPlan,boolean>;
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
  trialSetup?: {
    id: string;
    state: string;
    plan: CustomerPlan;
    revision: number;
    review: TrialReview | null;
    activationKey?: string | null;
  };
  trialProtectionReady?: boolean;
  legacyCheckout?: boolean;
};
export type TrialReview = {
  taxMode?: import('./billing-tax.js').BillingTaxMode;
  limits?: CustomerAllowance;
  policyVersion?:string;
  locationDigest?:string;
  tax?:'exclusive';
  version: 1;
  setupId: string;
  revision: number;
  plan: CustomerPlan;
  priceMinor: number;
  currency: 'USD';
  trialDays: 14;
  firstChargeAt: string;
  expiresAt: string;
  hash: string;
};
