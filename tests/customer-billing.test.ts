import { randomUUID } from 'node:crypto';
import { digest } from '../src/server/content.js';
import type { CustomerPlan } from '../src/shared/customer-billing.js';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import {
  CustomerBilling,
  customerContactLimit,
  customerSeatLimit,
  retentionServiceEndSql,
} from '../src/server/customer-billing/service.js';
import type { CustomerBillingStatus } from '../src/shared/customer-billing.js';
import type {
  CustomerBillingProvider,
  ProviderIntent,
  ProviderSubscription,
} from '../src/server/customer-billing/provider.js';
import type {BillingTaxMode} from '../src/shared/billing-tax.js';
import { recordAccess } from '../scripts/complimentary-access.js';
import { companyDirectory, createCompany, createBrand } from '../src/server/companies.js';
import { seatLimit } from '../src/server/team.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database, admin: Database;
const base = new Date('2026-11-08T15:00:00Z'),
  options = {
    environment: 'test' as const,
    exerciseEnabled: true,
    now: () => base,
  };
let billing: CustomerBilling;
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  admin = new Database(fixture.adminUrl);
  const client = new pg.Client({ connectionString: fixture.adminUrl });
  await client.connect();
  try {
    await client.query(
      await readFile(new URL('../migrations/016_customer_billing.sql', import.meta.url), 'utf8'),
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON customer_subscriptions,customer_billing_events,customer_billing_intents,customer_usage_reservations TO flockletter_runtime',
    );
  } finally {
    await client.end();
  }
  billing = new CustomerBilling(db, options);
});
afterAll(async () => {
  await db?.close();
  await admin?.close();
  await fixture?.stop();
});
async function shop() {
  const workspaceId = 'org_' + randomUUID().replaceAll('-', ''),
    userId = 'user_' + randomUUID();
  const actor: Actor = {
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
  const workspace = (await core.execute('workspace.get', {}, actor)) as {
    brands: { id: string }[];
  };
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
  const call = (name: string, input: object = {}) =>
    billing.execute(
      name,
      { operationKey: randomUUID(), ...input },
      actor,
    ) as Promise<CustomerBillingStatus>;
  return { workspaceId, brandId, actor, campaign, call };
}
// Simulate an already-recorded pre-upgrade agreement and provider request. New trials use
// the protected two-stage tests; these fixtures verify legacy reconciliation/rejoin only.
async function seedLegacyCheckout(
  actor: Actor,
  plan: CustomerPlan,
  gateway: CustomerBillingProvider,
  operationKey: string,
) {
  const intent = {
    id: randomUUID(),
    workspace: actor.workspaceId,
    plan,
    createdAt: base,
    reference: null,
    trialDays: 14 as const,
  };
  await db.tenant(actor.workspaceId, (sql) =>
    sql.query(
      `INSERT INTO customer_billing_intents(workspace_id,id,actor_id,operation_key,command,request_hash,state,provider_account,created_at,result)
    VALUES($1,$2,$3,$4,'customerBilling.checkout',$5,'unknown',$6,$7,$8)`,
      [
        actor.workspaceId,
        intent.id,
        actor.actorId,
        operationKey,
        digest(JSON.stringify([plan, actor.actorId, 14])),
        gateway.account,
        base,
        JSON.stringify({ plan, trialDays: 14 }),
      ],
    ),
  );
  try {
    const observed = await gateway.checkout(intent);
    await db.tenant(actor.workspaceId, (sql) =>
      sql.query('UPDATE customer_billing_intents SET provider_reference=$2 WHERE id=$1', [
        intent.id,
        observed.id,
      ]),
    );
  } catch {
    /* An uncertain legacy POST is reconciled by lookup, never replayed. */
  }
}
const start = (s: Awaited<ReturnType<typeof shop>>) =>
  s.call('customerBilling.startTrial', {
    plan: 'starter',
    simulatedCardConfirmed: true,
  });

it('starts one captured card-confirmed trial, replays a lost reply and cannot refresh it', async () => {
  const s = await shop(),
    key = randomUUID(),
    input = {
      operationKey: key,
      plan: 'starter',
      simulatedCardConfirmed: true,
    };
  const contactCapacity = () => db.tenant(s.workspaceId, sql => customerContactLimit(sql, s.workspaceId, options));
  expect(await contactCapacity()).toBe(250);
  const first = await billing.execute('customerBilling.startTrial', input, s.actor);
  expect(await billing.execute('customerBilling.startTrial', input, s.actor)).toEqual(first);
  expect(first).toMatchObject({
    source: 'exercise',
    state: 'trialing',
    eligible: true,
    limits: { contacts: 2500, recipients: 2500, emails: 2500, campaigns: 2, companies: 1, brands: 1, users: 1 },
  });
  expect(await contactCapacity()).toBe(2500);
  await expect(start(s)).rejects.toMatchObject({ code: 'trial_already_used' });
  await expect(
    billing.execute(
      'customerBilling.cancel',
      { operationKey: randomUUID() },
      { ...s.actor, owner: false },
    ),
  ).rejects.toMatchObject({ code: 'owner_required' });
  expect((await billing.status(s.workspaceId)).trialEnd).toBe('2026-11-22T15:00:00.000Z');
});

it('keeps failed-payment time stable, suspends on day six, closes on day thirty and recovers without resetting usage', async () => {
  const s = await shop();
  await start(s);
  await s.call('customerBilling.exercisePayment', { result: 'succeeded' });
  const failed = await s.call('customerBilling.exercisePayment', {
    result: 'failed',
  });
  await s.call('customerBilling.advanceExercise', { days: 5 });
  const again = await s.call('customerBilling.exercisePayment', {
    result: 'failed',
  });
  expect(again.failedSince).toBe(failed.failedSince);
  expect(again.eligible).toBe(true);
  expect(await s.call('customerBilling.advanceExercise', { days: 1 })).toMatchObject({
    state: 'suspended',
    eligible: false,
  });
  expect(await s.call('customerBilling.advanceExercise', { days: 24 })).toMatchObject({
    state: 'closed',
    eligible: false,
  });
  const ended = await db.tenant(s.workspaceId, (sql) =>
    retentionServiceEndSql(sql, s.workspaceId, options, base),
  );
  expect(ended.effectiveEnd).toBe('2026-12-08T15:00:00.000Z');
  expect(await s.call('customerBilling.exercisePayment', { result: 'succeeded' })).toMatchObject({
    state: 'active',
    eligible: true,
  });
  expect((await billing.retentionServiceEnd(s.workspaceId)).effectiveEnd).toBeNull();
});

it('admits a full first newsletter and preserves the complete-trial ceiling on replay', async () => {
  const s = await shop();
  await start(s);
  const reserve = (operationKey: string, recipients: number) =>
    db.tenant(s.workspaceId, sql => billing.reserve(sql, s.workspaceId, {
      operationKey, recipients, campaignId: s.campaign.id, brandId: s.brandId,
    }));
  await expect(reserve(randomUUID(), 2501)).rejects.toMatchObject({ code: 'allowance_exceeded' });

  const key = randomUUID();
  await expect(reserve(key, 2500)).resolves.toMatchObject({ recipients: 2500 });
  await expect(reserve(key, 2500)).resolves.toMatchObject({ recipients: 2500 });
  await expect(reserve(randomUUID(), 1)).rejects.toMatchObject({ code: 'allowance_exceeded' });

  const settle = () => db.tenant(s.workspaceId, sql =>
    billing.settle(sql, s.workspaceId, key, { accepted: 2500, excluded: 0 }));
  await settle();
  await expect(settle()).resolves.toMatchObject({ state: 'settled' });
  expect((await billing.status(s.workspaceId)).usage).toMatchObject({
    emails: 2500, reservedEmails: 0, campaigns: 1, reservedCampaigns: 0,
  });
  await expect(reserve(randomUUID(), 1)).rejects.toMatchObject({ code: 'allowance_exceeded' });
});

it('reserves concurrent campaigns across the subscription once and retains unknown recipients', async () => {
  const s = await shop();
  await start(s);
  const reserve = (key: string, count: number) =>
    db.tenant(s.workspaceId, (sql) =>
      billing.reserve(sql, s.workspaceId, {
        operationKey: key,
        campaignId: s.campaign.id,
        brandId: s.brandId,
        recipients: count,
      }),
    );
  const keys = [randomUUID(), randomUUID(), randomUUID()];
  const results = await Promise.allSettled(keys.map((key) => reserve(key, 200)));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  const first = results.findIndex((r) => r.status === 'fulfilled');
  expect(await reserve(keys[first]!, 200)).toMatchObject({ recipients: 200 });
  await expect(reserve(keys[first]!, 100)).rejects.toMatchObject({
    code: 'reservation_conflict',
  });
  await db.tenant(s.workspaceId, (sql) =>
    billing.settle(sql, s.workspaceId, keys[first]!, {
      accepted: 10,
      excluded: 40,
    }),
  );
  expect((await billing.status(s.workspaceId)).usage).toMatchObject({
    emails: 10,
    reservedEmails: 350,
    campaigns: 1,
    reservedCampaigns: 1,
  });
  await expect(
    db.tenant(s.workspaceId, (sql) => billing.release(sql, s.workspaceId, keys[first]!)),
  ).rejects.toMatchObject({ code: 'provider_already_accepted' });
  const result = await db.tenant(s.workspaceId, (sql) =>
    billing.settle(sql, s.workspaceId, keys[first]!, {
      accepted: 160,
      excluded: 40,
    }),
  );
  expect(result.state).toBe('settled');
  expect(
    await db.tenant(s.workspaceId, (sql) =>
      billing.settle(sql, s.workspaceId, keys[first]!, {
        accepted: 160,
        excluded: 40,
      }),
    ),
  ).toMatchObject({ state: 'settled' });
  await expect(
    db.tenant(s.workspaceId, (sql) =>
      billing.settle(sql, s.workspaceId, keys[first]!, {
        accepted: 159,
        excluded: 41,
      }),
    ),
  ).rejects.toMatchObject({ code: 'usage_conflict' });
});

it('applies period-end cancellation, protects future schedules and grants no Stripe fact to complimentary access', async () => {
  const s = await shop();
  await start(s);
  const canceled = await s.call('customerBilling.cancel');
  expect(canceled.eligible).toBe(true);
  await expect(
    db.tenant(s.workspaceId, (sql) =>
      billing.reserve(sql, s.workspaceId, {
        operationKey: randomUUID(),
        campaignId: s.campaign.id,
        brandId: s.brandId,
        recipients: 1,
        dueAt: new Date(canceled.cancelAt!),
      }),
    ),
  ).rejects.toMatchObject({ code: 'trial_schedule' });
  await s.call('customerBilling.resume');
  expect((await billing.status(s.workspaceId)).cancelAt).toBeNull();
  await s.call('customerBilling.cancel');
  expect(await s.call('customerBilling.advanceExercise', { days: 14 })).toMatchObject({
    state: 'canceled',
    eligible: false,
  });
  expect((await billing.retentionClock(s.workspaceId)).toISOString()).toBe('2026-11-22T15:00:00.000Z');
  await recordAccess(admin, s.workspaceId, {
    workspaceId: s.workspaceId,
    plan: 'pro',
    operator: 'Test',
    reason: 'Exercise grant',
    operationKey: randomUUID(),
  });
  expect(await billing.status(s.workspaceId)).toMatchObject({
    source: 'complimentary',
    state: 'active',
    eligible: true,
    limits: { users: null },
  });
  expect(await db.tenant(s.workspaceId, (sql) => customerSeatLimit(sql, s.workspaceId))).toBeNull();
  expect(await db.tenant(s.workspaceId, (sql) => customerContactLimit(sql, s.workspaceId))).toBe(10000);
  expect((await billing.retentionServiceEnd(s.workspaceId)).effectiveEnd).toBeNull();
  expect((await billing.retentionClock(s.workspaceId)).toISOString()).toBe(base.toISOString());
});

it('isolates reservation, status and hidden rows across two workspaces', async () => {
  const a = await shop(),
    b = await shop();
  await start(a);
  expect(await billing.status(b.workspaceId)).toMatchObject({
    state: 'preparation',
    eligible: false,
  });
  await expect(
    db.tenant(a.workspaceId, (sql) =>
      billing.reserve(sql, b.workspaceId, {
        operationKey: randomUUID(),
        campaignId: a.campaign.id,
        brandId: a.brandId,
        recipients: 1,
      }),
    ),
  ).rejects.toMatchObject({ code: 'workspace_scope' });
  expect(
    await db.tenant(
      b.workspaceId,
      async (sql) => (await sql.query('SELECT * FROM customer_subscriptions')).rowCount,
    ),
  ).toBe(0);
  expect(
    () =>
      new CustomerBilling(db, {
        environment: 'production',
        exerciseEnabled: true,
      }),
  ).toThrow();
});

it('counts test messages without consuming a campaign and checks the scheduled downgrade allowance', async () => {
  const s = await shop();
  await start(s);
  const test = randomUUID();
  await db.tenant(s.workspaceId, (sql) =>
    billing.reserve(sql, s.workspaceId, {
      operationKey: test,
      campaignId: s.campaign.id,
      brandId: s.brandId,
      recipients: 1,
      campaignSlot: false,
    }),
  );
  await db.tenant(s.workspaceId, (sql) =>
    billing.settle(sql, s.workspaceId, test, { accepted: 1, excluded: 0 }),
  );
  expect((await billing.status(s.workspaceId)).usage).toMatchObject({
    campaigns: 0,
    emails: 1,
    reservedCampaigns: 0,
  });
  await s.call('customerBilling.exercisePayment', { result: 'succeeded' });
  await s.call('customerBilling.changePlan', { plan: 'pro' });
  const status = await s.call('customerBilling.changePlan', {
    plan: 'starter',
  });
  expect(status).toMatchObject({ plan: 'pro', pendingPlan: 'starter' });
  await expect(
    db.tenant(s.workspaceId, (sql) =>
      billing.reserve(sql, s.workspaceId, {
        operationKey: randomUUID(),
        campaignId: s.campaign.id,
        brandId: s.brandId,
        recipients: 3000,
        dueAt: new Date(status.periodEnd!),
      }),
    ),
  ).rejects.toMatchObject({ code: 'allowance_exceeded' });
  await db.tenant(s.workspaceId, (sql) =>
    billing.reserve(sql, s.workspaceId, {
      operationKey: randomUUID(),
      campaignId: s.campaign.id,
      brandId: s.brandId,
      recipients: 3000,
    }),
  );
  await s.call('customerBilling.changePlan', { plan: 'growth' });
  expect((await billing.status(s.workspaceId)).usage.reservedEmails).toBe(3000);
});

it('reconciles an uncertain legacy checkout without a second POST and activates only from a verified bound event', async () => {
  const s = await shop();
  let sends = 0,
    known = false,
    risk = false,
    staleRoutes = 0;
  const snapshot: ProviderSubscription = {
    id: 'sub_test',
    customer: 'cus_test',
    state: 'trialing',
    plan: 'growth',
    cardVerified: true,
    workspaceHint: s.workspaceId,
    intentHint: null,
    trialStart: base,
    trialEnd: new Date(base.getTime() + 14 * 86400000),
    periodStart: base,
    periodEnd: new Date(base.getTime() + 14 * 86400000),
    cancelAt: null,
    endedAt: null,
    failedSince: null,
  };
  const gateway: CustomerBillingProvider = {
    account: 'acct_fixture',
    live: false,
    async checkout(intent) {
      sends++;
      snapshot.intentHint = intent.id;
      throw Error('lost reply');
    },
    async lookupCheckout() {
      return known ? { id: 'cs_test_owned', url: 'https://checkout.stripe.com/c/pay/test' } : null;
    },
    async portal() {
      return 'https://billing.stripe.com/p/test';
    },
    verify(raw, signature) {
      if (signature !== 'valid') throw Error();
      return {
        id: raw.toString(),
        kind: risk ? 'charge.dispute.created' : 'checkout.session.completed',
        checkout: risk ? null : 'cs_test_owned',
        subscription: risk ? 'sub_test' : null,
        risk,
      };
    },
    async resolve(notice) {
      return {
        subscription:
          notice.id === 'evt_stale' && staleRoutes++ === 0 ? { ...snapshot, state: 'active' } : snapshot,
        checkoutId: risk ? null : 'cs_test_owned',
        intentId: snapshot.intentHint,
        workspace: s.workspaceId,
      };
    },
    close() {},
  };
  const provider = new CustomerBilling(db, {
    ...options,
    exerciseEnabled: false,
    gateway,
  });
  const args = { plan: 'growth', operationKey: randomUUID() };
  await seedLegacyCheckout(s.actor, 'growth', gateway, args.operationKey);
  expect(await provider.execute('customerBilling.checkout', args, s.actor)).toMatchObject({
    state: 'awaiting_reconciliation',
  });
  expect(await provider.execute('customerBilling.checkout', args, s.actor)).toMatchObject({
    state: 'awaiting_reconciliation',
  });
  expect(sends).toBe(1);
  expect((await provider.status(s.workspaceId)).eligible).toBe(false);
  known = true;
  expect(await provider.execute('customerBilling.checkout', args, s.actor)).toMatchObject({
    state: 'checkout_ready',
  });
  await expect(provider.webhook(Buffer.from('evt_bad'), 'bad')).rejects.toMatchObject({
    code: 'invalid_signature',
  });
  await provider.webhook(Buffer.from('evt_first'), 'valid');
  expect(await provider.status(s.workspaceId)).toMatchObject({
    source: 'stripe',
    state: 'trialing',
    eligible: true,
    plan: 'growth',
  });
  risk = true;
  await provider.webhook(Buffer.from('evt_risk'), 'valid');
  risk = false;
  snapshot.state = 'active';
  await provider.webhook(Buffer.from('evt_late'), 'valid');
  expect(await provider.status(s.workspaceId)).toMatchObject({
    state: 'active',
    eligible: false,
    reasons: expect.arrayContaining(['A billing risk signal requires operator review.']),
  });
  expect(sends).toBe(1);
  snapshot.state = 'canceled';
  snapshot.endedAt = new Date(base.getTime() + 3600000);
  await provider.webhook(Buffer.from('evt_stale'), 'valid');
  expect((await provider.status(s.workspaceId)).state).toBe('canceled');
  expect((await provider.retentionServiceEnd(s.workspaceId)).effectiveEnd).toBe(
    snapshot.endedAt.toISOString(),
  );
});

it('rechecks current ownership after waiting for the workspace lock and before replaying an intent', async () => {
  const s = await shop();
  let currentOwner = true;
  const guarded = new CustomerBilling(db, {
    ...options,
    checkOwner: async (user, workspace) =>
      user === s.actor.userId && workspace === s.workspaceId && currentOwner,
  });
  const input = { operationKey: randomUUID(), plan: 'starter', simulatedCardConfirmed: true };
  const held = await db.pool.connect();
  await held.query('BEGIN');
  await held.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [s.workspaceId]);
  let checked!: () => void;
  const firstCheck = new Promise<void>((resolve) => {
    checked = resolve;
  });
  const waiting = new CustomerBilling(db, {
    ...options,
    checkOwner: async () => {
      checked();
      return currentOwner;
    },
  }).execute('customerBilling.startTrial', input, s.actor);
  const rejected = expect(waiting).rejects.toMatchObject({ code: 'owner_required' });
  await firstCheck;
  currentOwner = false;
  await held.query('COMMIT');
  held.release();
  await rejected;
  expect((await billing.status(s.workspaceId)).source).toBe('preparation');
  currentOwner = true;
  await guarded.execute('customerBilling.startTrial', input, s.actor);
  currentOwner = false;
  await expect(guarded.execute('customerBilling.startTrial', input, s.actor)).rejects.toMatchObject({
    code: 'owner_required',
  });
});

it('restarts only a verified expired legacy checkout and reconciles the new intent after a lost reply', async () => {
  const s = await shop();
  let posts = 0;
  const createdTrials: (0 | 14 | undefined)[] = [],
    lookedUpTrials: (0 | 14 | undefined)[] = [];
  const sessions = new Map<string, { id: string; state: 'open' | 'expired'; url: string | null }>();
  const gateway: CustomerBillingProvider = {
    account: 'acct_dedicated',
    live: false,
    async checkout(intent) {
      createdTrials.push(intent.trialDays);
      posts++;
      const session = {
        id: 'cs_' + intent.id,
        state: 'open' as const,
        url: 'https://checkout.stripe.com/c/synthetic',
      };
      sessions.set(intent.id, session);
      if (posts === 2) throw Error('Lost create reply');
      return session;
    },
    async lookupCheckout(intent) {
      lookedUpTrials.push(intent.trialDays);
      return sessions.get(intent.id) ?? null;
    },
    async portal() {
      throw Error('unused');
    },
    verify() {
      return null;
    },
    async resolve() {
      return { subscription: null, checkoutId: null, intentId: null, workspace: null };
    },
    close() {},
  };
  const real = new CustomerBilling(db, { ...options, exerciseEnabled: false, gateway });
  const first = { operationKey: randomUUID(), plan: 'starter' };
  await seedLegacyCheckout(s.actor, 'starter', gateway, first.operationKey);
  await real.execute('customerBilling.checkout', first, s.actor);
  const restart = { operationKey: randomUUID(), plan: 'starter' };
  await expect(real.execute('customerBilling.restartCheckout', restart, s.actor)).rejects.toMatchObject({
    code: 'checkout_unresolved',
  });
  expect(posts).toBe(1);
  const prior = [...sessions.values()][0]!;
  prior.state = 'expired';
  prior.url = null;
  expect(await real.execute('customerBilling.checkout', first, s.actor)).toMatchObject({
    state: 'checkout_expired',
  });
  expect(await real.execute('customerBilling.restartCheckout', restart, s.actor)).toMatchObject({
    state: 'awaiting_reconciliation',
  });
  expect(posts).toBe(2);
  expect(await real.execute('customerBilling.restartCheckout', restart, s.actor)).toMatchObject({
    state: 'checkout_ready',
  });
  expect(posts).toBe(2);
  expect((await real.status(s.workspaceId)).eligible).toBe(false);
  expect(createdTrials).toEqual([14, 0]);
  expect(lookedUpTrials.at(-1)).toBe(0);
  const persisted = (
    await db.tenant(s.workspaceId, (sql) =>
      sql.query<{ result: { trialDays: number } }>(
        "SELECT result FROM customer_billing_intents WHERE command='customerBilling.checkout'",
        [],
      ),
    )
  ).rows;
  expect(persisted.map((row) => row.result.trialDays).sort((a, b) => a - b)).toEqual([0, 14]);
});

it('applies the active billing company, brand and seat caps without elevating disabled or suspended service', async () => {
  const s = await shop();
  await start(s);
  await s.call('customerBilling.exercisePayment', { result: 'succeeded' });
  await s.call('customerBilling.changePlan', { plan: 'growth' });
  await db.tenant(s.workspaceId, async (sql) => {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [s.workspaceId]);
    expect(await companyDirectory(sql, options)).toMatchObject({
      planName: 'Growth',
      limits: { companies: 3, brands: 3 },
    });
    expect(await seatLimit(sql, options)).toBe(3);
    const company = await createCompany(sql, s.workspaceId, 'Second company', options);
    await createBrand(sql, s.workspaceId, company.id, 'Second brand', options);
    expect((await companyDirectory(sql, options)).companies).toHaveLength(2);
    const disabled = { ...options, exerciseEnabled: false };
    expect(await seatLimit(sql, disabled)).toBe(1);
    expect(await companyDirectory(sql, disabled)).toMatchObject({
      planName: 'Preparation',
      limits: { companies: 1, brands: 1 },
    });
    await expect(createCompany(sql, s.workspaceId, 'Cannot elevate', disabled)).rejects.toMatchObject({
      code: 'company_limit',
    });
  });
  await s.call('customerBilling.exercisePayment', { result: 'failed' });
  await s.call('customerBilling.advanceExercise', { days: 6 });
  expect(await db.tenant(s.workspaceId, (sql) => seatLimit(sql, options))).toBe(1);
  expect(await db.tenant(s.workspaceId, (sql) => companyDirectory(sql, options))).toMatchObject({
    planName: 'Preparation',
  });
});

async function rejoinFixture(ended = true) {
  const s = await shop();
  let posts = 0,
    last: import('../src/server/customer-billing/provider.js').ProviderIntent | undefined;
  const sessions = new Map<
    string,
    import('../src/server/customer-billing/provider.js').ProviderCheckout
  >();
  const old: ProviderSubscription = {
    id: 'sub_old',
    customer: 'cus_owned',
    state: 'trialing',
    plan: 'starter',
    cardVerified: true,
    workspaceHint: s.workspaceId,
    intentHint: null,
    trialStart: new Date(base.getTime() - 2 * 86400000),
    trialEnd: new Date(base.getTime() + 12 * 86400000),
    periodStart: base,
    periodEnd: new Date('2026-12-01T00:00:00Z'),
    cancelAt: null,
    endedAt: null,
    failedSince: null,
  };
  let active: ProviderSubscription | undefined;
  const events = new Map<
    string,
    { subscription: ProviderSubscription; checkoutId: string | null; kind: string }
  >();
  const gateway: CustomerBillingProvider = {
    account: 'acct_' + randomUUID().replaceAll('-', ''),
    live: false,
    async checkout(intent) {
      posts++;
      const rejoin = !!intent.previousSubscription;
      if (rejoin) {
        expect(intent).toMatchObject({
          trialDays: 0,
          customer: 'cus_owned',
          previousSubscription: 'sub_old',
        });
        last = intent;
        active = {
          ...old,
          id: 'sub_new',
          state: 'active',
          plan: intent.plan,
          trialStart: null,
          trialEnd: null,
          intentHint: intent.id,
          previousSubscription: intent.previousSubscription,
          previousRevision: String(intent.previousRevision),
          endedAt: null,
        };
      } else {
        old.intentHint = intent.id;
        expect(intent.trialDays).toBe(14);
      }
      const session = {
        id: rejoin ? 'cs_new' : 'cs_old',
        state: 'open' as const,
        url: 'https://checkout.stripe.com/c/owned',
        customer: old.customer,
        subscription: rejoin ? 'sub_new' : 'sub_old',
      };
      sessions.set(intent.id, session);
      if (rejoin) throw Error('Lost provider reply after create');
      return session;
    },
    async lookupCheckout(intent) {
      return sessions.get(intent.id) ?? null;
    },
    async inspectSubscription(id) {
      expect(id).toBe('sub_old');
      return { ...old };
    },
    async portal() {
      return 'https://billing.stripe.com/p/owned';
    },
    verify(raw, signature) {
      if (signature !== 'valid') throw Error('bad signature');
      const event = events.get(raw.toString());
      if (!event) return null;
      return {
        id: raw.toString(),
        kind: event.kind,
        checkout: event.checkoutId,
        subscription: event.subscription.id,
        risk: false,
      };
    },
    async resolve(notice) {
      const event = events.get(notice.id)!;
      return {
        subscription: { ...event.subscription },
        checkoutId: event.checkoutId,
        intentId: event.subscription.intentHint,
        workspace: s.workspaceId,
      };
    },
    close() {},
  };
  const real = new CustomerBilling(db, { ...options, exerciseEnabled: false, gateway });
  const emit = async (
    id: string,
    subscription: ProviderSubscription,
    checkoutId: string | null = null,
    kind = 'customer.subscription.updated',
  ) => {
    events.set(id, { subscription, checkoutId, kind });
    await real.webhook(Buffer.from(id), 'valid');
  };
  const legacyKey = randomUUID();
  await seedLegacyCheckout(s.actor, 'starter', gateway, legacyKey);
  await real.execute('customerBilling.checkout', { operationKey: legacyKey, plan: 'starter' }, s.actor);
  await emit('evt_initial', old, 'cs_old', 'checkout.session.completed');
  if (ended) {
    old.state = 'canceled';
    old.endedAt = new Date(base.getTime() - 3600000);
    await emit('evt_ended', old);
  }
  return { s, real, old, emit, sessions, posts: () => posts, last: () => last, active: () => active! };
}

it('serializes paid rejoin, reuses the existing customer, archives history and ignores all retired events', async () => {
  const f = await rejoinFixture();
  const revision = (await f.real.status(f.s.workspaceId)).revision;
  const first = { operationKey: randomUUID(), plan: 'growth', expectedRevision: revision },
    second = { ...first, operationKey: randomUUID() };
  await Promise.all([
    f.real.execute('customerBilling.rejoin', first, f.s.actor),
    f.real.execute('customerBilling.rejoin', second, f.s.actor),
  ]);
  const winner = await db.tenant(f.s.workspaceId, async sql =>
    (await sql.query<{ operation_key: string }>(
      "SELECT operation_key FROM customer_billing_intents WHERE command='customerBilling.rejoin'",
    )).rows[0]!.operation_key,
  );
  expect([first.operationKey, second.operationKey]).toContain(winner);
  const original = { ...first, operationKey: winner };
  expect(f.posts()).toBe(2);
  const restarted = new CustomerBilling(db, f.real.options);
  await restarted.execute('customerBilling.rejoin', first, f.s.actor);
  expect(f.posts()).toBe(2);
  expect((await f.real.status(f.s.workspaceId)).state).toBe('canceled');
  const intent = f.last()!;
  f.sessions.get(intent.id)!.state = 'complete';
  f.sessions.get(intent.id)!.url = null;
  await f.emit('evt_rejoined', f.active(), null, 'invoice.paid');
  const joined = await f.real.status(f.s.workspaceId);
  expect(joined).toMatchObject({ state: 'active', plan: 'growth', eligible: true, trialEnd: null });
  const history = (
    await db.tenant(f.s.workspaceId, (sql) =>
      sql.query<{ provider_subscription: string; replaced_by: string }>(
        'SELECT provider_subscription,replaced_by FROM customer_subscription_history',
      ),
    )
  ).rows;
  expect(history).toEqual([{ provider_subscription: 'sub_old', replaced_by: 'sub_new' }]);
  f.old.state = 'active';
  await f.emit('evt_old_invoice', f.old, null, 'invoice.paid');
  f.old.state = 'canceled';
  await f.emit('evt_old_cancel', f.old);
  await f.emit('evt_old_cancel', f.old);
  await f.emit('evt_rejoined', f.active(), null, 'invoice.paid');
  expect(await f.real.status(f.s.workspaceId)).toEqual(joined);
  expect(await restarted.execute('customerBilling.rejoin', original, f.s.actor)).toMatchObject({
    state: 'rejoined',
  });
  expect(f.posts()).toBe(2);
  const ignored = (
    await db.tenant(f.s.workspaceId, (sql) =>
      sql.query<{ event_kind: string }>(
        "SELECT event_kind FROM customer_billing_events WHERE event_id IN ('evt_old_invoice','evt_old_cancel')",
      ),
    )
  ).rows;
  expect(ignored).toHaveLength(2);
  expect(ignored.every((event) => event.event_kind.startsWith('ignored_retired:'))).toBe(true);
  await expect(
    db.tenant(f.s.workspaceId, (sql) =>
      sql.query('UPDATE customer_subscription_history SET replaced_by=$1', ['forbidden']),
    ),
  ).rejects.toMatchObject({ code: '42501' });
});

it('persists a verified renewal downgrade, applies future caps and clears it when the provider releases the schedule', async () => {
  const f = await rejoinFixture(false);
  f.old.state = 'active';
  f.old.trialStart = null;
  f.old.trialEnd = null;
  f.old.plan = 'growth';
  f.old.pendingPlan = 'starter';
  await f.emit('evt_schedule', f.old, null, 'subscription_schedule.updated');
  expect(await f.real.status(f.s.workspaceId)).toMatchObject({ plan: 'growth', pendingPlan: 'starter' });
  const reserve = (dueAt: Date) => db.tenant(f.s.workspaceId, sql => f.real.reserve(sql, f.s.workspaceId, {
    operationKey: randomUUID(), campaignId: f.s.campaign.id, brandId: f.s.brandId, recipients: 3000, dueAt,
  }));
  await expect(reserve(new Date('2026-11-20T00:00:00Z'))).resolves.toMatchObject({ recipients: 3000 });
  await expect(reserve(f.old.periodEnd)).rejects.toMatchObject({ code: 'allowance_exceeded' });
  f.old.pendingPlan = null;
  await f.emit('evt_schedule_released', f.old, null, 'subscription_schedule.released');
  expect(await f.real.status(f.s.workspaceId)).toMatchObject({ plan: 'growth', pendingPlan: null });
  await expect(reserve(f.old.periodEnd)).resolves.toMatchObject({ recipients: 3000 });
  await f.emit('evt_schedule_released', f.old, null, 'subscription_schedule.released');
  expect((await f.real.status(f.s.workspaceId)).pendingPlan).toBeNull();
});

it('refuses overlapping old provider service and requires an unchanged prior revision for verified rejoin', async () => {
  const f = await rejoinFixture();
  const revision = (await f.real.status(f.s.workspaceId)).revision;
  const input = { operationKey: randomUUID(), plan: 'pro', expectedRevision: revision };
  f.old.state = 'active';
  await expect(f.real.execute('customerBilling.rejoin', input, f.s.actor)).rejects.toMatchObject({
    code: 'subscription_not_ended',
  });
  expect(f.posts()).toBe(1);
  f.old.state = 'canceled';
  await f.real.execute('customerBilling.rejoin', input, f.s.actor);
  await f.emit('evt_old_changed', f.old);
  await expect(
    f.emit('evt_changed_rejoin', f.active(), 'cs_new', 'checkout.session.completed'),
  ).rejects.toMatchObject({ code: 'rejoin_changed' });
  expect((await f.real.status(f.s.workspaceId)).state).toBe('canceled');
  expect(
    (await db.tenant(f.s.workspaceId, (sql) => sql.query('SELECT FROM customer_subscription_history')))
      .rowCount,
  ).toBe(0);
  expect(f.posts()).toBe(2);
});

it('holds all new live Pro entry points at the canonical layer before Stripe or trial-history mutations',async()=>{
 const s=await shop(),live=new CustomerBilling(db,{environment:'production',exerciseEnabled:false});
 expect((await live.status(s.actor.workspaceId)).newSubscriptions).toEqual({starter:true,growth:true,pro:false});
 for(const command of ['customerBilling.checkout','customerBilling.paidCheckout','customerBilling.restartCheckout','customerBilling.rejoin','customerBilling.portal']){
  await expect(live.execute(command,{operationKey:randomUUID(),plan:'pro',...(command==='customerBilling.paidCheckout'?{accepted:true,priceMinor:3900}:{}),...(command==='customerBilling.rejoin'?{expectedRevision:1}:{})},s.actor)).rejects.toMatchObject({code:'plan_enrollment_paused'});
 }
 expect((await db.read(s.actor.workspaceId,sql=>sql.query('SELECT * FROM customer_billing_intents'))).rowCount).toBe(0);
});
it('requires the current terms acceptance for new live paid and rejoin agreements',async()=>{
 const s=await shop(),live=new CustomerBilling(db,{environment:'production',exerciseEnabled:false});
 for(const command of ['customerBilling.paidCheckout','customerBilling.restartCheckout','customerBilling.rejoin']){
  await expect(live.execute(command,{operationKey:randomUUID(),plan:'starter',accepted:true,...(command==='customerBilling.paidCheckout'?{priceMinor:1500}:{}),...(command==='customerBilling.rejoin'?{expectedRevision:1}:{}),policyVersion:'old'},s.actor)).rejects.toMatchObject({code:'policy_review_required'});
 }
 expect((await db.read(s.actor.workspaceId,sql=>sql.query('SELECT * FROM customer_billing_intents'))).rowCount).toBe(0);
});

it('reconciles retained mapped billing facts with new billing disabled without granting access or creating intents', async () => {
  const s = await shop();
  await db.tenant(s.workspaceId,sql=>sql.query(`INSERT INTO customer_subscriptions
    (workspace_id,id,source,state,plan,provider_account,provider_customer,provider_subscription,observed_at)
    VALUES($1,$2,'stripe','active','growth','acct_receipts','cus_receipts','sub_receipts',now())`,[s.workspaceId,randomUUID()]));
  const observed: ProviderSubscription = {
    id:'sub_receipts',customer:'cus_receipts',workspaceHint:s.workspaceId,intentHint:null,
    state:'past_due',plan:'growth',cardVerified:true,trialStart:null,trialEnd:null,
    periodStart:base,periodEnd:new Date(base.getTime()+30*86400000),cancelAt:null,endedAt:null,failedSince:base,
  };
  const receiver = new CustomerBilling(db,{
    ...options,exerciseEnabled:false,eventGateway:{
      account:'acct_receipts',live:false,close(){},async lookupCheckout(){return null;},
      verify(raw,signature){
        if(signature!=='valid')throw Error('Invalid synthetic signature');
        return {id:raw.toString(),kind:'invoice.payment_failed',subscription:observed.id,checkout:null,risk:false};
      },
      async resolve(){return {subscription:observed,checkoutId:null,intentId:null,workspace:null};},
    },
  });
  await expect(receiver.webhook(Buffer.from('evt_bad'),'invalid')).rejects.toMatchObject({code:'invalid_signature'});
  await receiver.webhook(Buffer.from('evt_receipts'),'valid');
  const after = await receiver.status(s.workspaceId);
  expect(after).toMatchObject({state:'past_due',eligible:false,failedSince:base.toISOString()});
  expect(after.reasons).toContain('This environment’s dedicated billing provider is disabled.');
  await receiver.webhook(Buffer.from('evt_receipts'),'valid');
  expect((await receiver.status(s.workspaceId)).revision).toBe(after.revision);
  const events = await db.read(s.workspaceId,sql=>sql.query('SELECT event_id,finished FROM customer_billing_events'));
  expect(events.rows).toEqual([{event_id:'evt_receipts',finished:true}]);
  for(const [command,input] of [
    ['customerBilling.portal',{operationKey:randomUUID()}],
    ['customerBilling.trialReview',{operationKey:randomUUID(),setupId:randomUUID()}],
    ['customerBilling.activateTrial',{operationKey:randomUUID(),setupId:randomUUID(),expectedRevision:1,reviewHash:'a'.repeat(64),accepted:true}],
  ] as const)
    await expect(receiver.execute(command,input,s.actor)).rejects.toMatchObject({code:'billing_provider_unavailable'});
  expect((await db.read(s.workspaceId,sql=>sql.query('SELECT FROM customer_billing_intents'))).rowCount).toBe(0);
});

it('binds paid Checkout tax acceptance and holds the saved open agreement across a configuration change',async()=>{
 const s=await shop();let mode:BillingTaxMode='off',state:'open'|'expired'='open';const posts:ProviderIntent[]=[];
 const gateway:CustomerBillingProvider={
  account:'acct_tax_intent',live:false,get taxMode(){return mode;},close(){},
  async checkout(intent){posts.push(intent);return{id:'cs_tax_'+posts.length,state:'open',url:'https://checkout.stripe.com/tax'};},
  async lookupCheckout(){return{id:'cs_tax_1',state,url:state==='open'?'https://checkout.stripe.com/tax':null};},
  async portal(){throw Error('Unexpected portal');},verify(){throw Error('Unexpected event');},
  async resolve(){return{subscription:null,checkoutId:null,intentId:null,workspace:null};},
 };
 const billing=new CustomerBilling(db,{...options,exerciseEnabled:false,gateway});
 const operationKey=randomUUID(),input={operationKey,plan:'starter',accepted:true,priceMinor:1500,taxMode:'off'};
 await expect(billing.execute('customerBilling.paidCheckout',{...input,taxMode:'stripe-automatic'},s.actor)).rejects.toMatchObject({code:'tax_policy_changed'});
 expect((await db.read(s.workspaceId,sql=>sql.query('SELECT FROM customer_billing_intents'))).rowCount).toBe(0);
 expect(await billing.execute('customerBilling.paidCheckout',input,s.actor)).toMatchObject({state:'checkout_ready'});
 expect(posts).toHaveLength(1);expect(posts[0]!.taxMode).toBe('off');
 mode='stripe-automatic';
 expect(await billing.execute('customerBilling.paidCheckout',{...input,taxMode:mode},s.actor)).toEqual({state:'tax_policy_changed',url:null});
 expect(posts).toHaveLength(1);
 expect((await db.read(s.workspaceId,sql=>sql.query("SELECT result->>'taxMode' mode FROM customer_billing_intents"))).rows).toEqual([{mode:'off'}]);
 state='expired';
 await billing.execute('customerBilling.restartCheckout',{operationKey:randomUUID(),plan:'starter',taxMode:mode},s.actor);
 expect(posts).toHaveLength(2);expect(posts[1]!.taxMode).toBe('stripe-automatic');
});
