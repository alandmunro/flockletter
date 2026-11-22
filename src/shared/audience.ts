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
/**
 * Text status of one person for the brand's company (FL-AUD-020). Email and text status are separate and never merged.
 * Consent belongs to the phone number, so a household sharing one phone shares this status.
 */
export const textStates = ['no_phone', 'phone_only', 'pending_confirmation', 'expired', 'opted_in', 'opted_out', 'pending_reenrollment', 'not_textable'] as const;
export type TextState = (typeof textStates)[number];
export const textStateLabel: Record<TextState, string> = {
  no_phone: 'No phone',
  phone_only: 'Phone on file, not subscribed',
  pending_confirmation: 'Waiting for YES',
  expired: 'YES request expired',
  opted_in: 'Subscribed',
  opted_out: 'Opted out (STOP)',
  pending_reenrollment: 'Needs START',
  not_textable: "Can't text",
};
export const notTextableLabel: Record<string, string> = {
  invalid: 'the number is not valid', landline: 'the carrier reports a landline',
  permanent_failure: 'texts to it failed permanently', repeated_failures: 'texts to it failed repeatedly',
};
export type SpecialDate = { month: number; day: number; year: number | null; label: string };
/** A person is an email subscriber (with an optional phone) or a phone-only text contact. */
export type AudienceContact = {
  id: string;
  kind: 'subscriber' | 'phone';
  /** Null for a phone-only contact. */
  email: string | null;
  state: SubscriberState | null;
  firstName: string | null;
  lastName: string | null;
  /** E.164, or null when no phone is on file. */
  phone: string | null;
  text: TextState;
  birthday: SpecialDate | null;
  anniversary: SpecialDate | null;
  createdAt: string;
  confirmedAt: string | null;
};
export const emailStateFilter = z.enum([...subscriberStates, 'no_email']);
export const textStateFilter = z.enum(textStates);
export const dateFilter = z.enum(['birthday', 'anniversary', 'any']);
export type PeopleSummary = {
  people: number;
  phoneOnly: number;
  text: Record<TextState, number>;
  birthdays: number;
  anniversaries: number;
  /** Birthdays and anniversaries falling in the current month of the workspace time zone. */
  thisMonth: number;
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
  evidenceSource?: string;
  recordedBy?: string;
};
export type TextConsentEvent = { id: string; event: string; source: string; recordedAt: string; wording: string | null };
export type ContactTexting = {
  companyName: string;
  /** The company's sending number, once one is active. */
  number: string | null;
  state: TextState;
  changedAt: string | null;
  pendingExpiresAt: string | null;
  notTextableReason: string | null;
  events: TextConsentEvent[];
};
export type ContactDetail = {
  contact: AudienceContact; events: ConsentEvent[]; nextCursor: string | null;
  practiceImport?: { row: number; recordedAt: string };
  /** Null when the brand has no company texting record or the person has no phone. */
  texting: ContactTexting | null;
  /** Other subscribers of this brand who share the phone. */
  sharedWith: string[];
  /** Workspace sign-up fields, so the page shows only what is in use. */
  fields: { birthday: boolean; anniversary: boolean; anniversaryLabel: string; name: boolean };
};
const name = z.string().trim().min(1).max(60).nullable().optional();
const monthDay = { month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) };
const validDay = (d: { month: number; day: number }) => d.day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][d.month - 1]!;
/** Owner edits. A missing field is unchanged; null clears it. Email and consent are never editable here. */
export const contactUpdate = {
  firstName: name, lastName: name,
  phone: z.string().trim().max(32).nullable().optional(),
  birthday: z.object(monthDay).strict().refine(validDay, 'Choose a real date.').nullable().optional(),
  anniversary: z.object({ ...monthDay, year: z.number().int().min(1900).max(2100).optional() }).strict().refine(validDay, 'Choose a real date.').nullable().optional(),
};
