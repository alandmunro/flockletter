// The real Twilio adapter. Plain fetch, bounded bodies, zod on every response. Twilio has no idempotency
// keys, so each created resource carries the operation key in FriendlyName and an uncertain create is
// settled by listing, never by a second POST. Live calls run only in `live` mode after operator approval.
// NOTE: the TrustHub and A2P request shapes follow Twilio's ISV documentation and are first exercised
// against Twilio in FL-AT-045, which needs the owner's approval.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { boundedJson } from '../customer-support/writer.js';
import { bodyDigest } from './twilio.js';
import type { AccountCredentials, BusinessProfile, CallbackUrls, CampaignInput, Outcome, ProvisionFacts, ProvisionKind, Result, SendResult, TwilioMessagingPort, TwilioPlatformPort } from './twilio.js';

const api = 'https://api.twilio.com/2010-04-01', trusthub = 'https://trusthub.twilio.com/v1', messaging = 'https://messaging.twilio.com/v1';
export type TwilioPolicies = { secondaryProfile: string; a2pProfile: string; primaryProfileSid: string };
type Auth = { user: string; secret: string };
type Response1 = { status: number; json: unknown; retryAfter: number | null };
const sid = (prefix: string) => z.string().regex(new RegExp('^' + prefix + '[0-9a-f]{32}$'));
/**
 * Twilio caps FriendlyName at 64 characters on Addresses, Messaging Services and phone numbers, and refuses longer
 * ones with error 20400. Operation keys run past that (`sms-reg/<uuid>/<revision>/customer_profile/address` is 71),
 * so a longer name becomes a fixed digest of itself plus its last segment. It stays deterministic, so an uncertain
 * create is still settled by looking the same name up again.
 */
export function twilioName(name: string): string {
  if (name.length <= 64) return name;
  const tail = (name.split('/').pop() ?? '').slice(0, 24);
  return `fl/${createHash('sha256').update(name).digest('hex').slice(0, 32)}/${tail}`;
}
const errorBody = z.object({ code: z.number().int().optional(), message: z.string().optional() }).passthrough();

export function mapStatus(status: number, code?: number): Outcome {
  if (status === 429 || code === 20429) return 'not_submitted';
  if (status >= 500 || status === 408 || status === 409) return 'unknown';
  return 'rejected';
}
async function request(call: typeof fetch, auth: Auth, method: 'GET' | 'POST', url: string, form?: Record<string, string | string[]>): Promise<Response1> {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(form ?? {})) for (const v of Array.isArray(value) ? value : [value]) body.append(name, v);
  const response = await call(url, { method, redirect: 'error', signal: AbortSignal.timeout(10000), headers: {
    authorization: 'Basic ' + Buffer.from(auth.user + ':' + auth.secret).toString('base64'),
    ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, ...(method === 'POST' ? { body } : {}) });
  const retry = response.headers.get('retry-after');
  const json = await boundedJson(response, 512 * 1024, response.ok ? undefined : response.status).catch(() => null);
  return { status: response.status, json, retryAfter: retry && /^\d+$/.test(retry) ? Math.min(3600, Number(retry)) : null };
}
function failed<T>(r: Response1): Result<T> {
  const error = errorBody.safeParse(r.json);
  const code = error.success ? error.data.code : undefined;
  return { outcome: mapStatus(r.status, code), reason: code ? 'twilio_' + code : 'http_' + r.status, ...(r.retryAfter !== null ? { retryAfterSeconds: r.retryAfter } : {}) };
}

export class TwilioHttpPlatform implements TwilioPlatformPort {
  readonly mode = 'live' as const;
  constructor(private readonly platform: Auth & { accountSid: string }, private readonly policies: TwilioPolicies, private readonly call: typeof fetch = fetch) {}
  private auth(account: AccountCredentials): Auth { return { user: account.keySid, secret: account.keySecret }; }
  // Live phase 2 binds the existing staging subaccount instead of creating one (see TextingRegistration).
  async createSubaccount(): Promise<Result<AccountCredentials>> { return { outcome: 'rejected', reason: 'live_subaccount_is_bound_not_created' }; }
  /** Finds an object by FriendlyName in a list endpoint, following at most 20 pages. */
  private async findNamed(auth: Auth, url: string, field: string, name: string, extract: z.ZodType<{ sid: string; friendly_name: string | null; status?: string | null }>): Promise<Result<ProvisionFacts>> {
    let next: string | null = url + (url.includes('?') ? '&' : '?') + 'PageSize=50';
    for (let page = 0; next && page < 20; page++) {
      let r: Response1; try { r = await request(this.call, auth, 'GET', next); } catch { return { outcome: 'unknown' }; }
      if (r.status !== 200) return { ...failed(r), outcome: failed(r).outcome === 'rejected' ? 'unknown' : failed(r).outcome };
      const parsed = z.object({ meta: z.object({ next_page_url: z.string().nullable() }).partial().optional(), next_page_uri: z.string().nullable().optional() }).passthrough().safeParse(r.json);
      const items = parsed.success ? (parsed.data as Record<string, unknown>)[field] : undefined;
      if (!parsed.success || !Array.isArray(items)) return { outcome: 'unknown', reason: 'unexpected_list' };
      for (const item of items as unknown[]) {
        const found = extract.safeParse(item);
        if (found.success && found.data.friendly_name === twilioName(name)) return { outcome: 'accepted', value: { sid: found.data.sid, ...(found.data.status ? { status: found.data.status } : {}) } };
      }
      next = parsed.data.meta?.next_page_url ?? (parsed.data.next_page_uri ? 'https://api.twilio.com' + parsed.data.next_page_uri : null);
    }
    return { outcome: next ? 'unknown' : 'not_submitted' };
  }
  /** Look up first, then create. A create that returns no clear result is reported as unknown. */
  private async ensure(auth: Auth, list: { url: string; field: string; schema: z.ZodType<{ sid: string; friendly_name: string | null; status?: string | null }> }, create: { url: string; form: Record<string, string | string[]> }): Promise<Result<ProvisionFacts>> {
    const name = String(create.form.FriendlyName);
    const existing = await this.findNamed(auth, list.url, list.field, name, list.schema);
    if (existing.outcome !== 'not_submitted') return existing;
    let r: Response1; try { r = await request(this.call, auth, 'POST', create.url, { ...create.form, FriendlyName: twilioName(name) }); } catch { return { outcome: 'unknown' }; }
    if (r.status !== 200 && r.status !== 201) return failed(r);
    const created = list.schema.safeParse(r.json);
    return created.success ? { outcome: 'accepted', value: { sid: created.data.sid, ...(created.data.status ? { status: created.data.status } : {}) } } : { outcome: 'unknown', reason: 'unexpected_create' };
  }
  private async assign(auth: Auth, parent: string, objectSid: string): Promise<Result<true>> {
    const listed = await request(this.call, auth, 'GET', `${parent}/EntityAssignments?PageSize=100`).catch(() => null);
    if (!listed || listed.status !== 200) return { outcome: 'unknown' };
    const items = z.object({ results: z.array(z.object({ object_sid: z.string() })) }).safeParse(listed.json);
    if (!items.success) return { outcome: 'unknown' };
    if (items.data.results.some(item => item.object_sid === objectSid)) return { outcome: 'accepted', value: true };
    const r = await request(this.call, auth, 'POST', `${parent}/EntityAssignments`, { ObjectSid: objectSid }).catch(() => null);
    return !r ? { outcome: 'unknown' } : r.status === 201 || r.status === 200 ? { outcome: 'accepted', value: true } : failed(r);
  }
  async createCustomerProfile(account: AccountCredentials, op: string, p: BusinessProfile, callback: string): Promise<Result<ProvisionFacts>> {
    const auth = this.auth(account);
    const bundle = z.object({ sid: z.string(), friendly_name: z.string().nullable(), status: z.string().nullable().optional() });
    const profile = await this.ensure(auth, { url: `${trusthub}/CustomerProfiles?PolicySid=${this.policies.secondaryProfile}`, field: 'results', schema: bundle },
      { url: `${trusthub}/CustomerProfiles`, form: { FriendlyName: op, Email: p.notificationEmail, PolicySid: this.policies.secondaryProfile, StatusCallback: callback } });
    if (profile.outcome !== 'accepted') return profile;
    const profileUrl = `${trusthub}/CustomerProfiles/${profile.value!.sid}`;
    const endUser = (name: string, type: string, attributes: object) => this.ensure(auth, { url: `${trusthub}/EndUsers`, field: 'results', schema: bundle },
      { url: `${trusthub}/EndUsers`, form: { FriendlyName: name, Type: type, Attributes: JSON.stringify(attributes) } });
    const business = await endUser(op + '/business', 'customer_profile_business_information', {
      business_name: p.legalName, business_identity: 'direct_customer', business_type: p.businessType, business_industry: p.vertical,
      business_registration_identifier: 'EIN', business_registration_number: p.ein, business_regions_of_operation: 'USA_AND_CANADA', website_url: p.website });
    if (business.outcome !== 'accepted') return business;
    const representative = await endUser(op + '/rep', 'authorized_representative_1', {
      first_name: p.contact.firstName, last_name: p.contact.lastName, email: p.contact.email, phone_number: p.contact.phone, business_title: p.contact.title, job_position: 'Director' });
    if (representative.outcome !== 'accepted') return representative;
    const address = await this.ensure(auth, { url: `${api}/Accounts/${account.accountSid}/Addresses.json?FriendlyName=${encodeURIComponent(twilioName(op + '/address'))}`, field: 'addresses', schema: bundle },
      { url: `${api}/Accounts/${account.accountSid}/Addresses.json`, form: { FriendlyName: op + '/address', CustomerName: p.legalName, Street: p.address.street, City: p.address.city, Region: p.address.region, PostalCode: p.address.postalCode, IsoCountry: 'US' } });
    if (address.outcome !== 'accepted') return address;
    const document = await this.ensure(auth, { url: `${trusthub}/SupportingDocuments`, field: 'results', schema: bundle },
      { url: `${trusthub}/SupportingDocuments`, form: { FriendlyName: op + '/address-document', Type: 'customer_profile_address', Attributes: JSON.stringify({ address_sids: address.value!.sid }) } });
    if (document.outcome !== 'accepted') return document;
    for (const object of [business.value!.sid, representative.value!.sid, document.value!.sid, this.policies.primaryProfileSid]) {
      const assigned = await this.assign(auth, profileUrl, object); if (assigned.outcome !== 'accepted') return { outcome: assigned.outcome, reason: assigned.reason };
    }
    const product = await this.ensure(auth, { url: `${trusthub}/TrustProducts?PolicySid=${this.policies.a2pProfile}`, field: 'results', schema: bundle },
      { url: `${trusthub}/TrustProducts`, form: { FriendlyName: op + '/a2p', Email: p.notificationEmail, PolicySid: this.policies.a2pProfile, StatusCallback: callback } });
    if (product.outcome !== 'accepted') return product;
    const productUrl = `${trusthub}/TrustProducts/${product.value!.sid}`;
    const a2p = await endUser(op + '/a2p-info', 'us_a2p_messaging_profile_information', { company_type: p.companyType });
    if (a2p.outcome !== 'accepted') return a2p;
    for (const object of [a2p.value!.sid, profile.value!.sid]) {
      const assigned = await this.assign(auth, productUrl, object); if (assigned.outcome !== 'accepted') return { outcome: assigned.outcome, reason: assigned.reason };
    }
    for (const [url, current] of [[profileUrl, profile.value!.status], [productUrl, product.value!.status]] as const) {
      if (current && current !== 'draft') continue;
      const r = await request(this.call, auth, 'POST', url, { Status: 'pending-review' }).catch(() => null);
      if (!r) return { outcome: 'unknown' };
      if (r.status !== 200) return failed(r);
    }
    return { outcome: 'accepted', value: { sid: profile.value!.sid, parentSid: product.value!.sid, status: 'pending-review' } };
  }
  async submitBrand(account: AccountCredentials, op: string, profileSid: string, a2pSid: string): Promise<Result<ProvisionFacts>> {
    const found = await this.find('brand', account, op, profileSid);
    if (found.outcome !== 'not_submitted') return found;
    const r = await request(this.call, this.auth(account), 'POST', `${messaging}/a2p/BrandRegistrations`, { CustomerProfileBundleSid: profileSid, A2PProfileBundleSid: a2pSid }).catch(() => null);
    if (!r) return { outcome: 'unknown' };
    if (r.status !== 201 && r.status !== 200) return failed(r);
    const brand = z.object({ sid: sid('BN'), status: z.string() }).safeParse(r.json);
    return brand.success ? { outcome: 'accepted', value: { sid: brand.data.sid, status: brand.data.status } } : { outcome: 'unknown' };
  }
  async createMessagingService(account: AccountCredentials, op: string, callbacks: CallbackUrls): Promise<Result<ProvisionFacts>> {
    return this.ensure(this.auth(account), { url: `${messaging}/Services`, field: 'services', schema: z.object({ sid: sid('MG'), friendly_name: z.string().nullable() }) },
      { url: `${messaging}/Services`, form: { FriendlyName: op, InboundRequestUrl: callbacks.inbound, InboundMethod: 'POST', StatusCallback: callbacks.status, UseInboundWebhookOnNumber: 'false' } });
  }
  async submitCampaign(account: AccountCredentials, op: string, serviceSid: string, brandSid: string, c: CampaignInput): Promise<Result<ProvisionFacts>> {
    const found = await this.find('campaign', account, op, serviceSid);
    if (found.outcome !== 'not_submitted') return found;
    const r = await request(this.call, this.auth(account), 'POST', `${messaging}/Services/${serviceSid}/Compliance/Usa2p`, {
      BrandRegistrationSid: brandSid, Description: c.description, MessageFlow: c.messageFlow, MessageSamples: c.samples, UsAppToPersonUsecase: c.useCase,
      HasEmbeddedLinks: String(c.hasLinks), HasEmbeddedPhone: 'false', OptInMessage: c.optInMessage, OptOutMessage: c.optOutMessage, HelpMessage: c.helpMessage,
      OptInKeywords: ['YES'], OptOutKeywords: ['STOP'], HelpKeywords: ['HELP'],
      // Twilio's automated check rejects a campaign without these fields (30908, 30882), even when the message flow links the pages.
      ...(c.privacyPolicyUrl ? { PrivacyPolicyUrl: c.privacyPolicyUrl } : {}), ...(c.termsUrl ? { TermsAndConditionsUrl: c.termsUrl } : {}) }).catch(() => null);
    if (!r) return { outcome: 'unknown' };
    if (r.status !== 201 && r.status !== 200) return failed(r);
    const campaign = z.object({ sid: sid('QE'), campaign_status: z.string().nullable() }).safeParse(r.json);
    return campaign.success ? { outcome: 'accepted', value: { sid: campaign.data.sid, ...(campaign.data.campaign_status ? { status: campaign.data.campaign_status } : {}) } } : { outcome: 'unknown' };
  }
  async buyNumber(account: AccountCredentials, op: string, serviceSid: string, areaCode: string | null): Promise<Result<ProvisionFacts>> {
    const auth = this.auth(account), base = `${api}/Accounts/${account.accountSid}`;
    let number = await this.find('number', account, op);
    if (number.outcome === 'not_submitted') {
      const search = await request(this.call, auth, 'GET', `${base}/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&PageSize=5${areaCode ? '&AreaCode=' + areaCode : ''}`).catch(() => null);
      if (!search || search.status !== 200) return search ? failed(search) : { outcome: 'not_submitted', reason: 'search_unavailable' };
      const candidate = z.object({ available_phone_numbers: z.array(z.object({ phone_number: z.string() })).min(1) }).safeParse(search.json);
      if (!candidate.success) return { outcome: 'rejected', reason: 'no_number_available' };
      const r = await request(this.call, auth, 'POST', `${base}/IncomingPhoneNumbers.json`, { PhoneNumber: candidate.data.available_phone_numbers[0]!.phone_number, FriendlyName: twilioName(op) }).catch(() => null);
      if (!r) return { outcome: 'unknown' };
      if (r.status !== 201 && r.status !== 200) return failed(r);
      const bought = z.object({ sid: sid('PN'), phone_number: z.string() }).safeParse(r.json);
      if (!bought.success) return { outcome: 'unknown' };
      number = { outcome: 'accepted', value: { sid: bought.data.sid, e164: bought.data.phone_number } };
    }
    if (number.outcome !== 'accepted') return number;
    const attached = await request(this.call, auth, 'GET', `${messaging}/Services/${serviceSid}/PhoneNumbers/${number.value!.sid}`).catch(() => null);
    if (!attached) return { outcome: 'unknown' };
    if (attached.status === 404) {
      const r = await request(this.call, auth, 'POST', `${messaging}/Services/${serviceSid}/PhoneNumbers`, { PhoneNumberSid: number.value!.sid }).catch(() => null);
      if (!r) return { outcome: 'unknown' };
      if (r.status !== 201 && r.status !== 200) return failed(r);
    } else if (attached.status !== 200) return failed(attached);
    return number;
  }
  async find(kind: ProvisionKind, account: AccountCredentials | null, op: string, parentSid?: string): Promise<Result<ProvisionFacts>> {
    if (!account) return { outcome: 'not_submitted' };
    const auth = this.auth(account), named = z.object({ sid: z.string(), friendly_name: z.string().nullable(), status: z.string().nullable().optional() });
    if (kind === 'messaging_service') return this.findNamed(auth, `${messaging}/Services`, 'services', op, named);
    if (kind === 'number') {
      const found = await this.findNamed(auth, `${api}/Accounts/${account.accountSid}/IncomingPhoneNumbers.json?FriendlyName=${encodeURIComponent(twilioName(op))}`, 'incoming_phone_numbers', op,
        z.object({ sid: z.string(), friendly_name: z.string().nullable(), phone_number: z.string() }).transform(n => ({ ...n, status: n.phone_number })));
      return found.outcome === 'accepted' ? { outcome: 'accepted', value: { sid: found.value!.sid, e164: found.value!.status! } } : found;
    }
    if (kind === 'customer_profile') {
      const profile = await this.findNamed(auth, `${trusthub}/CustomerProfiles?PolicySid=${this.policies.secondaryProfile}`, 'results', op, named);
      const product = profile.outcome === 'accepted' ? await this.findNamed(auth, `${trusthub}/TrustProducts?PolicySid=${this.policies.a2pProfile}`, 'results', op + '/a2p', named) : profile;
      if (profile.outcome !== 'accepted' || product.outcome !== 'accepted') return { outcome: product.outcome === 'accepted' ? profile.outcome : product.outcome };
      const submitted = [profile.value!.status, product.value!.status].every(s => s && s !== 'draft');
      return submitted ? { outcome: 'accepted', value: { sid: profile.value!.sid, parentSid: product.value!.sid, status: profile.value!.status! } } : { outcome: 'not_submitted', reason: 'profile_incomplete' };
    }
    if (kind === 'brand') {
      const r = await request(this.call, auth, 'GET', `${messaging}/a2p/BrandRegistrations?PageSize=50`).catch(() => null);
      if (!r || r.status !== 200) return { outcome: 'unknown' };
      const list = z.object({ data: z.array(z.object({ sid: z.string(), customer_profile_bundle_sid: z.string().nullable(), status: z.string() })) }).safeParse(r.json);
      if (!list.success) return { outcome: 'unknown' };
      const brand = list.data.data.find(b => b.customer_profile_bundle_sid === parentSid);
      return brand ? { outcome: 'accepted', value: { sid: brand.sid, status: brand.status } } : { outcome: 'not_submitted' };
    }
    if (kind === 'campaign') {
      const r = await request(this.call, auth, 'GET', `${messaging}/Services/${parentSid}/Compliance/Usa2p`).catch(() => null);
      if (!r || r.status !== 200) return { outcome: 'unknown' };
      const list = z.object({ compliance: z.array(z.object({ sid: z.string(), campaign_status: z.string().nullable() })) }).safeParse(r.json);
      if (!list.success) return { outcome: 'unknown' };
      const campaign = list.data.compliance[0];
      return campaign ? { outcome: 'accepted', value: { sid: campaign.sid, ...(campaign.campaign_status ? { status: campaign.campaign_status } : {}) } } : { outcome: 'not_submitted' };
    }
    return { outcome: 'not_submitted' };
  }
  async status(kind: 'brand' | 'campaign', account: AccountCredentials, resource: string, parentSid?: string): Promise<Result<{ status: string; reason?: string }>> {
    const url = kind === 'brand' ? `${messaging}/a2p/BrandRegistrations/${resource}` : `${messaging}/Services/${parentSid}/Compliance/Usa2p/${resource}`;
    const r = await request(this.call, this.auth(account), 'GET', url).catch(() => null);
    if (!r || r.status !== 200) return { outcome: 'unknown' };
    const parsed = z.object({ status: z.string().optional(), campaign_status: z.string().nullable().optional(), failure_reason: z.string().nullable().optional() }).safeParse(r.json); // Twilio sends `errors: null` on an approved brand; it is not read.
    if (!parsed.success) return { outcome: 'unknown' };
    const status = (kind === 'brand' ? parsed.data.status : parsed.data.campaign_status) ?? 'PENDING';
    return { outcome: 'accepted', value: { status: status.toUpperCase(), ...(parsed.data.failure_reason ? { reason: parsed.data.failure_reason.slice(0, 300) } : {}) } };
  }
}

const permanentCodes: Record<number, SendResult['permanent']> = { 21610: 'unsubscribed', 21211: 'invalid', 21614: 'landline', 21612: 'invalid', 21408: 'invalid' };
export class TwilioHttpMessaging implements TwilioMessagingPort {
  readonly mode = 'live' as const;
  constructor(private readonly allowed: (to: string) => Promise<boolean>, private readonly call: typeof fetch = fetch) {}
  async send(account: AccountCredentials, m: { op: string; serviceSid: string; to: string; body: string; statusCallback: string }): Promise<SendResult> {
    // D-063: in phase 2 a live text may reach only the owner's opted-in numbers on the operator allow-list.
    if (!await this.allowed(m.to).catch(() => false)) return { outcome: 'rejected', reason: 'live_recipient_not_allowed' };
    let r: Response1;
    try { r = await request(this.call, { user: account.keySid, secret: account.keySecret }, 'POST', `${api}/Accounts/${account.accountSid}/Messages.json`,
      { To: m.to, MessagingServiceSid: m.serviceSid, Body: m.body, StatusCallback: m.statusCallback }); } catch { return { outcome: 'unknown' }; }
    if (r.status === 201 || r.status === 200) {
      const message = z.object({ sid: sid('(SM|MM)') }).safeParse(r.json);
      return message.success ? { outcome: 'accepted', sid: message.data.sid } : { outcome: 'unknown' };
    }
    const error = errorBody.safeParse(r.json), code = error.success ? error.data.code : undefined;
    const permanent = code !== undefined ? permanentCodes[code] : undefined;
    if (permanent) return { outcome: 'rejected', permanent, reason: 'twilio_' + code };
    return { outcome: mapStatus(r.status, code), reason: code ? 'twilio_' + code : 'http_' + r.status, ...(r.retryAfter !== null ? { retryAfterSeconds: r.retryAfter } : mapStatus(r.status, code) === 'not_submitted' ? { retryAfterSeconds: 5 } : {}) };
  }
  async lookup(account: AccountCredentials, m: { op: string; sid: string | null; to: string; sentAfter: Date; bodyDigest: string }) {
    const auth = { user: account.keySid, secret: account.keySecret }, base = `${api}/Accounts/${account.accountSid}/Messages`;
    const message = z.object({ sid: z.string(), status: z.string(), body: z.string().optional(), to: z.string() });
    try {
      if (m.sid) {
        const r = await request(this.call, auth, 'GET', `${base}/${m.sid}.json`);
        const found = message.safeParse(r.json);
        return r.status === 200 && found.success ? { outcome: 'accepted' as const, sid: found.data.sid, status: found.data.status } : { outcome: 'unknown' as const };
      }
      const since = m.sentAfter.toISOString().slice(0, 10);
      const r = await request(this.call, auth, 'GET', `${base}.json?To=${encodeURIComponent(m.to)}&DateSent%3E=${since}&PageSize=100`);
      const list = z.object({ messages: z.array(message) }).safeParse(r.json);
      if (r.status !== 200 || !list.success) return { outcome: 'unknown' as const };
      const matches = list.data.messages.filter(item => item.body !== undefined && bodyDigest(item.body) === m.bodyDigest);
      // Two identical texts to one number are ambiguous; leave it uncertain for the status callback.
      if (matches.length > 1) return { outcome: 'unknown' as const };
      return matches[0] ? { outcome: 'accepted' as const, sid: matches[0].sid, status: matches[0].status } : { outcome: 'not_submitted' as const };
    } catch { return { outcome: 'unknown' as const }; }
  }
}
