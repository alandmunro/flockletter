import { z } from 'zod';

export const subscriberStates = [
  'pending',
  'confirmed',
  'unsubscribed',
  'hard_bounced',
  'complained',
] as const;
export type SubscriberState = (typeof subscriberStates)[number];
export const stateLabel: Record<SubscriberState, string> = {
  pending: 'Pending confirmation',
  confirmed: 'Confirmed',
  unsubscribed: 'Unsubscribed',
  hard_bounced: 'Hard bounce',
  complained: 'Complaint',
};
export const stateFilter = z.enum(subscriberStates);
export type AudienceSummary = Record<SubscriberState, number> & { total: number };
export type AudienceContact = {
  id: string;
  email: string;
  state: SubscriberState;
  createdAt: string;
  confirmedAt: string | null;
};
export type ContactPage = { items: AudienceContact[]; nextCursor: string | null };
export type ConsentEvent = {
  id: string;
  event: 'signup_requested' | 'confirmed' | 'unsubscribed' | 'suppressed';
  purpose: string;
  policyVersion: string;
  source: string;
  sourceDomain: string;
  recordedAt: string;
};
export type ContactDetail = { contact: AudienceContact; events: ConsentEvent[]; nextCursor: string | null };
