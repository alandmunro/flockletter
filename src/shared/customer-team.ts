import { z } from 'zod';
import { commandDefinition } from './command-definition.js';
import { normalizedEmail } from './subscriber.js';
const operationKey = z.uuid();
const userId = z.string().min(1).max(180);
export const customerTeamCommands = {
  'teamLifecycle.status': commandDefinition(
    'Inspect verified team lifecycle state or the isolated exercise scenario.',
    'owner',
    false,
    {},
  ),
  'teamLifecycle.initializeExercise': commandDefinition(
    'Start an isolated team scenario without changing Clerk membership.',
    'owner',
    true,
    { operationKey },
  ),
  'teamLifecycle.invite': commandDefinition(
    'Invite a member with a durable intent and verified seat capacity.',
    'owner',
    true,
    { operationKey, email: normalizedEmail },
  ),
  'teamLifecycle.exerciseAccept': commandDefinition(
    'Accept a captured invitation inside the team scenario.',
    'owner',
    true,
    { operationKey, id: z.uuid() },
  ),
  'teamLifecycle.remove': commandDefinition(
    'Remove a member after current authority and last-owner checks.',
    'owner',
    true,
    { operationKey, userId },
  ),
  'teamLifecycle.transfer': commandDefinition(
    'Transfer ownership by verifying the new owner before demoting the issuer.',
    'owner',
    true,
    { operationKey, userId },
  ),
  'teamLifecycle.revokeInvite': commandDefinition('Revoke a pending invitation.', 'owner', true, {
    operationKey,
    id: z.string().min(1).max(180),
  }),
  'teamLifecycle.reconcile': commandDefinition(
    'Look up an existing team operation after an uncertain provider response.',
    'owner',
    true,
    { operationKey, id: z.uuid() },
  ),
} as const;
export type LifecycleMember = { userId: string; email: string; role: 'owner' | 'member' };
export type LifecycleInvitation = { id: string; email: string; state: string; reference?: string };
export type TeamLifecycleView = {
  mode: 'exercise' | 'clerk' | 'off';
  initialized: boolean;
  members: LifecycleMember[];
  invitations: LifecycleInvitation[];
  operations: { id: string; action: string; state: string }[];
  seatLimit: number | null;
};
