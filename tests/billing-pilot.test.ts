import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { recordAccess } from '../scripts/complimentary-access.js';
import { Database } from '../src/server/db.js';
import { SandboxBilling } from '../src/server/billing/service.js';
import { sandboxGateway, subscriptionPlan, type BillingGateway, type SessionResult } from '../src/server/billing/gateway.js';
import { CommandService, type Actor } from '../src/server/service.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>,
  db: Database,
  admin: Database,
  billing: SandboxBilling,
  actor: Actor,
  gateway: BillingGateway;
let providerState: SessionResult, calls: string[], rejectOnce: boolean, workspace: string;
const prices = { starter: 'price_one', growth: 'price_two', pro: 'price_three' },
  account = 'acct_Flockletter',
  webhook = 'whsec_fixture';
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  admin = new Database(fixture.adminUrl);
  await db.verifyBoundary();
});
afterAll(async () => {
  await admin?.close();
  await db?.close();
  await fixture?.stop();
});
beforeEach(async () => {
  workspace = 'org_' + randomUUID();
  actor = {
    kind: 'session',
    owner: true,
    actorId: 'user:owner',
    userId: 'owner',
    workspaceId: workspace,
    scopes: ['read'],
    brandIds: null,
  };
  await new CommandService(db).execute(
    'workspace.initialize',
    { operationKey: randomUUID(), name: 'Shop', brandName: 'Shop' },
    actor,
  );
  calls = [];
  rejectOnce = false;
  providerState = {
    id: 'cs_test_' + randomUUID(),
    url: 'https://checkout.stripe.com/c/pay/test',
    customer: null,
    subscription: null,
    status: 'open',
    trialEnd: null,
  };
  gateway = {
    account,
    prices,
    open: async (intent) => {
      calls.push(intent.id);
      if (rejectOnce) {
        rejectOnce = false;
        throw Error('uncertain');
      }
      return providerState;
    },
    observe: async () => providerState,
    portal: async () => 'https://billing.stripe.com/p/session/test',
    verify: (raw) => JSON.parse(raw.toString()),
  };
  billing = new SandboxBilling(db, gateway);
});
const status = () => db.tenant(workspace, (sql) => billing.status(sql, workspace));
const key = () => randomUUID();
describe('isolated billing sandbox', () => {
  it('updates the effective tier only from the reconciled subscription and keeps the original checkout replayable', async () => {
    const originalKey=key();
    await billing.checkout(actor,'starter',originalKey);
    const event = (id:string) => Buffer.from(JSON.stringify({id,kind:'checkout.session.completed',
      workspace,intent:calls[0],objectId:providerState.id}));
    providerState={...providerState,status:'active',customer:'cus_fixture',subscription:'sub_fixture',effectivePlan:'starter',url:null};
    await billing.feedback(event('evt_original'),'signed');
    providerState={...providerState,effectivePlan:'growth'};
    await billing.checkout(actor,'starter',originalKey);
    expect((await status()).plan).toBe('starter');
    await billing.feedback(event('evt_change'),'signed');
    await billing.feedback(event('evt_change'),'signed');
    expect((await status()).plan).toBe('growth');
    providerState={...providerState,effectivePlan:'starter'};
    await billing.feedback(event('evt_back'),'signed');
    expect((await status()).plan).toBe('starter');
    expect(await db.tenant(workspace,async sql=>(await sql.query("SELECT plan FROM sandbox_checkouts")).rows[0]?.plan)).toBe('starter');
    expect(await db.tenant(workspace,async sql=>(await sql.query("SELECT count(*)::int n FROM operations WHERE actor_id='system:stripe-sandbox-plan'")).rows[0]?.n)).toBe(2);
    expect(await new CommandService(db).execute('workspace.get',{},actor)).toMatchObject({entitlement:'not_activated'});
  });
  it('accepts only the exact single, catalogued monthly sandbox price and quantity', () => {
    const price={id:prices.growth,livemode:false,unit_amount:2500,unit_amount_decimal:'2500.00',currency:'usd',
      recurring:{interval:'month',interval_count:1,usage_type:'licensed'},billing_scheme:'per_unit'} as const;
    expect(subscriptionPlan(prices,{price,quantity:1})).toBe('growth');
    for (const change of [{id:'price_other'},{unit_amount_decimal:'2500.01'},{livemode:true},{currency:'cad'},
      {recurring:{...price.recurring,interval:'year'}},{billing_scheme:'tiered'}] as const)
      expect(()=>subscriptionPlan(prices,{price:{...price,...change},quantity:1})).toThrow();
    expect(()=>subscriptionPlan(prices,{price,quantity:2})).toThrow();
  });
  it('persists one intent before an uncertain external call, reuses it across retries, and never stores a checkout URL', async () => {
    rejectOnce = true;
    await expect(billing.checkout(actor, 'growth', key())).rejects.toMatchObject({
      code: 'checkout_pending',
    });
    const retry = await Promise.all([
      billing.checkout(actor, 'growth', key()),
      billing.checkout(actor, 'growth', key()),
    ]);
    expect(retry[0]?.url).toContain('checkout.stripe.com');
    expect(new Set(calls).size).toBe(1);
    expect(await status()).toMatchObject({ status: 'open', plan: 'growth' });
    expect(
      await db.tenant(workspace, (sql) =>
        sql.query('SELECT * FROM sandbox_checkouts').then((r) => JSON.stringify(r.rows)),
      ),
    ).not.toContain('https:');
    await expect(billing.checkout(actor, 'pro', key())).rejects.toMatchObject({ code: 'checkout_exists' });
    expect(
      (
        await db.tenant(workspace, (sql) =>
          sql.query('SELECT action FROM audit WHERE action=$1', ['billing.checkout']),
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('only a verified provider event records trial status, deduplicates feedback, and reconciles current state after reordered events', async () => {
    await billing.checkout(actor, 'starter', key());
    const intent = (await db.tenant(workspace, (sql) => sql.query('SELECT id FROM sandbox_checkouts')))
      .rows[0].id;
    const raw = (id: string, kind: string, objectId: string) =>
      Buffer.from(JSON.stringify({ id, kind, workspace, intent, objectId }));
    providerState = {
      ...providerState,
      status: 'trialing',
      customer: 'cus_123',
      subscription: 'sub_123',
      url: null,
      trialEnd: new Date(),
    };
    expect((await billing.checkout(actor, 'starter', key())).status).toBe('awaiting_webhook');
    const event = raw('evt_1', 'checkout.session.completed', providerState.id);
    await Promise.all([billing.feedback(event, 'signed'), billing.feedback(event, 'signed')]);
    expect(await status()).toMatchObject({ status: 'trialing', canOpenPortal: true });
    providerState = { ...providerState, status: 'past_due' };
    await billing.feedback(raw('evt_2', 'customer.subscription.updated', 'sub_123'), 'signed');
    await billing.feedback(raw('evt_delayed', 'checkout.session.completed', providerState.id), 'signed');
    expect(await status()).toMatchObject({ status: 'past_due' });
    expect(await billing.portal(actor, key())).toMatchObject({
      url: 'https://billing.stripe.com/p/session/test',
    });
    expect((await db.tenant('org_other', (sql) => sql.query('SELECT * FROM sandbox_events'))).rows).toEqual(
      [],
    );
    expect(
      (await db.tenant(workspace, (sql) => sql.query('SELECT * FROM sandbox_events'))).rows,
    ).toHaveLength(3);
    expect(await new CommandService(db).execute('workspace.get', {}, actor)).toMatchObject({
      entitlement: 'not_activated',
    });
    const service = new CommandService(db);
    expect(await service.execute('workspace.retention', {}, actor)).toMatchObject({
      status: 'no_verified_closure',
      purgeEnabled: false,
    });
    const end = new Date(Date.now() - 92 * 86400000);
    providerState = { ...providerState, status: 'canceled', effectiveEnd: end };
    await billing.feedback(raw('evt_end', 'customer.subscription.deleted', 'sub_123'), 'signed');
    expect(await service.execute('workspace.retention', {}, actor)).toMatchObject({
      status: 'operator_review_due',
      effectiveEnd: end.toISOString(),
      purgeEnabled: false,
    });
  });
  it('restarts only a signed, unused expiration once and preserves its evidence across unknown outcomes', async () => {
    const sourceKey = key();
    await billing.checkout(actor, 'starter', sourceKey);
    const previous = calls[0]!;
    const expire = (event: string) =>
      Buffer.from(
        JSON.stringify({
          id: event,
          kind: 'checkout.session.expired',
          workspace,
          intent: previous,
          objectId: providerState.id,
        }),
      );
    providerState = { ...providerState, status: 'expired', url: null };
    await billing.checkout(actor, 'starter', key());
    expect((await status()).restartableId).toBeNull();
    await expect(billing.restart(actor, 'pro', previous, key())).rejects.toMatchObject({
      code: 'checkout_not_restartable',
    });
    const receipt = expire('evt_expired');
    await billing.feedback(receipt, 'signature');
    expect((await status()).restartableId).toBe(previous);
    await expect(billing.restart(actor, 'pro', previous, sourceKey)).rejects.toMatchObject({
      code: 'operation_conflict',
    });
    providerState = {
      ...providerState,
      id: 'cs_test_' + key(),
      status: 'open',
      url: 'https://checkout.stripe.com/c/pay/new',
    };
    rejectOnce = true;
    const restartKey = key();
    await expect(billing.restart(actor, 'pro', previous, restartKey)).rejects.toMatchObject({
      code: 'checkout_pending',
    });
    const replay = await Promise.all([
      billing.restart(actor, 'pro', previous, restartKey),
      billing.restart(actor, 'pro', previous, restartKey),
    ]);
    expect(replay.every((r) => r.status === 'open')).toBe(true);
    await expect(billing.restart(actor, 'pro', previous, key())).rejects.toMatchObject({
      code: 'checkout_not_restartable',
    });
    await expect(billing.restart(actor, 'growth', previous, restartKey)).rejects.toMatchObject({
      code: 'operation_conflict',
    });
    expect(new Set(calls).size).toBe(2);
    await billing.feedback(receipt, 'signature');
    expect(await status()).toMatchObject({ status: 'open', plan: 'pro', restartableId: null });
    expect(
      await db.tenant(
        workspace,
        async (sql) => (await sql.query('SELECT id,replacement_id FROM sandbox_expired_checkouts')).rows,
      ),
    ).toEqual([{ id: previous, replacement_id: calls.at(-1) }]);
    expect(
      await db.tenant(
        'org_other',
        async (sql) => (await sql.query('SELECT id FROM sandbox_expired_checkouts')).rowCount,
      ),
    ).toBe(0);
  });
  it('does not restart an expired session that already created a customer', async () => {
    await billing.checkout(actor, 'starter', key());
    const intent = calls[0]!;
    providerState = { ...providerState, status: 'expired', url: null, customer: 'cus_already_created' };
    await billing.feedback(
      Buffer.from(
        JSON.stringify({
          id: 'evt_used',
          kind: 'checkout.session.expired',
          workspace,
          intent,
          objectId: providerState.id,
        }),
      ),
      'signature',
    );
    expect((await status()).restartableId).toBeNull();
    await expect(billing.restart(actor, 'pro', intent, key())).rejects.toMatchObject({
      code: 'checkout_not_restartable',
    });
  });
  it('keeps opted-out sandbox configuration and complimentary accounts away from provider calls', async () => {
    await expect(new SandboxBilling(db).checkout(actor, 'starter', key())).rejects.toMatchObject({
      code: 'billing_off',
    });
    await expect(
      new SandboxBilling(db, gateway, workspace).checkout(actor, 'starter', key()),
    ).rejects.toMatchObject({ code: 'complimentary_workspace' });
    await recordAccess(admin, workspace, {
      workspaceId: workspace,
      plan: 'growth',
      operator: 'fixture',
      reason: 'staging pilot',
      operationKey: key(),
    });
    await expect(billing.checkout(actor, 'starter', key())).rejects.toMatchObject({
      code: 'complimentary_workspace',
    });
    expect(calls).toEqual([]);
  });
  it('requires a test key, exact account and a valid Stripe signature before interpreting webhook metadata', () => {
    const env = {
      FLOCKLETTER_BILLING_MODE: 'sandbox',
      FLOCKLETTER_STRIPE_TEST_ACCOUNT: account,
      FLOCKLETTER_STRIPE_TEST_KEY: 'rk_test_fixture',
      FLOCKLETTER_STRIPE_TEST_WEBHOOK: webhook,
      FLOCKLETTER_STRIPE_CARD_CONFIG: 'pmc_123',
      FLOCKLETTER_STRIPE_STARTER_PRICE: prices.starter,
      FLOCKLETTER_STRIPE_GROWTH_PRICE: prices.growth,
      FLOCKLETTER_STRIPE_PRO_PRICE: prices.pro,
    };
    expect(() =>
      sandboxGateway('https://billing.example.test', {
        ...env,
        FLOCKLETTER_STRIPE_TEST_KEY: 'sk_live_fixture',
      }),
    ).toThrow();
    const api = sandboxGateway('https://billing.example.test', env)!;
    const id = key(),
      payload = JSON.stringify({
        id: 'evt_signed',
        object: 'event',
        type: 'checkout.session.completed',
        livemode: false,
        account,
        data: { object: { id: 'cs_test_123', metadata: { fl_workspace: workspace, fl_intent: id } } },
      });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhook });
    expect(api.verify(Buffer.from(payload), signature)).toMatchObject({ workspace, intent: id });
    expect(() => api.verify(Buffer.from(payload + ' '), signature)).toThrow();
    const live = payload.replace('"livemode":false', '"livemode":true');
    expect(() =>
      api.verify(
        Buffer.from(live),
        Stripe.webhooks.generateTestHeaderString({ payload: live, secret: webhook }),
      ),
    ).toThrow();
  });
});
