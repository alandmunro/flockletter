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
};
export const customerAudienceCommands = {
  'audienceOnboarding.status': commandDefinition(
    'Read brand signup settings, captured confirmations and verified transport receipts.',
    'owner',
    false,
    { brandId },
  ),
  'audienceOnboarding.configure': commandDefinition(
    'Configure a brand signup form and its consent wording.',
    'owner',
    true,
    audiencePolicyInput,
  ),
  'audienceOnboarding.import': commandDefinition(
    'Import authorized contacts as pending without changing existing subscription choices.',
    'audience:write',
    true,
    {
      ...importPreviewInput.shape,
      operationKey,
      permissionAffirmed: z.literal(true),
      source: z.string().trim().min(3).max(250),
    },
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
  mode: 'exercise' | 'live' | 'off';
  enabled: boolean;
  purpose: string;
  policyVersion: string;
  consentText: string;
  sourceDomain: string;
  publicUrl: string | null;
  trackingEnabled: false;
  messages: { id: string; email: string; state: string; mode: string; createdAt: string; transport?: {kind: 'accepted'|'delivered'|'hard_bounce'|'complaint'|'failed'|'delayed'; occurredAt: string}|null }[];
  imports: { id: string; source: string; createdAt: string; rows: number }[];
};
