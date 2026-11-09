import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, authorize, type Actor } from '../src/server/service.js';
import { CustomerBilling, customerEligibility } from '../src/server/customer-billing/service.js';
import { createCustomerOptOut } from '../src/server/customer-audience/service.js';
import type { DeliveryView,DeliveryOutcomesPage } from '../src/shared/customer-delivery.js';
import { createMcpServer } from '../src/mcp/bridge.js';
import { CustomerDelivery } from '../src/server/customer-delivery/service.js';
import type { DeliveryOptions } from '../src/server/customer-delivery/types.js';
import { saveSenderProfile, addCampaignPhoto } from './helpers/delivery-profile.js';
import { makeAudienceConnection } from './helpers/audience-connection.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database;
const base = new Date('2026-11-08T15:00:00Z');
let billing: CustomerBilling;

beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  billing = new CustomerBilling(db, { environment: 'test', exerciseEnabled: true, now: () => base });
});

afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});

async function factory(optionsOverride: Partial<DeliveryOptions> = {}) {
  const workspaceId = 'org_' + randomUUID().replaceAll('-', ''),
    userId = 'user_' + randomUUID(),
    actor: Actor = {
      workspaceId,
      userId,
      actorId: 'user:' + userId,
      owner: true,
      kind: 'session',
      scopes: ['read'],
      brandIds: null,
    };
  const core = new CommandService(db);
  await core.execute(
    'workspace.initialize',
    { name: 'Shop', brandName: 'Trail', operationKey: randomUUID() },
    actor,
  );
  const workspace = (await core.execute('workspace.get', {}, actor)) as { brands: { id: string }[] };
  const brandId = workspace.brands[0]!.id;
  const campaign = (await core.execute(
    'campaign.create',
    {
      operationKey: randomUUID(),
      brandId,
      content: {
        title: 'Trail',
        subject: 'Trail news',
        fromName: 'Shop',
        replyTo: 'shop@example.test',
        heading: 'New',
        body: 'News',
        preheader: '',
        ctaLabel: '',
        ctaUrl: '',
        assetIds: [],
      },
    },
    actor,
  )) as { id: string };
  await billing.execute(
    'customerBilling.startTrial',
    { operationKey: randomUUID(), plan: 'starter', simulatedCardConfirmed: true },
    actor,
  );
  await billing.execute(
    'customerBilling.exercisePayment',
    { operationKey: randomUUID(), result: 'succeeded' },
    actor,
  );
  const subscriberId = randomUUID();
  await db.brand(workspaceId, brandId, (sql) =>
    sql.query(
      "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'confirmed@shop.test','confirmed')",
      [workspaceId, brandId, subscriberId],
    ),
  );
  const renderCalls: string[] = [];
  const options: DeliveryOptions = {
    mode: 'capture',
    origin: 'http://localhost:3000',
    environment: 'test',
    billing,
    isOwner: async () => true,
    now: () => base,
    render: async (msg) => {
      renderCalls.push(msg.to);
    },
    optOut: createCustomerOptOut,
    eligibilitySql: (sql, workspace) =>
      customerEligibility(sql, workspace, { environment: 'test', exerciseEnabled: true }, base),
    liveConsent: async () => true,
    ...optionsOverride,
  };
  const delivery = new CustomerDelivery(db, options);
  return { workspaceId, brandId, actor, campaign, subscriberId, delivery, renderCalls, core, options };
}

async function reviewAndApprove(f: Awaited<ReturnType<typeof factory>>) {
  const reviewed = (await f.delivery.execute(
    'delivery.review',
    {
      operationKey: randomUUID(),
      brandId: f.brandId,
      campaignId: f.campaign.id,
      expectedVersion: 1,
    },
    f.actor,
  )) as { id: string };
  await f.delivery.execute(
    'delivery.approve',
    { operationKey: randomUUID(), brandId: f.brandId, id: reviewed.id },
    f.actor,
  );
  return reviewed;
}

it('renders to reserved address, captures message with unsubscribe and settles delivery', async () => {
  const f = await factory();
  const id = (await reviewAndApprove(f)).id;
  await f.delivery.worker.tick(f.workspaceId, id);
  expect(f.renderCalls).toEqual(['reader@campaign.test']);
  await f.delivery.worker.tick(f.workspaceId, id);
  const report = (await f.delivery.execute(
    'delivery.report',
    { brandId: f.brandId, id },
    f.actor,
  )) as DeliveryView;
  expect(report).toMatchObject({ state: 'completed', accepted: 1, delivered: 1 });
  const recipients = (
    await db.tenant(f.workspaceId, (sql) =>
      sql.query('SELECT id FROM customer_delivery_recipients WHERE delivery_id=$1', [id]),
    )
  ).rows[0]!;
  const message = (await f.delivery.execute(
    'delivery.message',
    { brandId: f.brandId, id, recipientId: recipients.id },
    f.actor,
  )) as { html: string };
  expect(message.html).toContain('Unsubscribe from this newsletter');
});

it('excludes subscriber who unsubscribes after render', async () => {
  const f = await factory();
  const id = (await reviewAndApprove(f)).id;
  await f.delivery.worker.tick(f.workspaceId, id);
  expect(f.renderCalls).toEqual(['reader@campaign.test']);
  await db.brand(f.workspaceId, f.brandId, (sql) =>
    sql.query("UPDATE subscribers SET state='unsubscribed' WHERE id=$1", [f.subscriberId]),
  );
  await f.delivery.worker.tick(f.workspaceId, id);
  const report = (await f.delivery.execute(
    'delivery.report',
    { brandId: f.brandId, id },
    f.actor,
  )) as DeliveryView;
  expect(report).toMatchObject({ state: 'completed', accepted: 0, skipped: 1 });
});

it('rejects approval when campaign version changes after review', async () => {
  const f = await factory();
  const reviewed = (await f.delivery.execute(
    'delivery.review',
    { operationKey: randomUUID(), brandId: f.brandId, campaignId: f.campaign.id, expectedVersion: 1 },
    f.actor,
  )) as DeliveryView;
  await db.tenant(f.workspaceId, (sql) =>
    sql.query('UPDATE campaigns SET version=version+1 WHERE id=$1', [f.campaign.id]),
  );
  await expect(
    f.delivery.execute(
      'delivery.approve',
      { operationKey: randomUUID(), brandId: f.brandId, id: reviewed.id },
      f.actor,
    ),
  ).rejects.toMatchObject({ code: 'version_conflict' });
});

it('isolates delivery report across tenants', async () => {
  const a = await factory(),
    b = await factory();
  const id = (await reviewAndApprove(a)).id;
  await expect(
    b.delivery.execute('delivery.report', { brandId: b.brandId, id }, b.actor),
  ).rejects.toMatchObject({ code: 'delivery_unavailable' });
});

it('blocks a queued submission when subscription eligibility changes', async () => {
  const f = await factory();
  const id = (await reviewAndApprove(f)).id;
  await f.delivery.worker.tick(f.workspaceId, id);
  await billing.execute(
    'customerBilling.exercisePayment',
    { operationKey: randomUUID(), result: 'failed' },
    f.actor,
  );
  await billing.execute('customerBilling.advanceExercise', { operationKey: randomUUID(), days: 6 }, f.actor);
  await f.delivery.worker.tick(f.workspaceId, id);
  expect(await f.delivery.execute('delivery.report', { brandId: f.brandId, id }, f.actor)).toMatchObject({
    state: 'blocked',
    accepted: 0,
    reason: 'subscription_ineligible',
  });
  expect(
    await db.tenant(
      f.workspaceId,
      async (sql) => (await sql.query('SELECT count(*)::int n FROM customer_delivery_captures')).rows[0]?.n,
    ),
  ).toBe(0);
});

it('shares the subscription campaign limit across independently reviewed deliveries', async () => {
  const f = await factory();
  await reviewAndApprove(f);
  await reviewAndApprove(f);
  await expect(reviewAndApprove(f)).rejects.toMatchObject({ code: 'allowance_exceeded' });
  expect((await billing.status(f.workspaceId)).usage.reservedCampaigns).toBe(2);
});

it('reconciles an unknown outcome in its original reservation period without another submission', async () => {
  let submissions = 0,
    lookups = 0,
    now = base;
  const f = await factory({
    mode: 'ses',
    now: () => now,
    provider: () => ({
      fingerprint: 'test-provider-v1',
      from: 'news@shop.test',
      ready: async () => true,
      submit: async () => {
        submissions++;
        throw Error('lost response');
      },
      lookup: async () => {
        lookups++;
        return { outcome: 'accepted' as const, messageId: 'synthetic-message' };
      },
    }),
  });
  await f.delivery.execute(
    'delivery.saveSender',
    {
      operationKey: randomUUID(),
      brandId: f.brandId,
      fromName: 'Trail shop',
      fromEmail: 'news@shop.test',
      replyTo: 'support@shop.test',
      organization: 'Synthetic Trail Shop',
      postalAddress: '100 Example Lane, Denver, CO 80202',
    },
    f.actor,
  );
  await db.brand(f.workspaceId, f.brandId, (sql) =>
    sql.query(
      'INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge,checked_at,verified_at) VALUES($1,$2,$3,$4,now(),now())',
      [f.workspaceId, f.brandId, 'shop.test', randomUUID()],
    ),
  );
  const id = (await reviewAndApprove(f)).id;
  await f.delivery.worker.tick(f.workspaceId, id);
  await f.delivery.worker.tick(f.workspaceId, id);
  expect(await f.delivery.execute('delivery.report', { brandId: f.brandId, id }, f.actor)).toMatchObject({
    uncertain: 1,
    accepted: 0,
  });
  expect((await billing.status(f.workspaceId)).usage.reservedEmails).toBe(1);
  const reservedPeriod = (await billing.status(f.workspaceId)).usage.period;
  await billing.execute('customerBilling.advanceExercise', { operationKey: randomUUID(), days: 32 }, f.actor);
  await billing.execute(
    'customerBilling.exercisePayment',
    { operationKey: randomUUID(), result: 'succeeded' },
    f.actor,
  );
  expect((await billing.status(f.workspaceId)).usage.period).not.toBe(reservedPeriod);
  now = new Date(base.getTime() + 32 * 86400000 + 31000);
  await f.delivery.worker.tick(f.workspaceId, id);
  expect(submissions).toBe(1);
  expect(lookups).toBe(1);
  expect(await f.delivery.execute('delivery.report', { brandId: f.brandId, id }, f.actor)).toMatchObject({
    state: 'completed',
    accepted: 1,
    uncertain: 0,
  });
  expect((await billing.status(f.workspaceId)).usage.emails).toBe(0);
  expect(
    await db.tenant(
      f.workspaceId,
      async (sql) =>
        (
          await sql.query(
            'SELECT period,accepted,state FROM customer_usage_reservations WHERE operation_key=$1',
            ['customer-delivery-' + id],
          )
        ).rows[0],
    ),
  ).toMatchObject({ period: reservedPeriod, accepted: 1, state: 'settled' });
});

it('preserves reviewed image bytes and blocks an altered original before rendering', async () => {
  const { createHash } = await import('node:crypto');
  const f = await factory();
  const bytes = Buffer.from('synthetic unchanged original photo'),
    asset = randomUUID();
  await db.tenant(f.workspaceId, async (sql) => {
    await sql.query(
      'INSERT INTO assets(workspace_id,brand_id,id,item_key,name,mime,bytes,sha256,width,height) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,1)',
      [
        f.workspaceId,
        f.brandId,
        asset,
        'synthetic-photo',
        'photo.png',
        'image/png',
        bytes,
        createHash('sha256').update(bytes).digest('hex'),
      ],
    );
    await sql.query("UPDATE campaigns SET content=jsonb_set(content,'{assetIds}',$2::jsonb) WHERE id=$1", [
      f.campaign.id,
      JSON.stringify([asset]),
    ]);
  });
  const seen: Buffer[] = [];
  const guarded = new CustomerDelivery(db, {
    ...f.options,
    render: async (envelope) => {
      seen.push(Buffer.from(envelope.images[0]!.bytes));
    },
  });
  const scope = { ...f, delivery: guarded };
  const intact = (await reviewAndApprove(scope)).id;
  await guarded.worker.tick(f.workspaceId, intact);
  expect(seen).toEqual([bytes]);
  await guarded.worker.tick(f.workspaceId, intact);
  const corrupted = (await reviewAndApprove(scope)).id;
  const admin = new Database(fixture.adminUrl);
  try {
    await admin.tenant(f.workspaceId, (sql) =>
      sql.query('UPDATE assets SET bytes=$2 WHERE id=$1', [asset, Buffer.from('altered binary')]),
    );
  } finally {
    await admin.close();
  }
  await guarded.worker.tick(f.workspaceId, corrupted);
  expect(
    await guarded.execute('delivery.report', { brandId: f.brandId, id: corrupted }, f.actor),
  ).toMatchObject({ state: 'blocked', reason: 'image_unavailable', accepted: 0 });
  expect(seen).toEqual([bytes]);
});

it('requires a fresh review after an owner changes the frozen legal sender profile', async () => {
  const f = await factory();
  await saveSenderProfile(f.delivery, f.actor, f.brandId);
  const reviewed = (await f.delivery.execute(
    'delivery.review',
    { operationKey: randomUUID(), brandId: f.brandId, campaignId: f.campaign.id, expectedVersion: 1 },
    f.actor,
  )) as DeliveryView;
  await saveSenderProfile(f.delivery, f.actor, f.brandId, '200 Changed Lane, Denver, CO 80203');
  await expect(
    f.delivery.execute(
      'delivery.approve',
      { operationKey: randomUUID(), brandId: f.brandId, id: reviewed.id },
      f.actor,
    ),
  ).rejects.toMatchObject({ status: 409, code: 'sender_changed' });
  expect((await billing.status(f.workspaceId)).usage.reservedEmails).toBe(0);
});

it('blocks an unsubmitted prepared email when its sender profile changes after approval', async () => {
  const f = await factory();
  await saveSenderProfile(f.delivery, f.actor, f.brandId);
  const id = (await reviewAndApprove(f)).id;
  await f.delivery.worker.tick(f.workspaceId, id);
  await saveSenderProfile(f.delivery, f.actor, f.brandId, '200 Changed Lane, Denver, CO 80203');
  await f.delivery.worker.tick(f.workspaceId, id);
  expect(await f.delivery.execute('delivery.report', { brandId: f.brandId, id }, f.actor)).toMatchObject({
    state: 'blocked',
    reason: 'delivery_configuration_changed',
    accepted: 0,
  });
  expect(
    await db.tenant(
      f.workspaceId,
      async (sql) => (await sql.query('SELECT count(*)::int n FROM customer_delivery_captures')).rows[0]?.n,
    ),
  ).toBe(0);
});

it('keeps the original legal address and exact CID photo in a historical captured email', async () => {
  const f = await factory(),
    postal = '100 Original Avenue, Denver, CO 80202';
  await saveSenderProfile(f.delivery, f.actor, f.brandId, postal);
  const photo = await addCampaignPhoto(db, f.actor, f.brandId, f.campaign.id);
  const id = (await reviewAndApprove(f)).id;
  await f.delivery.worker.tick(f.workspaceId, id);
  await f.delivery.worker.tick(f.workspaceId, id);
  await saveSenderProfile(f.delivery, f.actor, f.brandId, '900 Later Street, Denver, CO 80203');
  const report = (await f.delivery.execute(
    'delivery.report',
    { brandId: f.brandId, id },
    f.actor,
  )) as DeliveryView;
  const message = (await f.delivery.execute(
    'delivery.message',
    { brandId: f.brandId, id, recipientId: report.recipients[0]!.id },
    f.actor,
  )) as { html: string; text: string; images: { sha256: string; mime: string; base64: string }[] };
  expect(message.html).toContain(postal);
  expect(message.text).toContain(postal);
  expect(message.html).not.toContain('900 Later Street');
  expect(message.html).toContain('cid:' + photo.sha256);
  expect(message.images).toEqual([
    { sha256: photo.sha256, mime: 'image/png', base64: photo.bytes.toString('base64') },
  ]);
});

it('blocks a still-unattempted email when the current subscription period differs from its reservation', async () => {
  const f = await factory();
  const id = (await reviewAndApprove(f)).id;
  await f.delivery.worker.tick(f.workspaceId, id);
  await billing.execute('customerBilling.advanceExercise', { operationKey: randomUUID(), days: 32 }, f.actor);
  await billing.execute(
    'customerBilling.exercisePayment',
    { operationKey: randomUUID(), result: 'succeeded' },
    f.actor,
  );
  expect((await billing.status(f.workspaceId)).eligible).toBe(true);
  await f.delivery.worker.tick(f.workspaceId, id);
  expect(await f.delivery.execute('delivery.report', { brandId: f.brandId, id }, f.actor)).toMatchObject({
    state: 'blocked',
    reason: 'usage_period_changed',
    accepted: 0,
  });
});

it('requires read together with campaign send, persisted scope, current ownership and the exact brand', async () => {
  const f = await factory();
  await expect(
    f.core.execute(
      'connection.create',
      {
        operationKey: randomUUID(),
        name: 'Incomplete sender',
        scopes: ['campaign:send'],
        brandIds: [f.brandId],
        expiresInDays: 1,
      },
      f.actor,
    ),
  ).rejects.toMatchObject({ code: 'invalid_send_grant' });
  const noRead = await makeAudienceConnection(db, f.actor, [f.brandId], ['campaign:send']);
  expect(() => authorize(noRead.actor, 'delivery.review')).toThrow();
  const request = {
    operationKey: randomUUID(),
    brandId: f.brandId,
    campaignId: f.campaign.id,
    expectedVersion: 1,
  };
  await expect(f.delivery.execute('delivery.review', request, noRead.actor)).rejects.toMatchObject({
    code: 'scope_required',
  });
  const sender = await makeAudienceConnection(db, f.actor, [f.brandId], ['read', 'campaign:send']);
  await expect(saveSenderProfile(f.delivery, sender.actor, f.brandId)).rejects.toMatchObject({
    code: 'owner_required',
  });
  expect(() => authorize(sender.actor, 'delivery.review')).not.toThrow();
  const reviewed = (await f.delivery.execute('delivery.review', request, sender.actor)) as DeliveryView;
  await f.delivery.execute(
    'delivery.approve',
    { operationKey: randomUUID(), brandId: f.brandId, id: reviewed.id },
    sender.actor,
  );
  const expired = await makeAudienceConnection(db, f.actor, [f.brandId], ['read', 'campaign:send']);
  await db.tenant(f.workspaceId, (sql) =>
    sql.query("UPDATE connections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [
      expired.id,
    ]),
  );
  await expect(
    f.delivery.execute('delivery.review', { ...request, operationKey: randomUUID() }, expired.actor),
  ).rejects.toMatchObject({ code: 'connection_revoked' });
  const lostOwnership = new CustomerDelivery(db, { ...f.options, isOwner: async () => false });
  await expect(
    lostOwnership.execute('delivery.review', { ...request, operationKey: randomUUID() }, sender.actor),
  ).rejects.toMatchObject({ code: 'owner_required' });
  const second = randomUUID();
  await db.tenant(f.workspaceId, (sql) =>
    sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
      f.workspaceId,
      second,
      'Second shop',
    ]),
  );
  await expect(
    f.delivery.execute(
      'delivery.review',
      { ...request, brandId: second, operationKey: randomUUID() },
      sender.actor,
    ),
  ).rejects.toMatchObject({ code: 'brand_unavailable' });
  await expect(
    f.delivery.execute(
      'delivery.review',
      { ...request, brandId: second, operationKey: randomUUID() },
      { ...sender.actor, brandIds: [f.brandId, second] },
    ),
  ).rejects.toMatchObject({ code: 'connection_revoked' });
});

it('rejects a revoked send grant after waiting for the workspace lock, including receipt retries', async () => {
  const f = await factory(),
    sender = await makeAudienceConnection(db, f.actor, [f.brandId], ['read', 'campaign:send']);
  const request = {
    operationKey: randomUUID(),
    brandId: f.brandId,
    campaignId: f.campaign.id,
    expectedVersion: 1,
  };
  const reviewed = (await f.delivery.execute('delivery.review', request, sender.actor)) as DeliveryView;
  let held!: () => void, unlock!: () => void;
  const ready = new Promise<void>((resolve) => {
      held = resolve;
    }),
    release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
  const blocker = db.tenant(f.workspaceId, async (sql) => {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [f.workspaceId]);
    held();
    await release;
  });
  await ready;
  const pending = f.delivery.execute('delivery.review', request, sender.actor);
  const rejection = expect(pending).rejects.toMatchObject({ code: 'connection_revoked' });
  const pendingRead = f.delivery.execute(
    'delivery.report',
    { brandId: f.brandId, id: reviewed.id },
    sender.actor,
  );
  const readRejection = expect(pendingRead).rejects.toMatchObject({ code: 'connection_revoked' });
  const admin = new Database(fixture.adminUrl);
  try {
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      blocked =
        Number(
          (
            await admin.pool.query(
              "SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
            )
          ).rows[0]?.n,
        ) >= 2;
      if (blocked) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(blocked).toBe(true);
    // Simulate an independent administrative revocation while application requests wait.
    await admin.pool.query('UPDATE connections SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[f.workspaceId,sender.id]);
  } finally {
    unlock();
    await blocker;
    await admin.close();
  }
  await rejection;
  await readRejection;
});
it('reports current selected-brand sender readiness without a permanent false setup gap',async()=>{
 let ready=true,checks=0;
 const f=await factory({mode:'ses',provider:()=>({fingerprint:'a'.repeat(64),from:'news@shop.test',ready:async()=>{checks++;return ready;},submit:async()=>{throw Error('Status must never send.');},lookup:async()=>{throw Error('Status must not reconcile.');}})});
 await saveSenderProfile(f.delivery,f.actor,f.brandId);
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query('INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge,verified_at) VALUES($1,$2,$3,$4,clock_timestamp())',[f.workspaceId,f.brandId,'shop.test',randomUUID()]));
 expect(await f.delivery.execute('delivery.status',{brandId:f.brandId},f.actor)).toMatchObject({brandId:f.brandId,senderVerified:true,gaps:[]});
 ready=false;expect(await f.delivery.execute('delivery.status',{brandId:f.brandId},f.actor)).toMatchObject({senderVerified:false,gaps:[expect.stringContaining('selected brand')]});
 ready=true;await db.brand(f.workspaceId,f.brandId,sql=>sql.query("UPDATE sender_domains SET verified_at=now()-interval '25 hours'"));
 expect(await f.delivery.execute('delivery.status',{brandId:f.brandId},f.actor)).toMatchObject({senderVerified:false});expect(checks).toBe(2);
 expect(await f.delivery.execute('delivery.status',{},f.actor)).toMatchObject({brandId:null,senderVerified:null,gaps:[expect.stringContaining('Choose a brand')]});
 const other=await factory();
 await expect(f.delivery.execute('delivery.status',{brandId:other.brandId},f.actor)).rejects.toMatchObject({code:'brand_unavailable'});
 await expect(f.delivery.execute('delivery.status',{brandId:f.brandId},{...f.actor,brandIds:[]})).rejects.toMatchObject({code:'brand_unavailable'});
 expect(checks).toBe(2);
});
it('freezes only the selected group and never adds later group members to the reviewed delivery',async()=>{
 const f=await factory(),later=randomUUID(),blocked=randomUUID(),groupCore=new CommandService(db,undefined,async()=>true);
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query(`INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state)
   VALUES($1,$2,$3,'later@shop.test','confirmed'),($1,$2,$4,'blocked@shop.test','hard_bounced')`,[f.workspaceId,f.brandId,later,blocked]));
 const group=await groupCore.execute('segment.create',{operationKey:randomUUID(),brandId:f.brandId,name:'Early customers'},f.actor) as {id:string};
 await groupCore.execute('segment.members',{operationKey:randomUUID(),brandId:f.brandId,segmentId:group.id,action:'add',emails:['confirmed@shop.test','blocked@shop.test']},f.actor);
 const review=await f.delivery.execute('delivery.review',{operationKey:randomUUID(),brandId:f.brandId,campaignId:f.campaign.id,expectedVersion:1,segmentId:group.id},f.actor) as DeliveryView;
 expect(review).toMatchObject({selected:1,excluded:1});
 await groupCore.execute('segment.members',{operationKey:randomUUID(),brandId:f.brandId,segmentId:group.id,action:'add',emails:['later@shop.test']},f.actor);
 await groupCore.execute('segment.members',{operationKey:randomUUID(),brandId:f.brandId,segmentId:group.id,action:'remove',emails:['confirmed@shop.test']},f.actor);
 await f.delivery.execute('delivery.approve',{operationKey:randomUUID(),brandId:f.brandId,id:review.id},f.actor);
 await f.delivery.worker.tick(f.workspaceId,review.id);await f.delivery.worker.tick(f.workspaceId,review.id);
 const selected=await db.brand(f.workspaceId,f.brandId,async sql=>(await sql.query('SELECT subscriber_id FROM customer_delivery_recipients WHERE delivery_id=$1',[review.id])).rows);
 expect(selected).toEqual([{subscriber_id:f.subscriberId}]);
 expect(await f.delivery.execute('delivery.report',{brandId:f.brandId,id:review.id},f.actor)).toMatchObject({state:'completed',selected:1,accepted:1,excluded:1});
});

it('pages beyond the first50 outcomes without writes or exposing subscriber/provider details',async()=>{
 const f=await factory();
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query(`INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state)
  SELECT $1,$2,gen_random_uuid(),'person-'||n||'@shop.test','confirmed' FROM generate_series(1,60) n`,[f.workspaceId,f.brandId]));
 const review=await f.delivery.execute('delivery.review',{operationKey:randomUUID(),brandId:f.brandId,campaignId:f.campaign.id,expectedVersion:1},f.actor) as DeliveryView;
 expect(review.selected).toBe(61);expect(review.recipients).toHaveLength(50);
 const ids=await db.brand(f.workspaceId,f.brandId,async sql=>(await sql.query<{id:string}>('SELECT id FROM customer_delivery_recipients WHERE delivery_id=$1 ORDER BY id',[review.id])).rows.map(x=>x.id));
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query("UPDATE customer_delivery_recipients SET state='uncertain',attempts=1,reason='provider_unknown' WHERE id=$1",[ids.at(-1)]));
 const fingerprint=()=>db.tenant(f.workspaceId,async sql=>(await sql.query(`SELECT
  (SELECT count(*)::int FROM operations) operations,(SELECT count(*)::int FROM audit) audit,
  (SELECT count(*)::int FROM customer_usage_reservations) reservations,
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM customer_delivery_recipients p) recipients`)).rows[0]);
 const before=await fingerprint(),found:string[]=[];
 let after:string|undefined;
 do {
  const page=await f.delivery.execute('delivery.outcomes',{brandId:f.brandId,id:review.id,limit:25,...(after?{after}:{})},f.actor) as DeliveryOutcomesPage;
  expect(page).toMatchObject({total:61,mode:'capture',brandId:f.brandId,deliveryId:review.id});
  expect(page.items.length).toBeLessThanOrEqual(25);expect(Number.isFinite(Date.parse(page.observedAt))).toBe(true);
  for(const person of page.items)expect(Object.keys(person).sort()).toEqual(['attempts','feedback','id','reason','state']);
  found.push(...page.items.map(p=>p.id));after=page.nextCursor??undefined;
 }while(after);
 expect(found).toEqual(ids);expect(new Set(found).size).toBe(61);expect(await fingerprint()).toEqual(before);
 const uncertain=await f.delivery.execute('delivery.outcomes',{brandId:f.brandId,id:review.id,state:'uncertain'},f.actor) as DeliveryOutcomesPage;
 expect(uncertain).toMatchObject({total:1,nextCursor:null,items:[{id:ids.at(-1),state:'uncertain',reason:'provider_unknown',attempts:1}]});
});

it('filters feedback separately and accepts an unchanged cursor when its feedback changes',async()=>{
 const f=await factory();
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query(`INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state)
  VALUES($1,$2,gen_random_uuid(),'second@shop.test','confirmed')`,[f.workspaceId,f.brandId]));
 const review=await f.delivery.execute('delivery.review',{operationKey:randomUUID(),brandId:f.brandId,campaignId:f.campaign.id,expectedVersion:1},f.actor) as DeliveryView;
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query("UPDATE customer_delivery_recipients SET state='accepted',feedback='delivered',attempts=1 WHERE delivery_id=$1",[review.id]));
 const first=await f.delivery.execute('delivery.outcomes',{brandId:f.brandId,id:review.id,state:'accepted',feedback:'delivered',limit:1},f.actor) as DeliveryOutcomesPage;
 expect(first.total).toBe(2);expect(first.nextCursor).toBe(first.items[0]!.id);
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query("UPDATE customer_delivery_recipients SET feedback='complaint' WHERE id=$1",[first.nextCursor]));
 const next=await f.delivery.execute('delivery.outcomes',{brandId:f.brandId,id:review.id,feedback:'delivered',after:first.nextCursor},f.actor) as DeliveryOutcomesPage;
 expect(next).toMatchObject({total:1,nextCursor:null});expect(next.items).toHaveLength(1);expect(next.items[0]!.id).not.toBe(first.nextCursor);
 const empty=await f.delivery.execute('delivery.outcomes',{brandId:f.brandId,id:review.id,state:'uncertain',feedback:'delivered'},f.actor) as DeliveryOutcomesPage;
 expect(empty).toMatchObject({total:0,items:[],nextCursor:null});
});

it('keeps paginated results scoped to the workspace, brand, delivery and current connection',async()=>{
 const f=await factory(),other=await factory();
 const review=await f.delivery.execute('delivery.review',{operationKey:randomUUID(),brandId:f.brandId,campaignId:f.campaign.id,expectedVersion:1},f.actor) as DeliveryView;
 const foreign=await other.delivery.execute('delivery.review',{operationKey:randomUUID(),brandId:other.brandId,campaignId:other.campaign.id,expectedVersion:1},other.actor) as DeliveryView;
 await expect(f.delivery.execute('delivery.outcomes',{brandId:other.brandId,id:foreign.id},f.actor)).rejects.toMatchObject({code:'brand_unavailable'});
 await expect(f.delivery.execute('delivery.outcomes',{brandId:f.brandId,id:foreign.id},f.actor)).rejects.toMatchObject({code:'delivery_unavailable'});
 await expect(f.delivery.execute('delivery.outcomes',{brandId:f.brandId,id:review.id,after:foreign.recipients[0]!.id},f.actor)).rejects.toMatchObject({code:'outcome_cursor_unavailable'});
 await expect(f.delivery.execute('delivery.outcomes',{brandId:f.brandId,id:review.id},{...f.actor,brandIds:[]})).rejects.toMatchObject({code:'brand_unavailable'});
 const sender=await makeAudienceConnection(db,f.actor,[f.brandId],['read','campaign:send']);
 const bridge=createMcpServer((name,input)=>f.delivery.execute(name,input,sender.actor)),mcp=new Client({name:'recipient-outcomes',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await bridge.connect(serverTransport);await mcp.connect(clientTransport);
 try {
  const tool=(await mcp.listTools()).tools.find(x=>x.name==='delivery_outcomes');expect(tool?.annotations?.readOnlyHint).toBe(true);
  const response=await mcp.callTool({name:'delivery_outcomes',arguments:{brandId:f.brandId,id:review.id,limit:1}});
  expect(response.isError).not.toBe(true);expect(JSON.parse((response.content as {text:string}[])[0]!.text)).toMatchObject({total:1,items:[{id:review.recipients[0]!.id}]});
  await db.tenant(f.workspaceId,sql=>sql.query('UPDATE connections SET revoked_at=now() WHERE id=$1',[sender.id]));
  const denied=await mcp.callTool({name:'delivery_outcomes',arguments:{brandId:f.brandId,id:review.id}});expect(denied.isError).toBe(true);
 }finally{await mcp.close();await bridge.close();}
 for(const raw of [{limit:0},{limit:101},{limit:1.5},{state:'anything'},{after:'invalid'}])
  await expect(f.delivery.execute('delivery.outcomes',{brandId:f.brandId,id:review.id,...raw},f.actor)).rejects.toThrow();
});

it('delivery.preflight reports ready capture configuration without mutating state', async () => {
  const f = await factory();
  const before = await db.tenant(f.workspaceId, async (sql) => {
    const deliveries = (await sql.query('SELECT count(*)::int AS n FROM customer_deliveries')).rows[0].n;
    const recipients = (await sql.query('SELECT count(*)::int AS n FROM customer_delivery_recipients')).rows[0].n;
    const reservations = (await sql.query('SELECT count(*)::int AS n FROM customer_usage_reservations')).rows[0].n;
    const operations = (await sql.query('SELECT count(*)::int AS n FROM operations')).rows[0].n;
    const audit = (await sql.query('SELECT count(*)::int AS n FROM audit')).rows[0].n;
    return { deliveries, recipients, reservations, operations, audit };
  });

  const result = (await f.delivery.execute(
    'delivery.preflight',
    { brandId: f.brandId, campaignId: f.campaign.id, expectedVersion: 1 },
    f.actor,
  )) as {
    campaignId: string; version: number; contentReady: boolean; canSend: boolean; reviewRequired: boolean;
    mode: string; gaps: { code: string }[]; audience?: { confirmed: number; selected: number; excluded: number };
    observedAt: string; senderRevision: number | null;
  };

  expect(result.campaignId).toBe(f.campaign.id);
  expect(result.version).toBe(1);
  expect(result.contentReady).toBe(true);
  expect(result.canSend).toBe(false);
  expect(result.reviewRequired).toBe(true);
  expect(result.mode).toBe('capture');
  expect(result.gaps).toEqual([]);
  expect(result.audience).toMatchObject({ confirmed: 1, selected: 1, excluded: 0 });
  expect(typeof result.observedAt).toBe('string');

  const after = await db.tenant(f.workspaceId, async (sql) => {
    const deliveries = (await sql.query('SELECT count(*)::int AS n FROM customer_deliveries')).rows[0].n;
    const recipients = (await sql.query('SELECT count(*)::int AS n FROM customer_delivery_recipients')).rows[0].n;
    const reservations = (await sql.query('SELECT count(*)::int AS n FROM customer_usage_reservations')).rows[0].n;
    const operations = (await sql.query('SELECT count(*)::int AS n FROM operations')).rows[0].n;
    const audit = (await sql.query('SELECT count(*)::int AS n FROM audit')).rows[0].n;
    return { deliveries, recipients, reservations, operations, audit };
  });

  expect(after.deliveries).toBe(before.deliveries);
  expect(after.recipients).toBe(before.recipients);
  expect(after.reservations).toBe(before.reservations);
  expect(after.operations).toBe(before.operations);
  expect(after.audit).toBe(before.audit);
});

it('delivery.preflight returns all configuration gaps without failing on the first', async () => {
  const f = await factory({ mode: 'off', render: undefined });
  const admin = new Database(fixture.adminUrl);
  try {
    await admin.tenant(f.workspaceId, (sql) =>
      sql.query("UPDATE campaigns SET content=jsonb_set(content,'{subject}','\"\"'::jsonb) WHERE id=$1", [f.campaign.id]),
    );
  } finally {
    await admin.close();
  }

  const result = (await f.delivery.execute(
    'delivery.preflight',
    { brandId: f.brandId, campaignId: f.campaign.id, expectedVersion: 1 },
    f.actor,
  )) as { contentReady: boolean; canSend: boolean; gaps: { code: string }[] };

  expect(result.contentReady).toBe(false);
  expect(result.canSend).toBe(false);
  const codes = result.gaps.map((g) => g.code).sort();
  expect(codes).toEqual(['delivery_off', 'renderer_required', 'subject_missing']);
});

it('delivery.preflight returns version_conflict gap for mismatched version and rejects missing campaign', async () => {
  const f = await factory();

  const mismatched = (await f.delivery.execute(
    'delivery.preflight',
    { brandId: f.brandId, campaignId: f.campaign.id, expectedVersion: 99 },
    f.actor,
  )) as { canSend: boolean; gaps: { code: string }[] };

  expect(mismatched.canSend).toBe(false);
  expect(mismatched.gaps.map((g) => g.code)).toContain('version_conflict');

  await expect(
    f.delivery.execute(
      'delivery.preflight',
      { brandId: f.brandId, campaignId: randomUUID(), expectedVersion: 1 },
      f.actor,
    ),
  ).rejects.toMatchObject({ code: 'campaign_unavailable' });
});
it('preflight observes current SES readiness and independently reports allowance, schedule and sender failures',async()=>{
 let ready=true;
 const f=await factory({mode:'ses',provider:()=>({fingerprint:'b'.repeat(64),from:'news@shop.test',ready:async()=>ready,submit:async()=>{throw Error('Read-only checks must never submit.');},lookup:async()=>{throw Error('Read-only checks must never reconcile.');}})});
 await saveSenderProfile(f.delivery,f.actor,f.brandId);
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query('INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge,verified_at) VALUES($1,$2,$3,$4,clock_timestamp())',[f.workspaceId,f.brandId,'shop.test',randomUUID()]));
 const input={brandId:f.brandId,campaignId:f.campaign.id,expectedVersion:1};
 expect(await f.delivery.execute('delivery.preflight',input,f.actor)).toMatchObject({gaps:[],senderRevision:1,canSend:false,audience:{selected:1}});
 ready=false;
 const result=await f.delivery.execute('delivery.preflight',{...input,dueAt:'2099-01-01T00:00:00Z'},f.actor) as {gaps:{code:string}[]};
 expect(result.gaps.map(g=>g.code)).toEqual(expect.arrayContaining(['sender_verification_required','invalid_schedule']));
});
it('preflight blocks oversized audiences without fabricating exact selected or excluded counts',async()=>{
 const f=await factory();
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query(`INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state)
  SELECT $1,$2,gen_random_uuid(),'synthetic-'||i||'@shop.test','confirmed' FROM generate_series(1,10000) i`,[f.workspaceId,f.brandId]));
 const result=await f.delivery.execute('delivery.preflight',{brandId:f.brandId,campaignId:f.campaign.id},f.actor) as {audience:unknown;gaps:{code:string}[]};
 expect(result.audience).toEqual({visibility:'over_limit',confirmed:10001});expect(result.gaps.map(g=>g.code)).toContain('audience_limit');
});
