import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import Stripe from 'stripe';
import {createServer} from 'node:http';
import {createApp} from '../src/server/app.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../src/mcp/bridge.js';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import {makeAudienceConnection} from './helpers/audience-connection.js';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { loadConfig } from '../src/server/config.js';
import { CustomerWorkflows } from '../src/server/customer-runtime.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { Authenticator, type IdentityProvider } from '../src/server/auth.js';
import type { CommandName } from '../src/shared/contracts.js';
import type { AudienceSettingsView } from '../src/shared/customer-audience.js';
import type { DeliveryView } from '../src/shared/customer-delivery.js';
import type { CompanyDirectory } from '../src/shared/companies.js';
import type { CustomerOperationsStatus } from '../src/shared/customer-operations.js';
import type { CustomerBillingStatus } from '../src/shared/customer-billing.js';
import type { SupportTicket, SupportDirectory } from '../src/shared/customer-support.js';
import type { RetentionStatus } from '../src/shared/customer-retention.js';
import type { Request as ExpressRequest } from 'express';

let fixture: Awaited<ReturnType<typeof startDatabase>>;
let db: Database;
let operator: Database;
const restartedDatabases: Database[] = [];
const owners = new Map<string, string>();
const workflows = new Set<CustomerWorkflows>();

beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url,2);
  operator = new Database(fixture.adminUrl);
});

afterAll(async () => {
  for (const workflow of workflows) await workflow.close();
  workflows.clear();
  for (const connection of restartedDatabases) await connection.close();
  await operator?.close();
  await db?.close();
  await fixture?.stop();
});

function makeIdentity(owners: Map<string, string>): IdentityProvider {
  return {
    team: {
      async membership(userId: string, workspaceId: string) {
        return owners.get(workspaceId) === userId ? 'owner' : null;
      },
      async members(workspaceId: string, offset: number) {
        const owner = owners.get(workspaceId);
        if (!owner || offset > 0) return { total: owner ? 1 : 0, members: [] };
        return { total: 1, members: [{ userId: owner, name: 'Owner', membership: 'owner' as const }] };
      },
    },
    async session() {
      throw new Error('Session identity is not used in this scaffold.');
    },
    async isOwner(userId: string, workspaceId: string) {
      return owners.get(workspaceId) === userId;
    },
  };
}

async function factory(overrides:NodeJS.ProcessEnv={}) {
  const workspaceId = 'org_' + randomUUID().replace(/-/g, '');
  const userId = 'user_' + randomUUID();
  owners.set(workspaceId, userId);
  const identity = makeIdentity(owners);

  const env: NodeJS.ProcessEnv = {
    APP_ENV: 'test',
    APP_ORIGIN: 'http://127.0.0.1:4310',
    FLOCKLETTER_CUSTOMER_BILLING: 'exercise',
    FLOCKLETTER_CUSTOMER_DELIVERY: 'capture',
    FLOCKLETTER_CUSTOMER_AUDIENCE: 'exercise',
    FLOCKLETTER_CUSTOMER_TEAM: 'exercise',
    FLOCKLETTER_CUSTOMER_SUPPORT: 'capture',
    FLOCKLETTER_CUSTOMER_RETENTION: 'capture',
    ...overrides,
  };

  const config = loadConfig(env);
  const runtime = new CustomerWorkflows(db, config, identity, env);
  workflows.add(runtime);

  const renderCalls: string[] = [];
  runtime.delivery.options.render = async (message) => {
    renderCalls.push(message.to);
  };

  const service = new CommandService(
    db,
    undefined,
    identity.isOwner,
    undefined,
    undefined,
    identity.team,
    undefined,
    undefined,
    undefined,
    config.environment,
    undefined,
    runtime,
  );

  const actor: Actor = {
    workspaceId,
    userId,
    actorId: 'user:' + userId,
    owner: true,
    kind: 'session',
    scopes: ['read'],
    brandIds: null,
  };

  await service.execute(
    'workspace.initialize',
    { name: 'Shop', brandName: 'Trail', operationKey: randomUUID() },
    actor,
  );

  const workspace = (await service.execute('workspace.get', {}, actor)) as {
    brands: { id: string }[];
  };
  const brandId = workspace.brands[0]!.id;

  identity.session = async () => ({ userId, workspaceId });
  const authenticator = new Authenticator(db, identity, runtime.billing.options);

  return {
    workspaceId,
    userId,
    brandId,
    actor,
    runtime,
    service,
    identity,
    config,
    env,
    authenticator,
    renderCalls,
    call: <T>(name: CommandName, input: unknown): Promise<T> =>
      service.execute(name, input, actor) as Promise<T>,
  };
}

it('acknowledges authenticated irrelevant events at the HTTP endpoint with billing off and rejects invalid signatures',async()=>{
  const f=await factory({
    APP_ORIGIN:'https://flockletter.example.test',FLOCKLETTER_CUSTOMER_BILLING:'off',
    FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT:'acct_fixture',FLOCKLETTER_CUSTOMER_STRIPE_KEY:'rk_test_SYNTHETIC',
    FLOCKLETTER_CUSTOMER_STRIPE_WEBHOOK:'whsec_fixture',FLOCKLETTER_CUSTOMER_STARTER_PRICE:'price_starter',
    FLOCKLETTER_CUSTOMER_GROWTH_PRICE:'price_growth',FLOCKLETTER_CUSTOMER_PRO_PRICE:'price_pro',
  });
  expect(f.runtime.billing.options.gateway).toBeUndefined();
  expect(f.runtime.billing.options.eventGateway).toBeDefined();
  expect(f.runtime.billing.options.eventGateway).not.toHaveProperty('checkout');
  expect((await f.runtime.billing.status(f.workspaceId)).eligible).toBe(false);
  const app=createServer(createApp(f.config,f.service,f.authenticator));
  await new Promise<void>(resolve=>app.listen(0,'127.0.0.1',resolve));
  try{
    const address=app.address();
    if(!address||typeof address==='string')throw Error('Missing disposable listener');
    const raw=JSON.stringify({id:'evt_unrelated',object:'event',livemode:false,type:'customer.created',data:{object:{id:'cus_other'}}});
    const stripe=new Stripe('sk_test_SYNTHETIC');
    const signature=stripe.webhooks.generateTestHeaderString({payload:raw,secret:'whsec_fixture'});
    const target='http://127.0.0.1:'+address.port+'/api/v1/customer-billing/stripe-events';
    const received=await fetch(target,{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body:raw});
    expect(received.status).toBe(200);
    expect(await received.json()).toEqual({received:true});
    const invalid=await fetch(target,{method:'POST',headers:{'content-type':'application/json','stripe-signature':'invalid'},body:raw});
    expect(invalid.status).toBe(400);
    expect((await f.runtime.billing.status(f.workspaceId)).eligible).toBe(false);
  }finally{await new Promise<void>((resolve,reject)=>app.close(error=>error?reject(error):resolve()));}
});

it('preparation status through CommandService is ineligible and operations shows captured modes/safeguards', async () => {
  const f = await factory();

  const status = await f.call<{
    environment: string;
    exercise: boolean;
    modes: Record<string, string>;
    safeguards: { externalDelivery: boolean; realCharges: boolean };
  }>('operations.status', {});

  expect(status.environment).toBe('test');
  expect(status.exercise).toBe(true);
  expect(status.modes.billing).toBe('exercise');
  expect(status.modes.delivery).toBe('capture');
  expect(status.modes.audience).toBe('exercise');
  expect(status.modes.team).toBe('exercise');
  expect(status.modes.support).toBe('capture');
  expect(status.modes.retention).toBe('capture');
  expect(status.safeguards.externalDelivery).toBe(false);
  expect(status.safeguards.realCharges).toBe(false);

  const deliveryStatus = await f.call<{ eligible: boolean }>('delivery.status', {});
  expect(deliveryStatus.eligible).toBe(false);
});

it('drains due campaign work beyond eight transitions and returns its actual pacing deadline',async()=>{
  const f=await factory();
  const tick=vi.spyOn(f.runtime.delivery.worker,'tick');
  for(let i=0;i<12;i++)tick.mockResolvedValueOnce({processed:true});
  tick.mockImplementation(async()=>({processed:false,retryAt:new Date(Date.now()+250).toISOString()}));
  const maintenance=vi.spyOn(f.runtime.senderSetup,'tick');
  const delay=await f.runtime.processWorkspace(f.workspaceId,false);
  expect(tick).toHaveBeenCalledTimes(13);
  expect(delay).toBeGreaterThan(0);
  expect(delay).toBeLessThanOrEqual(251);
  expect(maintenance).not.toHaveBeenCalled();
});
it('shares activated Growth company and brand limits through the ordinary command dispatcher', async () => {
  const f = await factory();

  await f.call('customerBilling.startTrial', {
    operationKey: randomUUID(),
    plan: 'starter',
    simulatedCardConfirmed: true,
  });

  await f.call('customerBilling.exercisePayment', {
    operationKey: randomUUID(),
    result: 'succeeded',
  });

  await f.call('customerBilling.changePlan', {
    operationKey: randomUUID(),
    plan: 'growth',
  });

  const caps = await f.call<CompanyDirectory>('company.list', {});
  expect(caps).toMatchObject({ planName: 'Growth', limits: { companies: 3, brands: 3 } });

  const company = await f.call<{ id: string }>('company.create', {
    name: 'New Company',
    operationKey: randomUUID(),
  });

  const brand = await f.call<{ id: string }>('brand.create', {
    companyId: company.id,
    name: 'New Brand',
    operationKey: randomUUID(),
  });

  expect(brand.id).toBeDefined();
});

async function trial(f: Awaited<ReturnType<typeof factory>>) {
  return f.call<CustomerBillingStatus>('customerBilling.startTrial', {
    operationKey: randomUUID(),
    plan: 'starter',
    simulatedCardConfirmed: true,
  });
}
async function audience(f: Awaited<ReturnType<typeof factory>>, email = 'reader@example.com') {
  await f.call('audienceOnboarding.configure', {
    operationKey: randomUUID(),
    brandId: f.brandId,
    enabled: true,
    purpose: 'shop_news',
    policyVersion: 'v1',
    consentText: 'Send me occasional shop news. I can unsubscribe from every message.',
    sourceDomain: 'shop.example.com',
  });
  await f.call('audienceOnboarding.signup', {
    operationKey: randomUUID(),
    brandId: f.brandId,
    email,
    consentAffirmed: true,
    policyVersion: 'v1',
  });
  const settings = await f.call<AudienceSettingsView>('audienceOnboarding.status', { brandId: f.brandId });
  const message = settings.messages.find((row) => row.email === email)!;
  expect(message).toMatchObject({ mode: 'exercise', state: 'captured' });
  const captured = await f.call<{ to: string; mode: string; confirmationUrl: string }>(
    'audienceOnboarding.confirmation',
    { brandId: f.brandId, id: message.id },
  );
  expect(captured).toMatchObject({ to: email, mode: 'exercise' });
  expect(new URL(captured.confirmationUrl).origin).toBe(f.config.origin);
  await f.call('audienceOnboarding.exerciseConfirm', {
    operationKey: randomUUID(),
    brandId: f.brandId,
    id: message.id,
  });
}
async function reviewed(f: Awaited<ReturnType<typeof factory>>) {
  const campaign = await f.call<{ id: string; version: number }>('campaign.create', {
    operationKey: randomUUID(),
    brandId: f.brandId,
    content: {
      title: 'Summer trail',
      subject: 'New at the shop',
      fromName: 'Trail shop',
      replyTo: 'shop@example.com',
      heading: 'A new trail',
      body: 'The summer collection is here.',
      preheader: 'Shop news',
      ctaLabel: '',
      ctaUrl: '',
      assetIds: [],
    },
  });
  const review = await f.call<DeliveryView>('delivery.review', {
    operationKey: randomUUID(),
    brandId: f.brandId,
    campaignId: campaign.id,
    expectedVersion: campaign.version,
  });
  await f.call('delivery.approve', { operationKey: randomUUID(), brandId: f.brandId, id: review.id });
  return review;
}

it('runs signup, captured double opt-in, review, queued processing and exact usage through normal commands', async () => {
  const f = await factory();
  await trial(f);
  await audience(f);
  const review = await reviewed(f);
  const queued = await f.call<CustomerOperationsStatus>('operations.status', {});
  expect(queued.queue.delivery).toBe(1);
  const operationKey = randomUUID();
  await f.call('operations.process', { operationKey });
  await f.call('operations.process', { operationKey });
  const report = await f.call<DeliveryView>('delivery.report', { brandId: f.brandId, id: review.id });
  expect(report).toMatchObject({ state: 'completed', selected: 1, accepted: 1, delivered: 1, uncertain: 0 });
  expect(f.renderCalls).toEqual(['reader@campaign.test']);
  const message = await f.call<{ html: string; to: string; mode: string }>('delivery.message', {
    brandId: f.brandId,
    id: review.id,
    recipientId: report.recipients[0]!.id,
  });
  expect(message).toMatchObject({ to: 'reader@example.com', mode: 'capture' });
  expect(message.html).toContain('Unsubscribe from this newsletter');
  expect((await f.call<CustomerBillingStatus>('customerBilling.status', {})).usage).toMatchObject({
    campaigns: 1,
    emails: 1,
    reservedEmails: 0,
  });
  expect((await f.call<CustomerOperationsStatus>('operations.status', {})).worker).toMatchObject({
    lastFailure: null,
  });
});

it('rejects member and delegated credentials for owner-only billing, team and support commands', async () => {
  const f = await factory();
  const actions: [CommandName, unknown][] = [
    [
      'customerBilling.startTrial',
      { operationKey: randomUUID(), plan: 'starter', simulatedCardConfirmed: true },
    ],
    ['teamLifecycle.initializeExercise', { operationKey: randomUUID() }],
    [
      'support.create',
      { operationKey: randomUUID(), subject: 'Plans', text: 'What is included?', topic: 'plans' },
    ],
  ];
  for (const actor of [
    { ...f.actor, owner: false },
    { ...f.actor, kind: 'connection' as const },
  ])
    for (const [name, input] of actions)
      await expect(f.service.execute(name, input, actor)).rejects.toMatchObject({ code: 'owner_required' });
  expect((await f.call<SupportDirectory>('support.list', {})).total).toBe(0);
});

it('authenticates current identity and rejects stale owner mutations after revocation', async () => {
  const f = await factory();
  const request = {
    get: (name: string) => (name === 'authorization' ? 'Bearer synthetic-runtime-test' : undefined),
  } as ExpressRequest;
  const signedIn = await f.authenticator.authenticate(request);
  expect(signedIn).toMatchObject({
    workspaceId: f.workspaceId,
    userId: f.userId,
    owner: true,
    kind: 'session',
  });
  owners.set(f.workspaceId, 'user_new_owner');
  await expect(f.authenticator.authenticate(request)).rejects.toMatchObject({ code: 'membership_required' });
  for (const [name, input] of [
    [
      'customerBilling.startTrial',
      { operationKey: randomUUID(), plan: 'starter', simulatedCardConfirmed: true },
    ],
    ['teamLifecycle.initializeExercise', { operationKey: randomUUID() }],
    [
      'support.create',
      { operationKey: randomUUID(), subject: 'Plans', text: 'What is included?', topic: 'plans' },
    ],
  ] as [CommandName, unknown][])
    await expect(f.service.execute(name, input, signedIn)).rejects.toMatchObject({ code: 'owner_required' });
});

it('limits the durable scheduler to fixed functions and current-scope changes', async () => {
  const a = await factory(),
    b = await factory();
  await trial(a);
  const due = (
    await db.pool.query<{ workspace_id: string }>('SELECT * FROM flockletter_customer_jobs.due_scopes()')
  ).rows;
  expect(due.some((row) => row.workspace_id === a.workspaceId)).toBe(true);
  expect(due.every((row) => Object.keys(row).join(',') === 'workspace_id')).toBe(true);
  await expect(db.pool.query('SELECT * FROM flockletter_customer_jobs.scopes')).rejects.toMatchObject({
    code: '42501',
  });
  const privileges = (
    await db.pool.query<{
      table_read: boolean;
      table_write: boolean;
      schema_create: boolean;
      can_wake: boolean;
    }>(`
    SELECT has_table_privilege(current_user,'flockletter_customer_jobs.scopes','SELECT') table_read,
      has_table_privilege(current_user,'flockletter_customer_jobs.scopes','UPDATE') table_write,
      has_schema_privilege(current_user,'flockletter_customer_jobs','CREATE') schema_create,
      has_function_privilege(current_user,'flockletter_customer_jobs.wake(text,timestamp with time zone)','EXECUTE') can_wake`)
  ).rows[0];
  expect(privileges).toEqual({ table_read: false, table_write: false, schema_create: false, can_wake: true });
  for (const command of [
    { query: 'SELECT flockletter_customer_jobs.wake($1,now())', args: [b.workspaceId] },
    { query: 'SELECT flockletter_customer_jobs.snooze($1,now())', args: [b.workspaceId] },
    { query: 'SELECT flockletter_customer_jobs.record_pass($1,NULL)', args: [b.workspaceId] },
    {
      query: 'SELECT flockletter_customer_jobs.record_pass($1,$2)',
      args: [a.workspaceId, 'arbitrary private error'],
    },
  ])
    await expect(
      db.tenant(a.workspaceId, (sql) => sql.query(command.query, command.args)),
    ).rejects.toMatchObject({ code: 'P0001' });
  expect(
    (
      await db.tenant(a.workspaceId, (sql) =>
        sql.query('SELECT * FROM flockletter_customer_jobs.scope_status($1)', [b.workspaceId]),
      )
    ).rows,
  ).toEqual([]);
  await db.tenant(a.workspaceId, (sql) =>
    sql.query("SELECT flockletter_customer_jobs.snooze($1,now()+interval '1 hour')", [a.workspaceId]),
  );
  expect(
    (
      await db.pool.query<{ workspace_id: string }>('SELECT * FROM flockletter_customer_jobs.due_scopes()')
    ).rows.some((row) => row.workspace_id === a.workspaceId),
  ).toBe(false);
  await a.runtime.wake(a.workspaceId);
  expect(
    (
      await db.pool.query<{ workspace_id: string }>('SELECT * FROM flockletter_customer_jobs.due_scopes()')
    ).rows.some((row) => row.workspace_id === a.workspaceId),
  ).toBe(true);
});

it('recovers the durable directory and worker receipt after application and connection restart', async () => {
  const f = await factory();
  await trial(f);
  await f.call('operations.process', { operationKey: randomUUID() });
  const before = await f.call<CustomerOperationsStatus>('operations.status', {});
  expect(before.worker.lastPass).not.toBeNull();
  await f.runtime.close();
  workflows.delete(f.runtime);
  const freshDb = new Database(fixture.url,2);
  restartedDatabases.push(freshDb);
  const restarted = new CustomerWorkflows(freshDb, f.config, f.identity, f.env);
  workflows.add(restarted);
  const status = await restarted.status(f.workspaceId);
  expect(status.worker.lastPass).toBe(before.worker.lastPass);
  expect(status.worker.lastFailure).toBeNull();
  expect(
    (
      await freshDb.pool.query<{ workspace_id: string }>(
        'SELECT * FROM flockletter_customer_jobs.due_scopes()',
      )
    ).rows.some((row) => row.workspace_id === f.workspaceId),
  ).toBe(true);
  expect((await restarted.billing.status(f.workspaceId)).state).toBe('trialing');
  await freshDb.verifyBoundary();
});

it('prevents an erased workspace from reentering any ordinary command path', async () => {
  const f = await factory();
  await trial(f);
  await audience(f);
  await reviewed(f);
  await operator.tenant(f.workspaceId, (sql) =>
    sql.query(
      `INSERT INTO customer_retention_receipts
    (workspace_id,job_id,effective_end_at,erased_at,manifest_digest,checkpoint_digest) VALUES($1,$2,now(),now(),$3,$3)`,
      [f.workspaceId, randomUUID(), 'a'.repeat(64)],
    ),
  );
  await expect(f.call('workspace.get', {})).rejects.toMatchObject({ code: 'workspace_erased', status: 410 });
  await expect(
    f.call('customerBilling.startTrial', {
      operationKey: randomUUID(),
      plan: 'starter',
      simulatedCardConfirmed: true,
    }),
  ).rejects.toMatchObject({ code: 'workspace_erased' });
  await expect(f.call('operations.process', { operationKey: randomUUID() })).rejects.toMatchObject({
    code: 'workspace_erased',
  });
  await expect(
    f.call('workspace.initialize', {
      operationKey: randomUUID(),
      name: 'Cannot recreate',
      brandName: 'Cannot recreate',
    }),
  ).rejects.toMatchObject({ code: 'workspace_erased' });
  await expect(
    db.tenant(f.workspaceId, (sql) =>
      sql.query(
        `INSERT INTO customer_retention_receipts
    (workspace_id,job_id,effective_end_at,erased_at,manifest_digest,checkpoint_digest) VALUES($1,$2,now(),now(),$3,$3)`,
        [f.workspaceId, randomUUID(), 'b'.repeat(64)],
      ),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  expect(await f.runtime.billing.eligibility(f.workspaceId)).toMatchObject({
    eligible: false,
    reasons: expect.arrayContaining(['This workspace has completed its retention erasure.']),
  });
  for (const name of [
    'customerBilling.checkout',
    'customerBilling.restartCheckout',
    'customerBilling.portal',
  ])
    await expect(
      f.runtime.billing.execute(
        name,
        { operationKey: randomUUID(), ...(name.endsWith('portal') ? {} : { plan: 'starter' }) },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: 'workspace_erased' });
  // A quarantined restore can contain old queued data plus the reapplied erasure receipt.
  // The autonomous worker must enforce the same denial before any new provider action.
  await f.runtime.processWorkspace(f.workspaceId);
  expect(
    (
      await db.tenant(f.workspaceId, (sql) =>
        sql.query('SELECT count(*)::int n FROM customer_delivery_captures'),
      )
    ).rows[0]!.n,
  ).toBe(0);
});

it('keeps another workspace’s audience, support and delivery outcomes isolated', async () => {
  const a = await factory(),
    b = await factory();
  await trial(a);
  await audience(a);
  const review = await reviewed(a);
  const ticket = await a.call<SupportTicket>('support.create', {
    operationKey: randomUUID(),
    subject: 'Shop question',
    text: 'How do I use templates?',
    topic: 'campaigns',
  });
  expect((await b.call<SupportDirectory>('support.list', {})).total).toBe(0);
  await expect(b.call('support.get', { id: ticket.id })).rejects.toMatchObject({ status: 404 });
  await expect(b.call('audienceOnboarding.status', { brandId: a.brandId })).rejects.toMatchObject({
    status: 404,
  });
  await expect(b.call('delivery.report', { brandId: b.brandId, id: review.id })).rejects.toMatchObject({
    status: 404,
  });
  expect((await b.call<CustomerOperationsStatus>('operations.status', {})).queue.delivery).toBe(0);
  expect((await a.call<CustomerOperationsStatus>('operations.status', {})).queue.delivery).toBe(1);
});

it('uses the shared processor for captured support and due retention without deleting data', async () => {
  const f = await factory();
  const ticket = await f.call<SupportTicket>('support.create', {
    operationKey: randomUUID(),
    subject: 'Plans',
    text: 'What does Starter include?',
    topic: 'plans',
  });
  const draft = await f.call<SupportTicket>('support.draft', {
    operationKey: randomUUID(),
    id: ticket.id,
    expectedVersion: ticket.version,
  });
  await f.call('support.approve', {
    operationKey: randomUUID(),
    id: ticket.id,
    expectedVersion: draft.version,
    reviewCode: draft.reviewCode,
  });
  await trial(f);
  await f.call('customerBilling.cancel', { operationKey: randomUUID() });
  await f.call('customerBilling.advanceExercise', { operationKey: randomUUID(), days: 120 });
  await f.call('operations.process', { operationKey: randomUUID() });
  const support = await f.call<SupportTicket>('support.get', { id: ticket.id });
  expect(support.messages.filter((message) => message.kind === 'captured_reply')).toHaveLength(1);
  expect(support.delivery).toMatchObject({ state: 'accepted', mode: 'capture', attempts: 1 });
  const retention = await f.call<RetentionStatus>('retention.status', {});
  expect(retention).toMatchObject({ purgeEnabled: false, retentionDays: 90 });
  expect(retention.cases).toHaveLength(1);
  expect(retention.cases[0]).toMatchObject({ source: 'exercise', state: 'due' });
  expect((await f.call<{ brands: unknown[] }>('workspace.get', {})).brands).toHaveLength(1);
  expect((await f.call<CustomerOperationsStatus>('operations.status', {})).worker.lastFailure).toBeNull();
});

it('shares truthful setup facts while withholding billing and audience facts outside their grants',async()=>{
  const f=await factory();await trial(f);await audience(f);
  const owner=await f.call<import('../src/shared/workspace-preflight.js').WorkspacePreflight>('workspace.preflight',{});
  expect(owner).toMatchObject({canSend:false,reviewRequired:true,capturedExercise:true,
    service:{source:'exercise',state:'trialing',eligible:true},brands:[{id:f.brandId,confirmed:1,senderVerified:false}]});
  expect(owner.gaps).toEqual(expect.arrayContaining([expect.objectContaining({code:'sender_profile_required',action:'delivery'})]));
  const connection=await makeAudienceConnection(db,f.actor,[f.brandId],['read']);
  const read=await f.service.execute('workspace.preflight',{},connection.actor) as typeof owner;
  expect(read.service).toBeNull();expect(read.allowance).toBeNull();expect(read.brands[0]!.confirmed).toBeNull();
  expect(read.gaps.some(gap=>gap.code==='confirmed_audience_required')).toBe(false);
  const summaryGrant=await makeAudienceConnection(db,f.actor,[f.brandId],['read','audience:summary']);
  const summary=await f.service.execute('workspace.preflight',{},summaryGrant.actor) as typeof owner;
  expect(summary.brands[0]!.confirmed).toBe(1);expect(summary.service).toBeNull();
  const restricted=await f.service.execute('workspace.preflight',{}, {...summaryGrant.actor,brandIds:[]}) as typeof owner;
  expect(restricted.brands).toEqual([]);
  // Cached summary authority must disappear when the saved grant narrows.
  await db.tenant(f.workspaceId,sql=>sql.query("UPDATE connections SET scopes=ARRAY['read']::text[] WHERE id=$1",[summaryGrant.id]));
  const narrowed=await f.service.execute('workspace.preflight',{},summaryGrant.actor) as typeof owner;
  expect(narrowed.brands[0]!.confirmed).toBeNull();expect(narrowed.scopes).toEqual(['read']);
  await db.tenant(f.workspaceId,sql=>sql.query('UPDATE connections SET brand_ids=ARRAY[]::uuid[] WHERE id=$1',[summaryGrant.id]));
  expect((await f.service.execute('workspace.preflight',{},summaryGrant.actor) as typeof owner).brands).toEqual([]);
  await db.tenant(f.workspaceId,sql=>sql.query('UPDATE connections SET revoked_at=clock_timestamp() WHERE id=$1',[summaryGrant.id]));
  await expect(f.service.execute('workspace.preflight',{},summaryGrant.actor)).rejects.toMatchObject({code:'connection_revoked'});
  await db.tenant(f.workspaceId,sql=>sql.query("UPDATE connections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[connection.id]));
  await expect(f.service.execute('workspace.preflight',{},connection.actor)).rejects.toMatchObject({code:'connection_revoked'});
  const noRead=await makeAudienceConnection(db,f.actor,[f.brandId],['audience:summary']);
  await expect(f.service.execute('workspace.preflight',{}, {...noRead.actor,scopes:['read','audience:summary']})).rejects.toMatchObject({code:'connection_revoked'});
  const issuerLost=await makeAudienceConnection(db,f.actor,[f.brandId],['read','audience:summary']);
  owners.delete(f.workspaceId);
  await expect(f.service.execute('workspace.preflight',{},issuerLost.actor)).rejects.toMatchObject({code:'owner_required'});
  const member=await f.service.execute('workspace.preflight',{}, {...f.actor,owner:false,brandIds:[f.brandId]}) as typeof owner;
  expect(member.service).toBeNull();expect(member.allowance).toBeNull();expect(member.brands[0]!.confirmed).toBeNull();
  const revoked=await f.call<typeof owner>('workspace.preflight',{});
  expect(revoked.service).toBeNull();expect(revoked.brands[0]!.confirmed).toBeNull();
});


it('observes workspace setup without rehydrating or deactivating provider route caches',async()=>{
  const f=await factory();
  const routes=vi.spyOn(f.runtime.infrastructure,'routeCandidates').mockRejectedValue(Error('A setup read must not hydrate provider routes.'));
  f.runtime.settings.infrastructure='aws';
  try{await expect(f.call('workspace.preflight',{})).resolves.toMatchObject({canSend:false,reviewRequired:true});expect(routes).not.toHaveBeenCalled();}
  finally{f.runtime.settings.infrastructure='off';routes.mockRestore();}
});

it('shares current campaign preflight across read and delivery scopes without revealing private counts or writing work',async()=>{
 const f=await factory();
 await f.call('customerBilling.startTrial',{operationKey:randomUUID(),plan:'starter',simulatedCardConfirmed:true});
 await f.call('customerBilling.exercisePayment',{operationKey:randomUUID(),result:'succeeded'});
 const draft=await f.call<{id:string}>('campaign.create',{operationKey:randomUUID(),brandId:f.brandId,content:{title:'Private',subject:'Hello',fromName:'Shop',replyTo:'owner@shop.test',preheader:'',heading:'News',body:'Hello',ctaLabel:'',ctaUrl:'',assetIds:[]}});
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query("INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'private@shop.test','confirmed')",[f.workspaceId,f.brandId,randomUUID()]));
 const make=async(scopes:string[])=>{
  const issued=await f.call<{connection:{id:string};token:string}>('connection.create',{operationKey:randomUUID(),name:'Preflight test',scopes,brandIds:[f.brandId],expiresInDays:1});
  return {id:issued.connection.id,actor:{...f.actor,kind:'connection' as const,actorId:'connection:'+issued.connection.id,scopes:scopes as Actor['scopes'],brandIds:[f.brandId]}};
 };
 const read=await make(['read']),summary=await make(['read','audience:summary']),sender=await make(['read','campaign:send','audience:summary']);
 const count=()=>db.tenant(f.workspaceId,async sql=>(await sql.query(`SELECT
  (SELECT count(*)::int FROM operations) operations,(SELECT count(*)::int FROM audit) audit,
  (SELECT count(*)::int FROM customer_deliveries) deliveries,(SELECT count(*)::int FROM customer_usage_reservations) reservations`)).rows[0]);
 const routingBefore=(await operator.pool.query('SELECT next_due_at,touched_at,last_pass_at,last_failure_code FROM flockletter_customer_jobs.scopes WHERE workspace_id=$1',[f.workspaceId])).rows;
 const before=await count();
 const hidden=await f.service.execute('campaign.preflight',{id:draft.id},read.actor) as {audience?:unknown;allowance?:unknown;gaps:{code:string}[]};
 expect(hidden.audience).toBeUndefined();expect(hidden.allowance).toBeUndefined();expect(hidden.gaps.map(g=>g.code)).toContain('audience_review_required');
 await expect(f.service.execute('delivery.preflight',{brandId:f.brandId,campaignId:draft.id},read.actor)).rejects.toMatchObject({code:'scope_required'});
 const visible=await f.service.execute('campaign.preflight',{id:draft.id},summary.actor) as {audience:unknown;allowance?:unknown;gaps:{code:string}[]};
 expect(visible.audience).toMatchObject({confirmed:1,selected:1,excluded:0});expect(visible.allowance).toBeUndefined();expect(visible.gaps).toEqual([]);
 const checks=await f.service.execute('delivery.preflight',{brandId:f.brandId,campaignId:draft.id,expectedVersion:1},sender.actor) as {canSend:boolean;reviewRequired:boolean;audience:unknown;gaps:unknown[]};
 expect(checks).toMatchObject({canSend:false,reviewRequired:true,audience:{selected:1},gaps:[]});expect(await count()).toEqual(before);
 expect((await operator.pool.query('SELECT next_due_at,touched_at,last_pass_at,last_failure_code FROM flockletter_customer_jobs.scopes WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual(routingBefore);
 const bridge=createMcpServer((name,input)=>f.service.execute(name as CommandName,input,sender.actor)),mcp=new Client({name:'preflight-proof',version:'1'}),[ct,st]=InMemoryTransport.createLinkedPair();
 await bridge.connect(st);await mcp.connect(ct);
 try {
  const result=await mcp.callTool({name:'delivery_preflight',arguments:{brandId:f.brandId,campaignId:draft.id,expectedVersion:1}});
  expect(result.isError).not.toBe(true);expect(JSON.parse((result.content as {text:string}[])[0]!.text)).toMatchObject({canSend:false,reviewRequired:true,audience:{selected:1}});
 }finally{await mcp.close();await bridge.close();}
 const foreign=await factory();await expect(f.service.execute('delivery.preflight',{brandId:foreign.brandId,campaignId:draft.id},sender.actor)).rejects.toMatchObject({code:'brand_unavailable'});
 await db.tenant(f.workspaceId,sql=>sql.query("UPDATE connections SET scopes=ARRAY['read','campaign:send'] WHERE id=$1",[sender.id]));
 const narrowed=await f.service.execute('campaign.preflight',{id:draft.id},sender.actor) as {audience?:unknown};expect(narrowed.audience).toBeUndefined();
 await db.tenant(f.workspaceId,sql=>sql.query("UPDATE connections SET scopes=ARRAY['read'] WHERE id=$1",[sender.id]));
 await expect(f.service.execute('delivery.preflight',{brandId:f.brandId,campaignId:draft.id},sender.actor)).rejects.toMatchObject({code:'connection_revoked'});
 await db.tenant(f.workspaceId,sql=>sql.query('UPDATE connections SET revoked_at=clock_timestamp() WHERE id=$1',[sender.id]));
 await expect(f.service.execute('delivery.preflight',{brandId:f.brandId,campaignId:draft.id},sender.actor)).rejects.toMatchObject({code:'connection_revoked'});
 await db.tenant(f.workspaceId,sql=>sql.query("UPDATE connections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[read.id]));
 await expect(f.service.execute('campaign.preflight',{id:draft.id},read.actor)).rejects.toMatchObject({code:'connection_revoked'});
 owners.delete(f.workspaceId);await expect(f.service.execute('campaign.preflight',{id:draft.id},summary.actor)).rejects.toMatchObject({code:'owner_required'});
});


it('returns redacted preparation observations through the canonical owner command while workflows stay captured', async()=>{
  const f=await factory();
  const secret='synthetic-private-credential-value';
  f.env.FLOCKLETTER_CUSTOMER_STRIPE_KEY=secret;
  const result=await f.call<CustomerOperationsStatus>('operations.status',{});
  expect(result.preparation).toEqual(expect.arrayContaining([
    expect.objectContaining({area:'Billing provider',state:'settings_missing'}),
    expect.objectContaining({area:'Trial protection',state:'settings_missing'}),
  ]));
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.safeguards.externalDelivery).toBe(false);
  expect(result.safeguards.realCharges).toBe(false);
  expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({code:'embedded_worker'})]));
  expect(result.gaps.some(gap=>gap.code==='sleeping_web_worker')).toBe(false);
});
