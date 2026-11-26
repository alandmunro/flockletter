import { z } from 'zod';
import { textPlanId } from './texting-commercial.js';
import { twilioBusinessTypes, twilioIndustries } from './texting-business.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const https = z.url({ protocol: /^https$/ }).max(300).refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return !url.username && !url.password && !url.port && url.hostname.includes('.');
}, 'Use a public HTTPS address.');
const companyId = z.uuid();
const revision = z.number().int().min(1);
export const verificationChannel = z.enum(['email', 'phone', 'carrier']);
export type VerificationChannel = z.infer<typeof verificationChannel>;
const channel = verificationChannel;
const mutation = { operationKey: z.uuid(), companyId, expectedRevision: revision };

export const onboardingBusiness = z.strictObject({
  legalName: text(120),
  ein: z.union([z.string().trim().regex(/^\d{2}-?\d{7}$/), z.literal('')]),
  registrationType: z.enum(['ein', 'sole_proprietor']).optional(),
  dbaName: text(120).optional(),
  plan: textPlanId.optional(),
  hostedPages: z.boolean().optional(),
  publicContact: z.email().max(120).optional(),
  description: text(300).optional(),
  businessType: z.enum(twilioBusinessTypes),
  vertical: z.enum(twilioIndustries),
  website: z.union([https, z.literal('')]),
  privacyPolicyUrl: z.union([https, z.literal('')]),
  smsTermsUrl: z.union([https, z.literal('')]),
  street: text(120),
  city: text(60),
  region: z.string().trim().regex(/^[A-Z]{2}$/),
  postalCode: z.string().trim().regex(/^\d{5}$/),
  firstName: text(60),
  lastName: text(60),
  title: text(60),
  email: z.email().max(254),
  phone: z.string().trim().regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/),
}).superRefine((value, ctx) => {
  const issue = (field: string, message: string) => ctx.addIssue({ code: 'custom', path: [field], message });
  if (value.registrationType === 'sole_proprietor') {
    if (value.ein || value.dbaName || value.plan === 'text_2500') issue('registrationType', 'Use the EIN registration for DBAs and Standard plans.');
  } else if (!value.ein) issue('ein', 'Enter the EIN on the business registration.');
  if (value.hostedPages) {
    if (!value.publicContact || !value.description) issue('publicContact', 'Supply a public contact and business description to publish practice pages.');
  } else {
    for (const field of ['website', 'privacyPolicyUrl', 'smsTermsUrl'] as const) if (!value[field]) issue(field, 'Enter a public HTTPS URL.');
  }
});
export type OnboardingBusiness = z.infer<typeof onboardingBusiness>;

// An unfinished form accepts incomplete values. EINs, codes and publication consent are never draft fields.
export const enrollmentDraftFields = z.strictObject({
  legalName: z.string().max(120), dbaName: z.string().max(120), registrationType: z.enum(['ein','sole_proprietor']),
  plan: textPlanId, hostedPages: z.boolean(), publicContact: z.string().max(120), description: z.string().max(300),
  businessType: z.enum(twilioBusinessTypes), vertical: z.enum(twilioIndustries),
  website: z.string().max(300), privacyPolicyUrl: z.string().max(300), smsTermsUrl: z.string().max(300),
  street: z.string().max(120), city: z.string().max(60), region: z.string().max(2), postalCode: z.string().max(5),
  firstName: z.string().max(60), lastName: z.string().max(60), title: z.string().max(60),
  email: z.string().max(254), phone: z.string().max(24),
}).partial();
export type EnrollmentDraftFields = z.infer<typeof enrollmentDraftFields>;
export type DraftAccess = { id: string; key: string };

const define = <T extends z.ZodRawShape>(description: string, isMutation: boolean, shape: T) => ({
  description, scope: 'owner' as const, mutation: isMutation, schema: z.strictObject(shape),
});

const planAcceptance = { acceptedPlan: textPlanId.optional(), acceptedMonthlyUsdCents: z.number().int().nonnegative().optional() };

export const textingOnboardingCommands = {
  'sms.onboardingStatus': define('Read the current owner’s carrier enrollment and required next actions.', false, { companyId }),
  'sms.onboardingDraftAccess': define('Open private browser draft storage for this owner, company and enrollment revision.', true, {
    ...mutation, expectedRevision: revision.nullable(),
  }),
  'sms.onboardingSave': define('Save the accepted practice registration details and SMS policy revision.', true, {
    ...mutation, expectedRevision: revision.nullable(), business: onboardingBusiness, accepted: z.literal(true),
  }),
  'sms.onboardingChallenge': define('Request a practice verification code for this registration and channel.', true, { ...mutation, channel }),
  'sms.onboardingVerify': define('Check the code for the current business verification challenge.', true, {
    ...mutation, channel, code: z.string().regex(/^\d{6}$/),
  }),
  'sms.onboardingScan': define('Check the business website, signup and policy pages for this revision.', true, mutation),
  'sms.onboardingEvidence': define('Attach a synthetic ownership letter to a practice review.', true, { ...mutation, document: z.enum(['CP575', '147C']), contents: z.string().max(1024).optional() }),
  'sms.onboardingResume': define('Resume a paused practice sender after reviewing the cause.', true, { ...mutation, reason: text(300).min(12) }),
  'sms.onboardingPay': define('Exercise the setup payment in the isolated mock checkout.', true, {
    ...mutation, result: z.enum(['paid', 'declined', 'payer_mismatch']).default('paid'),
  }),
  'sms.onboardingFinish': define('Confirm a practice setup fee and submit the verified enrollment in one transaction.', true, { ...mutation, ...planAcceptance, acceptedFee: z.number().int().positive(), currency: z.literal('USD') }),
  'sms.onboardingSubmit': define('Submit the paid, verified enrollment to carrier registration.', true, { ...mutation, ...planAcceptance }),
} as const;
export type TextingOnboardingCommand = keyof typeof textingOnboardingCommands;

export type OnboardingView = {
  available: boolean;
  blocked: boolean;
  revision: number | null;
  business: OnboardingBusiness | null;
  draftId: string | null;
  signupReady: boolean | null;
  verified: Record<'email' | 'phone', boolean>;
  checkout: 'unpaid' | 'declined' | 'pending' | 'paid';
  checkoutMode: 'capture' | 'stripe_test';
  setupFee: { amount: number; currency: 'USD' };
  state: string;
  message: string | null;
  samples: string[];
  requiredChannels: VerificationChannel[];
  carrierVerified: boolean;
  pageCheck: { retryAt?: string; attempts?: number; checkedAt: string; signupUrl?: string | null; issues: { page: string; message: string }[] } | null;
  review: string | null;
  evidence: { document: 'CP575' | '147C'; attachedAt: string; fingerprint?: string; source?: 'template' | 'upload' } | null;
  evidenceFiles?: Partial<Record<'CP575' | '147C', string>>;
  publicPages: { website: string; privacyPolicyUrl: string; smsTermsUrl: string } | null;
  progress: { stage: string; stalled: boolean; since: string } | null;
  probation: string | null;
  notices: { at: string; message: string }[];
};
