import { z } from 'zod';
import { commandDefinition as descriptor } from './command-definition.js';
import { usAreaCodeZones } from './us-area-codes.js';
import { textingOnboardingCommands } from './texting-onboarding.js';

// ---------- Operator settings catalogue (FL-SMS-013, ADM-1–6) ----------
// Bounds live here; values live only in the database. `required` settings fail closed while unset.
type SettingSpec =
  | { kind: 'int'; min: number; max: number; required: 'sending' | 'test' | 'live' | 'always' | 'optional'; description: string }
  | { kind: 'words'; mustInclude: readonly string[]; required: 'always'; description: string }
  | { kind: 'phones'; maxItems: number; required: 'live'; description: string };
export const textingSettings = {
  send_window_start_hour: { kind: 'int', min: 8, max: 20, required: 'sending', description: 'Earliest local hour a text may be sent in the recipient’s time zone (never before 8).' },
  send_window_end_hour: { kind: 'int', min: 9, max: 21, required: 'sending', description: 'Hour by which sending stops in the recipient’s time zone (never after 21).' },
  contact_monthly_limit: { kind: 'int', min: 1, max: 31, required: 'sending', description: 'Marketing texts per contact per calendar month per workspace.' },
  carrier_daily_limit: { kind: 'int', min: 1, max: 2_000_000, required: 'sending', description: 'Texts per day per workspace, from the carrier registration tier.' },
  monthly_segment_allowance: { kind: 'int', min: 0, max: 10_000_000, required: 'sending', description: 'Segments per calendar month per workspace. Sending stops when used.' },
  test_texts_per_day: { kind: 'int', min: 1, max: 10, required: 'test', description: 'Test texts per workspace per UTC day.' },
  member_code_minutes: { kind: 'int', min: 5, max: 30, required: 'test', description: 'Minutes a member phone verification code stays valid.' },
  member_code_attempts: { kind: 'int', min: 1, max: 10, required: 'test', description: 'Wrong codes allowed before a new code is needed.' },
  link_life_days: { kind: 'int', min: 1, max: 365, required: 'sending', description: 'Days a short link keeps redirecting.' },
  unconfirmed_expiry_days: { kind: 'int', min: 1, max: 30, required: 'always', description: 'Days a pending SMS confirmation waits for YES.' },
  consecutive_failure_limit: { kind: 'int', min: 1, max: 10, required: 'always', description: 'Consecutive temporary failures that mark a number not textable.' },
  short_name_change_days: { kind: 'int', min: 0, max: 365, required: 'always', description: 'Days between short-name changes.' },
  short_name_hold_days: { kind: 'int', min: 0, max: 730, required: 'always', description: 'Days a released short name stays reserved.' },
  opt_out_words: { kind: 'words', mustInclude: ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'], required: 'always', description: 'Replies treated as opt-out.' },
  help_words: { kind: 'words', mustInclude: ['HELP'], required: 'always', description: 'Replies answered with the HELP text.' },
  start_words: { kind: 'words', mustInclude: ['START'], required: 'always', description: 'Replies that re-enroll an opted-out contact.' },
  confirm_words: { kind: 'words', mustInclude: ['YES'], required: 'always', description: 'Replies that confirm a pending number.' },
  registration_poll_minutes: { kind: 'int', min: 5, max: 1440, required: 'optional', description: 'Minutes between registration status polls when no callback arrives. Unset: callbacks and operator checks only.' },
  reconcile_settle_minutes: { kind: 'int', min: 1, max: 1440, required: 'optional', description: 'Minutes an uncertain provider call must stay unfound before it may be retried. Unset: it stays uncertain for operator review.' },
  probation_canary_count: { kind: 'int', min: 1, max: 100, required: 'optional', description: 'Size of the first broadcast test group during probation.' },
  probation_canary_minutes: { kind: 'int', min: 1, max: 1440, required: 'optional', description: 'Minutes to observe the first broadcast group before releasing the rest.' },
  probation_min_days: { kind: 'int', min: 1, max: 365, required: 'optional', description: 'Minimum days after registration before probation can end.' },
  probation_delivered_min: { kind: 'int', min: 1, max: 100000, required: 'optional', description: 'Minimum delivered broadcasts needed before probation can end.' },
  probation_initial_days: { kind: 'int', min: 1, max: 365, required: 'optional', description: 'Days that use the initial daily limit during probation.' },
  probation_initial_daily_limit: { kind: 'int', min: 1, max: 10000, required: 'optional', description: 'Daily broadcast limit during initial probation.' },
  probation_daily_limit: { kind: 'int', min: 1, max: 10000, required: 'optional', description: 'Daily broadcast limit after initial probation.' },
  live_recipient_allow_list: { kind: 'phones', maxItems: 10, required: 'live', description: 'Phase 2 live mode: the only numbers that may receive a real text (D-063).' },
} as const satisfies Record<string, SettingSpec>;
export type TextingSettingKey = keyof typeof textingSettings;
export const textingSettingKeys = Object.keys(textingSettings) as TextingSettingKey[];
export const isTextingSetting = (key: string): key is TextingSettingKey => Object.hasOwn(textingSettings, key);

const word = z.string().trim().toUpperCase().regex(/^[\p{L}\p{N}]{1,20}$/u);
/** Validates a proposed value against its hard bounds. `null` clears the value. */
export function textingSettingValue(key: TextingSettingKey, value: unknown): number | string[] | null {
  if (value === null) return null;
  const spec: SettingSpec = textingSettings[key];
  if (spec.kind === 'int') return z.number().int().min(spec.min).max(spec.max).parse(value);
  if (spec.kind === 'phones') return z.array(z.string().transform((v, ctx) => {
    const phone = normalizeUsPhone(v); if (!phone) ctx.addIssue({ code: 'custom', message: 'Use valid US numbers.' }); return phone ?? '';
  })).max(spec.maxItems).refine(list => new Set(list).size === list.length, 'List each number once.').parse(value);
  const words = z.array(word).min(spec.mustInclude.length).max(30).refine(list => new Set(list).size === list.length, 'List each word once.').parse(value);
  const missing = spec.mustInclude.filter(required => !words.includes(required));
  if (missing.length) throw new z.ZodError([{ code: 'custom', path: [], message: 'The list must keep ' + missing.join(', ') + '.', input: value }]);
  return words;
}

// ---------- Phone numbers (FL-SMS-011, NUM-1) ----------
/** Returns +1NXXNXXXXXX for a number in the 50 states or DC, else null. */
export function normalizeUsPhone(raw: string): string | null {
  if (raw.length > 32 || /[^\d\s()+.-]/.test(raw)) return null;
  let digits = raw.replace(/\D/g, '');
  if (raw.trim().startsWith('+') && !digits.startsWith('1')) return null;
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  if (/^\d11$/.test(digits.slice(3, 6))) return null; // N11 service codes are not subscriber numbers
  if (!usAreaCodeZones[digits.slice(0, 3)]) return null;
  return '+1' + digits;
}
export const usPhone = z.string().transform((value, ctx) => {
  const phone = normalizeUsPhone(value);
  if (!phone) { ctx.addIssue({ code: 'custom', message: 'Enter a valid US mobile number.' }); return z.NEVER; }
  return phone;
});
export function areaCodeZones(e164: string): readonly string[] { return usAreaCodeZones[e164.slice(2, 5)] ?? []; }

// ---------- Text encoding (FL-SMS-008, MSG-2) ----------
const gsmBasic = new Set([...'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà']);
const gsmExtended = new Set([...'^{}\\[~]|€\f']);
const replacements: [RegExp, string][] = [[/[\u2018\u2019\u201A\u201B\u2032]/g, "'"], [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  [/[\u2010-\u2015\u2212]/g, '-'], [/\u2026/g, '...'], [/[\u00A0\u2007\u202F]/g, ' ']];
// Emoji, pictographs, dingbats and other decorative symbols, plus joiners and variation selectors.
const blocked = /[\p{Extended_Pictographic}\p{So}\p{Co}]|\u200D|\uFE0E|\uFE0F|\u20E3|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}]/u;
export type EncodedText = { text: string; encoding: 'gsm7' | 'ucs2'; units: number; segments: number; perSegment: number };
export function plainText(raw: string): string {
  let text = raw.normalize('NFC');
  for (const [pattern, value] of replacements) text = text.replace(pattern, value);
  return text;
}
export function blockedCharacters(text: string): string[] {
  return [...new Set([...text].filter(char => blocked.test(char) || /[\p{Cc}]/u.test(char) && !'\n\r'.includes(char)))];
}
export function encodeText(raw: string): EncodedText {
  const text = plainText(raw);
  const chars = [...text];
  if (chars.every(char => gsmBasic.has(char) || gsmExtended.has(char))) {
    const units = chars.reduce((n, char) => n + (gsmExtended.has(char) ? 2 : 1), 0);
    if (units <= 160) return { text, encoding: 'gsm7', units, segments: 1, perSegment: 160 };
    let segments = 1, used = 0;
    for (const char of chars) { const size = gsmExtended.has(char) ? 2 : 1; if (used + size > 153) { segments++; used = 0; } used += size; }
    return { text, encoding: 'gsm7', units, segments, perSegment: 153 };
  }
  const units = text.length; // UTF-16 code units; a surrogate pair is never split
  if (units <= 70) return { text, encoding: 'ucs2', units, segments: 1, perSegment: 70 };
  let segments = 1, used = 0;
  for (const char of chars) { if (used + char.length > 67) { segments++; used = 0; } used += char.length; }
  return { text, encoding: 'ucs2', units, segments, perSegment: 67 };
}
export const maxSegments = 10;

// Merge fields: {{name}} or {{name|fallback}} (MSG-4).
const mergeField = /\{\{\s*name\s*(?:\|([^{}]{0,40}))?\}\}/g;
export function mergeText(template: string, contact: { name: string | null }): string {
  return template.replace(mergeField, (_match, fallback?: string) => contact.name?.trim() || fallback?.trim() || '');
}
export const optOutFooter = 'Reply STOP to opt out.';
/** MSG-3: every broadcast names the business and carries opt-out instructions. */
export function composeBroadcast(template: string, businessName: string, contact: { name: string | null }): string {
  return formatBroadcast(mergeText(template, contact), businessName);
}
export function formatBroadcast(text: string, businessName: string): string {
  let body = plainText(text).trim();
  const sender = plainText(businessName);
  if (!body.toLowerCase().startsWith(sender.toLowerCase())) body = sender + ': ' + body;
  if (!/\bstop\b/i.test(body)) body += ' ' + optOutFooter;
  return body;
}
const urlPattern = /\bhttps?:\/\/[^\s<>"']+/gi;
export function findLinks(text: string): string[] { return [...text.matchAll(urlPattern)].map(match => match[0].replace(/[.,;:!?)]+$/, '')); }

// ---------- Customer commands (served by the one command layer: UI, HTTP API and MCP) ----------
const id = z.uuid();
const key = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'Use a stable operation key of 16–128 letters, digits, dashes or underscores.');
const body = z.string().min(1).max(1600);
export const shortName = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/, 'Use 3–30 lowercase letters, digits or dashes.');
export const textingCommands = {
  ...textingOnboardingCommands,
  'sms.status': descriptor('Read texting setup for this workspace: registration state and number per company, allowance use and the settings still needed before sending. Never returns provider credentials.', 'read', false, {}),
  'sms.configure': descriptor('Set the workspace short name, notification email, time zone, the optional sign-up fields (name, phone, birthday, anniversary) and whether people may sign up for texts without an email.', 'owner', true, {
    operationKey: key, expectedRevision: z.number().int().positive(), shortName: shortName.optional(), notificationEmail: z.email().max(254).nullable().optional(),
    timeZone: z.string().max(64).optional(), phoneField: z.boolean().optional(), birthdayField: z.boolean().optional(), anniversaryField: z.boolean().optional(),
    anniversaryLabel: z.string().trim().min(1).max(40).optional(), nameField: z.boolean().optional(), phoneOnlySignup: z.boolean().optional() }),
  'sms.contacts': descriptor('List text contacts with their consent state per company, including numbers that are not textable.', 'owner', false, {
    filter: z.enum(['all', 'not_textable', 'opted_out', 'pending']).default('all'), cursor: id.optional(), limit: z.number().int().min(1).max(100).default(50) }),
  'sms.addContact': descriptor('Add or re-add a contact phone without consent. Imports never carry SMS consent. Re-adding an opted-out contact requires acknowledging that no text goes out until they text START.', 'owner', true, {
    operationKey: key, companyId: id, phone: usPhone, name: z.string().trim().max(100).optional(), acknowledgeOptOut: z.boolean().default(false) }),
  'sms.inbound': descriptor('Read recent inbound texts for this workspace.', 'owner', false, { cursor: id.optional(), limit: z.number().int().min(1).max(100).default(50) }),
  'sms.draft': descriptor('Create or update a text draft for one company. Emoji and decorative symbols are rejected; curly quotes and long dashes are converted.', 'draft:write', true, {
    operationKey: key, companyId: id, body, id: id.optional(), expectedRevision: z.number().int().positive().optional() }),
  'sms.preview': descriptor('Show the plain text, encoding and segment count per recipient for a draft, plus link checks. Does not send.', 'read', false, { id }),
  'sms.verifyPhone': descriptor('Send a verification code to your own phone so it can receive test texts.', 'sms:send', true, { operationKey: key, phone: usPhone }),
  'sms.confirmPhone': descriptor('Confirm your phone with the code you received.', 'sms:send', true, { operationKey: key, code: z.string().regex(/^\d{6}$/) }),
  'sms.testSend': descriptor('Send the exact draft to your own verified phone, within the daily test limit.', 'sms:send', true, { operationKey: key, id, expectedRevision: z.number().int().positive() }),
  'sms.review': descriptor('Freeze the recipients and show the count, segments, allowance use and days needed. Nothing sends until sms.confirm with the returned digest.', 'sms:send', false, { id, expectedRevision: z.number().int().positive() }),
  'sms.confirm': descriptor('Send or schedule the exact reviewed text. Requires the digest from sms.review.', 'sms:send', true, {
    operationKey: key, id, expectedRevision: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/), scheduledAt: z.iso.datetime({ offset: true }).optional() }),
  'sms.pause': descriptor('Pause a running or scheduled send. Texts already handed to the carrier are not recalled.', 'sms:send', true, { operationKey: key, id }),
  'sms.resume': descriptor('Resume a paused send.', 'sms:send', true, { operationKey: key, id }),
  'sms.cancel': descriptor('Cancel a send. Texts not yet handed to the carrier are not sent.', 'sms:send', true, { operationKey: key, id }),
  'sms.sendStatus': descriptor('Read counts by state for one send, and the reasons texts were skipped.', 'read', false, { id }),
} as const;
export type TextingCommand = keyof typeof textingCommands;

export const registrationStates = ['draft', 'provisioning', 'brand_pending', 'campaign_pending', 'approved', 'rejected', 'suspended'] as const;
export type RegistrationState = typeof registrationStates[number];
export const registrationSteps = ['subaccount', 'customer_profile', 'brand', 'messaging_service', 'campaign', 'number'] as const;
export type RegistrationStep = typeof registrationSteps[number];
export const consentStates = ['none', 'pending_confirmation', 'opted_in', 'opted_out', 'pending_reenrollment'] as const;
export type ConsentState = typeof consentStates[number];
/** The exact SMS checkbox wording recorded as consent evidence (CON-2). */
export const smsConsentWording = (business: string, perMonth: number, stayTexts = false) =>
  `Yes, text me offers${stayTexts ? ', updates and info about my stays' : ' and updates'} from ${business}. Up to ${perMonth} msgs/month. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase.`;
export const smsConsentPolicyVersion = (stayTexts = false) => stayTexts ? 'sms-consent-stay-v1' : 'sms-consent-v1';
/** Twilio A2P campaign use cases Flockletter files. MARKETING is the default; LOW_VOLUME is Low Volume Mixed. */
export const campaignUseCases = ['MARKETING', 'LOW_VOLUME'] as const;
export type CampaignUseCase = typeof campaignUseCases[number];
export const confirmationText = (business: string) => `${business}: Reply YES to confirm you want texts from us. Msg & data rates may apply. Reply STOP to opt out.`;
export const helpText = (business: string, contact: string) => `${business}: For help contact ${contact}. Reply STOP to opt out.`;
