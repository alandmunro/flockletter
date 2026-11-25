import type {TestDeliveryReview,TestDeliveryDetails} from '../src/shared/customer-test-send.js';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { deliveryViews } from '../src/server/customer-delivery/storage.js';
import { mapDeliveryViews } from '../src/server/customer-delivery/report-mapping.js';
import { Database,type Sql } from '../src/server/db.js';
import { CommandService, authorize, type Actor } from '../src/server/service.js';
import { CustomerBilling, customerEligibility } from '../src/server/customer-billing/service.js';
import { CustomerAudience, createCustomerOptOut, customerPreferences } from '../src/server/customer-audience/service.js';
import type { DeliveryView,DeliveryOutcomesPage } from '../src/shared/customer-delivery.js';
import { createMcpServer } from '../src/mcp/bridge.js';
import { CustomerDelivery } from '../src/server/customer-delivery/service.js';
import type { DeliveryOptions,DeliveryRow } from '../src/server/customer-delivery/types.js';
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

async function factory(optionsOverride: Partial<DeliveryOptions> = {}, paid=true) {
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
  if(paid)await billing.execute(
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

it('links forwarded newsletters only to the sending brand’s enabled signup page', async () => {
  const f = await factory({signupPagesEnabled:true});
  await saveSenderProfile(f.delivery, f.actor, f.brandId);
  const audience = new CustomerAudience(db, {mode:'exercise', origin:f.options.origin,
    checkOwner:async () => true, contactLimit:async () => 250});
  const configure = (brand:typeof f, enabled:boolean) => audience.execute('audienceOnboarding.configure', {
    operationKey:randomUUID(), brandId:brand.brandId, enabled, purpose:'shop_news', policyVersion:'v1',
    consentText:'Send me occasional news from this shop. I can unsubscribe anytime.', sourceDomain:'shop.example.test',
  }, brand.actor) as Promise<{signupUrl:string}>;
  const review = async (delivery = f.delivery) => {
    const {id} = await delivery.execute('delivery.review', {operationKey:randomUUID(), brandId:f.brandId,
      campaignId:f.campaign.id, expectedVersion:1}, f.actor) as DeliveryView;
    return db.brand(f.workspaceId, f.brandId, async sql => (await sql.query<{rendered_html:string;rendered_text:string}>(
      'SELECT rendered_html,rendered_text FROM customer_deliveries WHERE id=$1',[id])).rows[0]!);
  };
  const invite = 'If someone forwarded this to you, join the crew and ';
  const other = await configure(await factory(), true);
  const absent = await review();
  expect(absent.rendered_html).not.toContain(invite);
  expect(absent.rendered_text).not.toContain(other.signupUrl);
  const {signupUrl} = await configure(f, true);
  expect(signupUrl).not.toBe(other.signupUrl);
  const token = await audience.resolveSignupSlug(new URL(signupUrl).pathname.split('/').pop()!);
  await expect(audience.publicForm(token)).resolves.toMatchObject({mode:'exercise'});
  const enabled = await review();
  expect(enabled.rendered_html).toContain(invite + '<a href="' + signupUrl + '"');
  expect(enabled.rendered_html).toContain('>subscribe</a>.');
  expect(enabled.rendered_text).toContain(signupUrl);
  expect(enabled.rendered_html).not.toContain('href="' + other.signupUrl + '"');
  const off = await review(new CustomerDelivery(db,{...f.options, signupPagesEnabled:false}));
  expect(off.rendered_html).not.toContain(invite);
  await configure(f, false);
  const disabled = await review();
  expect(disabled.rendered_html).not.toContain(invite);
  expect(disabled.rendered_text).not.toContain(signupUrl);
});

it('rolls back a partial 2,500-person freeze and replays the exact trial queue and allowance once', async () => {
  const f=await factory({},false);
  const request={operationKey:randomUUID(),brandId:f.brandId,campaignId:f.campaign.id,expectedVersion:1};
  const scoped=<T,>(fn:(sql:Sql)=>Promise<T>)=>db.brand(f.workspaceId,f.brandId,fn);
  await scoped(sql=>sql.query(`INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state)
    SELECT $1,$2,gen_random_uuid(),'reader-'||n||'@example.test','confirmed' FROM generate_series(1,2499) n`,[f.workspaceId,f.brandId]));
  const expected=(await scoped(sql=>sql.query<{id:string}>('SELECT id FROM subscribers ORDER BY id'))).rows.map(x=>x.id);
  const admin=new Database(fixture.adminUrl);
  try {
    // A test-only statement trigger models the hosted statement budget. Fail after the first
    // batch succeeded; sequence advancement survives rollback so the same request can recover.
    await admin.pool.query(`
      CREATE SEQUENCE public.test_freeze_batch;
      CREATE FUNCTION public.test_bounded_freeze() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      BEGIN
        IF (SELECT count(*) FROM inserted)>100 THEN RAISE EXCEPTION 'unbounded freeze'; END IF;
        IF nextval('public.test_freeze_batch'::regclass)=2 THEN RAISE EXCEPTION 'interrupted snapshot'; END IF;
        RETURN NULL;
      END $$;
      REVOKE ALL ON FUNCTION public.test_bounded_freeze() FROM PUBLIC;
      CREATE TRIGGER test_bounded_freeze AFTER INSERT ON public.customer_delivery_recipients
        REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION public.test_bounded_freeze();`);
    await expect(f.delivery.execute('delivery.review',request,f.actor)).rejects.toThrow('interrupted snapshot');
    expect((await scoped(sql=>sql.query(`SELECT
      (SELECT count(*)::int FROM customer_deliveries) reviews,
      (SELECT count(*)::int FROM customer_delivery_recipients) recipients,
      (SELECT count(*)::int FROM operations WHERE operation_key=$1) operations,
      (SELECT count(*)::int FROM customer_usage_reservations) reservations`,[request.operationKey]))).rows[0]
    ).toEqual({reviews:0,recipients:0,operations:0,reservations:0});
    const started=performance.now();
    const review=await f.delivery.execute('delivery.review',request,f.actor) as DeliveryView;
    expect(review).toMatchObject({selected:2500,state:'reviewed'});
    const frozen=async ()=>(await scoped(sql=>sql.query<{id:string;subscriber_id:string}>(
      "SELECT id,subscriber_id FROM customer_delivery_recipients WHERE delivery_id=$1 AND state='pending' ORDER BY subscriber_id",[review.id]))).rows;
    const people=await frozen();
    expect(people.map(p=>p.subscriber_id)).toEqual(expected);
    expect(new Set(people.map(p=>p.id)).size).toBe(2500);
    // Membership changes within the trial contact cap must not replace frozen recipients.
    // The worker independently rechecks the revoked subscriber before submission.
    await scoped(sql=>sql.query("UPDATE subscribers SET state='unsubscribed' WHERE id=$1",[f.subscriberId]));
    await scoped(sql=>sql.query(`INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state)
      VALUES($1,$2,gen_random_uuid(),'later@example.test','confirmed')`,[f.workspaceId,f.brandId]));
    expect(await f.delivery.execute('delivery.review',request,f.actor)).toEqual(review);
    const approve={operationKey:randomUUID(),brandId:f.brandId,id:review.id};
    const approved=await f.delivery.execute('delivery.approve',approve,f.actor);
    expect(approved).toMatchObject({id:review.id,selected:2500,state:'queued'});
    expect(await f.delivery.execute('delivery.approve',approve,f.actor)).toEqual(approved);
    expect(await f.delivery.execute('delivery.approve',{...approve,operationKey:randomUUID()},f.actor)).toEqual(approved);
    expect(await frozen()).toEqual(people);
    expect((await scoped(sql=>sql.query('SELECT recipients,slots,state FROM customer_usage_reservations'))).rows
    ).toEqual([{recipients:2500,slots:1,state:'reserved'}]);
    expect(performance.now()-started).toBeLessThan(30_000);
  } finally {
    try { await admin.pool.query(`DROP TRIGGER IF EXISTS test_bounded_freeze ON public.customer_delivery_recipients;
      DROP FUNCTION IF EXISTS public.test_bounded_freeze(); DROP SEQUENCE IF EXISTS public.test_freeze_batch;`); }
    finally { await admin.close(); }
  }
},45_000);

it('excludes a frozen recipient who leaves a subscriber-managed group before submission', async () => {
  const f = await factory();
  await saveSenderProfile(f.delivery, f.actor, f.brandId);
  const core = new CommandService(db, undefined, async () => true);
  const group = await core.execute('segment.create', {
    operationKey: randomUUID(), brandId: f.brandId, name: 'Seasonal notes', subscriberSelectable: true,
  }, f.actor) as { id: string };
  const links = await db.brand(f.workspaceId, f.brandId,
    sql => createCustomerOptOut(sql, f.workspaceId, f.brandId, f.subscriberId, f.options.origin));
  const token = new URL(links.preferencesUrl!).searchParams.get('t')!;
  const initial = (await customerPreferences(db, token))!;
  await customerPreferences(db, token, { version: initial.version, groups: [group.id], unsubscribe: false });
  const review = await f.delivery.execute('delivery.review', {
    operationKey: randomUUID(), brandId: f.brandId, campaignId: f.campaign.id,
    expectedVersion: 1, segmentId: group.id,
  }, f.actor) as { id: string };
  await f.delivery.execute('delivery.approve', { operationKey: randomUUID(), brandId: f.brandId, id: review.id }, f.actor);
  await f.delivery.worker.tick(f.workspaceId, review.id);
  const current = (await customerPreferences(db, token))!;
  await customerPreferences(db, token, { version: current.version, groups: [], unsubscribe: false });
  await f.delivery.worker.tick(f.workspaceId, review.id);
  await db.brand(f.workspaceId, f.brandId, async sql => {
    expect((await sql.query('SELECT state,reason FROM customer_delivery_recipients WHERE delivery_id=$1', [review.id])).rows)
      .toEqual([{ state: 'excluded', reason: 'consent_changed' }]);
    expect((await sql.query('SELECT FROM customer_delivery_captures WHERE delivery_id=$1', [review.id])).rowCount).toBe(0);
  });
});

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

it('rechecks an unavailable Clerk membership before retrying an unsubmitted recipient',async()=>{
  const f=await factory();
  const id=(await reviewAndApprove(f)).id;
  await f.delivery.worker.tick(f.workspaceId,id);
  f.options.isOwner=async()=>{throw Error('temporary Clerk failure');};
  await f.delivery.worker.tick(f.workspaceId,id);
  const read=()=>db.brand(f.workspaceId,f.brandId,async sql=>(await sql.query(
    'SELECT id,state,reason,attempts,next_check_at FROM customer_delivery_recipients WHERE delivery_id=$1',[id])).rows[0]!);
  const saved=await read();
  expect(saved).toMatchObject({state:'prepared',reason:'authority_verification_unavailable',attempts:0});
  expect(await f.delivery.worker.tick(f.workspaceId,id)).toEqual({processed:false});
  f.options.now=()=>new Date(saved.next_check_at.getTime()+1);
  f.options.isOwner=async()=>true;
  await f.delivery.worker.tick(f.workspaceId,id);
  expect(await read()).toMatchObject({id:saved.id,state:'accepted',attempts:1});
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
 ready=false;expect(await f.delivery.execute('delivery.status',{brandId:f.brandId},f.actor)).toMatchObject({providerConfigured:true,senderVerified:false,gaps:[expect.stringContaining('AWS SES readiness')]});
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
it('batches complete delivery counts and only50 ordered opaque outcomes in2 sequential reads',async()=>{
 const f=await factory();
 const reviewed=await f.delivery.execute('delivery.review',{operationKey:randomUUID(),brandId:f.brandId,campaignId:f.campaign.id,expectedVersion:1},f.actor) as DeliveryView;
 const states=['pending','prepared','preparing','submitting','accepted','uncertain','rejected','excluded','cancelled'];
 const feedback=[null,'delivered','hard_bounce','complaint','temporary_bounce'];
 const people=Array.from({length:60},(_,i)=>({subscriber:randomUUID(),id:i.toString(16).padStart(8,'0')+'-0000-4000-8000-000000000000',state:states[i%states.length]!,feedback:feedback[i%feedback.length]!}));
 await db.brand(f.workspaceId,f.brandId,async sql=>{
  await sql.query('UPDATE customer_delivery_recipients SET id=$2 WHERE delivery_id=$1',[reviewed.id,'ffffffff-ffff-4fff-8fff-ffffffffffff']);
  await sql.query(`INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state)
   SELECT $1,$2,p.id,'batch-'||p.id::text||'@shop.test','confirmed' FROM unnest($3::uuid[]) p(id)`,[f.workspaceId,f.brandId,people.map(p=>p.subscriber)]);
  await sql.query(`INSERT INTO customer_delivery_recipients(workspace_id,brand_id,delivery_id,id,subscriber_id,email_digest,engine_reference,state,feedback,reason,attempts)
   SELECT $1,$2,$3,p.id,p.subscriber,$4,p.id::text,p.state,p.feedback,'fixture_reason',1
   FROM unnest($5::uuid[],$6::uuid[],$7::text[],$8::text[]) p(id,subscriber,state,feedback)`,[f.workspaceId,f.brandId,reviewed.id,'a'.repeat(64),people.map(p=>p.id),people.map(p=>p.subscriber),people.map(p=>p.state),people.map(p=>p.feedback)]);
 });
 const rows=await db.brand(f.workspaceId,f.brandId,async sql=>(await sql.query<DeliveryRow>('SELECT * FROM customer_deliveries WHERE brand_id=$1',[f.brandId])).rows);
 const measured=async(input:DeliveryRow[])=>db.brand(f.workspaceId,f.brandId,async sql=>{
  let calls=0,active=0,maximum=0;
  const tracked=new Proxy(sql,{get(target,property,receiver){const value=Reflect.get(target,property,receiver);if(property!=='query')return value;return (...args:unknown[])=>{
   calls++;active++;maximum=Math.max(maximum,active);return Promise.resolve(Reflect.apply(value,target,args)).finally(()=>{active--;});
  };}});
  return {reports:await deliveryViews(tracked,input),calls,maximum};
 });
 const one=await measured(rows),report=one.reports[0]!;
 expect(one.calls).toBe(2);expect(one.maximum).toBe(1);
 const all=[{state:'pending',feedback:null},...people];
 const count=(...match:string[])=>all.filter(p=>match.includes(p.state)).length;
 const events=(kind:string)=>all.filter(p=>p.feedback===kind).length;
 expect(report).toMatchObject({pending:count('pending','prepared'),preparing:count('preparing'),submitting:count('submitting'),accepted:count('accepted'),uncertain:count('uncertain'),rejected:count('rejected'),skipped:count('excluded','cancelled'),delivered:events('delivered'),hardBounced:events('hard_bounce'),complained:events('complaint')});
 expect(report.recipients).toHaveLength(50);expect(report.recipients.map(p=>p.id)).toEqual(people.slice(0,50).map(p=>p.id));
 for(const p of report.recipients)expect(Object.keys(p).sort()).toEqual(['attempts','feedback','id','reason','state']);
 expect(report.recipients.every(p=>p.attempts===1&&p.reason==='fixture_reason')).toBe(true);
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query(`INSERT INTO customer_deliveries(workspace_id,brand_id,id,campaign_id,version,actor_id,creator_id,mode,state,content,rendered_html,rendered_text,asset_digests,provider_binding,due_at,selected,excluded)
  SELECT workspace_id,brand_id,gen_random_uuid(),campaign_id,version,actor_id,creator_id,mode,state,content,rendered_html,rendered_text,asset_digests,provider_binding,due_at,selected,excluded FROM customer_deliveries CROSS JOIN generate_series(1,99) WHERE id=$1`,[reviewed.id]));
 const manyRows=await db.brand(f.workspaceId,f.brandId,async sql=>(await sql.query<DeliveryRow>('SELECT * FROM customer_deliveries WHERE brand_id=$1 ORDER BY id DESC',[f.brandId])).rows);
 const many=await measured(manyRows);expect(many.calls).toBe(2);expect(many.maximum).toBe(1);expect(many.reports.map(r=>r.id)).toEqual(manyRows.map(r=>r.id));
 expect(many.reports.find(r=>r.id===reviewed.id)).toEqual(report);
 expect(many.reports.filter(r=>r.id!==reviewed.id).every(r=>r.pending===0&&r.accepted===0&&r.recipients.length===0)).toBe(true);
 expect(await deliveryViews({query:()=>{throw Error('Empty reports must not query.');}} as unknown as Sql,[])).toEqual([]);
 await expect(deliveryViews({query:()=>{throw Error('Oversized report must not query.');}} as unknown as Sql,Array.from({length:101},()=>rows[0]!))).rejects.toMatchObject({code:'report_batch_limit'});
 const duplicate=await measured([rows[0]!,rows[0]!]);expect(duplicate.reports).toEqual([report,report]);expect(duplicate.calls).toBe(2);
 const otherBrand=randomUUID();await db.tenant(f.workspaceId,sql=>sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)',[f.workspaceId,otherBrand,'Other report brand']));
 const hiddenCampaign=await f.core.execute('campaign.create',{operationKey:randomUUID(),brandId:otherBrand,content:rows[0]!.content},f.actor) as {id:string};
 await db.brand(f.workspaceId,otherBrand,sql=>sql.query("INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'hidden@other.test','confirmed')",[f.workspaceId,otherBrand,randomUUID()]));
 const hidden=await f.delivery.execute('delivery.review',{operationKey:randomUUID(),brandId:otherBrand,campaignId:hiddenCampaign.id,expectedVersion:1},f.actor) as DeliveryView;
 await expect(f.delivery.execute('delivery.list',{brandId:otherBrand},{...f.actor,brandIds:[f.brandId]})).rejects.toMatchObject({code:'brand_unavailable'});
 const listed=await f.delivery.execute('delivery.list',{brandId:f.brandId},{...f.actor,brandIds:[f.brandId]}) as DeliveryView[];
 expect(listed).toHaveLength(100);expect(listed.every(r=>r.brandId===f.brandId)).toBe(true);expect(listed.some(r=>r.id===hidden.id)).toBe(false);
});
it('keeps mapper routing tuples separate when delivery identifiers coincide across brands/workspaces',async()=>{
 const f=await factory(),review=await f.delivery.execute('delivery.review',{operationKey:randomUUID(),brandId:f.brandId,campaignId:f.campaign.id,expectedVersion:1},f.actor) as DeliveryView;
 const row=await db.brand(f.workspaceId,f.brandId,async sql=>(await sql.query<DeliveryRow>('SELECT * FROM customer_deliveries WHERE id=$1',[review.id])).rows[0]!);
 const base={workspace_id:f.workspaceId,brand_id:f.brandId,delivery_id:row.id};
 const groups=[{...base,state:'pending',feedback:null,n:1},{...base,brand_id:randomUUID(),state:'accepted',feedback:'complaint',n:9},{...base,workspace_id:'org_foreign',state:'accepted',feedback:'hard_bounce',n:7}];
 const outcomes=[{...base,id:randomUUID(),state:'pending',feedback:null,reason:null,attempts:0},{...base,workspace_id:'org_foreign',id:randomUUID(),state:'accepted',feedback:'complaint',reason:'foreign',attempts:3}];
 const report=mapDeliveryViews([row],groups,outcomes)[0]!;expect(report).toMatchObject({pending:1,accepted:0,complained:0,hardBounced:0});expect(report.recipients).toHaveLength(1);expect(JSON.stringify(report)).not.toContain('foreign');
});

it('freezes one confirmed contact as an immediate test review without touching the broadcast campaign', async () => {
  const f = await factory();
  const reviewed = (await f.delivery.execute(
    'delivery.reviewTest',
    {
      operationKey: randomUUID(),
      brandId: f.brandId,
      campaignId: f.campaign.id,
      expectedVersion: 1,
      subscriberId: f.subscriberId,
    },
    f.actor,
  )) as TestDeliveryReview;

  expect(reviewed.purpose).toBe('test');
  expect(reviewed.selected).toBe(1);
  expect(reviewed.testSubscriberId).toBe(f.subscriberId);
  expect(reviewed.subject.startsWith('[TEST]')).toBe(true);

  const campaign = (await f.core.execute('campaign.get', { id: f.campaign.id }, f.actor)) as {
    content:{subject:string};
    version: number;
  };
  expect(campaign.content.subject).toBe('Trail news');
  expect(campaign.version).toBe(1);

  const listed = (await f.delivery.execute('delivery.list', { brandId: f.brandId }, f.actor)) as DeliveryView[];
  const listedTest = listed.find((d) => d.id === reviewed.id);
  expect(listedTest).toBeDefined();
  expect(JSON.stringify(listedTest)).not.toContain(f.subscriberId);

  const report = (await f.delivery.execute(
    'delivery.report',
    { brandId: f.brandId, id: reviewed.id },
    f.actor,
  )) as DeliveryView;
  expect(JSON.stringify(report)).not.toContain(f.subscriberId);
});

it('captures an accepted test email with [TEST] subject prefix and consumes one usage credit', async () => {
  const f = await factory();
  const reviewed = (await f.delivery.execute(
    'delivery.reviewTest',
    {
      operationKey: randomUUID(),
      brandId: f.brandId,
      campaignId: f.campaign.id,
      expectedVersion: 1,
      subscriberId: f.subscriberId,
    },
    f.actor,
  )) as TestDeliveryReview;

  const details = (await f.delivery.execute(
    'delivery.testDetails',
    { brandId: f.brandId, id: reviewed.id },
    f.actor,
  )) as TestDeliveryDetails;
  expect(details.recipient.eligible).toBe(true);
  expect(details.canApprove).toBe(true);

  await f.delivery.execute(
    'delivery.approveTest',
    {
      operationKey: randomUUID(),
      brandId: f.brandId,
      id: reviewed.id,
      expectedVersion: 1,
      subscriberId: f.subscriberId,
    },
    f.actor,
  );

  await f.delivery.worker.tick(f.workspaceId, reviewed.id);
  expect(f.renderCalls).toEqual(['reader@campaign.test']);

  await f.delivery.worker.tick(f.workspaceId, reviewed.id);
  const recipients = (
    await db.tenant(f.workspaceId, (sql) =>
      sql.query('SELECT id FROM customer_delivery_recipients WHERE delivery_id=$1', [reviewed.id]),
    )
  ).rows[0]!;

  const message = (await f.delivery.execute(
    'delivery.message',
    { brandId: f.brandId, id: reviewed.id, recipientId: recipients.id },
    f.actor,
  )) as { subject: string; html: string };

  expect(message.subject.startsWith('[TEST]')).toBe(true);
  expect(message.html).toContain('Unsubscribe from this newsletter');

  const finalReport = (await f.delivery.execute(
    'delivery.report',
    { brandId: f.brandId, id: reviewed.id },
    f.actor,
  )) as DeliveryView;

  expect(finalReport.state).toBe('completed');
  expect(finalReport.accepted).toBe(1);

  const status = await billing.status(f.workspaceId);
  expect(status.usage.emails).toBe(1);
  expect(status.usage.campaigns).toBe(0);
  expect(status.usage.reservedEmails).toBe(0);

  expect(finalReport.testDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

it('observes canonical one-recipient test preflight and UTC budget without requiring a campaign slot',async()=>{
 const f=await factory();
 await db.brand(f.workspaceId,f.brandId,async sql=>{
  for(let i=0;i<2;i++){const key='fixture-exhaust-campaign-'+i;await billing.reserve(sql,f.workspaceId,{operationKey:key,campaignId:f.campaign.id,brandId:f.brandId,recipients:1});await billing.settle(sql,f.workspaceId,key,{accepted:1,excluded:0});}
 });
 const checked=await f.delivery.execute('delivery.preflight',{brandId:f.brandId,campaignId:f.campaign.id,expectedVersion:1,purpose:'test',subscriberId:f.subscriberId},f.actor) as {purpose:string;gaps:unknown[];testBudget:{day:string;limit:number;used:number;remaining:number}};
 expect(checked).toMatchObject({purpose:'test',gaps:[],testBudget:{limit:5,used:0,remaining:5}});expect(checked.testBudget.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

it('hands an eligible annual email to marketing delivery exactly once, with unsubscribe and no extra recipients',async()=>{
  const {DateAutomations}=await import('../src/server/date-automations/service.js');
  const {planBrand}=await import('../src/server/date-automations/planner.js');
  const {annualClaim,dispatchBrand}=await import('../src/server/date-automations/dispatch.js');
  const {setDate}=await import('../src/server/subscribers/people.js');
  const f=await factory(),dates=new DateAutomations(db,'capture',async()=>true);
  const settings={time:'09:00',startHour:9,endHour:20,zone:'America/New_York',sms:'Happy birthday!',
    email:{subject:'Your birthday greeting',body:'Happy birthday, {{firstName}}.'}};
  const keys={brandId:f.brandId,kind:'birthday'};
  await dates.execute('dateAutomation.save',{...keys,operationKey:randomUUID(),expectedRevision:0,settings},f.actor);
  await dates.execute('dateAutomation.activate',{...keys,operationKey:randomUUID(),expectedRevision:1,confirmRecurring:true},f.actor);
  await db.brand(f.workspaceId,f.brandId,async sql=>{
    await sql.query("UPDATE date_automations SET activated_at=$1,next_scan=$1",[new Date('2026-11-07')]);
    await setDate(sql,f.workspaceId,f.brandId,{subscriber:f.subscriberId,contact:null},'birthday',{month:11,day:8},'Birthday');
    await sql.query("INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'another@shop.test','confirmed')",[f.workspaceId,f.brandId,randomUUID()]);
  });
  const ports={mode:'capture' as const,isOwner:f.options.isOwner,delivery:f.delivery};
  f.options.annualClaim=(sql,w,b,id,now)=>annualClaim(sql,w,b,'email',id,ports,now);
  await planBrand(db,f.workspaceId,f.brandId,'capture',base);
  await Promise.all([1,2].map(()=>dispatchBrand(db,f.workspaceId,f.brandId,ports,base)));
  const rows=await db.brand(f.workspaceId,f.brandId,async sql=>(await sql.query('SELECT state,reason,channel,delivery_id FROM date_occurrences')).rows);
  expect(rows).toMatchObject([{state:'queued',reason:null,channel:'email'}]);
  // A delivery queued by the previous release must survive the controls rollout.
  const {dateSources}=await import('../src/server/date-automations/sources.js');
  const {digest}=await import('../src/server/content.js');
  await db.brand(f.workspaceId,f.brandId,async sql=>{
    const [source]=await dateSources(sql,f.brandId,'birthday',[11],null,1);
    expect(source?.subscriber_id).toBe(f.subscriberId);
    await sql.query('UPDATE date_occurrences SET source_digest=$1 WHERE delivery_id=$2',
      [digest(JSON.stringify([source,null])),rows[0]!.delivery_id]);
  });
  for(let i=0;i<4;i++)await f.delivery.worker.tick(f.workspaceId,rows[0]!.delivery_id);
  const captures=await db.brand(f.workspaceId,f.brandId,async sql=>(await sql.query('SELECT payload FROM customer_delivery_captures')).rows);
  expect(captures).toHaveLength(1);
  expect(captures[0]!.payload).toMatchObject({to:'confirmed@shop.test',subject:'Your birthday greeting'});
  expect(captures[0]!.payload.text).toContain('Happy birthday, friend.');
  expect(captures[0]!.payload.text.toLowerCase()).toContain('unsubscribe');
  expect((await billing.status(f.workspaceId)).usage).toMatchObject({emails:1,campaigns:1,reservedEmails:0,reservedCampaigns:0});

  // Edit another recipient's date after handoff but before submission. Keep the original
  // negative channel receipt and let the planner move the unsent greeting to the new day.
  const second=await db.brand(f.workspaceId,f.brandId,async sql=>{
    const id=(await sql.query<{id:string}>("SELECT id FROM subscribers WHERE email_normalized='another@shop.test'")).rows[0]!.id;
    await setDate(sql,f.workspaceId,f.brandId,{subscriber:id,contact:null},'birthday',{month:11,day:8},'Birthday');
    return id;
  });
  const later=new Date(base.getTime()+120000);
  await planBrand(db,f.workspaceId,f.brandId,'capture',later);
  await dispatchBrand(db,f.workspaceId,f.brandId,ports,later);
  const initial=await db.brand(f.workspaceId,f.brandId,async sql=>{
    const row=(await sql.query<{id:string;delivery_id:string}>(`SELECT o.id,o.delivery_id FROM date_occurrences o JOIN contact_dates d
      ON d.id=o.date_id WHERE d.subscriber_id=$1`,[second])).rows[0]!;
    await setDate(sql,f.workspaceId,f.brandId,{subscriber:second,contact:null},'birthday',{month:11,day:10},'Birthday');
    return row;
  });
  for(let i=0;i<4;i++)await f.delivery.worker.tick(f.workspaceId,initial.delivery_id);
  await planBrand(db,f.workspaceId,f.brandId,'capture',new Date(later.getTime()+120000));
  const result=await db.brand(f.workspaceId,f.brandId,async sql=>(await sql.query(
    'SELECT state,delivery_id,local_date::text FROM date_occurrences WHERE id=$1',[initial.id])).rows[0]);
  expect(result).toEqual({state:'planned',delivery_id:null,local_date:'2026-11-10'});
  expect(await db.brand(f.workspaceId,f.brandId,async sql=>(await sql.query('SELECT FROM customer_delivery_captures')).rowCount)).toBe(1);
});

// The delivery fixture starts with reserved offers. Use the ledger's normal
// workspace lock and restricted runtime role for each fixture state change.
async function seedGiftOffer(workspace: string, brand: string, offer: import('../src/server/workspace-gifts/store.js').GiftOffer) {
  const { put } = await import('../src/server/workspace-gifts/store.js');
  const { lockWorkspace } = await import('../src/server/workspace-lock.js');
  await db.brand(workspace,brand,async sql=>{
    await lockWorkspace(sql,workspace);
    await put(sql,workspace,'offer',offer.id,offer);
  });
}

it('binds captured annual SMS and fallback email to one reserved offer and rechecks before submission', async () => {
  const { DateAutomations } = await import('../src/server/date-automations/service.js');
  const { planBrand } = await import('../src/server/date-automations/planner.js');
  const { annualClaim, dispatchBrand } = await import('../src/server/date-automations/dispatch.js');
  const { setDate } = await import('../src/server/subscribers/people.js');
  const { reservedGiftLink } = await import('../src/server/workspace-gifts/ledger.js');
  const { Texting } = await import('../src/server/texting/service.js');
  const f = await factory(), w = f.workspaceId, b = f.brandId, phoneId = randomUUID();
  const policy={mode:'capture' as const,account:'acct_test'};
  const dates = new DateAutomations(db, 'capture', f.options.isOwner, policy);
  const campaignId = randomUUID();
  const offer = {
    id: randomUUID(), brand: b, campaign: campaignId, person: f.subscriberId, face: 500,
    expires: new Date(Date.now() + 86400000).toISOString(), state: 'offered' as const,
    alloc: [{id:randomUUID(),amount:500}], secret: randomUUID().replaceAll('-', '').repeat(2),
  };
  for (const kind of ['birthday', 'anniversary']) {
    await dates.execute('dateAutomation.save', { brandId: b, kind, expectedRevision: 0, operationKey: randomUUID(),
      settings: { giftCampaignId: campaignId, time: '09:00', zone: 'America/New_York', startHour: 9, endHour: 20,
        sms: 'Plain SMS', email: { subject: 'Plain subject', body: 'Plain email' } } }, f.actor);
    await dates.execute('dateAutomation.activate', { brandId: b, kind, expectedRevision: 1, giftMode:'capture', confirmRecurring: true, operationKey: randomUUID() }, f.actor);
  }
  await seedGiftOffer(w,b,offer);
  const company = await db.brand(w,b,async sql => {
    const company = (await sql.query('SELECT company_id FROM company_brands WHERE brand_id=$1', [b])).rows[0]!.company_id;
    await sql.query("INSERT INTO sms_contacts(workspace_id,id,phone_e164,brand_id,subscriber_id) VALUES($1,$2,'+12125550777',$3,$4)",[w,phoneId,b,f.subscriberId]);
    await sql.query("INSERT INTO sms_consents(workspace_id,company_id,contact_id,state) VALUES($1,$2,$3,'opted_in')",[w,company,phoneId]);
    await sql.query('UPDATE date_automations SET activated_at=$1,next_scan=$1', [new Date('2026-11-07')]);
    await setDate(sql,w,b,{subscriber:f.subscriberId,contact:phoneId},'birthday',{month:11,day:8},'Birthday');
    return company;
  });
  const texting=Texting.mock(db,{origin:f.options.origin,linkOrigin:f.options.origin+'/l',isOwner:f.options.isOwner,now:()=>base});
  const ports={mode:'capture' as const,giftDelivery:policy,isOwner:f.options.isOwner,delivery:f.delivery,texting};
  f.options.annualClaim=(sql,w,b,id,now)=>annualClaim(sql,w,b,'email',id,ports,now);
  await planBrand(db,w,b,'capture',base);
  await dispatchBrand(db,w,b,ports,base);
  const link=await db.brand(w,b,async sql=>{
    const m=(await sql.query('SELECT id,rendered_body FROM sms_messages WHERE date_brand_id=$1',[b])).rows[0]!;
    const path=await reservedGiftLink(sql,w,b,campaignId,f.subscriberId);
    const url=f.options.origin+path;
    expect(m.rendered_body.includes(url)).toBe(true);
    expect(m.rendered_body.includes('STOP')).toBe(true);
    expect(await annualClaim(sql,w,b,'sms',m.id,ports,base,company)).toBeNull();
    await sql.query("UPDATE sms_consents SET state='opted_out' WHERE contact_id=$1",[phoneId]);
    expect(await annualClaim(sql,w,b,'sms',m.id,ports,base,company)).toBeTruthy();
    await setDate(sql,w,b,{subscriber:f.subscriberId,contact:phoneId},'anniversary',{month:11,day:8},'Anniversary');
    return url;
  });
  const later=new Date(base.getTime()+120000);
  await planBrand(db,w,b,'capture',later);
  await dispatchBrand(db,w,b,ports,later);
  const email=await db.brand(w,b,async sql=>{
    const row=(await sql.query("SELECT delivery_id FROM date_occurrences WHERE channel='email'")).rows[0]!;
    const snap=(await sql.query('SELECT rendered_text FROM customer_deliveries WHERE id=$1',[row.delivery_id])).rows[0]!;
    expect(snap.rendered_text.includes(link)).toBe(true);
    expect(snap.rendered_text.includes('Plain email')).toBe(false);
    await sql.query("UPDATE subscribers SET first_name='Taylor' WHERE id=$1",[f.subscriberId]);
    expect(await annualClaim(sql,w,b,'email',row.delivery_id,ports,base)).toBe('date_changed');
    await sql.query('UPDATE subscribers SET first_name=NULL WHERE id=$1',[f.subscriberId]);
    // Changing the bearer on the same offer cannot silently change the reviewed message.
    await seedGiftOffer(w,b,{...offer,secret:'b'.repeat(64)});
    expect(await annualClaim(sql,w,b,'email',row.delivery_id,ports,base)).toBe('gift_review_changed');
    await seedGiftOffer(w,b,{...offer,state:'expired'});
    return row.delivery_id;
  });
  for(let i=0;i<4;i++)await f.delivery.worker.tick(w,email);
  expect(await db.brand(w,b,async sql=>(await sql.query('SELECT FROM customer_delivery_captures')).rowCount)).toBe(0);
  expect(await db.brand(w,b,async sql=>(await sql.query('SELECT state,reason FROM customer_delivery_recipients WHERE delivery_id=$1',[email])).rows))
    .toEqual([{state:'cancelled',reason:'gift_offer_unavailable'}]);
});

it('reviews manual gift bindings for the entire frozen audience and personalizes each copy', async () => {
  const { giftCampaignContent, reviewCampaignGifts, reviewedCampaignGift, attachEmailGift } =
    await import('../src/server/workspace-gifts/delivery.js');
  const { deliveryRow } = await import('../src/server/customer-delivery/storage.js');
  const { emptyContent } = await import('../src/shared/contracts.js');
  const f=await factory(), w=f.workspaceId, b=f.brandId, second=randomUUID(), campaignId=randomUUID();
  const draft=await f.core.execute('campaign.create',{brandId:b,operationKey:randomUUID(),
    content:giftCampaignContent({...emptyContent(),fromName:'Shop',replyTo:'shop@example.test',title:'Thank you'})},f.actor) as {id:string};
  await db.brand(w,b,sql=>sql.query("INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'second@example.test','confirmed')",[w,b,second]));
  const review=await f.delivery.execute('delivery.review',{brandId:b,operationKey:randomUUID(),campaignId:draft.id,expectedVersion:1},f.actor) as {id:string};
  const offers=[f.subscriberId,second].map(person=>({
    id:randomUUID(),brand:b,campaign:campaignId,person,face:500,state:'offered' as const,alloc:[{id:randomUUID(),amount:500}],
    expires:new Date(Date.now()+86400000).toISOString(),secret:randomUUID().replaceAll('-','').repeat(2),
  }));
  const bind=()=>db.brand(w,b,async sql=>reviewCampaignGifts(sql,f.actor,await deliveryRow(sql,review.id,b),campaignId,f.options.origin,{mode:'capture',account:'acct_test'}));
  await seedGiftOffer(w,b,offers[0]!);
  await expect(bind()).rejects.toMatchObject({code:'gift_offer_unavailable'});
  await seedGiftOffer(w,b,offers[1]!);
  await bind();
  await db.brand(w,b,async sql=>{
    const row=await deliveryRow(sql,review.id,b);
    expect(row.state).toBe('reviewed');
    const {rows}=await sql.query<import('../src/server/customer-delivery/types.js').PersonRow>(
      'SELECT * FROM customer_delivery_recipients WHERE delivery_id=$1',[review.id]);
    expect(rows).toHaveLength(2);
    for(const person of rows){
      const link=await reviewedCampaignGift(sql,row,person,f.options.origin,{mode:'capture',account:'acct_test'});
      expect(Boolean(link)).toBe(true);
      const own=offers.find(o=>o.person===person.subscriber_id)!;
      expect(new URLSearchParams(new URL(link!).hash.slice(1)).get('offer')).toBe(own.id);
      const result=attachEmailGift({html:row.rendered_html,text:row.rendered_text},link!);
      expect(result.html.includes('href="')).toBe(true);
      expect(result.text.includes(link!)).toBe(true);
      const other=offers.find(o=>o!==own)!;
      expect(result.html.includes(other.secret)||result.text.includes(other.secret)).toBe(false);
      expect(row.rendered_html.includes(own.secret)||row.rendered_text.includes(own.secret)).toBe(false);
    }
    await expect(reviewedCampaignGift(sql,row,{...rows[0]!,subscriber_id:rows[1]!.subscriber_id},f.options.origin,{mode:'capture',account:'acct_test'}))
      .rejects.toMatchObject({code:'gift_review_changed'});
    expect((await sql.query('SELECT count(*)::int n FROM customer_delivery_captures')).rows[0]!.n).toBe(0);
  });
});

it('requires explicit manual approval and captures only the reviewed recipient gift', async () => {
  const f=await factory({giftDelivery:{mode:'capture',account:'acct_test'}}), campaignId=randomUUID(), w=f.workspaceId, b=f.brandId;
  const offer={id:randomUUID(),brand:b,campaign:campaignId,person:f.subscriberId,face:500,state:'offered' as const,
    alloc:[{id:randomUUID(),amount:500}],expires:new Date(Date.now()+86400000).toISOString(),secret:randomUUID().replaceAll('-','').repeat(2)};
  const input={brandId:b,campaignId:f.campaign.id,expectedVersion:1,giftCampaignId:campaignId,operationKey:randomUUID()};
  await expect(f.delivery.execute('delivery.review',input,f.actor)).rejects.toMatchObject({code:'gift_offer_unavailable'});
  expect(await db.brand(w,b,async sql=>(await sql.query('SELECT FROM customer_deliveries')).rowCount)).toBe(0);
  await seedGiftOffer(w,b,offer);
  const review=await f.delivery.execute('delivery.review',input,f.actor) as DeliveryView;
  expect(review).toMatchObject({state:'reviewed',giftCampaignId:campaignId,selected:1});
  expect((await f.delivery.worker.tick(w,review.id)).processed).toBe(false);
  await f.delivery.execute('delivery.approve',{brandId:b,operationKey:randomUUID(),id:review.id},f.actor);
  for(let i=0;i<4;i++)await f.delivery.worker.tick(w,review.id);
  await db.brand(w,b,async sql=>{
    const payload=(await sql.query('SELECT payload FROM customer_delivery_captures WHERE delivery_id=$1',[review.id])).rows[0]?.payload;
    expect(Boolean(payload?.html.includes('href="'+f.options.origin+'/workspace-gift.html#'))).toBe(true);
    expect(Boolean(payload?.text.includes(offer.secret))).toBe(true);
    expect(Boolean(payload?.text.includes('Unsubscribe'))).toBe(true);
  });
  const next=await f.delivery.execute('delivery.review',{...input,operationKey:randomUUID()},f.actor) as DeliveryView;
  await f.delivery.execute('delivery.approve',{brandId:b,operationKey:randomUUID(),id:next.id},f.actor);
  await f.delivery.worker.tick(w,next.id);
  await seedGiftOffer(w,b,{...offer,state:'expired'});
  await f.delivery.worker.tick(w,next.id);
  await db.brand(w,b,async sql=>{
    expect((await sql.query('SELECT FROM customer_delivery_captures WHERE delivery_id=$1',[next.id])).rowCount).toBe(0);
    expect((await sql.query('SELECT state,reason FROM customer_delivery_recipients WHERE delivery_id=$1',[next.id])).rows)
      .toEqual([{state:'excluded',reason:'gift_offer_unavailable'}]);
  });
});

it.each(['ses','resend'] as const)('submits only a live reviewed gift on the authorized %s route',async mode=>{
  const {seedReservedGift}=await import('./helpers/reserved-gift.js');
  const {put}=await import('../src/server/workspace-gifts/store.js');
  const messages:{to:string;text:string;html:string}[]=[];
  let liveConsent=true;
  const f=await factory({mode,environment:'production',origin:'https://mail.example.org',
    liveConsent:async()=>liveConsent,
    provider:()=>({fingerprint:'live-gift-'+mode,from:'news@shop.test',ready:async()=>true,
      submit:async message=>{messages.push(message);return {outcome:'accepted',messageId:'synthetic-receipt'};},
      lookup:async()=>({outcome:'accepted',messageId:'synthetic-receipt'})})});
  const w=f.workspaceId,b=f.brandId,account='acct_same_in_test_and_live';
  const live={mode:'live' as const,account,verifiedBrands:new Set([b])};
  await saveSenderProfile(f.delivery,f.actor,b);
  await db.brand(w,b,sql=>sql.query('INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge,checked_at,verified_at) VALUES($1,$2,$3,$4,now(),now())',
    [w,b,'shop.test',randomUUID()]));
  const {campaign,lot,offer}=await seedReservedGift(db,w,b,f.subscriberId,account,false);
  const review=()=>f.delivery.execute('delivery.review',{brandId:b,campaignId:f.campaign.id,expectedVersion:1,
    giftCampaignId:campaign.id,operationKey:randomUUID()},f.actor) as Promise<DeliveryView>;
  const approve=(id:string)=>f.delivery.execute('delivery.approve',{brandId:b,id,operationKey:randomUUID()},f.actor);
  await expect(review()).rejects.toMatchObject({code:'gift_delivery_unavailable'});
  f.options.giftDelivery=live;
  await expect(review()).rejects.toMatchObject({code:'gift_provenance_mismatch'});
  await db.brand(w,b,sql=>put(sql,w,'campaign',campaign.id,{...campaign,live:true} as typeof campaign));
  await expect(review()).rejects.toMatchObject({code:'gift_provenance_mismatch'});
  await db.brand(w,b,sql=>put(sql,w,'lot',lot.id,{...lot,live:true} as typeof lot));
  f.options.giftDelivery={...live,account:'acct_unrelated'};
  await expect(review()).rejects.toMatchObject({code:'gift_provenance_mismatch'});
  f.options.giftDelivery=live;
  const approved=await review();
  expect(approved).toMatchObject({mode,state:'reviewed',selected:1,giftCampaignId:campaign.id});
  expect((await f.delivery.worker.tick(w,approved.id)).processed).toBe(false);
  live.verifiedBrands.delete(b);
  await expect(approve(approved.id)).rejects.toMatchObject({code:'gift_delivery_unavailable'});
  live.verifiedBrands.add(b);
  await approve(approved.id);
  for(let i=0;i<4;i++)await f.delivery.worker.tick(w,approved.id);
  expect(messages).toHaveLength(1);
  const message=messages[0]!;
  expect(message.to).toBe('confirmed@shop.test');
  expect(message.html.includes('href="'+f.options.origin+'/workspace-gift.html#')).toBe(true);
  expect(message.text.includes(offer.secret)&&message.text.includes('Unsubscribe')).toBe(true);

  const stopped=await review();
  await approve(stopped.id);
  await f.delivery.worker.tick(w,stopped.id);
  liveConsent=false;
  await f.delivery.worker.tick(w,stopped.id);
  expect(messages).toHaveLength(1);
  expect(await db.brand(w,b,async sql=>(await sql.query('SELECT state,reason FROM customer_delivery_recipients WHERE delivery_id=$1',[stopped.id])).rows))
    .toEqual([{state:'excluded',reason:'consent_changed'}]);
});
