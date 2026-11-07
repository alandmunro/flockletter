import { z } from 'zod';

export const consentPolicy = {
  purpose: 'ffa_product_marketing',
  version: 'ffa-newsletter-v1',
  text: 'Email me product launches, promotions, and occasional updates from Frosty Flamingo Apparel. I can unsubscribe anytime.',
  sources: ['storefront-footer', 'storefront-homepage'],
} as const;

export const intakeKey = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const normalizedEmail = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .refine((value) => {
    const local = value.slice(0, value.lastIndexOf('@'));
    return local.length <= 64 && /^[\x21-\x7e]+$/.test(value);
  })
  .transform((value) => {
    const at = value.lastIndexOf('@');
    return value.slice(0, at) + '@' + value.slice(at + 1).toLowerCase();
  });
export const signupInput = z
  .object({
    email: normalizedEmail,
    purpose: z.literal(consentPolicy.purpose),
    consentAffirmed: z.literal(true),
    consentVersion: z.literal(consentPolicy.version),
    consentText: z.literal(consentPolicy.text),
    source: z.enum(consentPolicy.sources),
    sourceDomain: z.string().min(1).max(253),
  })
  .strict();
export type SignupInput = z.infer<typeof signupInput>;
export const signupAccepted = {
  status: 'pending_confirmation',
  message: 'If this address can be subscribed, check your inbox for a confirmation email.',
} as const;
export type IntakeStatus = {
  enabled: boolean;
  ready: boolean;
  mode: 'off' | 'capture' | 'live';
  sourceDomain: string | null;
  counts: {
    pending: number;
    confirmed: number;
    queued: number;
    failed: number;
    unknown: number;
    accepted: number;
    replays: number;
    throttled: number;
    rejected: number;
    captured: number;
    delivered: number;
  };
};
