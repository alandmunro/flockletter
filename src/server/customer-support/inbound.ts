import { createHash, createHmac } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { z } from 'zod';
import { AppError, requireCondition } from '../errors.js';
import { boundedJson } from './writer.js';

const email = z.email().max(254);
const plain = (value: string) => !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\r\t]/g, ''));
export const supportDigest = (value: string) => createHash('sha256').update(value).digest('hex');
export function mailbox(value: string) {
  const match = value.match(/^(?:[^<>\r\n]{1,160}\s*)?<([^<>]+)>$/);
  return email.parse(match?.[1] ?? value).toLowerCase();
}
export type UnassignedSupportEmail = {
  providerEmailId: string; eventId: string; digest: string; recipient: string;
  from: string; subject: string; text: string; autoSubmitted: boolean;
  authentication: 'pass' | 'unverified'; attachmentCount: number;
};
export type NativeSupportOptions = {
  webhookSecret: string;
  apiKey: string;
  /** Exact, operator-owned address mappings. Email From never selects a workspace. */
  bindings?: { address: string; workspaceId: string }[];
  platformAddress?: string;
  replyDomain?: string;
  threadSecret?: string;
  onUnassigned?: (email: UnassignedSupportEmail) => Promise<{ id: string | null }>;
  send?: typeof fetch;
};
export type NativeRoute = {
  workspaceId: string; ticketId: string | null; participantDigest?: string;
};
export type NativeMessage = UnassignedSupportEmail & { messageId: string; route: NativeRoute; receiptDigest: string };
export type NativeSupportPorts = {
  resolve(tokenHash: string): Promise<NativeRoute | null>;
  reserve(route: NativeRoute, providerId: string, eventId: string, digest: string): Promise<{id:string|null}|null>;
  quarantine(route: NativeRoute, providerId: string): Promise<void>;
  ingest(message: NativeMessage): Promise<{ id: string | null }>;
};
const eventSchema = z.object({
  type: z.literal('email.received'), created_at: z.string().min(1).max(80),
  data: z.object({ email_id: z.uuid(), from: z.string().max(420), to: z.array(z.string().max(420)).min(1).max(5),
    subject: z.string().max(160), message_id: z.string().min(3).max(254) }),
});
const receivedSchema = z.object({
  id: z.uuid(), from: z.string().max(420), to: z.array(z.string().max(420)).min(1).max(5),
  subject: z.string().max(160), text: z.string().max(8000).nullable(),
  message_id: z.string().min(3).max(254), headers: z.record(z.string().max(160), z.string().max(4000)),
  authentication: z.object({ dmarc: z.string().max(40).nullable().optional() }).nullable().optional(),
  attachments: z.array(z.unknown()).max(100).default([]),
});
/** Native metadata is signed; content is retrieved only from the fixed Resend receiving API. */
export class ResendSupportInbox {
  constructor(readonly options: NativeSupportOptions, readonly ports: NativeSupportPorts) {
    const bindings=z.array(z.object({address:email,workspaceId:z.string().min(1).max(200)}).strict()).max(1000).parse(options.bindings ?? []);
    const addresses=bindings.map(binding => mailbox(binding.address));
    if (new Set(addresses).size !== addresses.length || (options.platformAddress && addresses.includes(mailbox(options.platformAddress)))) throw Error('Support destinations must have one unambiguous server-owned route.');
    if (options.platformAddress) email.parse(options.platformAddress);
    if (!options.webhookSecret || !options.apiKey) throw Error('Configure dedicated inbound support credentials.');
    if (options.replyDomain && (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(options.replyDomain) ||
      !options.threadSecret || Buffer.byteLength(options.threadSecret) < 32)) throw Error('Configure a support reply domain and dedicated thread signing secret.');
  }
  async receive(body: Buffer, headers: Record<string, string>) {
    requireCondition(body.length <= 16384, 413, 'support_email_too_large', 'Support email exceeds the intake limit.');
    let raw: unknown;
    const eventId = headers['svix-id'] ?? '';
    requireCondition(eventId.length > 0 && eventId.length <= 200, 401, 'invalid_signature', 'Invalid support email signature.');
    try {
      raw = new Webhook(this.options.webhookSecret).verify(body, {
        'webhook-id': eventId, 'webhook-timestamp': headers['svix-timestamp'] ?? '',
        'webhook-signature': headers['svix-signature'] ?? '',
      });
    } catch { throw new AppError(401, 'invalid_signature', 'Invalid support email signature.'); }
    const event = eventSchema.parse(raw), metadata = event.data;
    requireCondition(!/[\p{Cc}\p{Cf}]/u.test(metadata.subject),422,'invalid_support_text','Use a printable single-line support subject.');
    const recipients = metadata.to.map(mailbox);
    requireCondition(recipients.length === 1, 422, 'support_destination_unbound', 'Use one configured support destination.');
    const recipient = recipients[0]!, sender = mailbox(metadata.from);
    let route: NativeRoute | null = null, global = false;
    const binding = this.options.bindings?.find((item) => item.address.toLowerCase() === recipient);
    if (binding) route = { workspaceId: binding.workspaceId, ticketId: null };
    else if (recipient === this.options.platformAddress?.toLowerCase()) global = true;
    else if (this.options.replyDomain && recipient.endsWith('@' + this.options.replyDomain)) {
      const local = recipient.slice(0, recipient.indexOf('@'));
      requireCondition(/^r\+[a-z0-9_-]{32}$/i.test(local), 422, 'support_destination_unbound', 'This reply address is unavailable.');
      // Tokens are case-sensitive; mail local parts must retain the original opaque token.
      const original = metadata.to[0]!.match(/(?:^|<)(r\+[A-Za-z0-9_-]{32})@/i)?.[1];
      requireCondition(original, 422, 'support_destination_unbound', 'This reply address is unavailable.');
      route = await this.ports.resolve(supportDigest(original.slice(2)));
    }
    requireCondition(global || route, 422, 'support_destination_unbound', 'This support destination is not configured.');
    const receiptDigest=supportDigest(JSON.stringify([metadata.email_id,recipients,sender,metadata.subject,metadata.message_id]));
    if (route) {
      const prior=await this.ports.reserve(route,metadata.email_id,eventId,receiptDigest);
      if (prior) return prior;
    }
    // Reject unknown destinations before issuing a provider request. Never fetch supplied URLs, HTML, raw MIME or attachments.
    let value: unknown;
    try {
      const response = await (this.options.send ?? fetch)('https://api.resend.com/emails/receiving/' + metadata.email_id + '?html_format=cid', {
        redirect: 'error', signal: AbortSignal.timeout(8000), headers: { authorization: 'Bearer ' + this.options.apiKey },
      });
      value = await boundedJson(response, 65536);
    } catch { throw new AppError(503, 'support_inbound_pending', 'The verified email is awaiting provider retrieval. Retry this event.'); }
    const received = receivedSchema.parse(value);
    requireCondition(received.id === metadata.email_id && mailbox(received.from) === sender &&
      JSON.stringify(received.to.map(mailbox)) === JSON.stringify(recipients) && received.subject === metadata.subject &&
      received.message_id === metadata.message_id && /^<[^<>\s\p{Cc}\p{Cf}]{1,250}>$/u.test(received.message_id) &&
      plain(received.subject) && plain(received.text ?? ''), 422, 'support_provider_mismatch', 'The retrieved email does not match its signed metadata.');
    const normalizedHeaders = Object.fromEntries(Object.entries(received.headers).map(([key,val]) => [key.toLowerCase(),val.toLowerCase()]));
    const autoSubmitted = Boolean((normalizedHeaders['auto-submitted'] && normalizedHeaders['auto-submitted'] !== 'no') ||
      /\b(bulk|list|junk)\b/.test(normalizedHeaders.precedence ?? '') || normalizedHeaders['x-auto-response-suppress'] ||
      /^(no-?reply|mailer-daemon|postmaster)@/i.test(sender));
    const authentication = received.authentication?.dmarc?.toLowerCase() === 'pass' ? 'pass' : 'unverified';
    const normalized = {
      providerEmailId: received.id, eventId,
      digest: supportDigest(JSON.stringify([received.id,recipient,sender,received.subject,received.text,received.message_id,autoSubmitted,authentication,received.attachments.length])),
      recipient, from: sender, subject: received.subject || '(No subject)', text: received.text?.trim() || '[No plain-text message; human review required.]',
      autoSubmitted, authentication, attachmentCount: received.attachments.length,
    } satisfies UnassignedSupportEmail;
    if (global) {
      requireCondition(this.options.onUnassigned, 503, 'support_triage_unavailable', 'The operator inbox is not configured.');
      return this.options.onUnassigned(normalized);
    }
    requireCondition(route, 422, 'support_destination_unbound', 'This support destination is unavailable.');
    if (route.ticketId && (authentication !== 'pass' || route.participantDigest !== this.participant(sender))) {
      requireCondition(this.options.onUnassigned, 503, 'support_triage_unavailable', 'The operator inbox is not configured.');
      // A guessed token or unauthenticated From never gains conversation authority.
      await this.options.onUnassigned(normalized);
      await this.ports.quarantine(route,received.id);
      return {id:null};
    }
    return this.ports.ingest({ ...normalized, messageId: received.message_id, route, receiptDigest });
  }
  participant(address: string) {
    requireCondition(this.options.threadSecret, 503, 'support_thread_unavailable', 'Support reply routing is not configured.');
    return createHmac('sha256', this.options.threadSecret).update('participant\0' + address.toLowerCase()).digest('hex');
  }
  token(workspace: string, ticket: string, participant: string, nonce: string) {
    requireCondition(this.options.threadSecret, 503, 'support_thread_unavailable', 'Support reply routing is not configured.');
    return createHmac('sha256', this.options.threadSecret).update(JSON.stringify(['reply',workspace,ticket,participant,nonce])).digest().subarray(0,24).toString('base64url');
  }
}
