import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { CustomerBilling, customerEligibility } from '../src/server/customer-billing/service.js';
import { createCustomerOptOut } from '../src/server/customer-audience/service.js';
import type { DeliveryView } from '../src/shared/customer-delivery.js';
import { saveSenderProfile } from './helpers/delivery-profile.js';
import type { DeliveryOptions } from '../src/server/customer-delivery/types.js';
import { CustomerDelivery } from '../src/server/customer-delivery/service.js';

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
  let nowValue = base;
  const options: DeliveryOptions = {
    mode: 'capture',
    origin: 'http://localhost:3000',
    environment: 'test',
    billing,
    isOwner: async () => true,
    now: () => nowValue,
    render: async (msg) => {
      renderCalls.push(msg.to);
    },
    optOut: createCustomerOptOut,
    eligibilitySql: (sql, workspace) =>
      customerEligibility(sql, workspace, { environment: 'test', exerciseEnabled: true }, nowValue),
    liveConsent: async () => true,
    ...optionsOverride,
  };
  const delivery = new CustomerDelivery(db, options);
  return {
    workspaceId,
    brandId,
    actor,
    campaign,
    subscriberId,
    delivery,
    renderCalls,
    core,
    options,
    setNow: (d: Date) => {
      nowValue = d;
    },
  };
}

async function reviewAndApprove(f: Awaited<ReturnType<typeof factory>>, dueAtISO?: string) {
  const reviewed = (await f.delivery.execute(
    'delivery.review',
    {
      operationKey: randomUUID(),
      brandId: f.brandId,
      campaignId: f.campaign.id,
      expectedVersion: 1,
      ...(dueAtISO ? { dueAt: dueAtISO } : {}),
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

async function frozen(f: Awaited<ReturnType<typeof factory>>, id: string) {
  return db.tenant(f.workspaceId, async (sql) => {
    const row = (
      await sql.query<{ due_at: Date; reservation_key: string }>(
        'SELECT due_at,reservation_key FROM customer_deliveries WHERE id=$1',
        [id],
      )
    ).rows[0]!;
    const people = (
      await sql.query<{ id: string }>(
        'SELECT id FROM customer_delivery_recipients WHERE delivery_id=$1 ORDER BY id',
        [id],
      )
    ).rows;
    return {
      dueAt: row.due_at.toISOString(),
      reservation: row.reservation_key,
      recipients: people.map((person) => person.id),
    };
  });
}

it('pauses a future campaign without changing its reviewed audience, time or reservation, then captures it once', async () => {
  const f = await factory();
  const due = new Date(base.getTime() + 61000);
  const { id } = await reviewAndApprove(f, due.toISOString());
  const initial = await frozen(f, id);
  await action(f, 'delivery.pause', id);
  await db.brand(f.workspaceId, f.brandId, (sql) =>
    sql.query(
      "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'late@shop.test','confirmed')",
      [f.workspaceId, f.brandId, randomUUID()],
    ),
  );
  f.setNow(due);
  expect(await f.delivery.worker.tick(f.workspaceId, id)).toEqual({ processed: false });
  expect(f.renderCalls).toHaveLength(0);
  expect(await report(f, id)).toMatchObject({ state: 'paused', selected: 1, pending: 1, skipped: 0 });
  expect((await billing.status(f.workspaceId)).usage).toMatchObject({ emails: 0, reservedEmails: 1 });
  await action(f, 'delivery.resume', id);
  expect(await frozen(f, id)).toEqual(initial);
  for (let tick = 0; tick < 4; tick++) await f.delivery.worker.tick(f.workspaceId, id);
  expect(await report(f, id)).toMatchObject({ state: 'completed', selected: 1, accepted: 1, delivered: 1 });
  expect(f.renderCalls).toEqual(['reader@campaign.test']);
  expect((await billing.status(f.workspaceId)).usage).toMatchObject({
    campaigns: 1,
    emails: 1,
    reservedEmails: 0,
  });
});

it('holds a recipient paused during an in-flight render and resumes without canceling or spending twice', async () => {
  let began!: () => void,
    release!: () => void,
    renders = 0;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await factory({
    render: async () => {
      renders++;
      began();
      await held;
    },
  });
  const { id } = await reviewAndApprove(f);
  const pending = f.delivery.worker.tick(f.workspaceId, id);
  await started;
  try {
    await action(f, 'delivery.pause', id);
  } finally {
    release();
  }
  await pending;
  expect(await report(f, id)).toMatchObject({
    state: 'paused',
    pending: 1,
    skipped: 0,
    rejected: 0,
    accepted: 0,
  });
  expect((await billing.status(f.workspaceId)).usage).toMatchObject({ emails: 0, reservedEmails: 1 });
  expect(await f.delivery.worker.tick(f.workspaceId, id)).toEqual({ processed: false });
  expect(renders).toBe(1);
  await action(f, 'delivery.resume', id);
  for (let tick = 0; tick < 4; tick++) await f.delivery.worker.tick(f.workspaceId, id);
  expect(await report(f, id)).toMatchObject({ state: 'completed', accepted: 1, skipped: 0 });
  expect((await billing.status(f.workspaceId)).usage).toMatchObject({ emails: 1, reservedEmails: 0 });
});

async function configureSes(f: Awaited<ReturnType<typeof factory>>) {
  await saveSenderProfile(f.delivery, f.actor, f.brandId);
  await db.brand(f.workspaceId, f.brandId, (sql) =>
    sql.query(
      'INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge,checked_at,verified_at) VALUES($1,$2,$3,$4,now(),now())',
      [f.workspaceId, f.brandId, 'shop.test', randomUUID()],
    ),
  );
}
async function action(f: Awaited<ReturnType<typeof factory>>, name: string, id: string) {
  return f.delivery.execute(name, { operationKey: randomUUID(), brandId: f.brandId, id }, f.actor);
}
async function report(f: Awaited<ReturnType<typeof factory>>, id: string) {
  return f.delivery.execute('delivery.report', { brandId: f.brandId, id }, f.actor) as Promise<DeliveryView>;
}

it('holds allowance during temporary provider unavailability and resumes only after readiness recovers', async () => {
  let ready = true,
    submissions = 0;
  const provider = {
    fingerprint: 'pause-provider-v1',
    from: 'news@shop.test',
    ready: async () => ready,
    submit: async () => {
      submissions++;
      return { outcome: 'accepted' as const, messageId: 'synthetic-accepted' };
    },
    lookup: async () => ({ outcome: 'accepted' as const, messageId: 'synthetic-accepted' }),
  };
  const f = await factory({ mode: 'ses', provider: () => provider });
  await configureSes(f);
  const { id } = await reviewAndApprove(f);
  for (let flap = 0; flap < 4; flap++) {
    ready = false;
    await f.delivery.worker.tick(f.workspaceId, id);
    expect(await report(f, id)).toMatchObject({
      state: 'paused',
      accepted: 0,
      skipped: 0,
      rejected: 0,
      reason: 'sender_ineligible',
    });
    expect(submissions).toBe(0);
    expect(f.renderCalls).toHaveLength(0);
    expect((await billing.status(f.workspaceId)).usage).toMatchObject({ reservedEmails: 1, emails: 0 });
    await expect(action(f, 'delivery.resume', id)).rejects.toMatchObject({ code: 'resume_blocked' });
    ready = true;
    await action(f, 'delivery.resume', id);
  }
  for (let tick = 0; tick < 4; tick++) await f.delivery.worker.tick(f.workspaceId, id);
  expect(await report(f, id)).toMatchObject({ state: 'completed', accepted: 1, skipped: 0 });
  expect(submissions).toBe(1);
  expect((await billing.status(f.workspaceId)).usage).toMatchObject({ emails: 1, reservedEmails: 0 });
});

it('reconciles unknown work while paused and cancels only definitely unsent recipients', async () => {
  let submissions = 0,
    lookups = 0,
    lookupOutcome: 'unknown' | 'accepted' = 'unknown';
  const provider = {
    fingerprint: 'pause-provider-v1',
    from: 'news@shop.test',
    ready: async () => true,
    submit: async () => ({
      outcome: ++submissions === 1 ? ('accepted' as const) : ('unknown' as const),
      messageId: submissions === 1 ? 'synthetic-first' : undefined,
    }),
    lookup: async () => {
      lookups++;
      return {
        outcome: lookupOutcome,
        messageId: lookupOutcome === 'accepted' ? 'synthetic-reconciled' : undefined,
      };
    },
  };
  const f = await factory({ mode: 'ses', provider: () => provider });
  await configureSes(f);
  for (const email of ['second@shop.test', 'third@shop.test'])
    await db.brand(f.workspaceId, f.brandId, (sql) =>
      sql.query(
        "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,$4,'confirmed')",
        [f.workspaceId, f.brandId, randomUUID(), email],
      ),
    );
  const { id } = await reviewAndApprove(f);
  for (let tick = 0; tick < 4; tick++) await f.delivery.worker.tick(f.workspaceId, id);
  expect(await report(f, id)).toMatchObject({ selected: 3, accepted: 1, uncertain: 1, pending: 1 });
  await action(f, 'delivery.pause', id);
  f.setNow(new Date(base.getTime() + 31000));
  await f.delivery.worker.tick(f.workspaceId, id);
  expect(submissions).toBe(2);
  expect(lookups).toBe(1);
  expect(await report(f, id)).toMatchObject({
    state: 'paused',
    accepted: 1,
    uncertain: 1,
    skipped: 0,
    pending: 1,
  });
  expect((await billing.status(f.workspaceId)).usage).toMatchObject({ emails: 1, reservedEmails: 2 });
  await action(f, 'delivery.cancel', id);
  expect(await report(f, id)).toMatchObject({ state: 'cancelled', accepted: 1, uncertain: 1, skipped: 1 });
  expect((await billing.status(f.workspaceId)).usage).toMatchObject({ emails: 1, reservedEmails: 1 });
  await expect(action(f, 'delivery.resume', id)).rejects.toMatchObject({ code: 'resume_unavailable' });
  lookupOutcome = 'accepted';
  f.setNow(new Date(base.getTime() + 62000));
  await f.delivery.worker.tick(f.workspaceId, id);
  await f.delivery.worker.tick(f.workspaceId, id);
  expect(await report(f, id)).toMatchObject({ state: 'cancelled', accepted: 2, uncertain: 0, skipped: 1 });
  expect(submissions).toBe(2);
  expect(lookups).toBe(2);
  expect((await billing.status(f.workspaceId)).usage).toMatchObject({
    campaigns: 1,
    emails: 2,
    reservedEmails: 0,
  });
});
