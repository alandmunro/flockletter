import { z } from 'zod';
import { commandDefinition } from './command-definition.js';
const operationKey = z.uuid(),
  id = z.uuid(),
  expectedVersion = z.number().int().positive();
export const customerRetentionCommands = {
  'retention.status': commandDefinition(
    'Read this workspace’s verified service end and retention cases.',
    'owner',
    false,
    {},
  ),
  'retention.inspect': commandDefinition(
    'Reconcile service-end eligibility and inventory the workspace for retention.',
    'owner',
    true,
    { operationKey },
  ),
  'retention.hold': commandDefinition('Hold a retention case for human review.', 'owner', true, {
    operationKey,
    id,
    expectedVersion,
    reason: z.string().trim().min(1).max(500),
  }),
  'retention.release': commandDefinition(
    'Release a requested hold and recheck the current service end.',
    'owner',
    true,
    { operationKey, id, expectedVersion },
  ),
  'retention.request': commandDefinition(
    'Request a separately authorized retention executor for a due case.',
    'owner',
    true,
    { operationKey, id, expectedVersion, inventoryDigest: z.string().regex(/^[a-f0-9]{64}$/) },
  ),
  'retention.exercise': commandDefinition(
    'Capture the retention executor outcome for an exercise case without deleting account data.',
    'owner',
    true,
    { operationKey, id, expectedVersion },
  ),
} as const;
export type ServiceEnd = {
  source: 'stripe' | 'exercise' | 'complimentary';
  status: string;
  effectiveEnd: string | null;
  version: string;
};
export type RetentionCase = {
  id: string;
  source: ServiceEnd['source'];
  sourceVersion: string;
  effectiveEnd: string;
  dueAt: string;
  state: 'retained' | 'due' | 'held' | 'awaiting_operator' | 'captured' | 'cancelled';
  version: number;
  holdReason: string | null;
  inventory: Record<string, number>;
  inventoryDigest: string | null;
  updatedAt: string;
};
export type RetentionJob = {
  id: string;
  caseId: string;
  state: string;
  manifestDigest: string;
  createdAt: string;
  result: { captured: boolean; deletedRows: number; reason: string } | null;
};
export type RetentionStatus = {
  mode: 'off' | 'capture' | 'live';
  service: ServiceEnd;
  cases: RetentionCase[];
  jobs: RetentionJob[];
  purgeEnabled: false;
  retentionDays: 90;
};
