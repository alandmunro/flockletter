// Texting phase 2 acceptance tests, against the mock Twilio client (FL-AT-041 to FL-AT-044).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, authorize, type Actor } from '../src/server/service.js';
import { Authenticator, type IdentityProvider } from '../src/server/auth.js';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { memberPermissions, type ClerkTeam } from '../src/server/team.js';
const oneSeatTeam = { members: async () => ({ total: 1, members: [] }) } as unknown as ClerkTeam;
import type { CustomerWorkflows } from '../src/server/customer-runtime.js';
import { CustomerAudience } from '../src/server/customer-audience/service.js';
import type { AudienceSettingsView } from '../src/shared/customer-audience.js';
import { Texting, type OperatorActor } from '../src/server/texting/service.js';
import { TextingRegistration, signupPage } from '../src/server/texting/registration.js';
import express from 'express';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SignupFields } from '../src/shared/SignupPostcard.js';
import { customerAudienceRoutes } from '../src/server/customer-audience/routes.js';
import { twilioSignature, verifyTwilioSignature } from '../src/server/texting/twilio.js';
import { encodeText, normalizeUsPhone, composeBroadcast, smsConsentWording, smsConsentPolicyVersion } from '../src/shared/texting.js';
import { textingPlatformCommands, type TextingPlatformCommand } from '../src/shared/texting-platform.js';
import type { Connection } from '../src/shared/contracts.js';

const owner = (workspaceId: string): Actor => ({ workspaceId, userId: `user_${workspaceId}`, actorId: `user:user_${workspaceId}`, owner: true, kind: 'session', scopes: ['read', 'draft:write', 'assets:write'], brandIds: null });
const A = owner('org_texting_a'), B = owner('org_texting_b');
const operator: OperatorActor = { userId: 'user_operator', via: 'operator_api' };
const identity: IdentityProvider = {
  async session(request) { const actor = request.get('authorization') === 'Bearer test-a' ? A : request.get('authorization') === 'Bearer test-b' ? B : null; if (!actor) throw new Error('Invalid test session'); return { userId: actor.userId, workspaceId: actor.workspaceId }; },
  async isOwner(user, workspace) { return user === `user_${workspace}`; },
};
let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database, service: CommandService, texting: Texting, server: Server, origin: string, admin: pg.Client;
let clock = 0, base = 0;
/** Day offset from the test calendar's start, at an hour UTC. */
const at = (day: number, hour: number) => base + day * 86400000 + hour * 3600000;
const now = () => new Date(clock);
const advance = (ms: number) => { clock += ms; };
const key = () => randomUUID();
const run = <T = Record<string, unknown>>(name: string, input: unknown, actor = A) => service.execute(name as never, input, actor) as Promise<T>;
const op = <T = Record<string, unknown>>(name: TextingPlatformCommand, input: Record<string, unknown>) => texting.operator(name, { ...(textingPlatformCommands[name].mutation ? { operationKey: key() } : {}), ...input }, operator) as Promise<T>;
// Each pass moves the clock past short retry delays (429 back-off, reconcile intervals).
const tick = async (w = A.workspaceId) => { for (let i = 0; i < 8; i++) { await texting.deliverMockCallbacks(); await texting.tick(w); advance(31000); } };
const rows = <T = Record<string, unknown>>(w: string, text: string, values: unknown[] = []) => db.tenant(w, async sql => (await sql.query(text, values)).rows as T[]);
const company: Record<string, string> = {}, registration: Record<string, string> = {}, number: Record<string, string> = {};
async function setting(keyName: string, value: unknown, workspaceId: string | null = null) {
  const current = (await op<{ key: string; platform: { revision: number } | null; workspace: { revision: number } | null }[]>('platform.textingSettings', { ...(workspaceId ? { workspaceId } : {}) })).find(s => s.key === keyName)!;
  const revision = (workspaceId ? current.workspace?.revision : current.platform?.revision) ?? 0;
  return op('platform.textingSetSetting', { key: keyName, workspaceId, value, expectedRevision: revision, reason: 'Test configuration for FL-AT.' });
}
const profile = { ein: '12-3456789', website: 'https://example.com', businessType: 'Limited Liability Corporation', vertical: 'RETAIL', areaCode: '212',
  address: { street: '1 Main St', city: 'New York', region: 'NY', postalCode: '10001', country: 'US' },
  contact: { firstName: 'Pat', lastName: 'Owner', email: 'pat@example.com', phone: '+12125550100', title: 'Owner' } };
async function optIn(w: string, phone: string, name: string | null = null) {
  const actor = w === A.workspaceId ? A : B;
  const added = await run<{ contactId: string }>('sms.addContact', { operationKey: key(), companyId: company[w], phone, ...(name ? { name } : {}) }, actor);
  await db.tenant(w, async sql => {
    await sql.query(`UPDATE sms_consents SET state='pending_confirmation' WHERE contact_id=$1`, [added.contactId]);
  });
  await op('platform.textingMock', { workspaceId: w, action: { kind: 'inbound', from: phone, to: number[w], body: 'YES' } });
  return added.contactId;
}
async function http(name: string, input: unknown, token: string, extra: Record<string, string> = {}) {
  return fetch(`${origin}/api/v1/commands/${name}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }, body: JSON.stringify(input) });
}
async function issue(actor: Actor, scopes: string[]) {
  const brandId = (await rows<{ id: string }>(actor.workspaceId, 'SELECT id FROM brands'))[0]!.id;
  return run<{ connection: Connection; token: string }>('connection.create', { operationKey: key(), name: 'Texting test', scopes, brandIds: [brandId], expiresInDays: 30 }, actor);
}

beforeAll(async () => {
  const today = new Date(); base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 2); // a fixed calendar in the future
  clock = at(0, 20); // 3 p.m. Eastern (winter or summer time), 10 a.m. Hawaii
  fixture = await startDatabase(); db = new Database(fixture.url);
  admin = new pg.Client({ connectionString: fixture.adminUrl }); await admin.connect();
  texting = Texting.mock(db, { origin: 'http://127.0.0.1:4310', linkOrigin: 'http://127.0.0.1:4310/l', isOwner: identity.isOwner, now });
  service = new CommandService(db, undefined, identity.isOwner);
  (service as unknown as { customer: Partial<CustomerWorkflows> }).customer = { texting, owns: () => false } as Partial<CustomerWorkflows>;
  for (const actor of [A, B]) {
    await run('workspace.initialize', { operationKey: key(), name: actor.workspaceId, brandName: 'Shop' }, actor);
    company[actor.workspaceId] = (await db.tenant(actor.workspaceId, async sql => (await sql.query<{ id: string }>('SELECT id FROM companies')).rows[0]!.id));
    await run('sms.configure', { operationKey: key(), expectedRevision: 1, shortName: actor === A ? 'shop-a' : 'shop-b', notificationEmail: 'owner@example.com', phoneField: true, birthdayField: true }, actor);
  }
  for (const [name, value] of [['carrier_daily_limit', 100], ['monthly_segment_allowance', 1000], ['test_texts_per_day', 2], ['member_code_minutes', 10], ['member_code_attempts', 3], ['reconcile_settle_minutes', 1]] as const)
    await setting(name, value);
  const config = loadConfig({ APP_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:4310', LOCAL_TEST_IDENTITY: 'true', DATABASE_URL: fixture.url });
  const app = createApp(config, service, new Authenticator(db, identity));
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server'); origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await admin?.end(); await db?.close(); await fixture?.stop(); });

describe('shared texting rules', () => {
  it('normalizes US numbers only and counts segments per encoding', () => {
    expect(normalizeUsPhone('(212) 555-0142')).toBe('+12125550142');
    expect(normalizeUsPhone('+1 416 555 0142')).toBeNull(); // Toronto: not a US number
    expect(normalizeUsPhone('+44 20 7946 0958')).toBeNull();
    expect(normalizeUsPhone('212-911-0000')).toBeNull();
    expect(encodeText('a'.repeat(160))).toMatchObject({ encoding: 'gsm7', segments: 1 });
    expect(encodeText('a'.repeat(161))).toMatchObject({ encoding: 'gsm7', segments: 2 });
    expect(encodeText('José ' + 'a'.repeat(65))).toMatchObject({ encoding: 'gsm7', segments: 1 }); // é is in GSM-7
    expect(encodeText('Zoë ' + 'a'.repeat(66))).toMatchObject({ encoding: 'ucs2', segments: 1 });
    expect(encodeText('Zoë ' + 'a'.repeat(67))).toMatchObject({ encoding: 'ucs2', segments: 2 });
    expect(encodeText('“Hi” — it’s here').text).toBe('"Hi" - it\'s here');
    expect(composeBroadcast('Hi {{name|there}}', 'Shop', { name: null })).toBe('Shop: Hi there Reply STOP to opt out.');
  });
  it('signs and verifies webhooks the way Twilio does', () => {
    const params = { Body: 'STOP', From: '+12125550142' };
    const signature = twilioSignature('https://x.test/hook', params, 'token');
    expect(verifyTwilioSignature('https://x.test/hook', params, signature, 'token')).toBe(true);
    expect(verifyTwilioSignature('https://x.test/hook', { ...params, Body: 'START' }, signature, 'token')).toBe(false);
    expect(verifyTwilioSignature('https://x.test/hook', params, signature, 'other')).toBe(false);
  });
});

describe('FL-AT-042 registration', () => {
  it('runs every step once per operation key through timeouts, 5xx, 429 and a restart', async () => {
    const w = A.workspaceId;
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'fault', target: 'subaccount', faults: ['timeout_after_commit'] } });
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'fault', target: 'customer_profile', faults: ['5xx'] } });
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'fault', target: 'brand', faults: ['429'] } });
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'fault', target: 'messaging_service', faults: ['timeout_after_commit'] } });
    const created = await op<{ carrierBrandId: string; registrationId: string }>('platform.textingCarrierBrand', { workspaceId: w, companyId: company[w], legalName: 'Synthetic A LLC', dbaName: 'Synthetic A', entityType: 'private_profit', profile, helpContact: 'help@example.com', reason: 'Synthetic staging workspace.' });
    registration[w] = created.registrationId;
    // Registration waits for the confirmed privacy policy and SMS terms.
    await expect(op('platform.textingSubmit', { workspaceId: w, registrationId: created.registrationId, reason: 'Too early, policies unconfirmed.' })).rejects.toMatchObject({ code: 'policies_unconfirmed' });
    await op('platform.textingConfirmPolicies', { workspaceId: w, carrierBrandId: created.carrierBrandId, privacyPolicyUrl: 'https://example.com/privacy', smsTermsUrl: 'https://example.com/sms-terms', reason: 'Synthetic policies are live.' });
    await op('platform.textingSubmit', { workspaceId: w, registrationId: created.registrationId, reason: 'Synthetic registration run.' });
    // A second carrier brand for the same company is refused.
    await expect(op('platform.textingCarrierBrand', { workspaceId: w, companyId: company[w], legalName: 'Other LLC', dbaName: null, entityType: 'private_profit', profile, helpContact: 'x@example.com', reason: 'Attempt a second brand.' })).rejects.toMatchObject({ code: 'registration_in_progress' });
    await expect(db.tenant(w, sql => sql.query(`INSERT INTO sms_carrier_brands(workspace_id,id,company_id,legal_name,entity_type,profile,help_contact,created_by) VALUES($1,$2,$3,'Dup','private_profit','{}','x@example.com','t')`, [w, randomUUID(), company[w]]))).rejects.toThrow(/unique/);
    await tick(w); // subaccount timed out after commit → reconciled by lookup; profile 5xx → uncertain
    // With no settle time the uncertain step waits, and both the customer and operator views say which setting is needed.
    await setting('reconcile_settle_minutes', null);
    await db.tenant(w, sql => sql.query(`UPDATE sms_registration_steps SET state='uncertain' WHERE step='campaign'`));
    expect((await run<{ settingsNeeded: string[] }>('sms.status', {})).settingsNeeded).toContain('reconcile_settle_minutes');
    expect((await op<{ settingsNeeded: string[] }>('platform.textingRegistration', { workspaceId: w })).settingsNeeded).toEqual(['reconcile_settle_minutes']);
    await db.tenant(w, sql => sql.query(`UPDATE sms_registration_steps SET state='queued' WHERE step='campaign'`));
    await setting('reconcile_settle_minutes', 1);
    expect((await op<{ settingsNeeded: string[] }>('platform.textingRegistration', { workspaceId: w })).settingsNeeded).toEqual([]);
    advance(2 * 60000); await tick(w); // settle time passed: profile retried; brand 429 → queued
    advance(60000); await tick(w);
    // Crash simulation: a committed `calling` intent with no provider call made.
    const before = await op<{ registrations: { state: string; steps: { step: string; state: string; operationKey: string }[] }[] }>('platform.textingRegistration', { workspaceId: w });
    expect(before.registrations[0]!.state).toBe('brand_pending');
    const restarted = Texting.mock(db, { origin: 'http://127.0.0.1:4310', linkOrigin: 'http://127.0.0.1:4310/l', isOwner: identity.isOwner, now });
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'brand', registrationId: created.registrationId, status: 'APPROVED' } });
    await restarted.tick(w);
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'campaign', registrationId: created.registrationId, status: 'VERIFIED' } });
    await tick(w);
    const after = await op<{ registrations: { state: string; steps: { step: string; state: string; operationKey: string }[] }[]; numbers: { e164: string; state: string }[] }>('platform.textingRegistration', { workspaceId: w });
    expect(after.registrations[0]!.state).toBe('approved');
    expect(after.numbers).toHaveLength(1);
    number[w] = after.numbers[0]!.e164;
    const account = await db.read(w, sql => texting.registration.account(sql, w));
    for (const step of after.registrations[0]!.steps) {
      expect(step.state).toBe('done');
      expect(await texting.mock!.platform.creates(account!.accountSid, step.step as never, step.operationKey)).toBe(1);
    }
    const audit = await rows<{ action: string }>(w, `SELECT action FROM sms_audit WHERE action LIKE 'registration.%' ORDER BY at`);
    expect(audit.map(r => r.action)).toEqual(expect.arrayContaining(['registration.submit', 'registration.call', 'registration.reconcile', 'registration.approved']));
  });
  it('ignores duplicate and out-of-order carrier callbacks, and handles rejection then correction', async () => {
    const w = B.workspaceId;
    const created = await op<{ carrierBrandId: string; registrationId: string }>('platform.textingCarrierBrand', { workspaceId: w, companyId: company[w], legalName: 'Synthetic B LLC', dbaName: 'Synthetic B', entityType: 'private_profit', profile, helpContact: 'help@example.com', reason: 'Synthetic staging workspace.' });
    registration[w] = created.registrationId;
    await op('platform.textingConfirmPolicies', { workspaceId: w, carrierBrandId: created.carrierBrandId, privacyPolicyUrl: 'https://example.com/privacy', smsTermsUrl: 'https://example.com/sms-terms', reason: 'Synthetic policies are live.' });
    await op('platform.textingSubmit', { workspaceId: w, registrationId: created.registrationId, reason: 'Synthetic registration run.' });
    await tick(w);
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'brand', registrationId: created.registrationId, status: 'FAILED' } });
    let state = await op<{ registrations: { state: string; revision: number }[] }>('platform.textingRegistration', { workspaceId: w });
    expect(state.registrations[0]!.state).toBe('rejected');
    // Sending is refused while not approved.
    const draft = await run<{ id: string; revision: number }>('sms.draft', { operationKey: key(), companyId: company[w], body: 'Hello' }, B);
    const review = await run<{ gaps: string[] }>('sms.review', { id: draft.id, expectedRevision: draft.revision }, B);
    expect(review.gaps).toContain('registration_not_approved');
    await op('platform.textingCarrierBrand', { workspaceId: w, companyId: company[w], legalName: 'Synthetic B Holdings LLC', dbaName: 'Synthetic B', entityType: 'private_profit', profile, helpContact: 'help@example.com', reason: 'Correct the legal name.' });
    await op('platform.textingConfirmPolicies', { workspaceId: w, carrierBrandId: created.carrierBrandId, privacyPolicyUrl: 'https://example.com/privacy', smsTermsUrl: 'https://example.com/sms-terms', reason: 'Policies still live.' });
    await op('platform.textingSubmit', { workspaceId: w, registrationId: created.registrationId, reason: 'Resubmit after correction.' });
    await tick(w);
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'brand', registrationId: created.registrationId, status: 'APPROVED' } });
    await tick(w);
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'campaign', registrationId: created.registrationId, status: 'VERIFIED' } });
    await tick(w);
    state = await op('platform.textingRegistration', { workspaceId: w });
    expect(state.registrations[0]).toMatchObject({ state: 'approved', revision: 2 });
    number[w] = (state as unknown as { numbers: { e164: string }[] }).numbers[0]!.e164;
    // An older status after approval is recorded but cannot move it back; a duplicate is a no-op.
    const reg = (await rows<{ campaign_sid: string }>(w, 'SELECT campaign_sid FROM sms_registrations'))[0]!;
    const account = await db.read(w, sql => texting.registration.account(sql, w));
    const url = 'http://127.0.0.1:4310/api/v1/texting/twilio/registration?w=' + w;
    for (const status of ['IN_PROGRESS', 'VERIFIED']) {
      const params = { AccountSid: account!.accountSid, ResourceType: 'campaign', ResourceSid: reg.campaign_sid, Status: status };
      await texting.webhook('registration', url, params, twilioSignature(url, params, account!.authToken));
    }
    state = await op('platform.textingRegistration', { workspaceId: w });
    expect(state.registrations[0]!.state).toBe('approved');
    expect((await rows(w, `SELECT 1 FROM sms_audit WHERE action='registration.campaign_status_ignored'`)).length).toBe(1);
  });
});

describe('FL-AT-041 workspace isolation', () => {
  it('keeps numbers, contacts, consent, messages and links within one workspace on every path', async () => {
    await optIn(A.workspaceId, '+12125550101', 'Ann');
    await optIn(B.workspaceId, '+12125550201', 'Bea');
    const draft = await run<{ id: string; revision: number }>('sms.draft', { operationKey: key(), companyId: company[A.workspaceId], body: 'Sale today' });
    await expect(run('sms.sendStatus', { id: draft.id }, B)).rejects.toMatchObject({ code: 'not_found' });
    await expect(run('sms.preview', { id: draft.id }, B)).rejects.toMatchObject({ code: 'not_found' });
    await expect(run('sms.draft', { operationKey: key(), companyId: company[A.workspaceId], body: 'Hijack' }, B)).rejects.toMatchObject({ code: 'not_found' });
    const contactsB = await run<{ contacts: { phone: string }[] }>('sms.contacts', {}, B);
    expect(contactsB.contacts.map(c => c.phone)).toEqual(['+12125550201']);
    // HTTP and hosted MCP reach the same rule.
    const response = await http('sms.sendStatus', { id: draft.id }, 'test-b');
    expect(response.status).toBe(404);
    const issued = await issue(B, ['read', 'sms:send']);
    const client = new Client({ name: 'texting-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/api/v1/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + issued.token } } }));
    const result = await client.callTool({ name: 'sms_sendStatus', arguments: { id: draft.id } });
    expect(result.isError).toBe(true);
    await client.close();
    // Database row-level security: A's context cannot see or write B's rows.
    expect(await rows(A.workspaceId, 'SELECT * FROM sms_contacts WHERE phone_e164=$1', ['+12125550201'])).toEqual([]);
    await expect(db.tenant(A.workspaceId, sql => sql.query(`INSERT INTO sms_contacts(workspace_id,id,phone_e164) VALUES($1,$2,'+12125550999')`, [B.workspaceId, randomUUID()]))).rejects.toThrow(/row-level security/);
  });
  it('routes webhooks by number and account, and rejects a signature from another workspace', async () => {
    const countA = (await rows(A.workspaceId, 'SELECT 1 FROM sms_inbound')).length;
    await op('platform.textingMock', { workspaceId: B.workspaceId, action: { kind: 'inbound', from: '+12125550201', to: number[B.workspaceId], body: 'Thanks!' } });
    expect((await rows(A.workspaceId, 'SELECT 1 FROM sms_inbound')).length).toBe(countA);
    expect((await rows(B.workspaceId, `SELECT 1 FROM sms_inbound WHERE classification='other'`)).length).toBe(1);
    const accountA = await db.read(A.workspaceId, sql => texting.registration.account(sql, A.workspaceId));
    const accountB = await db.read(B.workspaceId, sql => texting.registration.account(sql, B.workspaceId));
    const url = 'http://127.0.0.1:4310/api/v1/texting/twilio/inbound';
    const forged = { AccountSid: accountB!.accountSid, MessageSid: 'SM' + 'f'.repeat(32), From: '+12125550201', To: number[B.workspaceId]!, Body: 'STOP' };
    await expect(texting.webhook('inbound', url, forged, twilioSignature(url, forged, accountA!.authToken))).rejects.toMatchObject({ code: 'signature_rejected' });
    // Over HTTP, an unsigned request is refused.
    const unsigned = await fetch(origin + '/api/v1/texting/twilio/inbound', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(forged) });
    expect(unsigned.status).toBe(403);
    // A request addressed to A's number but signed by B's account is ignored for A.
    const crossed = { AccountSid: accountB!.accountSid, MessageSid: 'SM' + 'e'.repeat(32), From: '+12125550101', To: number[A.workspaceId]!, Body: 'STOP' };
    await texting.webhook('inbound', url, crossed, twilioSignature(url, crossed, accountB!.authToken));
    expect((await rows(A.workspaceId, `SELECT state FROM sms_consents s JOIN sms_contacts c ON c.id=s.contact_id WHERE c.phone_e164='+12125550101'`))[0]).toEqual({ state: 'opted_in' });
  });
  it('never admits another workspace’s texts in a worker pass', async () => {
    const draftB = await run<{ id: string; revision: number }>('sms.draft', { operationKey: key(), companyId: company[B.workspaceId], body: 'B only' }, B);
    const review = await run<{ digest: string }>('sms.review', { id: draftB.id, expectedRevision: draftB.revision }, B);
    await run('sms.confirm', { operationKey: key(), id: draftB.id, expectedRevision: draftB.revision, digest: review.digest }, B);
    await texting.tick(A.workspaceId);
    expect((await rows(B.workspaceId, `SELECT state FROM sms_messages WHERE send_id=$1`, [draftB.id]))[0]).toEqual({ state: 'pending' });
    await tick(B.workspaceId);
    expect((await rows(B.workspaceId, `SELECT state FROM sms_messages WHERE send_id=$1`, [draftB.id]))[0]).toEqual({ state: 'delivered' });
  });
  it('keeps provider credentials and operator settings away from customer roles, and audits setting changes', async () => {
    await expect(db.pool.query('SELECT * FROM flockletter_customer_jobs.texting_accounts')).rejects.toThrow(/permission denied/);
    await expect(db.tenant(A.workspaceId, sql => sql.query(`SELECT * FROM flockletter_customer_jobs.texting_account($1)`, [B.workspaceId]))).rejects.toThrow(/texting_workspace_mismatch/);
    expect((await http('platform.textingSetSetting', {}, 'test-a')).status).toBe(404);
    const status = await run<Record<string, unknown>>('sms.status', {});
    expect(JSON.stringify(status)).not.toMatch(/authToken|keySecret|credentials/);
    await expect(setting('send_window_start_hour', 6)).rejects.toMatchObject({ code: 'setting_out_of_bounds' });
    await expect(setting('opt_out_words', ['PARAR'])).rejects.toMatchObject({ code: 'setting_out_of_bounds' });
    await expect(op('platform.textingSetSetting', { key: 'contact_monthly_limit', workspaceId: null, value: 5, expectedRevision: 0, reason: 'Stale revision attempt.' })).rejects.toMatchObject({ code: 'revision_conflict' });
    await setting('contact_monthly_limit', 4, A.workspaceId);
    const history = await op<{ key: string; old_value: unknown; new_value: unknown; actor_id: string; interface: string }[]>('platform.textingSettingHistory', { workspaceId: A.workspaceId });
    expect(history[0]).toMatchObject({ key: 'contact_monthly_limit', old_value: null, new_value: 4, actor_id: 'operator:user_operator', interface: 'operator_api' });
  });
});

describe('FL-AT-043 consent', () => {
  const w = A.workspaceId;
  const consent = async (phone: string) => (await rows<{ state: string }>(w, `SELECT s.state FROM sms_consents s JOIN sms_contacts c ON c.id=s.contact_id WHERE c.phone_e164=$1`, [phone]))[0]?.state;
  const brand = async () => (await rows<{ id: string }>(w, 'SELECT id FROM brands'))[0]!.id;
  it('records sign-up consent only from the checkbox, confirms by YES, and expires unconfirmed numbers', async () => {
    const brandId = await brand();
    const offer = await db.tenant(w, sql => texting.smsOffer(sql, w, brandId));
    expect(offer?.wording).toMatch(/Up to 4 msgs\/month/);
    await db.tenant(w, sql => texting.recordSignup(sql, w, brandId, null, { phone: '212 555 0301' }));
    expect(await consent('+12125550301')).toBe('none'); // a phone number alone is not consent
    await db.tenant(w, sql => texting.recordSignup(sql, w, brandId, null, { phone: '212 555 0302', smsConsent: true, wordingShown: offer!.wording, birthday: { month: 2, day: 29 } }));
    expect(await consent('+12125550302')).toBe('pending_confirmation');
    const event = (await rows<{ wording: string; policy_version: string }>(w, `SELECT e.wording,e.policy_version FROM sms_consent_events e JOIN sms_contacts c ON c.id=e.contact_id WHERE c.phone_e164='+12125550302'`))[0]!;
    expect(event).toEqual({ wording: offer!.wording, policy_version: 'sms-consent-v1' });
    expect((await rows(w, `SELECT 1 FROM contact_dates d JOIN sms_contacts c ON c.id=d.contact_id WHERE c.phone_e164='+12125550302' AND d.month=2 AND d.day=29`)).length).toBe(1);
    await tick(w);
    const sent = await rows<{ purpose: string; state: string }>(w, `SELECT purpose,state FROM sms_messages WHERE to_e164='+12125550302'`);
    expect(sent).toEqual([{ purpose: 'confirmation', state: 'delivered' }]);
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'inbound', from: '+12125550302', to: number[w], body: 'yes' } });
    expect(await consent('+12125550302')).toBe('opted_in');
    // Unconfirmed: nothing else is sent, and it expires.
    await db.tenant(w, sql => texting.recordSignup(sql, w, brandId, null, { phone: '212 555 0303', smsConsent: true, wordingShown: offer!.wording }));
    await db.tenant(w, sql => sql.query(`UPDATE sms_consents SET pending_expires_at=now()-interval '1 minute' FROM sms_contacts c WHERE c.id=sms_consents.contact_id AND c.phone_e164='+12125550303'`));
    await tick(w);
    expect(await consent('+12125550303')).toBe('none');
    expect((await rows(w, `SELECT 1 FROM sms_consent_events e JOIN sms_contacts c ON c.id=e.contact_id WHERE c.phone_e164='+12125550303' AND e.event='expired'`)).length).toBe(1);
    // Changed wording on the page is refused rather than recorded.
    await expect(db.tenant(w, sql => texting.recordSignup(sql, w, brandId, null, { phone: '212 555 0304', smsConsent: true, wordingShown: 'Different words' }))).rejects.toMatchObject({ code: 'consent_wording_changed' });
  });
  it('adds the texting fields to the hosted sign-up without changing either D-054 email setting', async () => {
    const brandId = await brand();
    const audience = new CustomerAudience(db, { mode: 'exercise', origin: 'http://127.0.0.1:4310', checkOwner: async () => true, contactLimit: async () => 250, texting });
    const configure = (patch: Record<string, unknown>) => audience.execute('audienceOnboarding.configure', { brandId, enabled: true, purpose: 'shop_news', policyVersion: 'v1',
      consentText: 'Send me Shop newsletters. I can unsubscribe anytime.', sourceDomain: 'shop.example.test', operationKey: key(), ...patch }, A);
    await configure({});
    const form = ((await audience.execute('audienceOnboarding.status', { brandId }, A)) as AudienceSettingsView).publicUrl!.split('/newsletter/')[1]!;
    const view = await audience.publicForm(form);
    expect(view.texting).toMatchObject({ phone: true, birthday: true, anniversary: false });
    const wording = view.texting!.smsWording!;
    const email = async (address: string) => (await db.brand(w, brandId, sql => sql.query<{ state: string }>('SELECT state FROM subscribers WHERE email_normalized=$1', [address]))).rows[0]?.state;
    // Double opt-in (default): the email stays pending its confirmation; the phone separately waits for YES.
    await audience.publicSignup(form, { email: 'double@example.com', policyVersion: 'v1', consentAffirmed: true, texting: { phone: '212-555-0331', smsConsent: true, wordingShown: wording, birthday: { month: 7, day: 4 } } });
    expect(await email('double@example.com')).toBe('pending');
    expect(await consent('+12125550331')).toBe('pending_confirmation');
    expect((await rows(w, `SELECT 1 FROM contact_dates WHERE subscriber_id IS NOT NULL AND month=7 AND day=4`)).length).toBe(1);
    // Email without a phone still works; a phone is never required.
    await audience.publicSignup(form, { email: 'nophone@example.com', policyVersion: 'v1', consentAffirmed: true, texting: { smsConsent: true, wordingShown: wording } });
    expect(await email('nophone@example.com')).toBe('pending');
    // Single opt-in: the email is confirmed at once, but texting still needs the YES reply.
    await configure({ confirmationMode: 'single_opt_in', policyVersion: 'v2' });
    await audience.publicSignup(form, { email: 'single@example.com', policyVersion: 'v2', consentAffirmed: true, texting: { phone: '212-555-0332', smsConsent: true, wordingShown: wording } });
    expect(await email('single@example.com')).toBe('confirmed');
    expect(await consent('+12125550332')).toBe('pending_confirmation');
  });
  it('shows carrier reviewers the SMS box on a view-only preview before the number is active, with the policy links', async () => {
    const brandId = await brand();
    const audience = new CustomerAudience(db, { mode: 'exercise', origin: 'http://127.0.0.1:4310', checkOwner: async () => true, contactLimit: async () => 250, texting });
    await audience.execute('audienceOnboarding.configure', { brandId, enabled: true, purpose: 'shop_news', policyVersion: 'v1',
      consentText: 'Send me Shop newsletters. I can unsubscribe anytime.', sourceDomain: 'shop.example.test', operationKey: key() }, A);
    const status = (await audience.execute('audienceOnboarding.status', { brandId }, A)) as AudienceSettingsView;
    const companyId = company[w]!;
    const terms = 'https://shop.example.test/sms-terms', privacy = 'https://shop.example.test/privacy';
    const offers = await db.tenant(w, async sql => {
      await sql.query('SAVEPOINT preview');
      // Before approval: no active number, so the live page offers no SMS box.
      await sql.query(`UPDATE sms_registrations SET state='campaign_pending'`);
      await sql.query(`UPDATE sms_carrier_brands SET sms_terms_confirmed_at=NULL, privacy_policy_confirmed_at=NULL WHERE company_id=$1`, [companyId]);
      const unconfirmed = await texting.smsOffer(sql, w, brandId, true);
      await sql.query(`UPDATE sms_carrier_brands SET profile=profile||jsonb_build_object('smsTermsUrl',$2::text,'privacyPolicyUrl',$3::text),
        sms_terms_confirmed_at=now(), privacy_policy_confirmed_at=now() WHERE company_id=$1`, [companyId, terms, privacy]);
      const live = await texting.smsOffer(sql, w, brandId);
      const preview = await texting.smsOffer(sql, w, brandId, true);
      const page = await signupPage(sql, companyId, 'http://127.0.0.1:4310');
      // Registration under way: the live page shows the same box greyed out, so carrier vetting sees the opt-in.
      const pendingView = await texting.signupView(sql, w, brandId);
      await sql.query(`UPDATE sms_registrations SET state='draft'`);
      const draftView = await texting.signupView(sql, w, brandId);
      await sql.query(`UPDATE sms_registrations SET state='campaign_pending'`);
      await sql.query(`UPDATE sms_workspace_profile SET phone_field=false`);
      const noPhone = await signupPage(sql, companyId, 'http://127.0.0.1:4310');
      const brandContext = (await sql.query<{ v: string | null }>("SELECT current_setting('app.intake_brand_id', true) v")).rows[0]!.v;
      await sql.query('ROLLBACK TO SAVEPOINT preview');
      return { unconfirmed, live, preview, page, noPhone, brandContext, pendingView, draftView };
    });
    expect(offers.unconfirmed).toBeNull(); // the preview needs the confirmed policies
    expect(offers.live).toBeNull();
    expect(offers.preview).toMatchObject({ smsTermsUrl: terms, privacyPolicyUrl: privacy });
    expect(offers.preview!.wording).toMatch(/Up to 4 msgs\/month/);
    expect(offers.page).toBe(status.signupUrl);
    expect(offers.noPhone).toBeNull(); // no phone field, no SMS box to show carriers
    expect(offers.brandContext ?? '').toBe(''); // the lookup clears the brand context it set
    expect(offers.pendingView).toMatchObject({ smsPending: true, smsWording: offers.preview!.wording, smsTermsUrl: terms, privacyPolicyUrl: privacy });
    expect(offers.draftView).toMatchObject({ smsWording: null });
    expect(offers.draftView).not.toHaveProperty('smsPending');
    const pendingHtml = renderToStaticMarkup(createElement(SignupFields, { consent: 'Email me.', version: 'v1', texting: offers.pendingView! }));
    expect(pendingHtml).toMatch(/<input type="checkbox" disabled="" name="smsConsent"/);
    expect(pendingHtml).not.toContain('name="smsWording"'); // nothing to record as consent
    expect(pendingHtml).toContain('Text messages start soon');
    expect(pendingHtml).toContain(`href="${terms}"`);
    expect(pendingHtml).toMatch(/<button[^>]*type="submit"/); // email sign-up still works
    // Over HTTP (the number is active again here): the slug route keeps ?preview=sms, submitting is off, links show.
    await db.tenant(w, sql => sql.query(`UPDATE sms_carrier_brands SET profile=profile||jsonb_build_object('smsTermsUrl',$2::text,'privacyPolicyUrl',$3::text),
      sms_terms_confirmed_at=now(), privacy_policy_confirmed_at=now() WHERE company_id=$1`, [companyId, terms, privacy]));
    const app = express(); app.use(['/signup', '/newsletter'], customerAudienceRoutes(audience));
    const local = await new Promise<Server>(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
    try {
      const port = (local.address() as { port: number }).port;
      const path = new URL(status.signupUrl!).pathname;
      const preview = await fetch(`http://127.0.0.1:${port}${path}?preview=sms`);
      expect(preview.status).toBe(200);
      const html = await preview.text();
      expect(html).toContain('name="smsConsent"');
      expect(html).toContain('Submitting is turned off on this preview.');
      expect(html).toMatch(/<button[^>]*disabled/);
      expect(html).toContain(`href="${terms}"`);
      expect(html).toContain(`href="${privacy}"`);
      const normal = await (await fetch(`http://127.0.0.1:${port}${path}`)).text();
      expect(normal).not.toContain('Submitting is turned off');
      expect(normal).toContain(`href="${terms}"`); // the live SMS box links its terms too
    } finally { await new Promise<void>(resolve => local.close(() => resolve())); }
  });
  it('handles STOP (English and Spanish), HELP, START and pending re-enrollment for the number that received them', async () => {
    await optIn(w, '+12125550311', 'Stu');
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'inbound', from: '+12125550311', to: number[w], body: 'Stop' } });
    expect(await consent('+12125550311')).toBe('opted_out');
    await optIn(w, '+12125550312', 'Sofia');
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'inbound', from: '+12125550312', to: number[w], body: 'PARAR' } });
    expect(await consent('+12125550312')).toBe('opted_out');
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'inbound', from: '+12125550311', to: number[w], body: 'HELP' } });
    await tick(w);
    const help = (await rows<{ rendered_body: string }>(w, `SELECT rendered_body FROM sms_messages WHERE purpose='help' AND to_e164='+12125550311'`))[0]!;
    expect(help.rendered_body).toBe('Synthetic A: For help contact help@example.com. Reply STOP to opt out.');
    // STOP to A's number does not change consent for B's company.
    expect((await rows(B.workspaceId, `SELECT 1 FROM sms_contacts WHERE phone_e164='+12125550311'`)).length).toBe(0);
    // Re-adding an opted-out contact needs acknowledgement, then waits for START.
    await expect(run('sms.addContact', { operationKey: key(), companyId: company[w], phone: '+12125550311' })).rejects.toMatchObject({ code: 'reenrollment_acknowledgement_required' });
    await run('sms.addContact', { operationKey: key(), companyId: company[w], phone: '+12125550311', acknowledgeOptOut: true });
    expect(await consent('+12125550311')).toBe('pending_reenrollment');
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'inbound', from: '+12125550311', to: number[w], body: 'START' } });
    expect(await consent('+12125550311')).toBe('opted_in');
    // Unknown numbers are logged, never added.
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'inbound', from: '+12125550399', to: number[w], body: 'hello' } });
    expect((await rows(w, `SELECT 1 FROM sms_contacts WHERE phone_e164='+12125550399'`)).length).toBe(0);
    expect((await rows(w, `SELECT 1 FROM sms_inbound WHERE from_e164='+12125550399' AND classification='unknown_number'`)).length).toBe(1);
    // Imported or manually added numbers never carry consent.
    await run('sms.addContact', { operationKey: key(), companyId: company[w], phone: '+12125550313' });
    expect(await consent('+12125550313')).toBe('none');
  });
  it('marks a permanent failure not textable and keeps consent evidence immutable', async () => {
    await optIn(w, '+12125550321', 'Fay');
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'fault', target: 'send', faults: ['invalid'] } });
    const draft = await run<{ id: string; revision: number }>('sms.draft', { operationKey: key(), companyId: company[w], body: 'Only Fay sees this' });
    await db.tenant(w, sql => sql.query(`UPDATE sms_consents SET state='none' FROM sms_contacts c WHERE c.id=sms_consents.contact_id AND c.phone_e164<>'+12125550321'`));
    const review = await run<{ digest: string; recipients: number }>('sms.review', { id: draft.id, expectedRevision: draft.revision });
    expect(review.recipients).toBe(1);
    await run('sms.confirm', { operationKey: key(), id: draft.id, expectedRevision: draft.revision, digest: review.digest });
    await tick(w);
    const contact = (await run<{ contacts: { phone: string; notTextableReason: string }[] }>('sms.contacts', { filter: 'not_textable' })).contacts;
    expect(contact).toEqual([expect.objectContaining({ phone: '+12125550321', notTextableReason: 'invalid' })]);
    // A rejected text uses no allowance: its reservation is released.
    expect(await rows(w, `SELECT state,reserved_segments FROM sms_messages WHERE send_id=$1`, [draft.id])).toEqual([{ state: 'failed', reserved_segments: 0 }]);
    await expect(db.tenant(w, sql => sql.query(`UPDATE sms_consent_events SET wording='changed'`))).rejects.toThrow(/permission denied/);
    await expect(db.tenant(w, sql => sql.query(`DELETE FROM sms_consent_events`))).rejects.toThrow(/permission denied/);
    await db.tenant(w, sql => sql.query(`UPDATE sms_consents SET state='opted_in' WHERE state='none' AND contact_id IN (SELECT id FROM sms_contacts WHERE phone_e164 IN ('+12125550101','+12125550302','+12125550311'))`));
  });
});

describe('FL-AT-044 sending', () => {
  const w = A.workspaceId;
  it('requires an explicit send grant on every interface', async () => {
    const member: Actor = { ...A, userId: 'user_member', actorId: 'user:user_member', owner: false };
    await db.tenant(w, async sql => {
      await sql.query(`INSERT INTO team_grants(workspace_id,user_id,permission,updated_by) VALUES($1,'user_member','editor','test')`, [w]);
      await sql.query(`INSERT INTO team_grant_brands(workspace_id,user_id,brand_id) SELECT $1,'user_member',id FROM brands`, [w]);
    });
    let perms = await db.tenant(w, sql => memberPermissions(sql, w, 'user_member', oneSeatTeam));
    expect(perms.scopes).not.toContain('sms:send');
    expect(() => authorize({ ...member, scopes: perms.scopes }, 'sms.confirm')).toThrow(/sms:send/);
    expect(() => authorize({ ...member, scopes: perms.scopes }, 'sms.draft')).not.toThrow();
    await run('team.grant', { operationKey: key(), userId: 'user_member', permission: 'editor', brandIds: [(await rows<{ id: string }>(w, 'SELECT id FROM brands'))[0]!.id], smsSend: true }).catch(() => undefined);
    await db.tenant(w, sql => sql.query(`UPDATE team_grants SET sms_send=true WHERE user_id='user_member'`));
    perms = await db.tenant(w, sql => memberPermissions(sql, w, 'user_member', oneSeatTeam));
    expect(perms.scopes).toContain('sms:send');
    const viewer = { ...member, scopes: ['read'] as Actor['scopes'] };
    expect(() => authorize(viewer, 'sms.confirm')).toThrow();
    const readOnly = await issue(A, ['read']);
    expect((await http('sms.confirm', { operationKey: key(), id: randomUUID(), expectedRevision: 1, digest: 'a'.repeat(64) }, readOnly.token)).status).toBe(403);
    const client = new Client({ name: 'texting-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/api/v1/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + readOnly.token } } }));
    expect((await client.listTools()).tools.map(t => t.name)).not.toContain('sms_confirm');
    await client.close();
  });
  it('limits test texts per day to a verified phone', async () => {
    const draft = await run<{ id: string; revision: number }>('sms.draft', { operationKey: key(), companyId: company[w], body: 'Test me' });
    await expect(run('sms.testSend', { operationKey: key(), id: draft.id, expectedRevision: 1 })).rejects.toMatchObject({ code: 'phone_not_verified' });
    await run('sms.verifyPhone', { operationKey: key(), phone: '+12125550401' });
    await tick(w);
    const code = (await rows<{ rendered_body: string }>(w, `SELECT rendered_body FROM sms_messages WHERE purpose='verification'`))[0]!.rendered_body.match(/\d{6}/)![0];
    expect(await run('sms.confirmPhone', { operationKey: key(), code: code === '000000' ? '111111' : '000000' })).toEqual({ verified: false });
    expect(await run('sms.confirmPhone', { operationKey: key(), code })).toEqual({ verified: true });
    await run('sms.testSend', { operationKey: key(), id: draft.id, expectedRevision: 1 });
    await run('sms.testSend', { operationKey: key(), id: draft.id, expectedRevision: 1 });
    await expect(run('sms.testSend', { operationKey: key(), id: draft.id, expectedRevision: 1 })).rejects.toMatchObject({ code: 'test_limit' });
    await tick(w);
    expect((await rows(w, `SELECT 1 FROM sms_messages WHERE purpose='test' AND state='delivered' AND rendered_body LIKE '[Test]%'`)).length).toBe(2);
  });
  it('blocks emoji, converts curly quotes, and counts segments per recipient after merge fields', async () => {
    await expect(run('sms.draft', { operationKey: key(), companyId: company[w], body: 'Party time \u{1F389}' })).rejects.toMatchObject({ code: 'text_characters_blocked' });
    await expect(run('sms.draft', { operationKey: key(), companyId: company[w], body: 'Hearts ♥ forever' })).rejects.toMatchObject({ code: 'text_characters_blocked' });
    const draft = await run<{ id: string; revision: number; body: string }>('sms.draft', { operationKey: key(), companyId: company[w], body: '“Hello” {{name|friend}} — ' + 'x'.repeat(100) });
    expect(draft.body.startsWith('"Hello" {{name|friend}} - ')).toBe(true);
    await optIn(w, '+12125550411', 'Zoë');
    const review = await run<{ gsm7Recipients: number; ucs2Recipients: number; segments: number; recipients: number }>('sms.review', { id: draft.id, expectedRevision: draft.revision });
    expect(review.ucs2Recipients).toBe(1);
    expect(review.gsm7Recipients).toBe(review.recipients - 1);
    expect(review.segments).toBeGreaterThan(review.recipients); // the ucs2 recipient needs more segments
    await run('sms.cancel', { operationKey: key(), id: draft.id });
  });
  it('waits for quiet hours in each recipient\u2019s zone, and applies daily and frequency limits with an estimate', async () => {
    await optIn(w, '+13105550421', 'Pia'); // Los Angeles
    await optIn(w, '+18085550422', 'Kai'); // Honolulu
    const audience = (await rows<{ phone_e164: string }>(w, `SELECT c.phone_e164 FROM sms_consents s JOIN sms_contacts c ON c.id=s.contact_id WHERE s.state='opted_in' AND c.textable`)).map(r => r.phone_e164);
    expect(audience.length).toBeGreaterThanOrEqual(4);
    // 9 p.m. Eastern = 6 p.m. Pacific = 4 p.m. Hawaii.
    clock = at(3, 2);
    const late = await run<{ id: string; revision: number }>('sms.draft', { operationKey: key(), companyId: company[w], body: 'Weekend hours' });
    const lateReview = await run<{ digest: string }>('sms.review', { id: late.id, expectedRevision: late.revision });
    await run('sms.confirm', { operationKey: key(), id: late.id, expectedRevision: late.revision, digest: lateReview.digest });
    // A sign-up during quiet hours gets its YES confirmation at once; one queued long before (sending was down) waits.
    const brandId = (await rows<{ id: string }>(w, 'SELECT id FROM brands'))[0]!.id;
    const offer = await db.tenant(w, sql => texting.smsOffer(sql, w, brandId));
    await db.tenant(w, sql => texting.recordSignup(sql, w, brandId, null, { phone: '212 555 0431', smsConsent: true, wordingShown: offer!.wording }));
    await db.tenant(w, sql => texting.recordSignup(sql, w, brandId, null, { phone: '212 555 0432', smsConsent: true, wordingShown: offer!.wording }));
    await db.tenant(w, sql => sql.query(`UPDATE sms_messages SET created_at=clock_timestamp()-interval '11 minutes' WHERE to_e164='+12125550432'`));
    await tick(w);
    const confirmations = await rows<{ to_e164: string; state: string; reason: string | null }>(w, `SELECT to_e164,state,reason FROM sms_messages WHERE purpose='confirmation' AND to_e164 IN ('+12125550431','+12125550432') ORDER BY to_e164`);
    expect(confirmations).toEqual([{ to_e164: '+12125550431', state: 'delivered', reason: null }, { to_e164: '+12125550432', state: 'pending', reason: 'quiet_hours' }]);
    const byPhone = await rows<{ to_e164: string; state: string; reason: string | null; next_check_at: Date }>(w, `SELECT to_e164,state,reason,next_check_at FROM sms_messages WHERE send_id=$1`, [late.id]);
    for (const message of byPhone) {
      if (message.to_e164.startsWith('+1212')) { expect(message).toMatchObject({ state: 'pending', reason: 'quiet_hours' }); expect([13, 14]).toContain(message.next_check_at.getUTCHours()); }
      else expect(message.state).toBe('delivered');
    }
    clock = at(3, 20); await tick(w);
    expect((await rows<{ state: string }>(w, `SELECT state FROM sms_messages WHERE send_id=$1`, [late.id])).every(m => m.state === 'delivered')).toBe(true);
    // Daily limit: a send larger than the limit is spread over days, and the estimate says so first.
    await setting('carrier_daily_limit', 2, w);
    clock = at(5, 20);
    const big = await run<{ id: string; revision: number }>('sms.draft', { operationKey: key(), companyId: company[w], body: 'Spread over days' });
    const review = await run<{ digest: string; recipients: number; daysNeeded: number }>('sms.review', { id: big.id, expectedRevision: big.revision });
    expect(review.daysNeeded).toBe(Math.ceil(review.recipients / 2));
    await run('sms.confirm', { operationKey: key(), id: big.id, expectedRevision: big.revision, digest: review.digest });
    await tick(w);
    let states = await rows<{ state: string; reason: string | null }>(w, `SELECT state,reason FROM sms_messages WHERE send_id=$1`, [big.id]);
    expect(states.filter(m => m.state === 'delivered')).toHaveLength(2);
    expect(states.filter(m => m.reason === 'daily_limit')).toHaveLength(review.recipients - 2);
    for (let day = 6; day < 6 + review.daysNeeded; day++) { clock = at(day, 20); await tick(w); }
    states = await rows(w, `SELECT state,reason FROM sms_messages WHERE send_id=$1`, [big.id]);
    expect(states.every(m => m.state === 'delivered')).toBe(true);
    await setting('carrier_daily_limit', null, w);
    // Frequency: with a limit of 2 per month, a third marketing text this month is skipped.
    await setting('contact_monthly_limit', 2, w);
    const third = await run<{ id: string; revision: number }>('sms.draft', { operationKey: key(), companyId: company[w], body: 'One more' });
    const thirdReview = await run<{ digest: string }>('sms.review', { id: third.id, expectedRevision: third.revision });
    await run('sms.confirm', { operationKey: key(), id: third.id, expectedRevision: third.revision, digest: thirdReview.digest });
    clock = at(12, 20); await tick(w);
    const skipped = await rows<{ to_e164: string; reason: string }>(w, `SELECT to_e164,reason FROM sms_messages WHERE send_id=$1`, [third.id]);
    expect(skipped.length).toBeGreaterThan(0);
    for (const m of skipped) expect(m.reason).toBe('frequency_limit');
    await setting('contact_monthly_limit', null, w);
  });
  it('loses nothing and sends nothing twice across a restart, and stops at the allowance', async () => {
    await op('platform.textingMock', { workspaceId: w, action: { kind: 'fault', target: 'send', faults: ['timeout_after_commit', '5xx', '429'] } });
    clock = at(33, 20); // the next month, mid-afternoon in every US zone
    const draft = await run<{ id: string; revision: number }>('sms.draft', { operationKey: key(), companyId: company[w], body: 'Restart safe' });
    const review = await run<{ digest: string; recipients: number }>('sms.review', { id: draft.id, expectedRevision: draft.revision });
    await run('sms.confirm', { operationKey: key(), id: draft.id, expectedRevision: draft.revision, digest: review.digest });
    await texting.tick(w);
    const restarted = Texting.mock(db, { origin: 'http://127.0.0.1:4310', linkOrigin: 'http://127.0.0.1:4310/l', isOwner: identity.isOwner, now });
    for (let i = 0; i < 6; i++) { clock += 2 * 60000; await restarted.deliverMockCallbacks(); await restarted.tick(w); }
    const sent = await rows<{ id: string; state: string }>(w, `SELECT id,state FROM sms_messages WHERE send_id=$1`, [draft.id]);
    expect(sent).toHaveLength(review.recipients);
    expect(sent.every(m => m.state === 'delivered')).toBe(true);
    for (const message of sent) expect(await texting.mock!.messaging.sends(message.id)).toBe(1);
    // Allowance exhaustion stops sending and blocks confirmation.
    const used = (await rows<{ used: number }>(w, `SELECT segments_used+segments_reserved AS used FROM sms_usage ORDER BY period_month DESC LIMIT 1`))[0]!.used;
    await setting('monthly_segment_allowance', used + 1, w);
    const big = await run<{ id: string; revision: number }>('sms.draft', { operationKey: key(), companyId: company[w], body: 'Too many' });
    const reviewBig = await run<{ digest: string; gaps: string[] }>('sms.review', { id: big.id, expectedRevision: big.revision });
    expect(reviewBig.gaps).toContain('allowance_insufficient');
    await expect(run('sms.confirm', { operationKey: key(), id: big.id, expectedRevision: big.revision, digest: reviewBig.digest })).rejects.toMatchObject({ code: 'send_not_ready' });
    await setting('monthly_segment_allowance', null, w);
  });
  it('sends only allowed links, through case-sensitive short codes that expire', async () => {
    const bad = await run<{ id: string; revision: number }>('sms.draft', { operationKey: key(), companyId: company[w], body: 'See https://evil.example.net/x' });
    expect((await run<{ gaps: string[] }>('sms.review', { id: bad.id, expectedRevision: bad.revision })).gaps).toContain('link_not_allowed');
    const signup = 'http://127.0.0.1:4310/signup/Shop';
    const ok = await run<{ id: string; revision: number }>('sms.draft', { operationKey: key(), companyId: company[w], body: 'Join us ' + signup });
    const review = await run<{ digest: string; gaps: string[] }>('sms.review', { id: ok.id, expectedRevision: ok.revision });
    expect(review.gaps).toEqual([]);
    await run('sms.confirm', { operationKey: key(), id: ok.id, expectedRevision: ok.revision, digest: review.digest });
    const body = (await rows<{ rendered_body: string }>(w, `SELECT rendered_body FROM sms_messages WHERE send_id=$1 LIMIT 1`, [ok.id]))[0]!.rendered_body;
    const code = body.match(/\/l\/shop-a\/([A-Za-z0-9]{7})/)![1]!;
    expect(body).not.toContain(signup);
    expect(await texting.resolveLink('shop-a', code)).toBe(signup);
    const flipped = code.replace(/[a-z]/, c => c.toUpperCase()) !== code ? code.replace(/[a-z]/, c => c.toUpperCase()) : code.replace(/[A-Z]/, c => c.toLowerCase());
    expect(await texting.resolveLink('shop-a', flipped)).toBeNull();
    expect(await texting.resolveLink('shop-b', code)).toBeNull();
    const redirect = await fetch(`${origin}/l/shop-a/${code}`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe(signup);
    // A link to the verified domain expires after the link life.
    await db.tenant(w, sql => sql.query(`INSERT INTO sms_links(workspace_id,code,destination,expires_at) VALUES($1,'Exp1red','https://example.com/a',now()-interval '1 second')`, [w]));
    await db.tenant(w, sql => sql.query(`SELECT flockletter_customer_jobs.texting_register_link($1,'shop-a','Exp1red')`, [w]));
    expect(await texting.resolveLink('shop-a', 'Exp1red')).toBeNull();
  });
});

describe('live registration wording', () => {
  const wording = { description: 'Synthetic C texts past and future guests about open dates, seasonal offers and local news for its rental condo.',
    samples: ['Synthetic C: Two winter weekends just opened at the lake condo. Book at example.com. Reply STOP to opt out.',
      'Synthetic C: Summer is here! Stay 4 nights in June and get the 5th free. Reply STOP to opt out.'] };
  it('refuses a business Twilio would refuse before anything is stored', async () => {
    const w = A.workspaceId, base = { workspaceId: w, companyId: randomUUID(), legalName: 'Synthetic C LLC', dbaName: null, helpContact: 'help@example.com', reason: 'Synthetic business check.' };
    await expect(op('platform.textingCarrierBrand', { ...base, entityType: 'non_profit', profile })).rejects.toMatchObject({ code: 'business_type_mismatch' });
    await expect(op('platform.textingCarrierBrand', { ...base, entityType: 'government', profile: { ...profile, businessType: 'Non-profit Corporation' } })).rejects.toMatchObject({ code: 'industry_mismatch' });
    await expect(op('platform.textingCarrierBrand', { ...base, entityType: 'public_profit', profile })).rejects.toMatchObject({ code: 'public_company_unsupported' });
    await expect(op('platform.textingCarrierBrand', { ...base, entityType: 'sole_proprietor', profile })).rejects.toMatchObject({ code: 'sole_proprietor_unsupported' });
    await expect(op('platform.textingCarrierBrand', { ...base, entityType: 'private_profit', profile: { ...profile, vertical: 'Vacation rentals' } })).rejects.toThrow();
    await expect(op('platform.textingCarrierBrand', { ...base, entityType: 'private_profit', profile: { ...profile, businessType: 'LLC' } })).rejects.toThrow();
  });
  it('refuses live submit without the business’s own campaign wording, then files it as written', async () => {
    const w = A.workspaceId;
    const companyId = randomUUID();
    await db.tenant(w, sql => sql.query(`INSERT INTO companies(workspace_id,id,name,is_default) VALUES($1,$2,'Synthetic C',false)`, [w, companyId]));
    const created = await op<{ carrierBrandId: string; registrationId: string }>('platform.textingCarrierBrand', { workspaceId: w, companyId, legalName: 'Synthetic C LLC', dbaName: 'Synthetic C', entityType: 'private_profit', profile: { ...profile, vertical: 'HOSPITALITY' }, helpContact: 'help@example.com', reason: 'Synthetic live wording check.' });
    await op('platform.textingConfirmPolicies', { workspaceId: w, carrierBrandId: created.carrierBrandId, privacyPolicyUrl: 'https://example.com/privacy', smsTermsUrl: 'https://example.com/sms-terms', reason: 'Synthetic policies are live.' });
    const mock = texting.registration.options.platform;
    const calls: { name: string; args: unknown[] }[] = [];
    const livePlatform = new Proxy(mock, { get(target, name, receiver) {
      if (name === 'mode') return 'live';
      const value = Reflect.get(target, name, receiver) as unknown;
      return typeof value === 'function' ? (...args: unknown[]) => { calls.push({ name: String(name), args }); return (value as (...a: unknown[]) => unknown).apply(target, args); } : value;
    } });
    const live = new TextingRegistration({ ...texting.registration.options, platform: livePlatform });
    const submit = () => db.tenant(w, sql => live.submit(sql, w, created.registrationId, 'user_operator', 'operator_api'));
    await expect(submit()).rejects.toMatchObject({ code: 'campaign_wording_missing' });
    expect(calls).toEqual([]);
    // Correcting the draft with the wording clears the policy confirmation, as any correction does.
    await op('platform.textingCarrierBrand', { workspaceId: w, companyId, legalName: 'Synthetic C LLC', dbaName: 'Synthetic C', entityType: 'private_profit', profile: { ...profile, vertical: 'HOSPITALITY' }, campaign: wording, helpContact: 'help@example.com', reason: 'Add the campaign wording.' });
    await op('platform.textingConfirmPolicies', { workspaceId: w, carrierBrandId: created.carrierBrandId, privacyPolicyUrl: 'https://example.com/privacy', smsTermsUrl: 'https://example.com/sms-terms', reason: 'Synthetic policies are live.' });
    await expect(submit()).resolves.toMatchObject({ state: 'provisioning' });
    const stored = (await rows<{ profile: { campaign: unknown; businessType: string } }>(w, 'SELECT profile FROM sms_carrier_brands WHERE id=$1', [created.carrierBrandId]))[0]!;
    expect(stored.profile).toMatchObject({ campaign: wording, businessType: 'Limited Liability Corporation' });
    await db.tenant(w, sql => sql.query(`UPDATE sms_registrations SET state='draft' WHERE id=$1`, [created.registrationId]));
  });
  it('records a campaign resubmitted in the Twilio Console and goes back to waiting on its status', async () => {
    const w = A.workspaceId;
    const companyId = randomUUID();
    await db.tenant(w, sql => sql.query(`INSERT INTO companies(workspace_id,id,name,is_default) VALUES($1,$2,'Synthetic E',false)`, [w, companyId]));
    const created = await op<{ carrierBrandId: string; registrationId: string }>('platform.textingCarrierBrand', { workspaceId: w, companyId, legalName: 'Synthetic E LLC', dbaName: 'Synthetic E', entityType: 'private_profit', profile: { ...profile, vertical: 'HOSPITALITY' }, campaign: wording, helpContact: 'help@example.com', reason: 'Synthetic resubmitted campaign.' });
    const resubmitted = () => op<{ state: string }>('platform.textingCampaignResubmitted', { workspaceId: w, registrationId: created.registrationId, reason: 'Added policy URLs and resubmitted in the Twilio Console.' });
    await expect(resubmitted()).rejects.toMatchObject({ code: 'campaign_not_failed' });
    const sid = 'QE' + 'e'.repeat(32);
    await db.tenant(w, sql => sql.query(`UPDATE sms_registrations SET state='rejected',campaign_sid=$2,campaign_status='FAILED',rejection_reason='campaign: 30908' WHERE id=$1`, [created.registrationId, sid]));
    await expect(resubmitted()).resolves.toMatchObject({ state: 'campaign_pending' });
    expect((await rows(w, 'SELECT state,campaign_status,rejection_reason FROM sms_registrations WHERE id=$1', [created.registrationId]))[0]).toEqual({ state: 'campaign_pending', campaign_status: 'IN_PROGRESS', rejection_reason: null });
    await expect(resubmitted()).rejects.toMatchObject({ code: 'campaign_not_failed' });
    // The carrier's verdict on the same campaign now applies as a forward move.
    await db.tenant(w, sql => texting.registration.status(sql, w, 'campaign', sid, 'VERIFIED', null, 'worker'));
    expect((await rows<{ campaign_status: string }>(w, 'SELECT campaign_status FROM sms_registrations WHERE id=$1', [created.registrationId]))[0]!.campaign_status).toBe('VERIFIED');
    await db.tenant(w, sql => sql.query(`UPDATE sms_registrations SET state='draft' WHERE id=$1`, [created.registrationId]));
  });
  it('widens the checkbox wording and its policy version when the campaign covers stay texts', () => {
    expect(smsConsentWording('Synthetic D', 4)).toMatch(/^Yes, text me offers and updates from Synthetic D\./);
    expect(smsConsentWording('Synthetic D', 4, true)).toMatch(/^Yes, text me offers, updates and info about my stays from Synthetic D\. Up to 4 msgs\/month\./);
    expect([smsConsentPolicyVersion(), smsConsentPolicyVersion(true)]).toEqual(['sms-consent-v1', 'sms-consent-stay-v1']);
  });
  it('changes campaign wording after submit, holds the campaign until the SMS terms are confirmed again, and refuses once filed', async () => {
    const w = A.workspaceId;
    const companyId = randomUUID();
    await db.tenant(w, sql => sql.query(`INSERT INTO companies(workspace_id,id,name,is_default) VALUES($1,$2,'Synthetic D',false)`, [w, companyId]));
    const created = await op<{ carrierBrandId: string; registrationId: string }>('platform.textingCarrierBrand', { workspaceId: w, companyId, legalName: 'Synthetic D LLC', dbaName: 'Synthetic D', entityType: 'private_profit', profile: { ...profile, vertical: 'HOSPITALITY' }, campaign: wording, helpContact: 'help@example.com', reason: 'Synthetic campaign wording change.' });
    const confirm = () => op('platform.textingConfirmPolicies', { workspaceId: w, carrierBrandId: created.carrierBrandId, privacyPolicyUrl: 'https://example.com/privacy', smsTermsUrl: 'https://example.com/sms-terms', reason: 'Synthetic policies are live.' });
    await confirm();
    const mock = texting.registration.options.platform;
    const calls: string[] = [];
    const livePlatform = new Proxy(mock, { get(target, name, receiver) {
      if (name === 'mode') return 'live';
      const value = Reflect.get(target, name, receiver) as unknown;
      return typeof value === 'function' ? (...args: unknown[]) => { calls.push(String(name)); return (value as (...a: unknown[]) => unknown).apply(target, args); } : value;
    } });
    const live = new TextingRegistration({ ...texting.registration.options, platform: livePlatform });
    await expect(db.tenant(w, sql => live.submit(sql, w, created.registrationId, 'user_operator', 'operator_api'))).resolves.toMatchObject({ state: 'provisioning' });
    const stay = { ...wording, useCase: 'LOW_VOLUME', stayTexts: true };
    const change = (campaign: Record<string, unknown>) => op<{ policiesCleared: boolean }>('platform.textingCampaignWording', { workspaceId: w, carrierBrandId: created.carrierBrandId, campaign, reason: 'Cover stay texts on a Low Volume Mixed campaign.' });
    await expect(change(stay)).resolves.toMatchObject({ policiesCleared: true });
    const stored = (await rows<{ profile: { campaign: unknown }; terms: Date | null }>(w, 'SELECT profile,sms_terms_confirmed_at terms FROM sms_carrier_brands WHERE id=$1', [created.carrierBrandId]))[0]!;
    expect(stored).toMatchObject({ profile: { campaign: stay }, terms: null });
    // Same coverage again: wording changes, confirmation is kept.
    await confirm();
    await expect(change({ ...stay, samples: [...stay.samples, 'Synthetic D: Your check-in code arrives the morning of arrival. Reply STOP to opt out.'] })).resolves.toMatchObject({ policiesCleared: false });
    await expect(change(wording)).resolves.toMatchObject({ policiesCleared: true });
    await change(stay);
    // Brand approved and earlier steps done: the campaign still waits while the terms are unconfirmed, even with an approval.
    const reg = (await rows<{ revision: number }>(w, 'SELECT revision FROM sms_registrations WHERE id=$1', [created.registrationId]))[0]!;
    await db.tenant(w, async sql => {
      await sql.query(`UPDATE sms_registrations SET brand_status='APPROVED',state='brand_pending' WHERE id=$1`, [created.registrationId]);
      await sql.query(`UPDATE sms_registration_steps SET state='done' WHERE registration_id=$1 AND revision=$2 AND step IN ('subaccount','customer_profile','brand','messaging_service')`, [created.registrationId, reg.revision]);
      await sql.query(`INSERT INTO sms_operator_approvals(workspace_id,id,registration_id,revision,step,cost_note,approved_by) VALUES($1,$2,$3,$4,'campaign','Synthetic','user_operator')`, [w, randomUUID(), created.registrationId, reg.revision]);
    });
    await expect(live.advance(w, created.registrationId)).resolves.toBeNull();
    expect(calls).not.toContain('submitCampaign');
    expect((await rows<{ state: string }>(w, `SELECT state FROM sms_registration_steps WHERE registration_id=$1 AND revision=$2 AND step='campaign'`, [created.registrationId, reg.revision]))[0]!.state).toBe('queued');
    // Once the campaign has gone to the carrier, its wording is fixed.
    await db.tenant(w, sql => sql.query(`UPDATE sms_registration_steps SET state='calling' WHERE registration_id=$1 AND revision=$2 AND step='campaign'`, [created.registrationId, reg.revision]));
    await expect(change(stay)).rejects.toMatchObject({ code: 'campaign_already_filed' });
    await db.tenant(w, sql => sql.query(`UPDATE sms_registrations SET state='draft' WHERE id=$1`, [created.registrationId]));
  });
});
