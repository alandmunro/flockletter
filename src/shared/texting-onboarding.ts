import { z } from 'zod';
import { twilioBusinessTypes, twilioIndustries } from './texting-business.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const https = z.url({ protocol: /^https$/ }).max(300).refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && !url.port && url.hostname.includes('.');
}, 'Use a public HTTPS address.');
const companyId = z.uuid();
const revision = z.number().int().min(1);
const channel = z.enum(['email', 'phone']);
const mutation = { operationKey: z.uuid(), companyId, expectedRevision: revision };

export const onboardingBusiness = z.strictObject({
  legalName: text(120),
  ein: z.string().trim().regex(/^\d{2}-?\d{7}$/),
  businessType: z.enum(twilioBusinessTypes),
  vertical: z.enum(twilioIndustries),
  website: https,
  privacyPolicyUrl: https,
  smsTermsUrl: https,
  street: text(120),
  city: text(60),
  region: z.string().trim().regex(/^[A-Z]{2}$/),
  postalCode: z.string().trim().regex(/^\d{5}$/),
  firstName: text(60),
  lastName: text(60),
  title: text(60),
  email: z.email().max(254),
  phone: z.string().trim().regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/),
});
export type OnboardingBusiness = z.infer<typeof onboardingBusiness>;

const define = <T extends z.ZodRawShape>(description: string, isMutation: boolean, shape: T) => ({
  description, scope: 'owner' as const, mutation: isMutation, schema: z.strictObject(shape),
});

export const textingOnboardingCommands = {
  'sms.onboardingStatus': define('Read the current owner’s carrier enrollment and required next actions.', false, { companyId }),
  'sms.onboardingSave': define('Save and accept an EIN-based business and SMS policy snapshot.', true, {
    ...mutation, expectedRevision: revision.nullable(), business: onboardingBusiness, accepted: z.literal(true),
  }),
  'sms.onboardingChallenge': define('Start a business email or phone verification challenge.', true, { ...mutation, channel }),
  'sms.onboardingVerify': define('Check the code for the current business verification challenge.', true, {
    ...mutation, channel, code: z.string().regex(/^\d{6}$/),
  }),
  'sms.onboardingPay': define('Exercise the setup payment in the isolated mock checkout.', true, {
    ...mutation, result: z.enum(['paid', 'declined', 'payer_mismatch']).default('paid'),
  }),
  'sms.onboardingSubmit': define('Submit the paid, verified enrollment to carrier registration.', true, mutation),
} as const;
export type TextingOnboardingCommand = keyof typeof textingOnboardingCommands;

export type OnboardingView = {
  available: boolean;
  blocked: boolean;
  revision: number | null;
  business: OnboardingBusiness | null;
  verified: Record<'email' | 'phone', boolean>;
  checkout: 'unpaid' | 'declined' | 'pending' | 'paid';
  checkoutMode: 'capture' | 'stripe_test';
  setupFee: { amount: number; currency: 'USD' };
  state: string;
  message: string | null;
  samples: string[];
};
