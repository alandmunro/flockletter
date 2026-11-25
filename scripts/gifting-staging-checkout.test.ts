// node --import tsx --test scripts/gifting-staging-checkout.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { once } from 'node:events';
import express from 'express';
import pg from 'pg';
import { all, put } from '../src/server/workspace-gifts/store.js';
import { lockWorkspace } from '../src/server/workspace-lock.js';
import { loadConfig } from '../src/server/config.js';
import { Database } from '../src/server/db.js';
import { installCheckoutProof, operateCheckoutProof, readCheckoutProofStage } from '../src/server/workspace-gifts/checkout-proof.js';
import { startDatabase } from './database-fixture.js';

const origin = 'https://flockletter-staging.onrender.com';
const workspace = 'fixture:gifting:checkout:v1';
const marker = 'workspace-gifts:checkout-proof:v1';

test('the shell command emits exactly one sanitized stage for denied inputs', () => {
  for (const [args, env, expected] of [
    [['advance', 'arbitrary-workspace'], {}, 'invalid_command'],
    [['advance'], { APP_ENV: 'production' }, 'target_blocked'],
    [['checkout-link'], { APP_ENV: 'staging', APP_ORIGIN: origin }, 'private_terminal_required'],
  ] as const) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/gifting-staging-checkout.ts', ...args],
      { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify({ stage: expected }) + '\n');
  }
});

// This double intercepts only the external HTTP boundary of the configured WorkspaceGiftProvider.
// Flipping paid changes GET receipts as a browser payment would. No confirmation API exists here.
function sandbox() {
  const session = 'cs_test_FixturePrivate', payment = 'pi_fixture', charge = 'ch_fixture', refund = 're_fixture';
  const account = 'acct_fixture', reward = 'REWARD01', order = 'ORDER001';
  const state = { paid: false, expired: false, wrongCharge: false, wrongAccount: false, checkoutDenied: false, orders: 0, creates: 0, refunds: 0,
    loseOrderReply: true, wrongRefund: true, privateLinks: 0, requests: 0 };
  const meta: Record<string, string> = {};
  let externalId = '';
  const checkout = () => ({ id: session, livemode: false, mode: 'payment', currency: 'usd', amount_total: 1100,
    metadata: meta, client_reference_id: meta.lot, payment_status: state.paid ? 'paid' : 'unpaid',
    status: state.paid ? 'complete' : state.expired ? 'expired' : 'open', payment_intent: state.paid ? payment : null,
    url: state.paid || state.expired ? null : 'https://checkout.stripe.com/c/pay/' + session + '#private' });
  const refundReceipt = () => ({ id: refund, amount: 550, status: 'succeeded', currency: 'usd',
    charge, payment_intent: payment, metadata: meta });
  const unexpected: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), method = init?.method ?? 'GET';
    const form = new URLSearchParams(String(init?.body));
    state.requests++;
    if (url.origin === 'https://api.stripe.com') {
      switch (method + ' ' + url.pathname) {
        case 'GET /v1/account': return Response.json({ id: state.wrongAccount ? 'acct_other' : account });
        case 'POST /v1/checkout/sessions': {
          if (state.checkoutDenied) return Response.json({ error: {
            type: 'invalid_request_error', message: 'Fixture-private detail. Missing permission: checkout_session_write.',
          } }, { status: 403 });
          state.creates++;
          assert.equal(form.get('line_items[0][price_data][unit_amount]'), '1100');
          assert.equal(form.get('mode'), 'payment');
          for (const key of ['purpose', 'workspace', 'lot', 'brand']) {
            meta[key] = form.get('metadata[' + key + ']')!;
            assert.equal(meta[key], form.get('payment_intent_data[metadata][' + key + ']'));
          }
          assert.equal(meta.workspace, workspace);
          assert.equal(form.get('client_reference_id'), meta.lot);
          return Response.json(checkout());
        }
        case 'GET /v1/checkout/sessions/' + session: return Response.json(checkout());
        case 'GET /v1/payment_intents/' + payment:
          return Response.json({ id: payment, livemode: false, amount: 1100, amount_received: 1100,
            currency: 'usd', status: 'succeeded', latest_charge: charge, metadata: meta });
        case 'GET /v1/charges/' + charge:
          return Response.json({ id: charge, payment_intent: payment, livemode: false, currency: 'usd', paid: true,
            amount_captured: state.wrongCharge ? 1099 : 1100, amount_refunded: state.refunds ? 550 : 0,
            created: Math.floor(Date.now() / 1000) - 1, disputed: false });
        case 'GET /v1/refunds': return Response.json({ has_more: false, data: state.refunds ? [refundReceipt()] : [] });
        case 'POST /v1/refunds':
          assert.equal(form.get('payment_intent'), payment);
          assert.equal(form.get('amount'), '550');
          state.refunds++;
          return Response.json(refundReceipt());
        case 'GET /v1/refunds/' + refund:
          return Response.json({ ...refundReceipt(), amount: state.wrongRefund ? 551 : 550 });
      }
    }
    if (url.origin === 'https://testflight.tremendous.com') {
      if (method === 'GET' && url.pathname === '/api/v2/products') return Response.json({ products: [
        { id: 'CARD01', name: 'Target fixture', currency_codes: ['USD'], skus: [{ min: 5, max: 5, currency_code: 'USD' }] },
      ] });
      if (method === 'POST' && url.pathname === '/api/v2/orders') {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.payment.funding_source_id, 'BALANCE');
        assert.deepEqual(body.reward.value, { denomination: 5, currency_code: 'USD' });
        assert.deepEqual(body.reward.products, ['CARD01']);
        assert.deepEqual(body.reward.delivery, { method: 'LINK' });
        assert.equal(body.reward.recipient.email, 'gift-' + body.external_id + '@example.invalid');
        state.orders++;
        externalId = body.external_id;
        if (state.loseOrderReply) throw new Error('simulated private diagnostic with reward bearer');
        return Response.json({});
      }
      if (method === 'GET' && url.pathname.startsWith('/api/v2/orders/')) {
        if (!externalId || url.pathname !== '/api/v2/orders/' + externalId) return new Response(null, { status: 404 });
        return Response.json({ order: { id: order, external_id: externalId, status: 'EXECUTED', rewards: [
          { id: reward, order_id: order, delivery: { method: 'LINK', status: 'SUCCEEDED' },
            recipient: { email: 'gift-' + externalId + '@example.invalid' }, value: { currency_code: 'USD', denomination: 5 } },
        ] } });
      }
      if (method === 'POST' && url.pathname === '/api/v2/rewards/' + reward + '/generate_link') {
        state.privateLinks++;
        return Response.json({ reward: { id: reward, link: 'https://testflight.tremendous.com/private-reward' } });
      }
    }
    unexpected.push(method + ' ' + url.origin + url.pathname);
    throw Error('Unimplemented sandbox request');
  };
  return { state, fetch, unexpected };
}

test('the configured gateway resumes the bounded fixture across unpaid, ambiguous and verified receipts', async t => {
  const fixture = await startDatabase();
  t.after(() => fixture.stop());
  const gateway = sandbox();
  const browserFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', gateway.fetch);
  const bindings = { APP_ENV: 'staging', APP_ORIGIN: origin, FLOCKLETTER_STRIPE_TEST_KEY: 'sk_test_fixture',
    FLOCKLETTER_STRIPE_TEST_ACCOUNT: 'acct_fixture', TREMENDOUS_SANDBOX_API_KEY: 'TEST_fixture' };
  const saved = Object.fromEntries(Object.keys(bindings).map(k => [k, process.env[k]]));
  Object.assign(process.env, bindings);
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

  const wrong = new Database(fixture.url, 2);
  try {
    assert.deepEqual(await operateCheckoutProof(wrong, 'advance'), { stage: 'target_blocked' });
  } finally { await wrong.close(); }
  assert.equal(gateway.state.requests, 0);

  // This PostgreSQL cluster is created for this test only. Match the runtime identity
  // instead of introducing a test bypass into the hosted code.
  const adminUrl = new URL(fixture.adminUrl);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.href });
  await admin.connect();
  try {
    await admin.query('ALTER ROLE flockletter_runtime RENAME TO flockletter_staging_runtime');
    await admin.query('ALTER DATABASE flockletter_test RENAME TO flockletter_staging');
  } finally { await admin.end(); }
  const url = new URL(fixture.url);
  url.username = 'flockletter_staging_runtime';
  url.pathname = '/flockletter_staging';
  const db = new Database(url.href, 1);
  try {
    const stage = (s: string) => ({ stage: s });
    const advance = () => operateCheckoutProof(db, 'advance');
    assert.deepEqual(await readCheckoutProofStage(db), stage('not_started'));
    const count = async (w: string) => (await db.read(w, sql => sql.query('SELECT FROM operations'))).rowCount;
    assert.equal(await count(workspace), 0);
    delete process.env.TREMENDOUS_SANDBOX_API_KEY;
    assert.deepEqual(await advance(), stage('configuration_blocked'));
    process.env.TREMENDOUS_SANDBOX_API_KEY = bindings.TREMENDOUS_SANDBOX_API_KEY;
    const stamp = (key: string, kind: string, at = new Date()) => db.tenant(workspace, async sql => {
      await lockWorkspace(sql, workspace);
      await put(sql, workspace, 'signal', key, { kind, at: at.toISOString(), ref: 'test' });
    });
    await stamp(marker + '/lease', 'running');
    assert.deepEqual(await advance(), stage('busy'));
    await stamp(marker + '/lease', 'running', new Date(0));
    await stamp(marker, 'passed');
    assert.deepEqual(await readCheckoutProofStage(db), stage('report_unavailable'));
    gateway.state.wrongAccount = true;
    assert.deepEqual(await advance(), stage('checkout_creation_blocked'));
    assert.equal(gateway.state.creates, 0);
    gateway.state.wrongAccount = false;
    gateway.state.checkoutDenied = true;
    assert.deepEqual(await advance(), stage('checkout_session_write_required'));
    assert.deepEqual(await readCheckoutProofStage(db), stage('checkout_session_write_required'));
    assert.equal(gateway.state.creates, 0);
    gateway.state.checkoutDenied = false;
    for (let i = 0; i < 2; i++) assert.deepEqual(await advance(), stage('awaiting_browser_payment'));
    const app = express(), qa = { userId: 'user_qa', workspaceId: 'org_qa', owner: true };
    const env = { ...bindings, FLOCKLETTER_GIFT_QA_CLERK_USER: 'user_qa', FLOCKLETTER_GIFT_QA_CLERK_ORG: 'org_qa' };
    const config = loadConfig({ ...env, CLERK_PUBLISHABLE_KEY: 'pk_test_fixture' });
    let releaseStartup!: () => void;
    const afterStartup = new Promise<void>(resolve => { releaseStartup = resolve; });
    const startup = installCheckoutProof(app, { db, env, identity: {
      async session(req) { assert.equal(req.get('authorization'), 'Bearer synthetic-session'); return qa; },
      async isOwner() { return qa.owner; },
    } }, config, afterStartup);
    const http = app.listen(0, '127.0.0.1');
    await once(http, 'listening');
    t.after(() => new Promise<void>((resolve, reject) => http.close(err => err ? reject(err) : resolve())));
    const addr = http.address();
    assert(addr && typeof addr === 'object');
    const route = 'http://127.0.0.1:' + addr.port + '/api/staging/gifting/checkout';
    const post = (suffix: string, args: RequestInit = {}) => browserFetch(route + suffix, {
      method: 'POST', headers: { origin, authorization: 'Bearer synthetic-session' }, ...args });
    const beforeRead = gateway.state.requests, rowsBefore = await count(workspace);
    const publicResult = await browserFetch(route);
    assert.equal(publicResult.status, 503);
    assert.deepEqual(await publicResult.json(), stage('awaiting_browser_payment'));
    assert.match(publicResult.headers.get('cache-control')!, /no-store/);
    assert.deepEqual(await readCheckoutProofStage(db), stage('awaiting_browser_payment'));
    const deniedRequests: RequestInit[] = [{ headers: { origin } }, { headers: { authorization: 'Bearer synthetic-session', origin: 'https://other.example' } },
      { headers: { authorization: 'Bearer flk_example', origin } }, { body: '{"workspace":"arbitrary"}' }];
    for (const args of deniedRequests) {
      assert.equal((await post('/link', args)).status, 403);
    }
    qa.userId = 'user_other';
    assert.equal((await post('/link')).status, 403);
    qa.userId = 'user_qa'; qa.workspaceId = 'org_other';
    assert.equal((await post('/advance')).status, 403);
    qa.workspaceId = 'org_qa'; qa.owner = false;
    assert.equal((await post('/link')).status, 403);
    qa.owner = true;
    assert.equal((await post('/link?session=other')).status, 403);
    assert.equal(beforeRead, gateway.state.requests);
    assert.equal(await count(workspace), rowsBefore);
    const privateResult = await post('/link');
    assert.equal(privateResult.status, 200);
    assert.deepEqual(await privateResult.json(), { url: 'https://checkout.stripe.com/c/pay/cs_test_FixturePrivate#private' });
    assert.equal(privateResult.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(await count(workspace), rowsBefore);
    releaseStartup();
    assert.deepEqual(await startup, stage('awaiting_browser_payment'));
    assert.equal(gateway.state.creates, 1);
    assert.equal(gateway.state.orders, 0);
    gateway.state.paid = true;
    gateway.state.wrongCharge = true;
    assert.deepEqual(await advance(), stage('payment_verification_blocked'));
    assert.equal(gateway.state.orders, 0);
    gateway.state.wrongCharge = false;
    assert.deepEqual(await advance(), stage('claim_pending'));
    assert.equal(gateway.state.orders, 1);
    gateway.state.loseOrderReply = false;
    assert.deepEqual(await advance(), stage('refund_blocked'));
    assert.equal(gateway.state.refunds, 1);
    gateway.state.wrongRefund = false;
    assert.deepEqual(await advance(), stage('passed'));
    const completed = gateway.state.requests;
    assert.deepEqual(await advance(), stage('passed'));
    assert.deepEqual(await readCheckoutProofStage(db), stage('passed'));
    assert(gateway.state.requests > completed, 'Replay must retrieve the original provider receipts');
    assert.equal(gateway.state.creates, 1);
    assert.equal(gateway.state.orders, 1);
    assert.equal(gateway.state.refunds, 1);
    assert.equal(gateway.state.privateLinks, 1);
    assert.equal(await count('fixture:gifting:unrelated'), 0);
    assert.deepEqual(gateway.unexpected, []);
    const offers = await db.read(workspace, sql => all(sql, 'offer'));
    assert.deepEqual(offers.map(o => [o.state, o.face]).sort(), [['claimed', 500], ['expired', 500]]);
    const ledger = await db.read(workspace, sql => all(sql, 'entry'));
    assert.deepEqual(Object.fromEntries(ledger.map(e => [e.kind, e.amount])),
      { purchased: 1000, reserved: 1000, claimed: 500, expired: 500, refunded: 550 });
    assert.equal(ledger.length, 5);
    const expiredOffer = offers.find(o => o.state === 'expired')!;
    assert(!expiredOffer.reward && !expiredOffer.order);
    assert.equal(ledger.find(e => e.kind === 'expired')!.at, expiredOffer.expires);
    assert(Date.parse(expiredOffer.expires) - Date.now() > 14 * 86400000);
    gateway.state.wrongRefund = true;
    const failedReplay = await post('/advance');
    assert.deepEqual(await failedReplay.json(), stage('receipt_verification_blocked'));
    assert.equal(gateway.state.refunds, 1);
    assert.equal(gateway.state.orders, 1);
    await db.tenant(workspace, async sql => {
      await lockWorkspace(sql, workspace);
      await put(sql, workspace, 'offer', expiredOffer.id, { ...expiredOffer, state: 'offered' });
    });
    await stamp(marker, 'passed');
    assert.deepEqual(await readCheckoutProofStage(db), stage('report_unavailable'));
    await stamp(marker, 'unpublished internal diagnostic');
    assert.deepEqual(await readCheckoutProofStage(db), stage('report_unavailable'));
  } finally { await db.close(); }
});
