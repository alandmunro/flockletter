import { signupDesign, type SignupDesign } from './signup-design.js';
import { z } from 'zod';
import { commandDefinition } from './command-definition.js';
import { importPreviewInput } from './import-preview.js';
import { normalizedEmail } from './subscriber.js';

const brandId = z.uuid().toLowerCase();
const operationKey = z.uuid();
export const audiencePolicyInput = {
  brandId,
  operationKey,
  enabled: z.boolean(),
  purpose: z.string().trim().min(3).max(120),
  policyVersion: z.string().trim().min(1).max(80),
  consentText: z.string().trim().min(20).max(2000),
  sourceDomain: z
    .string()
    .trim()
    .min(3)
    .max(253)
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
  confirmationMode: z.enum(['double_opt_in', 'single_opt_in']).optional(),
};
export const customerAudienceCommands = {
  'audienceOnboarding.saveDesign': commandDefinition('Publish the selected brand’s subscriber page design.', 'owner', true, { brandId, operationKey, expectedRevision: z.number().int().nonnegative(), design: signupDesign }),
  'audienceOnboarding.status': commandDefinition(
    'Read brand signup settings, captured confirmations and verified transport receipts.',
    'owner',
    false,
    { brandId },
  ),
  'audienceOnboarding.configure': commandDefinition(
    'Configure brand consent wording and email-confirmation choice. Owner session required.',
    'owner',
    true,
    audiencePolicyInput,
  ),
  'audienceOnboarding.import': commandDefinition(
    'Import contacts with permission. Immediate subscription additionally requires audience:confirm and the current consent policy. Existing suppression is preserved.',
    'audience:write',
    true,
    {
      ...importPreviewInput.shape,
      operationKey,
      permissionAffirmed: z.literal(true),
      source: z.string().trim().min(3).max(250),
      confirmWithoutEmail: z.boolean().optional(),
      consentPolicyVersion: z.string().trim().min(1).max(80).optional(),
    },
  ),
  'audienceOnboarding.confirmContacts': commandDefinition(
    'Subscribe up to 250 selected pending contacts without email verification, recording existing permission and current policy. Requires audience:confirm. Suppressed contacts cannot be reactivated.',
    'audience:confirm', true,
    { brandId, operationKey, subscriberIds: z.array(z.uuid()).min(1).max(250).refine(ids => new Set(ids).size === ids.length, 'Choose each contact once.'),
      permissionAffirmed: z.literal(true), source: z.string().trim().min(3).max(250), policyVersion: z.string().trim().min(1).max(80) },
  ),
  'audienceOnboarding.signup': commandDefinition(
    'Exercise a brand signup with the currently configured consent text.',
    'owner',
    true,
    {
      brandId,
      operationKey,
      email: normalizedEmail,
      consentAffirmed: z.literal(true),
      policyVersion: z.string().min(1).max(80),
    },
  ),
  'audienceOnboarding.confirmation': commandDefinition(
    'Read one captured confirmation message in exercise mode.',
    'owner',
    false,
    { brandId, id: z.uuid() },
  ),
  'audienceOnboarding.importResult': commandDefinition(
    'Recover the durable results of an earlier authorized CSV import.',
    'audience:write',
    false,
    { brandId, id: z.uuid() },
  ),
  'audienceOnboarding.exerciseConfirm': commandDefinition(
    'Redeem a captured confirmation as an explicitly recorded exercise.',
    'owner',
    true,
    { brandId, id: z.uuid(), operationKey },
  ),
  'audienceOnboarding.requestConfirmation': commandDefinition(
    'Queue a new confirmation for a pending imported contact.',
    'audience:write',
    true,
    { brandId, subscriberId: z.uuid(), operationKey },
  ),
} as const;

export type AudienceSettingsView = {
  brandId: string;
  brandName: string;
  design?: SignupDesign;
  designRevision?: number;
  mode: 'exercise' | 'live' | 'off';
  enabled: boolean;
  purpose: string;
  policyVersion: string;
  consentText: string;
  sourceDomain: string;
  confirmationMode: 'double_opt_in' | 'single_opt_in';
  publicUrl: string | null;
  trackingEnabled: false;
  messages: { id: string; email: string; state: string; mode: string; createdAt: string; transport?: {kind: 'accepted'|'delivered'|'hard_bounce'|'complaint'|'failed'|'delayed'; occurredAt: string}|null }[];
  imports: { id: string; source: string; createdAt: string; rows: number }[];
};
