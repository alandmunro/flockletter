import { z } from 'zod';
import { commandDefinition } from './command-definition.js';
import type { CustomerSenderProfile } from './customer-delivery.js';
const operationKey = z.uuid(),
  brandId = z.uuid(),
  id = z.uuid(),
  expectedVersion = z.number().int().positive();
export const customerInfrastructureCommands = {
  'infrastructure.status': commandDefinition(
    'Read this brand’s sender infrastructure plan and captured or verified resources.',
    'owner',
    false,
    { brandId },
  ),
  'infrastructure.review': commandDefinition(
    'Review a server-owned provisioning plan for the exact saved sender profile. No resources are created.',
    'owner',
    true,
    { operationKey, brandId, senderRevision: z.number().int().positive() },
  ),
  'infrastructure.approve': commandDefinition(
    'Approve the exact reviewed sender infrastructure plan for the configured provider.',
    'owner',
    true,
    { operationKey, brandId, id, expectedVersion, reviewDigest: z.string().regex(/^[a-f0-9]{64}$/) },
  ),
  'infrastructure.process': commandDefinition(
    'Process or reconcile an approved infrastructure job without repeating an unknown mutation.',
    'owner',
    true,
    { operationKey, brandId, id },
  ),
  'infrastructure.retry': commandDefinition(
    'Retry a safely held infrastructure job after its blocking cause is resolved.',
    'owner',
    true,
    { operationKey, brandId, id, expectedVersion },
  ),
  'infrastructure.cancel': commandDefinition(
    'Cancel future provisioning attempts while preserving known and uncertain resource evidence.',
    'owner',
    true,
    { operationKey, brandId, id, expectedVersion },
  ),
} as const;
export type InfrastructureState =
  | 'reviewed'
  | 'queued'
  | 'provisioning'
  | 'awaiting_dns'
  | 'verified'
  | 'captured'
  | 'held'
  | 'uncertain'
  | 'cancelled';
export type InfrastructureDns = {
  type: 'TXT' | 'CNAME' | 'MX';
  name: string;
  value: string;
  priority?: number;
};
export type InfrastructurePlan = {
  id: string;
  brandId: string;
  mode: 'capture' | 'aws';
  domain: string;
  fromEmail: string;
  senderRevision: number;
  state: InfrastructureState;
  version: number;
  reviewDigest: string;
  attempts: number;
  retryable: boolean;
  reason: string | null;
  captured: boolean;
  verified: boolean;
  dns: InfrastructureDns[];
  createdAt: string;
  updatedAt: string;
  resources: { tenant: string; configurationSet: string; identityArn: string; topicArn: string } | null;
};
export type InfrastructureStatus = {
  mode: 'off' | 'capture' | 'aws';
  profile: CustomerSenderProfile | null;
  eligible: boolean;
  plans: InfrastructurePlan[];
  providerConfigured: boolean;
  budgetApprovalRequired: boolean;
  externalChangesEnabled: boolean;
};
