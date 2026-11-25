// The default Twilio client for tests and staging (CHG-1). It follows the same outcome rules as the real
// adapter, keeps its state in the database so staging survives restarts, and is scriptable: faults,
// carrier decisions and inbound replies are queued by tests or by the staging operator console.
import { randomBytes } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import { bodyDigest, CredentialSeal, twilioSignature, type AccountCredentials, type BusinessProfile, type CallbackUrls, type CampaignInput, type ProvisionFacts, type ProvisionKind, type RegistrationTier, type Result, type SendResult, type TwilioMessagingPort, type TwilioPlatformPort } from './twilio.js';
import { usAreaCodeZones } from '../../shared/us-area-codes.js';

import { mockFaults, type MockFault } from '../../shared/texting-mock.js';
export { mockFaults, type MockFault };
export type MockCallback = { id: string; url: string; params: Record<string, string>; accountSid: string; body?: string };
type FaultTarget = `${'send' | ProvisionKind}/${string}`;
type Resource = ProvisionFacts & { kind: ProvisionKind; op: string; brandSid?: string };
type NumberRoute = { accountSid: string; serviceSid: string; numberSid: string };
type CapturedAccountList = {
  accounts: { sid: string; owner_account_sid: string; friendly_name: string; status: string; auth_token: string }[];
  next_page_uri: string | null;
};
const mockParentSid = 'AC' + 'a'.repeat(32);
const subaccountName = (workspace: string) => 'flockletter-' + bodyDigest(workspace).slice(0, 48);
type Message = { sid: string; to: string; digest: string; status: string; at: string; callback: string; serviceSid: string };
const hex = (n: number) => randomBytes(n).toString('hex');
const mockSid = (prefix: string) => prefix + hex(16);

export class TwilioMockState {
  private migratedLegacyCallbacks = false;
  constructor(private readonly db: Database, private readonly connection?: Sql) {}
  async get<T>(key: string, sql: Sql = this.connection ?? this.db.pool): Promise<T | null> { return ((await sql.query('SELECT flockletter_customer_jobs.texting_mock_get($1) v', [key])).rows[0]?.v ?? null) as T | null; }
  async put(key: string, value: unknown, sql: Sql = this.connection ?? this.db.pool) { await sql.query('SELECT flockletter_customer_jobs.texting_mock_put($1,$2)', [key, JSON.stringify(value)]); }
  async workspace(account: string): Promise<string | null> {
    return (await (this.connection ?? this.db.pool).query('SELECT flockletter_customer_jobs.texting_route_account($1) workspace', [account])).rows[0]?.workspace ?? null;
  }
  async list<T>(prefix: string): Promise<{ key: string; value: T }[]> { return (await (this.connection ?? this.db.pool).query('SELECT * FROM flockletter_customer_jobs.texting_mock_list($1)', [prefix])).rows; }
  private async faultQueue(sql: Sql, key: string): Promise<MockFault[]> {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
    return (await sql.query('SELECT flockletter_customer_jobs.texting_mock_get($1) faults', [key])).rows[0]?.faults ?? [];
  }
  async script(sql: Sql, kind: FaultTarget, faults: MockFault[]) {
    const key = 'fault/' + kind, current = await this.faultQueue(sql, key);
    await sql.query('SELECT flockletter_customer_jobs.texting_mock_put($1,$2)', [key, JSON.stringify([...current, ...faults])]);
  }
  async transaction<T>(action: (sql: Sql) => Promise<T>): Promise<T> {
    if (this.connection) return action(this.connection);
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async next(kind: FaultTarget): Promise<MockFault | null> {
    const key = 'fault/' + kind;
    return this.transaction(async sql => {
      const queue = await this.faultQueue(sql, key);
      if (queue.length) await this.put(key, queue.slice(1), sql);
      return queue[0] ?? null;
    });
  }
  private async queue(sql: Sql, account: string) {
    const key = 'pending-callbacks/' + account;
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
    return { key, entries: await this.get<MockCallback[]>(key, sql) ?? [] };
  }
  async enqueue(callback: Omit<MockCallback, 'id'>, tx?: Sql) {
    const append = async (sql: Sql) => {
      const { key, entries } = await this.queue(sql, callback.accountSid);
      entries.push({ ...callback, id: mockSid('CB') });
      await this.put(key, entries, sql);
    };
    if (tx) await append(tx); else await this.transaction(append);
  }
  /** Before the account queues, acknowledgements left tombstones in the oldest 1,000 rows.
   * Split full legacy pages by the next key character to recover entries hidden behind that limit. */
  private async migrateLegacyCallbacks() {
    if (this.migratedLegacyCallbacks) return;
    await this.transaction(async sql => {
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('flockletter:mock:callback-migration',0))");
      const roots = ['callback/'];
      while (roots.length) {
        const root = roots.pop()!;
        const rows = (await sql.query<{ key: string; value: MockCallback | null }>('SELECT * FROM flockletter_customer_jobs.texting_mock_list($1)', [root])).rows;
        if (rows.length === 1000) {
          // Legacy keys contain a decimal timestamp, slash and a CB-prefixed hexadecimal SID.
          for (const c of [...'/0123456789BCabcdef'].reverse()) roots.push(root + c);
          continue;
        }
        for (const row of rows) if (row.value) {
          const { key, entries } = await this.queue(sql, row.value.accountSid);
          entries.push(row.value);
          await this.put(key, entries, sql);
          await this.put(row.key, null, sql);
        }
      }
    });
    this.migratedLegacyCallbacks = true;
  }
  async pending(accountSid?: string): Promise<MockCallback[]> {
    await this.migrateLegacyCallbacks();
    if (accountSid) return (await this.get<MockCallback[]>('pending-callbacks/' + accountSid) ?? []).slice(0, 100);
    return (await this.list<MockCallback[]>('pending-callbacks/')).flatMap(row => row.value.slice(0, 100));
  }
  async done(callback: MockCallback) {
    await this.transaction(async sql => {
      const { key, entries } = await this.queue(sql, callback.accountSid);
      await this.put(key, entries.filter(item => item.id !== callback.id), sql);
    });
  }
  /** Signs a callback with the owning account's auth token, exactly as Twilio does. */
  async sign(callback: MockCallback) {
    const account = await this.get<AccountCredentials>('account/' + callback.accountSid);
    return account ? twilioSignature(callback.url, callback.params, account.authToken) : '';
  }
}

export class TwilioMockPlatform implements TwilioPlatformPort {
  readonly mode = 'mock' as const;
  private readonly accountSeal = CredentialSeal.mock();
  constructor(readonly state: TwilioMockState) {}
  private async fault<T>(kind: ProvisionKind, workspace: string | null): Promise<Result<T> | 'commit_then_unknown' | null> {
    const fault = workspace && await this.state.next(`${kind}/${workspace}`);
    if (fault === '429') return { outcome: 'not_submitted', retryAfterSeconds: 1, reason: 'twilio_20429' };
    if (fault === '5xx') return { outcome: 'unknown', reason: 'http_503' };
    if (fault === 'reject') return { outcome: 'rejected', reason: 'mock_rejected' };
    return fault === 'timeout_after_commit' ? 'commit_then_unknown' : null;
  }
  private key(accountSid: string, kind: ProvisionKind, op: string) { return `resource/${accountSid}/${kind}/${op}`; }
  private async create(account: string, kind: ProvisionKind, op: string, make: () => ProvisionFacts,
    onStored?: (sql: Sql, resource: Resource) => Promise<void>): Promise<Result<ProvisionFacts>> {
    const fault = await this.fault<ProvisionFacts>(kind, await this.state.workspace(account));
    if (fault && fault !== 'commit_then_unknown') return fault;
    // A real POST repeated after a lost response would create a duplicate. The mock records every
    // create so a test can prove that never happens.
    const key = this.key(account, kind, op);
    return this.state.transaction(async sql => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
      const existing = await this.state.get<Resource>(key,sql);
      const creates = (await this.state.get<number>('creates/' + key,sql) ?? 0) + 1;
      const resource = existing ?? { ...make(), kind, op };
      await this.state.put('creates/' + key, creates,sql);
      await this.state.put(key, resource,sql);
      if (onStored) await onStored(sql,resource);
      return fault === 'commit_then_unknown' ? { outcome: 'unknown', reason: 'timeout' } : { outcome: 'accepted', value: resource };
    });
  }
  async createSubaccount(op: string, workspace?: string): Promise<Result<AccountCredentials>> {
    if (!workspace) return { outcome: 'rejected', reason: 'workspace_required' };
    const fault = await this.fault<AccountCredentials>('subaccount', workspace);
    if (fault && fault !== 'commit_then_unknown') return fault;
    const name = subaccountName(workspace);
    return this.state.transaction(async sql => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['mock-subaccount/' + name]);
      const lookup = await this.lookupSubaccount(op, workspace, sql);
      if (lookup.outcome !== 'not_submitted') return lookup;
      const account = { accountSid: mockSid('AC'), keySid: mockSid('SK'), keySecret: hex(16), authToken: hex(16) };
      // Captured Accounts-list fields match Twilio's exact FriendlyName lookup. Key secrets are
      // available only at creation, so reconciliation must use our saved credential receipt.
      const list: CapturedAccountList = { accounts: [{ sid: account.accountSid, owner_account_sid: mockParentSid,
        friendly_name: name, status: 'active', auth_token: account.authToken }], next_page_uri: null };
      await this.state.put('accounts-by-name/' + name, list, sql);
      await this.state.put('key-receipt/' + account.accountSid, this.accountSeal.seal(account, workspace), sql);
      await this.state.put('account/' + account.accountSid, { authToken: account.authToken }, sql);
      await this.state.put('creates/subaccount/' + op, (await this.state.get<number>('creates/subaccount/' + op, sql) ?? 0) + 1, sql);
      return fault === 'commit_then_unknown' ? { outcome: 'unknown', reason: 'timeout' } : { outcome: 'accepted', value: account };
    });
  }
  private async lookupSubaccount(op: string, workspace: string, sql?: Sql): Promise<Result<AccountCredentials>> {
    const name = subaccountName(workspace);
    const list = await this.state.get<CapturedAccountList>('accounts-by-name/' + name, sql);
    if (!list) {
      // Existing captured operations written before workspace-scoped Accounts lookup.
      const legacy = await this.state.get<AccountCredentials>('subaccount/' + op, sql);
      return legacy ? { outcome: 'accepted', value: legacy } : { outcome: 'not_submitted' };
    }
    const account = list.accounts?.[0];
    if (list.next_page_uri || list.accounts?.length !== 1 || !account || account.owner_account_sid !== mockParentSid ||
      account.friendly_name !== name || account.status !== 'active' || !/^AC[0-9a-f]{32}$/.test(account.sid))
      return { outcome: 'unknown', reason: 'subaccount_lookup_review' };
    const receipt = await this.state.get<string>('key-receipt/' + account.sid, sql);
    if (receipt) {
      try {
        const grant = this.accountSeal.open(receipt, workspace);
        if (grant.accountSid === account.sid && grant.authToken === account.auth_token && /^SK[0-9a-f]{32}$/.test(grant.keySid) && grant.keySecret)
          return { outcome: 'accepted', value: grant };
      } catch { /* A missing or unreadable one-time secret cannot be reconstructed by another create. */ }
    }
    return { outcome: 'unknown', reason: 'subaccount_credentials_review' };
  }
  async createCustomerProfile(account: AccountCredentials, op: string, _profile: BusinessProfile, _callback: string) {
    return this.create(account.accountSid, 'customer_profile', op, () => ({ sid: mockSid('BU'), parentSid: mockSid('BU'), status: 'pending-review' }));
  }
  async submitBrand(account: AccountCredentials, op: string, profileSid: string, _a2pSid?: string, tier?: RegistrationTier) {
    return this.create(account.accountSid, 'brand', op, () => ({ sid: mockSid('BN'), status: 'PENDING', parentSid: profileSid, ...(tier && { tier }) }));
  }
  async createMessagingService(account: AccountCredentials, op: string, callbacks: CallbackUrls) {
    return this.create(account.accountSid, 'messaging_service', op, () => ({ sid: mockSid('MG') }),
      (sql, service) => this.state.put('service/' + service.sid, { accountSid: account.accountSid, ...callbacks },sql));
  }
  async submitCampaign(account: AccountCredentials, op: string, serviceSid: string, brandSid: string, _input: CampaignInput) {
    return this.create(account.accountSid, 'campaign', op, () => ({ sid: mockSid('QE'), status: 'IN_PROGRESS', parentSid: serviceSid, brandSid }));
  }
  async correctCampaign(account: AccountCredentials, op: string, serviceSid: string, brandSid: string, campaignSid: string, input: CampaignInput): Promise<Result<ProvisionFacts>> {
    const fault = await this.fault<ProvisionFacts>('campaign', await this.state.workspace(account.accountSid));
    if (fault && fault !== 'commit_then_unknown') return fault;
    const candidates = await this.state.list<Resource>(`resource/${account.accountSid}/campaign/`);
    const previous = candidates.find(row => row.value.sid === campaignSid && row.value.parentSid === serviceSid && row.value.brandSid === brandSid);
    if (!previous) return { outcome: 'rejected', reason: 'mock_campaign_mismatch' };
    return this.state.transaction(async sql => {
      const key = this.key(account.accountSid, 'campaign', op);
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
      const existing = await this.state.get<Resource>(key,sql);
      if (existing) return { outcome:'accepted',value:existing };
      const current = { ...previous.value, op, status: 'IN_PROGRESS', wordingDigest: bodyDigest(JSON.stringify(input)) };
      await this.state.put(key, current, sql);
      await this.state.put('current-campaign/' + account.accountSid + '/' + campaignSid, key, sql);
      return fault === 'commit_then_unknown' ? { outcome: 'unknown', reason: 'timeout' } : { outcome: 'accepted', value: current };
    });
  }
  async buyNumber(account: AccountCredentials, op: string, serviceSid: string, areaCode: string | null): Promise<Result<ProvisionFacts>> {
    const fault = await this.fault<ProvisionFacts>('number', await this.state.workspace(account.accountSid));
    if (fault && fault !== 'commit_then_unknown') return fault;
    const key = this.key(account.accountSid, 'number', op);
    // Allocate only fictional numbers. Reserve the mock provider's route and its operation atomically
    // so a second workspace can never override it or lose a committed number after a restart.
    return this.state.transaction(async sql => {
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('flockletter:mock:number-pool',0))");
      let resource = await this.state.get<Resource>(key, sql);
      if (!resource) {
        const codes = areaCode ? [areaCode] : ['212', ...Object.keys(usAreaCodeZones).filter(code => code !== '212')];
        let e164: string | undefined;
        for (const code of codes) {
          if (!Object.hasOwn(usAreaCodeZones, code)) continue;
          const { rows } = await sql.query<{ e164: string }>(
            `SELECT candidate e164 FROM (SELECT '+1' || $1::text || '55501' || lpad(n::text,2,'0') AS candidate
              FROM generate_series(0,99) n) pool WHERE flockletter_customer_jobs.texting_mock_get('number/' || candidate) IS NULL
              AND NOT EXISTS (SELECT 1 FROM flockletter_customer_jobs.texting_route_number(candidate)) LIMIT 1`, [code]);
          if (rows[0]) { e164 = rows[0].e164; break; }
        }
        if (!e164) return { outcome: 'rejected', reason: 'mock_numbers_unavailable' };
        resource = { sid: mockSid('PN'), e164, parentSid: serviceSid, kind: 'number', op };
        const route: NumberRoute = { accountSid: account.accountSid, serviceSid, numberSid: resource.sid };
        await this.state.put(key, resource, sql);
        await this.state.put('number/' + e164, route, sql);
        await this.state.put('number-sid/' + resource.sid, route, sql);
      }
      await this.state.put('creates/' + key, (await this.state.get<number>('creates/' + key, sql) ?? 0) + 1, sql);
      return fault === 'commit_then_unknown' ? { outcome: 'unknown', reason: 'timeout' } : { outcome: 'accepted', value: resource };
    });
  }
  async attachNumber(account: AccountCredentials, serviceSid: string, numberSid: string): Promise<Result<true>> {
    return this.state.transaction(async sql => {
      const key = `attachment/${account.accountSid}/${numberSid}`;
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      if (await this.state.get<string>(key, sql) === serviceSid) return { outcome: 'accepted', value: true };
      const route = await this.state.get<NumberRoute>('number-sid/' + numberSid, sql);
      const service = await this.state.get<CallbackUrls & { accountSid: string }>('service/' + serviceSid, sql);
      if (route?.accountSid !== account.accountSid || route.serviceSid !== serviceSid || service?.accountSid !== account.accountSid)
        return { outcome: 'rejected', reason: 'mock_number_mismatch' };
      const body = JSON.stringify([{
        id: mockSid('CE'), type: 'com.twilio.messaging.compliance.number-registration.successful', time: new Date().toISOString(),
        data: { accountsid: account.accountSid, messagingservicesid: serviceSid, phonenumbersid: numberSid, externalstatus: 'registered' },
      }]);
      const url = new URL('/api/v1/texting/twilio/carrier-events', service.registration);
      url.searchParams.set('bodySHA256', bodyDigest(body));
      await this.state.enqueue({ url: url.href, params: {}, accountSid: account.accountSid, body }, sql);
      await this.state.put(key, serviceSid, sql);
      return { outcome: 'accepted', value: true };
    });
  }
  async find(kind: ProvisionKind, account: AccountCredentials | null, op: string, _parentSid?: string, workspace?: string): Promise<Result<ProvisionFacts & { account?: AccountCredentials }>> {
    if (kind === 'subaccount') {
      if (!workspace) return { outcome: 'unknown', reason: 'workspace_required' };
      const found = await this.lookupSubaccount(op, workspace);
      return found.outcome === 'accepted' && found.value ? { outcome: 'accepted', value: { sid: found.value.accountSid, account: found.value } }
        : { outcome: found.outcome, reason: found.reason };
    }
    if (!account) return { outcome: 'not_submitted' };
    const found = await this.state.get<Resource>(this.key(account.accountSid, kind, op));
    return found ? { outcome: 'accepted', value: found } : { outcome: 'not_submitted' };
  }
  async status(kind: 'brand' | 'campaign', account: AccountCredentials, sid: string) {
    const current = kind === 'campaign' ? await this.state.get<string>('current-campaign/' + account.accountSid + '/' + sid) : null;
    if (current) {
      const resource = await this.state.get<Resource>(current);
      if (resource) return { outcome: 'accepted' as const, value: { status: resource.status ?? 'IN_PROGRESS' } };
    }
    for (const row of await this.state.list<Resource>(`resource/${account.accountSid}/${kind}/`))
      if (row.value.sid === sid) return { outcome: 'accepted' as const, value: { status: row.value.status ?? 'PENDING' } };
    return { outcome: 'unknown' as const };
  }
  /** Staging console and tests: a carrier decision, delivered by signed callback. */
  async decide(kind: 'brand' | 'campaign', account: AccountCredentials, sid: string, status: 'APPROVED' | 'VERIFIED' | 'FAILED' | 'SUSPENDED', callbackUrl: string) {
    const current = kind === 'campaign' ? await this.state.get<string>('current-campaign/' + account.accountSid + '/' + sid) : null;
    for (const row of await this.state.list<Resource>(`resource/${account.accountSid}/${kind}/`)) if (row.value.sid === sid && (!current || current === row.key)) {
      await this.state.put(row.key, { ...row.value, status });
      await this.state.enqueue({ url: callbackUrl, accountSid: account.accountSid, params: { AccountSid: account.accountSid, ResourceType: kind, ResourceSid: sid, Status: status,
        ...(current && { MockCorrection: row.value.op }) } });
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
