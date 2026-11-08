export const rehearsalAudiences = ['test', 'confirmed'] as const;
export type RehearsalAudience = (typeof rehearsalAudiences)[number];
export const rehearsalTransports = ['capture', 'provider_test'] as const;
export type RehearsalTransport = (typeof rehearsalTransports)[number];
export type RecipientOutcome = {
  id: string;
  state:
    'pending' | 'submitting' | 'uncertain' | 'accepted' | 'rejected' | 'excluded' | 'cancelled' | 'captured';
  reason: string | null;
  attempts: number;
};
export type PlanId = 'starter' | 'growth' | 'pro';
export type WorkspaceAccess = {
  status: 'preparation' | 'complimentary';
  plan: PlanId | null;
  revision: number;
  effectiveAt: string | null;
};
export type Usage = {
  period: string;
  campaigns: number;
  messages: number;
  reservedCampaigns: number;
  reservedMessages: number;
};
export type Rehearsal = {
  id: string;
  campaignId: string;
  version: number;
  audience: RehearsalAudience;
  transport: RehearsalTransport;
  segment?: { id: string; name: string };
  state: 'reviewed' | 'queued' | 'completed' | 'cancelled' | 'blocked';
  dueAt: string;
  selected: number;
  excluded: number;
  pending: number;
  captured: number;
  submitting: number;
  uncertain: number;
  accepted: number;
  rejected: number;
  skipped: number;
  reason: string | null;
};
export const practiceMailbox = 'reader@campaign.test';
export const maxPracticeRecipients = 25;
