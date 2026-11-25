// The default Twilio client for tests and staging (CHG-1). It follows the same outcome rules as the real
// adapter, keeps its state in the database so staging survives restarts, and is scriptable: faults,
// carrier decisions and inbound replies are queued by tests or by the staging operator console.
import { randomBytes } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import { bodyDigest, twilioSignature, type AccountCredentials, type BusinessProfile, type CallbackUrls, type CampaignInput, type ProvisionFacts, type ProvisionKind, type Result, type SendResult, type TwilioMessagingPort, type TwilioPlatformPort } from './twilio.js';

import { mockFaults, type MockFault } from '../../shared/texting-mock.js';
export { mockFaults, type MockFault };
export type MockCallback = { id: string; url: string; params: Record<string, string>; accountSid: string };
type Resource = ProvisionFacts & { kind: ProvisionKind; op: string };
type Message = { sid: string; to: string; digest: string; status: string; at: string; callback: string; serviceSid: string };
const hex = (n: number) => randomBytes(n).toString('hex');
const mockSid = (prefix: string) => prefix + hex(16);

export class TwilioMockState {
  constructor(private readonly db: Database) {}
  async get<T>(key: string): Promise<T | null> { return ((await this.db.pool.query('SELECT flockletter_customer_jobs.texting_mock_get($1) v', [key])).rows[0]?.v ?? null) as T | null; }
  async put(key: string, value: unknown) { await this.db.pool.query('SELECT flockletter_customer_jobs.texting_mock_put($1,$2)', [key, JSON.stringify(value)]); }
  async list<T>(prefix: string): Promise<{ key: string; value: T }[]> { return (await this.db.pool.query('SELECT * FROM flockletter_customer_jobs.texting_mock_list($1)', [prefix])).rows; }
  private async faultQueue(sql: Sql, key: string): Promise<MockFault[]> {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
    return (await sql.query('SELECT flockletter_customer_jobs.texting_mock_get($1) faults', [key])).rows[0]?.faults ?? [];
  }
  async script(sql: Sql, kind: ProvisionKind | `send/${string}`, faults: MockFault[]) {
    const key = 'fault/' + kind, current = await this.faultQueue(sql, key);
    await sql.query('SELECT flockletter_customer_jobs.texting_mock_put($1,$2)', [key, JSON.stringify([...current, ...faults])]);
  }
  async next(kind: ProvisionKind | `send/${string}`): Promise<MockFault | null> {
    const key = 'fault/' + kind, client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const queue = await this.faultQueue(client, key);
      if (queue.length) await client.query('SELECT flockletter_customer_jobs.texting_mock_put($1,$2)', [key, JSON.stringify(queue.slice(1))]);
      await client.query('COMMIT');
      return queue[0] ?? null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async enqueue(callback: Omit<MockCallback, 'id'>) { const id = mockSid('CB'); await this.put('callback/' + Date.now().toString().padStart(15, '0') + '/' + id, { ...callback, id }); }
  async pending(): Promise<MockCallback[]> { return (await this.list<MockCallback | null>('callback/')).flatMap(row => row.value ? [row.value] : []); }
  async done(id: string) { for (const row of await this.list<MockCallback | null>('callback/')) if (row.value?.id === id) await this.put(row.key, null); }
  /** Signs a callback with the owning account's auth token, exactly as Twilio does. */
  async sign(callback: MockCallback) {
    const account = await this.get<AccountCredentials>('account/' + callback.accountSid);
    return account ? twilioSignature(callback.url, callback.params, account.authToken) : '';
  }
}

export class TwilioMockPlatform implements TwilioPlatformPort {
  readonly mode = 'mock' as const;
  constructor(readonly state: TwilioMockState) {}
  private async fault<T>(kind: ProvisionKind): Promise<Result<T> | 'commit_then_unknown' | null> {
    const fault = await this.state.next(kind);
    if (fault === '429') return { outcome: 'not_submitted', retryAfterSeconds: 1, reason: 'twilio_20429' };
    if (fault === '5xx') return { outcome: 'unknown', reason: 'http_503' };
    if (fault === 'reject') return { outcome: 'rejected', reason: 'mock_rejected' };
    return fault === 'timeout_after_commit' ? 'commit_then_unknown' : null;
  }
  private key(accountSid: string, kind: ProvisionKind, op: string) { return `resource/${accountSid}/${kind}/${op}`; }
  private async create(account: string, kind: ProvisionKind, op: string, make: () => ProvisionFacts, callback?: Omit<MockCallback, 'id' | 'accountSid'>): Promise<Result<ProvisionFacts>> {
    const fault = await this.fault<ProvisionFacts>(kind);
    if (fault && fault !== 'commit_then_unknown') return fault;
    // A real POST repeated after a lost response would create a duplicate. The mock records every
    // create so a test can prove that never happens.
    const key = this.key(account, kind, op), existing = await this.state.get<Resource>(key);
    const creates = (await this.state.get<number>('creates/' + key) ?? 0) + 1;
    await this.state.put('creates/' + key, creates);
    const resource: Resource = existing ?? { ...make(), kind, op };
    await this.state.put(key, resource);
    if (callback && !existing) await this.state.enqueue({ ...callback, accountSid: account });
    return fault === 'commit_then_unknown' ? { outcome: 'unknown', reason: 'timeout' } : { outcome: 'accepted', value: resource };
  }
  async createSubaccount(op: string): Promise<Result<AccountCredentials>> {
    const fault = await this.fault<AccountCredentials>('subaccount');
    if (fault && fault !== 'commit_then_unknown') return fault;
    const existing = await this.state.get<AccountCredentials>('subaccount/' + op);
    const account = existing ?? { accountSid: mockSid('AC'), keySid: mockSid('SK'), keySecret: hex(16), authToken: hex(16) };
    if (!existing) { await this.state.put('subaccount/' + op, account); await this.state.put('account/' + account.accountSid, account); }
    await this.state.put('creates/subaccount/' + op, (await this.state.get<number>('creates/subaccount/' + op) ?? 0) + 1);
    return fault === 'commit_then_unknown' ? { outcome: 'unknown', reason: 'timeout' } : { outcome: 'accepted', value: account };
  }
  async createCustomerProfile(account: AccountCredentials, op: string, _profile: BusinessProfile, _callback: string) {
    return this.create(account.accountSid, 'customer_profile', op, () => ({ sid: mockSid('BU'), parentSid: mockSid('BU'), status: 'pending-review' }));
  }
  async submitBrand(account: AccountCredentials, op: string, _profileSid: string) {
    return this.create(account.accountSid, 'brand', op, () => ({ sid: mockSid('BN'), status: 'PENDING' }));
  }
  async createMessagingService(account: AccountCredentials, op: string, callbacks: CallbackUrls) {
    const result = await this.create(account.accountSid, 'messaging_service', op, () => ({ sid: mockSid('MG') }));
    // Recorded even when the response is lost: the service exists at the provider either way.
    const created = await this.state.get<Resource>(this.key(account.accountSid, 'messaging_service', op));
    if (created) await this.state.put('service/' + created.sid, { accountSid: account.accountSid, ...callbacks });
    return result;
  }
  async submitCampaign(account: AccountCredentials, op: string, serviceSid: string, _brandSid: string, _input: CampaignInput) {
    return this.create(account.accountSid, 'campaign', op, () => ({ sid: mockSid('QE'), status: 'IN_PROGRESS', parentSid: serviceSid }));
  }
  async buyNumber(account: AccountCredentials, op: string, serviceSid: string, areaCode: string | null) {
    const result = await this.create(account.accountSid, 'number', op, () => ({ sid: mockSid('PN'), e164: '+1' + (areaCode ?? '212') + '55501' + String(Math.floor(Math.random() * 100)).padStart(2, '0') }));
    const created = await this.state.get<Resource>(this.key(account.accountSid, 'number', op));
    if (created?.e164) await this.state.put('number/' + created.e164, { accountSid: account.accountSid, serviceSid });
    return result;
  }
  async find(kind: ProvisionKind, account: AccountCredentials | null, op: string): Promise<Result<ProvisionFacts>> {
    if (kind === 'subaccount') {
      const found = await this.state.get<AccountCredentials>('subaccount/' + op);
      return found ? { outcome: 'accepted', value: { sid: found.accountSid } } : { outcome: 'not_submitted' };
    }
    if (!account) return { outcome: 'not_submitted' };
    const found = await this.state.get<Resource>(this.key(account.accountSid, kind, op));
    return found ? { outcome: 'accepted', value: found } : { outcome: 'not_submitted' };
  }
  async subaccount(op: string) { return this.state.get<AccountCredentials>('subaccount/' + op); }
  async status(kind: 'brand' | 'campaign', account: AccountCredentials, sid: string) {
    for (const row of await this.state.list<Resource>(`resource/${account.accountSid}/${kind}/`))
      if (row.value.sid === sid) return { outcome: 'accepted' as const, value: { status: row.value.status ?? 'PENDING' } };
    return { outcome: 'unknown' as const };
  }
  /** Staging console and tests: a carrier decision, delivered by signed callback. */
  async decide(kind: 'brand' | 'campaign', account: AccountCredentials, sid: string, status: 'APPROVED' | 'VERIFIED' | 'FAILED' | 'SUSPENDED', callbackUrl: string) {
    for (const row of await this.state.list<Resource>(`resource/${account.accountSid}/${kind}/`)) if (row.value.sid === sid) {
      await this.state.put(row.key, { ...row.value, status });
      await this.state.enqueue({ url: callbackUrl, accountSid: account.accountSid, params: { AccountSid: account.accountSid, ResourceType: kind, ResourceSid: sid, Status: status } });
      return true;
    }
    return false;
  }
  creates(accountSid: string, kind: ProvisionKind, op: string) { return this.state.get<number>('creates/' + (kind === 'subaccount' ? 'subaccount/' + op : this.key(accountSid, kind, op))); }
}

export class TwilioMockMessaging implements TwilioMessagingPort {
  readonly mode = 'mock' as const;
  constructor(readonly state: TwilioMockState) {}
  async send(account: AccountCredentials, m: { op: string; serviceSid: string; to: string; body: string; statusCallback: string }): Promise<SendResult> {
    const fault = await this.state.next(`send/${account.accountSid}`);
    if (fault === '429') return { outcome: 'not_submitted', retryAfterSeconds: 1, reason: 'twilio_20429' };
    if (fault === '5xx') return { outcome: 'unknown', reason: 'http_503' };
    if (fault === 'invalid' || fault === 'landline' || fault === 'unsubscribed') return { outcome: 'rejected', permanent: fault, reason: 'mock_' + fault };
    const sid = mockSid('SM');
    const message: Message = { sid, to: m.to, digest: bodyDigest(m.body), status: 'queued', at: new Date().toISOString(), callback: m.statusCallback, serviceSid: m.serviceSid };
    await this.state.put(`message/${account.accountSid}/${sid}`, message);
    await this.state.put(`sends/${m.op}`, (await this.state.get<number>(`sends/${m.op}`) ?? 0) + 1);
    const final: Record<string, string> = fault === 'undelivered' ? { MessageStatus: 'undelivered', ErrorCode: '30003' } : fault === 'failed' ? { MessageStatus: 'failed', ErrorCode: '30005' } : { MessageStatus: 'delivered' };
    for (const params of [{ MessageStatus: 'sent' }, final] as Record<string, string>[])
      await this.state.enqueue({ url: m.statusCallback, accountSid: account.accountSid, params: { AccountSid: account.accountSid, MessageSid: sid, MessagingServiceSid: m.serviceSid, To: m.to, ...params } });
    return fault === 'timeout_after_commit' ? { outcome: 'unknown', reason: 'timeout' } : { outcome: 'accepted', sid };
  }
  async lookup(account: AccountCredentials, m: { op: string; sid: string | null; to: string; sentAfter: Date; bodyDigest: string }) {
    const rows = await this.state.list<Message>(`message/${account.accountSid}/`);
    const matches = rows.map(row => row.value).filter(x => m.sid ? x.sid === m.sid : x.to === m.to && x.digest === m.bodyDigest && Date.parse(x.at) >= m.sentAfter.getTime() - 60000);
    if (matches.length > 1) return { outcome: 'unknown' as const };
    return matches[0] ? { outcome: 'accepted' as const, sid: matches[0].sid, status: matches[0].status } : { outcome: 'not_submitted' as const };
  }
  /** How many times the provider accepted a POST for one operation key. Must never exceed 1. */
  sends(op: string) { return this.state.get<number>(`sends/${op}`); }
  /** Staging console and tests: a reply from a phone to one of our numbers. */
  async inbound(accountSid: string, from: string, to: string, body: string) {
    const number = await this.state.get<{ accountSid: string; serviceSid: string }>('number/' + to);
    if (!number || number.accountSid !== accountSid) return false;
    const service = await this.state.get<CallbackUrls & { accountSid: string }>('service/' + number.serviceSid);
    if (!service || service.accountSid !== accountSid) return false;
    await this.state.enqueue({ url: service.inbound, accountSid: number.accountSid, params: { AccountSid: number.accountSid, MessageSid: mockSid('SM'), MessagingServiceSid: number.serviceSid, From: from, To: to, Body: body, NumMedia: '0' } });
    return true;
  }
}
