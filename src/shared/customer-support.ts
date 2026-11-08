import { z } from 'zod';
import { commandDefinition } from './command-definition.js';
import { supportTopics } from './support-topics.js';

const operationKey = z.uuid();
const ticket = z.uuid();
const version = z.number().int().positive();
export const customerSupportCommands = {
  'support.list': commandDefinition('Read this workspace’s support conversations.', 'owner', false, {
    offset: z.number().int().min(0).max(10000).default(0),
  }),
  'support.get': commandDefinition('Read a support conversation and its reply history.', 'owner', false, {
    id: ticket,
  }),
  'support.create': commandDefinition(
    'Open a support conversation in the current workspace.',
    'owner',
    true,
    {
      operationKey,
      subject: z.string().trim().min(1).max(160),
      text: z.string().trim().min(1).max(8000),
      topic: z.enum(supportTopics),
      replyTo: z.email().max(254).optional(),
    },
  ),
  'support.draft': commandDefinition(
    'Prepare a reviewed reply using approved public guidance.',
    'owner',
    true,
    { operationKey, id: ticket, expectedVersion: version },
  ),
  'support.editDraft': commandDefinition('Save a human revision of the support reply.', 'owner', true, {
    operationKey,
    id: ticket,
    expectedVersion: version,
    text: z.string().trim().min(1).max(4000),
  }),
  'support.approve': commandDefinition(
    'Approve the exact saved support reply for the configured transport.',
    'owner',
    true,
    { operationKey, id: ticket, expectedVersion: version, reviewCode: z.string().regex(/^[a-f0-9]{64}$/) },
  ),
  'support.process': commandDefinition(
    'Submit or reconcile the support reply without duplicating an uncertain attempt.',
    'owner',
    true,
    { operationKey, id: ticket },
  ),
  'support.escalate': commandDefinition(
    'Ask a human operator to handle this support request.',
    'owner',
    true,
    { operationKey, id: ticket, expectedVersion: version, reason: z.string().trim().min(1).max(500) },
  ),
  'support.close': commandDefinition('Close a support conversation after review.', 'owner', true, {
    operationKey,
    id: ticket,
    expectedVersion: version,
  }),
} as const;
export type SupportState = 'open' | 'review' | 'escalated' | 'queued' | 'replied' | 'closed';
export type SupportMessage = {
  id: string;
  kind: 'incoming' | 'draft' | 'captured_reply' | 'sent_reply';
  text: string;
  createdAt: string;
  provenance: string;
};
export type SupportTicket = {
  id: string;
  subject: string;
  topic: (typeof supportTopics)[number];
  state: SupportState;
  version: number;
  replyTo: string | null;
  createdAt: string;
  updatedAt: string;
  draft: string | null;
  reviewCode: string | null;
  draftProvenance: 'approved_guidance' | 'ai_assisted' | 'human' | null;
  messages: SupportMessage[];
  delivery: { state: string; attempts: number; mode: 'capture' | 'live'; reason: string | null } | null;
};
export type SupportDirectory = {
  mode: 'off' | 'capture' | 'live';
  tickets: Omit<SupportTicket, 'messages'>[];
  total: number;
  offset: number;
  limit: number;
};
