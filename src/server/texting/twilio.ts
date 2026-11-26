import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CampaignUseCase, RegistrationStep } from '../../shared/texting.js';

/** The same four outcomes as email delivery. `unknown` is reconciled by lookup, never by a second POST. */
export type Outcome = 'accepted' | 'rejected' | 'not_submitted' | 'unknown';
export type Result<T> = { outcome: Outcome; value?: T; reason?: string; retryAfterSeconds?: number };
export type AccountCredentials = { accountSid: string; keySid: string; keySecret: string; authToken: string };
export type BusinessProfile = {
  legalName: string; dbaName: string | null; entityType: string; ein: string; website: string; vertical: string;
  /** Twilio's exact `business_type` and `company_type` strings (see shared/texting-business.ts). */
  businessType: string; companyType: string;
  address: { street: string; city: string; region: string; postalCode: string; country: 'US' };
  contact: { firstName: string; lastName: string; email: string; phone: string; title: string };
  notificationEmail: string;
};
export type CampaignInput = { useCase: CampaignUseCase; privacyPolicyUrl?: string; termsUrl?: string; description: string; messageFlow: string; samples: string[]; optInMessage: string; optOutMessage: string; helpMessage: string; hasLinks: boolean };
export type CallbackUrls = { inbound: string; status: string; registration: string };
export type ProvisionKind = Exclude<RegistrationStep, 'subaccount'> | 'subaccount';
export type ProvisionFacts = { sid: string; status?: string; e164?: string; parentSid?: string };
export type RegistrationTier = 'low_volume' | 'standard' | 'sole_proprietor';

/** Platform key only (operator registration). Every create carries the operation key as FriendlyName. */
export interface TwilioPlatformPort {
  readonly mode: 'mock' | 'live';
  createSubaccount(op: string, workspace?: string): Promise<Result<AccountCredentials>>;
  createCustomerProfile(account: AccountCredentials, op: string, profile: BusinessProfile, callback: string): Promise<Result<ProvisionFacts>>;
  submitBrand(account: AccountCredentials, op: string, profileSid: string, a2pSid: string, tier?: RegistrationTier): Promise<Result<ProvisionFacts>>;
  createMessagingService(account: AccountCredentials, op: string, callbacks: CallbackUrls): Promise<Result<ProvisionFacts>>;
  submitCampaign(account: AccountCredentials, op: string, serviceSid: string, brandSid: string, input: CampaignInput): Promise<Result<ProvisionFacts>>;
  /** Captured corrections update the original campaign. The live adapter does not offer this capability. */
  correctCampaign?(account: AccountCredentials, op: string, serviceSid: string, brandSid: string, campaignSid: string, input: CampaignInput): Promise<Result<ProvisionFacts>>;
  buyNumber(account: AccountCredentials, op: string, serviceSid: string, areaCode: string | null): Promise<Result<ProvisionFacts>>;
  /** Live numbers are attached by immutable SID after the purchase is recorded. */
  attachNumber?(account: AccountCredentials, serviceSid: string, numberSid: string, mockNotice?: 'omit'): Promise<Result<true>>;
  /** Staging only: reread the original captured carrier decision after its delivery was missed. */
  capturedNumberReceipt?(account: AccountCredentials, serviceSid: string, numberSid: string): Promise<{ url: string; body: string; signature: string } | null>;
  /** Reconciles an uncertain create. `accepted` means the resource exists. */
  find(kind: ProvisionKind, account: AccountCredentials | null, op: string, parentSid?: string, workspace?: string): Promise<Result<ProvisionFacts & { account?: AccountCredentials }>>;
  status(kind: 'brand' | 'campaign', account: AccountCredentials, sid: string, parentSid?: string): Promise<Result<{ status: string; reason?: string }>>;
}
export type SendResult = { outcome: Outcome; sid?: string; retryAfterSeconds?: number; permanent?: 'invalid' | 'landline' | 'unsubscribed'; reason?: string };
/** Per-workspace subaccount credentials only. */
export interface TwilioMessagingPort {
  readonly mode: 'mock' | 'live';
  send(account: AccountCredentials, m: { op: string; serviceSid: string; to: string; body: string; statusCallback: string }): Promise<SendResult>;
  lookup(account: AccountCredentials, m: { op: string; sid: string | null; to: string; sentAfter: Date; bodyDigest: string }): Promise<{ outcome: Outcome; sid?: string; status?: string }>;
}

/** X-Twilio-Signature: base64 HMAC-SHA1 over the full URL plus sorted name/value pairs, keyed by the owning account's auth token. */
export function twilioSignature(url: string, params: Record<string, string>, authToken: string) {
  const data = url + Object.keys(params).sort().map(name => name + params[name]).join('');
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}
export function verifyTwilioSignature(url: string, params: Record<string, string>, header: string, authToken: string) {
  if (!header || !authToken) return false;
  const expected = Buffer.from(twilioSignature(url, params, authToken)), given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
export const bodyDigest = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');

/** Status names that only move forward. An older or duplicate callback cannot move a record back. */
export const messageRank: Record<string, number> = { queued: 1, accepted: 1, scheduled: 1, sending: 2, sent: 3, delivered: 4, undelivered: 4, failed: 4, read: 4, canceled: 4 };
export const registrationRank: Record<string, number> = { PENDING: 1, IN_PROGRESS: 1, VERIFIED: 2, APPROVED: 2, FAILED: 2, SUSPENDED: 3 };

/**
 * Credentials sealed with AES-256-GCM. Mock mode uses a fixed, published key because its
 * credentials are fabricated; live mode refuses mock-sealed blobs and needs a key from Bitwarden.
 */
export class CredentialSeal {
  private constructor(private readonly key: Buffer, readonly keyId: 'mock' | 'live') {}
  static mock() { return new CredentialSeal(createHash('sha256').update('flockletter-texting-mock-only').digest(), 'mock'); }
  static live(hex: string | undefined) {
    if (!hex || !/^[a-f0-9]{64}$/i.test(hex)) throw Error('Live texting needs FLOCKLETTER_TEXTING_SEAL_KEY from Bitwarden.');
    return new CredentialSeal(Buffer.from(hex, 'hex'), 'live');
  }
  seal(value: AccountCredentials, workspace: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(this.keyId + ':' + workspace));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [this.keyId, iv.toString('base64'), data.toString('base64'), cipher.getAuthTag().toString('base64')].join('.');
  }
  open(sealed: string, workspace: string): AccountCredentials {
    const [keyId, iv, data, tag] = sealed.split('.');
    if (keyId !== this.keyId || !iv || !data || !tag) throw Error('Stored provider credentials were sealed for another mode.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(keyId + ':' + workspace)); decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')) as AccountCredentials;
  }
}
