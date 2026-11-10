import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import type { Actor } from '../src/server/service.js';
import type { DeliveryView } from '../src/shared/customer-delivery.js';
import type { CustomerCampaignPreflight } from '../src/shared/customer-preflight.js';
import { createTestSendFixture } from './helpers/test-send-fixture.js';
import {saveSenderProfile,addCampaignPhoto} from './helpers/delivery-profile.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../src/mcp/bridge.js';
import {makeAudienceConnection} from './helpers/audience-connection.js';
type Fixture=Awaited<ReturnType<typeof createTestSendFixture>>;

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database;
type TestReview = DeliveryView & { purpose: 'test'; testSubscriberId: string };

beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
});

afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});

const selection = (f: Fixture) => ({ brandId: f.brandId, campaignId: f.campaign.id, subscriberId: f.subscriberId });

async function review(f: Fixture, actor: Actor = f.actor, target = selection(f), extra: Record<string, unknown> = {}) {
  return (await f.delivery.execute('delivery.reviewTest', { operationKey: randomUUID(), ...target, expectedVersion: 1, ...extra }, actor)) as TestReview;
}

async function approve(f: Fixture, row: TestReview, actor: Actor = f.actor, extra: Record<string, unknown> = {}) {
  return (await f.delivery.execute('delivery.approveTest', { operationKey: randomUUID(), brandId: row.brandId, id: row.id, subscriberId: row.testSubscriberId, expectedVersion: row.version, ...extra }, actor)) as TestReview;
}

it('reports broadcasts_disabled in preflight for broadcast purpose only', async () => {
  const f = await createTestSendFixture(db, { scope: 'tests' });

  const broadcastPreflight = await f.delivery.execute(
    'delivery.preflight',
    { brandId: f.brandId, campaignId: f.campaign.id, purpose: 'broadcast' },
    f.actor,
  ) as CustomerCampaignPreflight;

  expect(broadcastPreflight.gaps.some((gap) => gap.code === 'broadcasts_disabled')).toBe(true);

  const testPreflight = await f.delivery.execute(
    'delivery.preflight',
    { brandId: f.brandId, campaignId: f.campaign.id, purpose: 'test', subscriberId: f.subscriberId },
    f.actor,
  ) as CustomerCampaignPreflight;

  expect(testPreflight.gaps.some((gap) => gap.code === 'broadcasts_disabled')).toBe(false);
});

it('rejects direct broadcast review before rows or allowance when scope is tests', async () => {
  const f = await createTestSendFixture(db, { scope: 'tests' });

  await expect(
    f.delivery.execute(
      'delivery.review',
      { operationKey: randomUUID(), brandId: f.brandId, campaignId: f.campaign.id, expectedVersion: 1 },
      f.actor,
    ),
  ).rejects.toMatchObject({ status: 403, code: 'broadcasts_disabled' });

  const deliveries = await db.tenant(f.workspaceId, async (sql) =>
    sql.query<{ n: number }>('SELECT count(*)::int n FROM customer_deliveries WHERE purpose=\'broadcast\''),
  );
  expect(deliveries.rows[0]!.n).toBe(0);

  const recipients = await db.tenant(f.workspaceId, async (sql) =>
    sql.query<{ n: number }>('SELECT count(*)::int n FROM customer_delivery_recipients'),
  );
  expect(recipients.rows[0]!.n).toBe(0);

  const usage = await f.billing.status(f.workspaceId);
  expect(usage.usage.reservedCampaigns).toBe(0);
});

it('rejects approval of a prior reviewed broadcast after scope is mutated to tests', async () => {
  const f = await createTestSendFixture(db);

  const row = (await f.delivery.execute(
    'delivery.review',
    { operationKey: randomUUID(), brandId: f.brandId, campaignId: f.campaign.id, expectedVersion: 1 },
    f.actor,
  )) as DeliveryView;

  expect(row.state).toBe('reviewed');

  f.options.scope = 'tests';

  await expect(
    f.delivery.execute(
      'delivery.approve',
      { operationKey: randomUUID(), brandId: f.brandId, id: row.id },
      f.actor,
    ),
  ).rejects.toMatchObject({ status: 403, code: 'broadcasts_disabled' });

  const report = await f.delivery.execute('delivery.report', { brandId: f.brandId, id: row.id }, f.actor) as DeliveryView;
  expect(report.state).toBe('reviewed');
});

it('blocks a prior queued broadcast in the worker before rendering and releases reservations', async () => {
  const f = await createTestSendFixture(db);

  const row = (await f.delivery.execute(
    'delivery.review',
    { operationKey: randomUUID(), brandId: f.brandId, campaignId: f.campaign.id, expectedVersion: 1 },
    f.actor,
  )) as DeliveryView;

  await f.delivery.execute(
    'delivery.approve',
    { operationKey: randomUUID(), brandId: f.brandId, id: row.id },
    f.actor,
  );

  expect(f.renderCalls.length).toBe(0);

  f.options.scope = 'tests';

  await f.delivery.worker.tick(f.workspaceId, row.id);
  await f.delivery.worker.tick(f.workspaceId, row.id);

  expect(f.renderCalls.length).toBe(0);

  const report = await f.delivery.execute('delivery.report', { brandId: f.brandId, id: row.id }, f.actor) as DeliveryView;
  expect(report).toMatchObject({state:'blocked',reason:'broadcasts_disabled',accepted:0});
  expect((await db.tenant(f.workspaceId,sql=>sql.query('SELECT FROM customer_delivery_captures'))).rowCount).toBe(0);

  const usage = await f.billing.status(f.workspaceId);
  expect(usage.usage.reservedCampaigns).toBe(0);
  expect(usage.usage.campaigns).toBe(0);
});

it('blocks a prior prepared captured broadcast before submit after scope change', async () => {
  const f = await createTestSendFixture(db);

  const row = (await f.delivery.execute(
    'delivery.review',
    { operationKey: randomUUID(), brandId: f.brandId, campaignId: f.campaign.id, expectedVersion: 1 },
    f.actor,
  )) as DeliveryView;

  await f.delivery.execute(
    'delivery.approve',
    { operationKey: randomUUID(), brandId: f.brandId, id: row.id },
    f.actor,
  );

  // Advance to prepared state without submitting (capture mode renders but doesn't submit until worker processes)
  await f.delivery.worker.tick(f.workspaceId, row.id);

  expect(f.renderCalls.length).toBeGreaterThan(0);

  const renderCountBeforeBlock = f.renderCalls.length;

  f.options.scope = 'tests';

  await f.delivery.worker.tick(f.workspaceId, row.id);
  await f.delivery.worker.tick(f.workspaceId, row.id);

  expect(f.renderCalls.length).toBe(renderCountBeforeBlock);

  const report = await f.delivery.execute('delivery.report', { brandId: f.brandId, id: row.id }, f.actor) as DeliveryView;
  expect(report).toMatchObject({state:'blocked',reason:'broadcasts_disabled',accepted:0});
  expect((await db.tenant(f.workspaceId,sql=>sql.query('SELECT FROM customer_delivery_captures'))).rowCount).toBe(0);

  const usage = await f.billing.status(f.workspaceId);
  expect(usage.usage.reservedCampaigns).toBe(0);
});

it('completes one reviewed and approved test with accepted 1, emails 1, campaigns 0 when scope is tests', async () => {
  const f = await createTestSendFixture(db, { scope: 'tests' });

  const row = await review(f);
  expect(row.state).toBe('reviewed');
  expect(row.purpose).toBe('test');

  const approved = await approve(f, row);
  expect(approved.state).toBe('queued');

  await f.delivery.worker.tick(f.workspaceId, row.id);
  await f.delivery.worker.tick(f.workspaceId, row.id);

  const report = (await f.delivery.execute('delivery.report', { brandId: row.brandId, id: row.id }, f.actor)) as DeliveryView;
  expect(report).toMatchObject({ purpose: 'test', accepted: 1, state: 'completed' });

  const usage = await f.billing.status(f.workspaceId);
  expect(usage.usage).toMatchObject({ emails: 1, campaigns: 0, reservedEmails: 0, reservedCampaigns: 0 });
});

it('delivery.status returns scope, externalSendingEnabled, testSendingEnabled, and broadcastsEnabled', async () => {
  const f = await createTestSendFixture(db, { scope: 'tests', mode: 'ses' });

  const status = (await f.delivery.execute('delivery.status', { brandId: f.brandId }, f.actor)) as {
    scope?: 'all' | 'tests';
    externalSendingEnabled: boolean;
    testSendingEnabled: boolean;
    broadcastsEnabled: boolean;
  };

  expect(status.scope).toBe('tests');
  expect(status.externalSendingEnabled).toBe(false);
  expect(status.testSendingEnabled).toBe(true);
  expect(status.broadcastsEnabled).toBe(false);

  const allFixture = await createTestSendFixture(db, { scope: 'all', mode: 'ses' });
  const allStatus = (await allFixture.delivery.execute('delivery.status', { brandId: allFixture.brandId }, allFixture.actor)) as {
    scope?: 'all' | 'tests';
    externalSendingEnabled: boolean;
    testSendingEnabled: boolean;
    broadcastsEnabled: boolean;
  };

  expect(allStatus.scope).toBe('all');
  expect(allStatus.externalSendingEnabled).toBe(true);
  expect(allStatus.testSendingEnabled).toBe(true);
  expect(allStatus.broadcastsEnabled).toBe(true);

  const offFixture = await createTestSendFixture(db, { scope: 'all', mode: 'off' });
  const offStatus = (await offFixture.delivery.execute('delivery.status', { brandId: offFixture.brandId }, offFixture.actor)) as {
    scope?: 'all' | 'tests';
    externalSendingEnabled: boolean;
    testSendingEnabled: boolean;
    broadcastsEnabled: boolean;
  };

  expect(offStatus.scope).toBe('all');
  expect(offStatus.externalSendingEnabled).toBe(false);
  expect(offStatus.testSendingEnabled).toBe(false);
  expect(offStatus.broadcastsEnabled).toBe(false);
});

it('rejects broadcast resume while preserving cancellation controls',async()=>{
  const f=await createTestSendFixture(db);
  const row=await f.delivery.execute('delivery.review',{operationKey:randomUUID(),brandId:f.brandId,campaignId:f.campaign.id,expectedVersion:1},f.actor) as DeliveryView;
  await f.delivery.execute('delivery.approve',{operationKey:randomUUID(),brandId:f.brandId,id:row.id},f.actor);
  await f.delivery.execute('delivery.pause',{operationKey:randomUUID(),brandId:f.brandId,id:row.id},f.actor);
  f.options.scope='tests';
  await expect(f.delivery.execute('delivery.resume',{operationKey:randomUUID(),brandId:f.brandId,id:row.id},f.actor)).rejects.toMatchObject({code:'resume_blocked'});
  await f.delivery.execute('delivery.cancel',{operationKey:randomUUID(),brandId:f.brandId,id:row.id},f.actor);
  expect(f.renderCalls).toHaveLength(0);
  expect((await f.billing.status(f.workspaceId)).usage).toMatchObject({emails:0,campaigns:0,reservedEmails:0,reservedCampaigns:0});
});

it('reconciles an already-submitted broadcast after narrowing scope without submitting again',async()=>{
  let submissions=0,lookups=0;
  const f=await createTestSendFixture(db,{mode:'ses',provider:()=>({fingerprint:'synthetic-route',from:'news@shop.test',ready:async()=>true,
    submit:async()=>{submissions++;return {outcome:'unknown' as const};},
    lookup:async()=>{lookups++;return {outcome:'accepted' as const,messageId:'synthetic-reconciled'};}})});
  await saveSenderProfile(f.delivery,f.actor,f.brandId);
  await addCampaignPhoto(db,f.actor,f.brandId,f.campaign.id);
  await db.brand(f.workspaceId,f.brandId,sql=>sql.query('INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge,checked_at,verified_at) VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp())',[f.workspaceId,f.brandId,'shop.test',randomUUID()]));
  const row=await f.delivery.execute('delivery.review',{operationKey:randomUUID(),brandId:f.brandId,campaignId:f.campaign.id,expectedVersion:1},f.actor) as DeliveryView;
  await f.delivery.execute('delivery.approve',{operationKey:randomUUID(),brandId:f.brandId,id:row.id},f.actor);
  await f.delivery.worker.tick(f.workspaceId,row.id);await f.delivery.worker.tick(f.workspaceId,row.id);
  expect(submissions).toBe(1);
  f.options.scope='tests';f.setClock(new Date(f.now().getTime()+61000));
  await f.delivery.worker.tick(f.workspaceId,row.id);await f.delivery.worker.tick(f.workspaceId,row.id);
  expect(submissions).toBe(1);expect(lookups).toBe(1);
  expect(await f.delivery.execute('delivery.report',{brandId:f.brandId,id:row.id},f.actor)).toMatchObject({accepted:1,uncertain:0,state:'completed'});
  expect((await f.billing.status(f.workspaceId)).usage).toMatchObject({emails:1,campaigns:1,reservedEmails:0,reservedCampaigns:0});
});

it('MCP returns the same scope and denies broadcast review through the canonical service',async()=>{
  const f=await createTestSendFixture(db,{scope:'tests'}),connection=await makeAudienceConnection(db,f.actor,[f.brandId],['read','campaign:send']);
  const bridge=createMcpServer((name,input)=>f.delivery.execute(name,input,connection.actor)),client=new Client({name:'scope-test',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await bridge.connect(serverTransport);await client.connect(clientTransport);
  try{
    const status=await client.callTool({name:'delivery_status',arguments:{brandId:f.brandId}});
    expect(JSON.parse((status.content as {text:string}[])[0]!.text)).toMatchObject({scope:'tests',broadcastsEnabled:false});
    const blocked=await client.callTool({name:'delivery_review',arguments:{operationKey:randomUUID(),brandId:f.brandId,campaignId:f.campaign.id,expectedVersion:1}});
    expect(blocked.isError).toBe(true);
    expect((blocked.content as {text:string}[])[0]!.text).toContain('Broadcasts and schedules are disabled');
    expect((await db.tenant(f.workspaceId,sql=>sql.query('SELECT FROM customer_deliveries'))).rowCount).toBe(0);
  }finally{await client.close();await bridge.close();}
});
