import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/server/db.js';
import { startDatabase } from '../scripts/database-fixture.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { recipientGift } from '../src/server/gifting.js';
import { verifyStagingGifts } from '../src/server/gifting-evidence.js';
import type { GiftAction, GiftStatus } from '../src/shared/gifting.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database, service: CommandService;
const owner: Actor = {
  kind: 'session',
  workspaceId: 'org_gift_a',
  actorId: 'user:gift_a',
  userId: 'gift_a',
  owner: true,
  scopes: [],
  brandIds: null,
};
const other = { ...owner, workspaceId: 'org_gift_b' };
const build = (environment: 'test' | 'production') =>
  new CommandService(
    db,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    environment,
  );
const act = (action: GiftAction, operationKey = randomUUID()) =>
  service.execute('gifting.captureAction', { action, operationKey }, owner);
const status = (actor = owner) =>
  service.execute('gifting.captureStatus', {}, actor) as Promise<GiftStatus>;
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  service = build('test');
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});

it('keeps all capture commands behind owner authority and the server environment', async () => {
  await expect(build('production').execute('gifting.captureStatus', {}, owner)).rejects.toMatchObject({
    code: 'gift_capture_disabled',
  });
  for (const actor of [
    { ...owner, owner: false },
    { ...owner, kind: 'connection' as const },
  ]) {
    await expect(status(actor)).rejects.toMatchObject({ code: 'owner_required' });
  }
});
it('persists across service instances and serializes payment, reservation, claim and recovery', async () => {
  const key = randomUUID();
  await expect(act({ kind: 'reserve', days: 15, products: 1 })).rejects.toMatchObject({
    code: 'gift_action_unavailable',
  });
  await Promise.all([act({ kind: 'fund' }, key), act({ kind: 'fund' }, key), act({ kind: 'fund' })]);
  expect(await status()).toMatchObject({ available: 50000, reserved: 0 });
  await act({ kind: 'reserve', days: 15, products: 6 });
  await expect(act({ kind: 'reserve', days: 30, products: 1 })).rejects.toMatchObject({
    code: 'gift_terms_changed',
  });
  expect(await status()).toMatchObject({ available: 0, reserved: 50000 });
  const { path } = (await service.execute('gifting.captureLink', { person: 1 }, owner)) as {
    path: string;
  };
  const token = new URLSearchParams(path.split('#')[1]).get('token')!;
  await expect(recipientGift(db, other.workspaceId, 1, token, true)).rejects.toMatchObject({
    code: 'gift_unavailable',
  });
  await expect(recipientGift(db, owner.workspaceId, 2, token, true)).rejects.toMatchObject({
    code: 'gift_unavailable',
  });
  const open = (claim: boolean) => recipientGift(db, owner.workspaceId, 1, token, claim);
  expect(await open(false)).toMatchObject({ state: 'offered' });
  expect((await status()).orders).toBe(0);
  await act({ kind: 'timeout' });
  await Promise.all([open(true), open(true)]);
  expect(await status()).toMatchObject({ orders: 1, spent: 0, reserved: 50000 });
  service = build('test');
  await act({ kind: 'recover' });
  await act({ kind: 'expire' });
  expect(await status()).toMatchObject({ orders: 1, spent: 500, available: 49500, reserved: 0 });
  await act({ kind: 'refund' });
  expect(await status()).toMatchObject({ closed: true, refunded: 54450, reserved: 0, available: 0 });
  expect(await open(true)).toMatchObject({ state: 'claimed' });
  expect(await status(other)).toMatchObject({ funded: false, offers: [] });
});
it('runs the staging acceptance proof twice against PostgreSQL and recovers the same results', async () => {
  const first = await verifyStagingGifts(db);
  expect(first).toMatchObject({ claimed: 5, orders: 5, expired: 95, spent: 2500, refunded: 52250 });
  expect(await verifyStagingGifts(db)).toEqual(first);
});

it('blocks simulated settlement for a provider-backed fixture and resumes a provider timeout exactly once', async () => {
  const { sandboxRun } = await import('../src/server/gifting-sandbox.js');
  const { giftStatus, recordGift } = await import('../src/server/gifting.js');
  const { sandboxGiftWorkspace: ws } = await import('../src/shared/gifting.js');
  await expect(db.tenant(ws, (sql) => recordGift(sql, ws, { kind: 'fund' }))).rejects.toMatchObject({
    code: 'gift_provider_mismatch',
  });
  const orders = new Map<string, { order: string; reward: string }>();
  let timeout = true,
    confirmations = 0;
  const providers = {
    account: 'acct_fixture',
    checkAccount: async () => {},
    products: async () => ['TEST1', 'TEST2', 'TEST3', 'TEST4', 'TEST5'],
    payment: async () => 'pi_fixture',
    confirm: async () => {
      confirmations++;
      return 55000;
    },
    async order(id: string, person: number) {
      if (!orders.has(id)) orders.set(id, { order: 'ORDER' + person, reward: 'REWARD' + person });
      if (timeout) {
        timeout = false;
        throw Error('synthetic timeout after provider commit');
      }
      return orders.get(id)!;
    },
    rewardLink: async () => 'https://testflight.tremendous.com/rewards/fixture',
    async refund(_run: string, payment: string, total: number) {
      expect(payment).toBe('pi_fixture');
      expect(total).toBe(52250);
      return { id: 're_fixture', total };
    },
  };
  await expect(sandboxRun(db, providers).verify(() => {})).rejects.toThrow('synthetic timeout');
  const held = await db.read(ws, (sql) => giftStatus(sql, ws));
  expect(held).toMatchObject({ spent: 0, reserved: 50000 });
  expect(held.offers[0]?.state).toBe('pending');
  const report = await sandboxRun(db, providers).verify(() => {});
  expect(report).toMatchObject({
    payment: 55000,
    claimed: 5,
    orders: 5,
    expired: 95,
    spent: 2500,
    released: 47500,
    refund: 52250,
    available: 0,
    reserved: 0,
  });
  expect(orders.size).toBe(5);
  expect(await sandboxRun(db, providers).verify(() => {})).toEqual(report);
  expect(confirmations).toBe(2);
});

it('binds the Tremendous host, recipient, order and reward and retains pending results', async () => {
  const { stagingGiftProviders } = await import('../src/server/gifting-providers.js');
  const env = {
    APP_ENV: 'staging',
    FLOCKLETTER_STRIPE_TEST_KEY: 'sk_test_fixture',
    FLOCKLETTER_STRIPE_TEST_ACCOUNT: 'acct_fixture',
    TREMENDOUS_SANDBOX_API_KEY: 'TEST_fixture',
  };
  expect(() => stagingGiftProviders({ ...env, APP_ENV: 'production' })).toThrow();
  expect(() =>
    stagingGiftProviders({ ...env, FLOCKLETTER_STRIPE_TEST_KEY: 'sk_live_fixture' }),
  ).toThrow();
  expect(() => stagingGiftProviders({ ...env, TREMENDOUS_SANDBOX_API_KEY: 'PROD_fixture' })).toThrow();
  let lookup = 0,
    posts = 0,
    verified = false;
  const gateway = stagingGiftProviders(env, async (url, opts) => {
    expect(new URL(String(url)).origin).toBe('https://testflight.tremendous.com');
    if (opts?.method === 'POST') {
      posts++;
      expect(JSON.parse(String(opts.body))).toMatchObject({
        external_id: 'testoffer',
        payment: { funding_source_id: 'BALANCE' },
        reward: { delivery: { method: 'LINK' }, value: { denomination: 5, currency_code: 'USD' } },
      });
      return Response.json({});
    }
    if (!lookup++) return new Response(null, { status: 404 });
    return Response.json({
      order: {
        id: 'ORDER1',
        external_id: 'testoffer',
        status: verified ? 'EXECUTED' : 'OPEN',
        rewards: [
          {
            id: 'REWARD1',
            order_id: 'ORDER1',
            value: { denomination: 5, currency_code: 'USD' },
            recipient: { email: 'recipient-1@example.invalid' },
            delivery: { method: 'LINK', status: 'SUCCEEDED' },
          },
        ],
      },
    });
  });
  await expect(gateway.order('testoffer', 1, ['TEST1'])).rejects.toThrow('pending');
  verified = true;
  expect(await gateway.order('testoffer', 1, ['TEST1'])).toEqual({ order: 'ORDER1', reward: 'REWARD1' });
  await expect(gateway.order('testoffer', 2, ['TEST1'])).rejects.toThrow('pending');
  expect(posts).toBe(1);
});

it('checks the Stripe test payment and original charge before accepting the partial refund', async () => {
  const { stagingGiftProviders } = await import('../src/server/gifting-providers.js');
  const env = {
    APP_ENV: 'staging',
    FLOCKLETTER_STRIPE_TEST_KEY: 'sk_test_fixture',
    FLOCKLETTER_STRIPE_TEST_ACCOUNT: 'acct_fixture',
    TREMENDOUS_SANDBOX_API_KEY: 'TEST_fixture',
  };
  let paid = false,
    refunded = false,
    wrongCharge = false;
  const run = '5aa73f90-2d31-496f-91ef-5932b1020d17';
  const refund = {
    id: 're_fixture',
    amount: 52250,
    currency: 'usd',
    payment_intent: 'pi_fixture',
    charge: 'ch_fixture',
    status: 'succeeded',
    metadata: { flock_gift_run: run },
  };
  const gateway = stagingGiftProviders(env, async (url, opts) => {
    const path = new URL(String(url)).pathname,
      body = new URLSearchParams(String(opts?.body ?? ''));
    const intent = {
      id: 'pi_fixture',
      livemode: false,
      currency: 'usd',
      amount: 55000,
      amount_received: paid ? 55000 : 0,
      metadata: { flock_gift_run: run },
      status: paid ? 'succeeded' : 'requires_payment_method',
      latest_charge: paid ? 'ch_fixture' : null,
    };
    if (path === '/v1/account') return Response.json({ id: 'acct_fixture' });
    if (path === '/v1/payment_intents') {
      expect(body.get('amount')).toBe('55000');
      expect(body.get('metadata[flock_gift_run]')).toBe(run);
      return Response.json(intent);
    }
    if (path === '/v1/payment_intents/pi_fixture') return Response.json(intent);
    if (path.endsWith('/confirm')) {
      expect(body.get('payment_method')).toBe('pm_card_visa');
      paid = true;
      return Response.json(intent);
    }
    if (path === '/v1/refunds' && opts?.method === 'POST') {
      expect(body.get('payment_intent')).toBe('pi_fixture');
      expect(body.get('amount')).toBe('52250');
      refunded = true;
      return Response.json(refund);
    }
    if (path === '/v1/refunds')
      return Response.json({ data: refunded ? [refund] : [], has_more: false });
    if (path === '/v1/refunds/re_fixture') return Response.json(refund);
    if (path === '/v1/charges/ch_fixture')
      return Response.json({
        id: 'ch_fixture',
        livemode: wrongCharge,
        payment_intent: 'pi_fixture',
        amount_refunded: 52250,
      });
    throw Error('Unexpected test request ' + path);
  });
  await gateway.checkAccount();
  expect(await gateway.payment(run, undefined, true)).toBe('pi_fixture');
  expect(await gateway.confirm(run, 'pi_fixture')).toBe(55000);
  expect(await gateway.refund(run, 'pi_fixture', 52250, true)).toEqual({
    id: 're_fixture',
    total: 52250,
  });
  wrongCharge = true;
  await expect(gateway.refund(run, 'pi_fixture', 52250, false)).rejects.toThrow(
    'stripe_refund_unverified',
  );
});
