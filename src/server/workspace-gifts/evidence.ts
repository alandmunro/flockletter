import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { Database, Sql } from '../db.js';
import {lockWorkspace} from '../workspace-lock.js';
import type { Actor } from '../service.js';
import { seedStagingGiftAudience } from './audience.js';
import { WorkspaceGiftProvider } from './provider.js';
import { WorkspaceGifts, giftSendingHold } from './service.js';
import { all } from './store.js';

const fixtureAccount = 'acct_giftevidence';
const productIds = ['CARD01', 'CARD02', 'CARD03', 'CARD04', 'CARD05'];
const face = 50_000, total = 55_000, offerFace = 500, refundAmount = 52_250;
const sessionId = 'cs_simulated', paymentId = 'pi_simulated', chargeId = 'ch_simulated';
const refundId = 're_simulated';
type OrderRequest = {
  external_id: string;
  payment: { funding_source_id: string };
  reward: {
    value: { denomination: number; currency_code: string };
    delivery: { method: string };
    products: string[];
    recipient: { email: string };
  };
};

const fixtureWorkspace = 'fixture:gifting:audience:v1:studio';
const suite = 'workspace-gift-evidence:v1';

// The runtime journal is insert-only. Only ownership changes and near-expiry
// renewals append lease rows. All lease times come from the same PostgreSQL clock.
const leaseActor = suite + ':lease';
class LeaseLost extends Error {}
type Lease = { version: number; owner: string; active: boolean; renew: boolean };
async function currentLease(sql: Sql) {
  await lockWorkspace(sql,fixtureWorkspace);
  const { rows } = await sql.query<Lease>(`
    SELECT operation_key::integer AS version,request_hash AS owner,
      result = 'true'::jsonb AND created_at + interval '90 seconds' > clock_timestamp() AS active,
      created_at + interval '45 seconds' <= clock_timestamp() AS renew
    FROM operations WHERE workspace_id=$1 AND actor_id=$2 ORDER BY operation_key DESC LIMIT 1`,
    [fixtureWorkspace, leaseActor]);
  return rows[0];
}
async function writeLease(sql: Sql, prior: Lease | undefined, owner: string, open: boolean) {
  await sql.query(`INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result,created_at)
    VALUES($1,$2,$3,$4,$5,clock_timestamp())`,
    [fixtureWorkspace, leaseActor, String((prior?.version ?? 0) + 1).padStart(10, '0'), owner, JSON.stringify(open)]);
}

class ProofJournal {
  private constructor(private db: Database, private owner: string, private records: Map<string, unknown>) {}

  static async acquire(db: Database) {
    return db.tenant(fixtureWorkspace, async sql => {
      const lease = await currentLease(sql);
      const result = await sql.query<{operation_key: string; result: unknown}>(
        'SELECT operation_key,result FROM operations WHERE workspace_id=$1 AND actor_id=$2', [fixtureWorkspace, suite]);
      const records = new Map(result.rows.map(r => [r.operation_key, r.result]));
      if (records.has('complete')) return reportSchema.parse(records.get('complete'));
      if (lease?.active) return null;
      const owner = randomUUID();
      await writeLease(sql, lease, owner, true);
      return new ProofJournal(db, owner, records);
    });
  }

  private async verify(sql: Sql) {
    const lease = await currentLease(sql);
    if (!lease || lease.owner !== this.owner) throw new LeaseLost();
    if (lease.renew) await writeLease(sql, lease, this.owner, true);
  }

  async release() {
    await this.db.tenant(fixtureWorkspace, async sql => {
      const lease = await currentLease(sql);
      if (lease?.owner === this.owner) await writeLease(sql, lease, this.owner, false);
    });
  }

  get<T>(key: string) { return this.records.get(key) as T | undefined; }

  // Fence both sides of each replayable service action. A stopped process can finish
  // an already-issued operation with its original key, but cannot publish a checkpoint
  // or start the next stage once a new process has acquired the expired lease.
  async once<T>(key: string, perform: () => Promise<T>): Promise<T> {
    if (this.records.has(key)) return this.records.get(key) as T;
    await this.db.tenant(fixtureWorkspace, sql => this.verify(sql));
    const value = await perform();
    await this.db.tenant(fixtureWorkspace, async sql => {
      await this.verify(sql);
      const params = [fixtureWorkspace, suite, key, JSON.stringify(value ?? null)];
      const inserted = await sql.query(`INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result)
        VALUES($1,$2,$3,$3,$4) ON CONFLICT DO NOTHING`, params);
      if (!inserted.rowCount) {
        // Concurrent payment reconciliation can observe the same simulated charge.
        const matching = await sql.query(`SELECT FROM operations
          WHERE workspace_id=$1 AND actor_id=$2 AND operation_key=$3 AND result=$4::jsonb`, params);
        assert.equal(matching.rowCount, 1);
      }
    });
    this.records.set(key, value);
    return value;
  }
}

// Wait for both transactions even if one fails, before relinquishing proof ownership.
async function together<A, B>(a: Promise<A>, b: Promise<B>): Promise<[A, B]> {
  const [left, right] = await Promise.allSettled([a, b]);
  if (left.status === 'rejected') throw left.reason;
  if (right.status === 'rejected') throw right.reason;
  return [left.value, right.value];
}

// The real gateway parses every synthetic HTTP response, including inconsistent and
// unavailable receipts. This transport has no network fallback or environment bindings.
class SimulatedTransport {
  readonly orders = new Map<string, { request: OrderRequest; order: string; reward: string }>();
  readonly lookups = new Set<string>();
  readonly metadata: Record<string, string>;
  checkoutCreated = false;
  chargeReads = 0;
  wrongCharge = true;
  catalogUnavailable = false;
  disputeState = 'needs_response';
  orderPosts = 0;
  outageAfterCommit = true;
  refundPosts = 0;
  refundReads = 0;
  wrongRefund = true;

  constructor(workspace: string, brand: string, private started: number, private journal: ProofJournal) {
    this.metadata = { purpose: 'flockletter_workspace_gift_v1', workspace, brand };
    const lot = journal.get<string>('simulated-checkout');
    if (lot) { this.checkoutCreated = true; this.metadata.lot = lot; }
    this.refundPosts = journal.get('simulated-refund') ? 1 : 0;
    for (let i = 1; i <= 5; i++) {
      const request = journal.get<OrderRequest>('simulated-order-' + i);
      if (!request) break;
      this.orders.set(request.external_id, { request, order: 'ORDER' + i, reward: 'REWARD' + i });
      this.orderPosts++;
    }
  }

  private async stripe(path: string, method: string, body: URLSearchParams) {
    const json = Response.json;
    if (method === 'GET' && path === '/v1/account') return json({ id: fixtureAccount });
    const checkout = {
      id: sessionId, livemode: false, mode: 'payment', currency: 'usd', amount_total: total,
      client_reference_id: this.metadata.lot, metadata: this.metadata, payment_intent: paymentId,
    };
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      assert(Number(body.get('line_items[0][price_data][unit_amount]')) === total);
      const lot = body.get('client_reference_id');
      assert(lot && /^[0-9a-f-]{36}$/.test(lot));
      this.metadata.lot = checkout.client_reference_id = lot;
      for (const [key, value] of Object.entries(this.metadata)) {
        assert(body.get('metadata[' + key + ']') === value);
        assert(body.get('payment_intent_data[metadata][' + key + ']') === value);
      }
      const saved = await this.journal.once('simulated-checkout', async () => lot);
      assert(saved === lot);
      this.checkoutCreated = true;
      return json({ ...checkout, status: 'open', payment_status: 'unpaid', url: 'https://checkout.stripe.com/fixture' });
    }
    assert(this.checkoutCreated, 'Lookup before simulated checkout');
    if (method === 'GET' && path === '/v1/checkout/sessions/' + sessionId)
      return json({ ...checkout, status: 'complete', payment_status: 'paid', url: null });
    if (method === 'GET' && path === '/v1/payment_intents/' + paymentId)
      return json({ id: paymentId, livemode: false, amount: total, amount_received: total, currency: 'usd',
        metadata: this.metadata, status: 'succeeded', latest_charge: chargeId });
    if (method === 'GET' && path === '/v1/disputes/dp_simulated') return json({
      id: 'dp_simulated', charge: chargeId, payment_intent: paymentId, livemode: false, amount: total,
      currency: 'usd', status: this.disputeState, created: Math.floor(this.started / 1000),
    });
    if (method === 'GET' && path === '/v1/charges/' + chargeId) {
      this.chargeReads++;
      if (!this.wrongCharge) await this.journal.once('matching-charge-lookup', async () => true);
      return json({ id: chargeId, livemode: false, paid: true, disputed: false, currency: 'usd',
        amount_captured: this.wrongCharge ? total - 1 : total, created: Math.floor(this.started / 1000),
        payment_intent: paymentId, amount_refunded: this.refundPosts ? refundAmount : 0 });
    }
    const refund = { id: refundId, amount: refundAmount, status: 'succeeded', currency: 'usd',
      charge: chargeId, payment_intent: paymentId, metadata: this.metadata };
    if (method === 'GET' && path === '/v1/refunds') {
      assert(body.get('payment_intent') === paymentId);
      return json({ data: this.refundPosts ? [refund] : [], has_more: false });
    }
    if (method === 'POST' && path === '/v1/refunds') {
      assert(this.refundPosts === 0 && body.get('payment_intent') === paymentId && Number(body.get('amount')) === refundAmount);
      await this.journal.once('simulated-refund', async () => true);
      this.refundPosts++;
      return json(refund);
    }
    if (method === 'GET' && path === '/v1/refunds/' + refundId && this.refundPosts) {
      this.refundReads++;
      if (!this.wrongRefund) await this.journal.once('matching-refund-lookup', async () => true);
      return json({ ...refund, charge: this.wrongRefund ? 'ch_wrongfixture' : chargeId });
    }
    throw Error('Unexpected simulated payment request');
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    if (u.origin === 'https://api.stripe.com')
      return this.stripe(u.pathname, method, method === 'GET' ? u.searchParams : new URLSearchParams(String(init?.body)));
    assert(u.origin === 'https://testflight.tremendous.com', 'Unexpected simulated gateway host');
    const path = u.pathname;
    if (method === 'GET' && path === '/api/v2/products' && this.catalogUnavailable) return new Response(null, { status: 503 });
    if (method === 'GET' && path === '/api/v2/products')
      return Response.json({ products: productIds.map((id, i) => ({
        id, name: 'Target fixture ' + i, currency_codes: ['USD'], skus: [{ min: 5, max: 5, currency_code: 'USD' }],
      })) });
    if (method === 'POST' && path === '/api/v2/orders') {
      const request: OrderRequest = JSON.parse(String(init?.body));
      const id = request.external_id;
      assert(this.lookups.has(id) && !this.orders.has(id), 'Order creation requires a previous empty lookup');
      assert.equal(request.payment.funding_source_id, 'BALANCE');
      assert.deepEqual(request.reward.value, { denomination: 5, currency_code: 'USD' });
      assert.deepEqual([...request.reward.products].sort(), productIds);
      assert.equal(request.reward.delivery.method, 'LINK');
      assert(request.reward.recipient.email === 'gift-' + id + '@example.invalid');
      const ordinal = ++this.orderPosts;
      this.orders.set(id, { request, order: 'ORDER' + ordinal, reward: 'REWARD' + ordinal });
      await this.journal.once('simulated-order-' + ordinal, async () => request);
      if (this.outageAfterCommit) throw Error('Simulated response lost after order creation');
      return Response.json({});
    }
    if (method === 'GET' && path.startsWith('/api/v2/orders/')) {
      const id = path.slice('/api/v2/orders/'.length);
      this.lookups.add(id);
      const record = this.orders.get(id);
      if (!record) return new Response(null, { status: 404 });
      if (this.outageAfterCommit) return new Response(null, { status: 503 });
      return Response.json({ order: { id: record.order, external_id: id, status: 'EXECUTED', rewards: [{
        id: record.reward, order_id: record.order, recipient: record.request.reward.recipient,
        delivery: { method: 'LINK', status: 'SUCCEEDED' }, value: record.request.reward.value,
      }] } });
    }
    const reward = [...this.orders.values()].find(r => path === '/api/v2/rewards/' + r.reward + '/generate_link');
    if (method === 'POST' && reward) return Response.json({ reward: {
      id: reward.reward, link: 'https://testflight.tremendous.com/fixture/' + reward.reward,
    } });
    throw Error('Unexpected simulated reward request');
  };

  gateway() {
    return new WorkspaceGiftProvider('sk_test_fixture', fixtureAccount, 'TEST_fixture', false,
      'https://example.invalid', this.fetch);
  }
}

type Status = {
  people: { id: string }[];
  purchases: { id: string; state: string }[];
  campaigns: { id: string; offered: number; claimed: number; expired: number; released: number }[];
  ledger: { kind: string; amount: number }[];
  closed: boolean; available: number; spent: number; reserved: number; refunded: number;
};

function fixtureOwner(workspaceId: string, person: string): Actor {
  return { kind: 'session', workspaceId, userId: person, actorId: 'user:' + person,
    owner: true, scopes: [], brandIds: null };
}

const reportSchema = z.strictObject({
  gateway: z.literal('simulated'), unit: z.literal('USD cents'), charged: z.literal(55000),
  credit: z.literal(50000), initiallyReserved: z.literal(50000), claimed: z.literal(5), expired: z.literal(95),
  orders: z.literal(5), spent: z.literal(2500), released: z.literal(47500), availableBeforeClosure: z.literal(47500),
  refunded: z.literal(52250), available: z.literal(0), reserved: z.literal(0), foreignPurchases: z.literal(0),
  ledgerEntries: z.literal(105), negativeBalance: z.literal(-2500),
  access: z.tuple([z.literal('paused'), z.literal('suspended'), z.literal('closed')]),
  reservedDuringCatalogOutage: z.literal(0),
});
type Report = z.infer<typeof reportSchema>;

async function prove(db: Database, journal: ProofJournal, phase: (label: string) => void) {
  const a = await seedStagingGiftAudience(db, 'studio');
  const b = await seedStagingGiftAudience(db, 'orchard');
  const owner = fixtureOwner(a.workspaceId, 'studio-owner'), other = fixtureOwner(b.workspaceId, 'orchard-owner');
  const w = a.workspaceId, brandId = a.brandId;
  assert(w === fixtureWorkspace && b.workspaceId === 'fixture:gifting:audience:v1:orchard');
  const step = <T>(name: string, fn: () => Promise<T>) => { phase(name); return journal.once(name, fn); };
  const prior = await db.read(w, sql => all(sql, 'lot'));
  assert(prior.length <= 1 && prior.every(l => l.account === fixtureAccount && l.brand === brandId),
    'A different gift run occupies this fixture');
  const { started, purchaseKey, campaignId } = await step('initialize', async () => {
    assert.equal(prior.length, 0);
    assert.equal((await db.read(w, sql => all(sql, 'campaign'))).length, 0);
    return { started: Date.now(), purchaseKey: randomUUID(), campaignId: randomUUID() };
  });
  let now = started;
  const mock = new SimulatedTransport(w, brandId, started, journal);
  const options = { fixture: true, live: false, waitMs: 0, monthlyCap: face, clock: () => new Date(now) };
  const start = () => new WorkspaceGifts(db, mock.gateway(), options);
  let gifts = start();
  const status = async (actor = owner, brand = brandId) =>
    await gifts.execute('gifts.status', { brandId: brand }, actor) as Status;
  const people = (await status()).people.map(p => p.id).sort();
  assert.equal(people.length, 100);
  assert.equal((await status(other, b.brandId)).people.length, 1);
  await assert.rejects(status(other, brandId), { code: 'gift_unavailable' });
  const body = JSON.stringify({ type: 'checkout.session.completed', livemode: false });
  const timestamp = Math.floor(Date.now() / 1000);
  const mac = createHmac('sha256', 'whsec_fixture').update(timestamp + '.' + body).digest('hex');
  const signature = 't=' + timestamp + ',v1=' + mac;
  const verifier = mock.gateway();
  assert.equal(verifier.signedEvent(Buffer.from(body), signature, 'whsec_fixture').type, 'checkout.session.completed');
  assert.throws(() => verifier.signedEvent(Buffer.from(body + ' '), signature, 'whsec_fixture'), { code: 'signature_rejected' });

  const purchaseId = await step('checkout', async () => {
    const purchase = await gifts.execute('gifts.purchase', { brandId, face, operationKey: purchaseKey }, owner) as { id: string };
    assert(purchase.id && purchase.id === mock.metadata.lot);
    return purchase.id;
  });
  assert(purchaseId === mock.metadata.lot && prior.every(l => l.id === purchaseId));
  const reconcile = () => gifts.execute('gifts.reconcile', { brandId, operationKey: purchaseKey, purchaseId }, owner);
  await step('incorrect charge', async () => {
    await assert.rejects(reconcile(), { code: 'gift_provider_mismatch' });
    assert.equal((await status()).available, 0);
    assert.equal(mock.chargeReads, 1);
    return true;
  });
  mock.wrongCharge = false;
  await step('settled charge', async () => {
    await together(reconcile(), gifts.tick(w));
    const funded = await status();
    assert.equal(funded.available, face);
    assert.deepEqual(funded.ledger.map(e => [e.kind, e.amount]), [['purchased', face]]);
    await assert.rejects(gifts.execute('gifts.reconcile',
      { brandId: b.brandId, purchaseId, operationKey: purchaseKey }, other), { code: 'gift_purchase_missing' });
    return true;
  });

  const launch = { brandId, operationKey: campaignId, title: 'Fixture thank-you', face: offerFace, days: 30,
    products: productIds, personIds: people, brokerConfirmed: true };
  const reservedDuringCatalogOutage = await step('catalog outage', async () => {
    const catalog = await gifts.execute('gifts.catalog', { brandId, face: offerFace }, owner) as { products: { id: string }[] };
    assert.deepEqual(catalog.products.map(p => p.id).sort(), productIds);
    await assert.rejects(gifts.execute('gifts.launch', { ...launch, products: ['MISSING'] }, owner),
      { code: 'gift_product_unavailable' });
    mock.catalogUnavailable = true;
    await assert.rejects(gifts.execute('gifts.launch', launch, owner), { code: 'gift_vendor_unavailable' });
    const held = await status();
    assert.equal(held.reserved, 0);
    assert.equal(held.campaigns.length, 0);
    return held.reserved;
  });
  mock.catalogUnavailable = false;
  const initiallyReserved = await step('offer reservation', async () => {
    await gifts.execute('gifts.launch', launch, owner);
    const reserved = await status();
    assert.equal(reserved.available, 0);
    assert.equal(reserved.campaigns[0]?.offered, 100);
    assert.equal(reserved.reserved, face);
    return reserved.reserved;
  });

  // Resolve only those links needed by the current phase. Never copy a bearer into the checkpoint journal.
  const link = async (i: number) => {
    const { path } = await gifts.execute('gifts.link', { brandId, campaignId, personId: people[i] }, owner) as { path: string };
    const query = new URL(path, 'https://example.invalid').hash.slice(1);
    const params = new URLSearchParams(query);
    const id = params.get('offer'), token = params.get('token');
    assert(id && token && params.get('workspace') === w);
    return { id, token };
  };
  const open = async (i: number, claim: boolean) => {
    const { id, token } = await link(i);
    return gifts.recipient(w, id, token, claim);
  };
  await step('recipient isolation', async () => {
    const first = await link(0), second = await link(1);
    await assert.rejects(gifts.recipient(b.workspaceId, first.id, first.token, true), { code: 'gift_unavailable' });
    await assert.rejects(gifts.recipient(w, second.id, first.token, true), { code: 'gift_unavailable' });
    assert.equal((await open(0, false)).state, 'offered');
    assert.equal(mock.orderPosts, 0);
    return true;
  });
  await step('ambiguous order', async () => {
    const first = await link(0);
    const claims = await together(open(0, true), open(0, true));
    assert(claims.every(r => r.state === 'pending'));
    assert.equal(mock.orderPosts, 1);
    const held = await status();
    assert.equal(held.reserved, face);
    assert.equal(held.spent, 0);
    const offer = await db.read(w, async sql => (await all(sql, 'offer')).find(o => o.id === first.id));
    assert(offer?.state === 'pending' && !offer.order);
    return true;
  });
  gifts = start();
  mock.outageAfterCommit = false;
  now += 120_000;
  await step('order recovery', async () => {
    await gifts.tick(w);
    assert.equal((await open(0, false)).state, 'claimed');
    assert.equal(mock.orderPosts, 1);
    return true;
  });
  await step('five claims', async () => {
    for (let i = 1; i < 5; i++) assert.equal((await open(i, true)).state, 'claimed');
    assert.equal(mock.orderPosts, 5);
    return true;
  });
  now = started + 30 * 86_400_000;
  const preClosure = await step('claim and expiry', async () => {
    // A boot can stop after the expiry transaction commits and before the checkpoint.
    // The private offer still carries the original link binding in that case.
    const candidate = await db.read(w, async sql => (await all(sql, 'offer')).find(o => o.campaign === campaignId && o.person === people[5]));
    assert(candidate);
    const claimLink = candidate.state === 'expired' ? { id: candidate.id, token: candidate.secret } : await link(5);
    const [atExpiry] = await together(gifts.recipient(w, claimLink.id, claimLink.token, true), gifts.tick(w));
    assert.equal(atExpiry.state, 'expired');
    const expired = await status(), campaign = expired.campaigns[0];
    assert(campaign?.claimed === 5 && campaign.expired === 95 && campaign.released === 47500);
    assert(expired.spent === 2500 && expired.available === 47500 && expired.reserved === 0);
    return { claimed: campaign.claimed, expired: campaign.expired, released: campaign.released, availableBeforeClosure: expired.available };
  });
  const dispute = await mock.gateway().dispute('dp_simulated');
  assert(dispute && dispute.workspace === w && dispute.lot === purchaseId);
  const hold = () => db.read(w, giftSendingHold);
  const debt = await step('disputed balance', async () => {
    await gifts.dispute(dispute);
    await gifts.dispute(dispute);
    const negativeBalance = (await status()).available, paused = await hold();
    assert(negativeBalance === -2500 && paused === 'paused');
    return { negativeBalance, paused };
  });
  now += 6 * 86_400_000;
  const suspended = await step('day six', async () => {
    await gifts.tick(w);
    const state = await hold();
    assert.equal(state, 'suspended');
    return state;
  });
  now += 24 * 86_400_000;
  const closed = await step('day thirty', async () => {
    await gifts.tick(w);
    const state = await hold();
    assert.equal(state, 'closed');
    assert.equal(mock.refundPosts, 0);
    return state;
  });
  await step('dispute resolved', async () => {
    mock.disputeState = 'won';
    const won = await mock.gateway().dispute('dp_simulated');
    assert(won && won.state === 'won');
    await gifts.dispute(won);
    await gifts.dispute(dispute);
    assert.equal((await status()).available, 47500);
    return true;
  });

  const close = { brandId, operationKey: purchaseKey };
  await step('incorrect refund', async () => {
    await assert.rejects(gifts.execute('gifts.close', close, owner), { code: 'gift_provider_mismatch' });
    assert.equal((await status()).refunded, 0);
    assert.equal(mock.refundPosts, 1);
    assert.equal(mock.refundReads, 1);
    return true;
  });
  mock.wrongRefund = false;
  gifts = start();
  await step('refund recovery', async () => {
    await gifts.tick(w);
    await gifts.execute('gifts.close', close, owner);
    assert.equal(mock.refundPosts, 1);
    return true;
  });
  phase('settled ledger');
  const final = await status(), foreign = await status(other, b.brandId);
  const [lot] = await db.read(w, sql => all(sql, 'lot'));
  assert(journal.get('matching-charge-lookup') && journal.get('matching-refund-lookup'));
  assert(lot?.payment === paymentId && lot.charge === chargeId && lot.refundId === refundId);
  assert(lot.face === face && lot.fee === 5000 && lot.total === total && lot.state === 'refunded');
  assert.deepEqual([final.closed, final.available, final.reserved, final.refunded], [true, 0, 0, refundAmount]);
  assert.deepEqual([foreign.closed, foreign.available, foreign.reserved, foreign.refunded, foreign.campaigns.length,
    foreign.purchases.length, foreign.ledger.length], [false, 0, 0, 0, 0, 0, 0]);
  const offers = await db.read(w, sql => all(sql, 'offer'));
  const recorded = new SimulatedTransport(w, brandId, started, journal).orders;
  assert.equal(recorded.size, mock.orderPosts);
  assert.equal(offers.length, 100);
  for (const offer of offers) {
    const receipt = recorded.get(offer.id);
    if (offer.state === 'claimed') assert(receipt && offer.order === receipt.order && offer.reward === receipt.reward);
    else assert(offer.state === 'expired' && !receipt && !offer.order && !offer.reward);
  }
  for (const [kind, count, amount] of [
    ['purchased', 1, face], ['reserved', 1, face], ['claimed', 5, offerFace], ['expired', 95, offerFace],
    ['refunded', 1, refundAmount], ['dispute_needs_response', 1, face], ['dispute_won', 1, face],
  ] as const) {
    const entries = final.ledger.filter(e => e.kind === kind);
    assert.equal(entries.length, count);
    assert(entries.every(e => e.amount === amount));
  }
  const result = reportSchema.parse({ gateway: 'simulated', unit: 'USD cents', charged: lot.total, credit: lot.face,
    initiallyReserved, ...preClosure, orders: mock.orderPosts, spent: final.spent, refunded: final.refunded,
    available: final.available, reserved: final.reserved, foreignPurchases: foreign.purchases.length,
    ledgerEntries: final.ledger.length, negativeBalance: debt.negativeBalance,
    access: [debt.paused, suspended, closed], reservedDuringCatalogOutage });
  return journal.once('complete', async () => result);
}

const active = new WeakMap<Database, Promise<Report>>();
async function lockedProof(db: Database): Promise<Report> {
  let step = 'fixture setup';
  try {
    for (;;) {
      const lease = await ProofJournal.acquire(db);
      if (!lease) {
        await delay(150);
        continue;
      }
      if (!(lease instanceof ProofJournal)) return lease;
      try {
        return await prove(db, lease, label => { step = label; });
      } catch (error) {
        if (!(error instanceof LeaseLost)) throw error;
      } finally {
        await lease.release();
      }
    }
  } catch {
    // Never surface a raw assertion, database query or SDK response on the public report.
    throw Error('Workspace gift fixture verification failed during ' + step + '.');
  }
}

export async function verifyWorkspaceGiftEvidence(db: Database): Promise<Report> {
  if (process.env.APP_ENV !== 'staging' && process.env.APP_ENV !== 'test')
    throw Error('Workspace gift evidence requires staging or test.');
  const running = active.get(db);
  if (running) return running;
  const proof = lockedProof(db);
  active.set(db, proof);
  try { return await proof; } finally { active.delete(db); }
}
