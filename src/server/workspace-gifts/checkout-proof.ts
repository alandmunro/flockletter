import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import Stripe from 'stripe';
import type { CustomerWorkflows } from '../customer-runtime.js';
import type { Config } from '../config.js';
import { giftBindings } from '../gifting-providers.js';
import { writeSync } from 'node:fs';
import { z } from 'zod';
import type { Database } from '../db.js';
import { verifyRuntimeBoundary } from '../runtime-boundary.mjs';
import type { Actor } from '../service.js';
import { lockWorkspace } from '../workspace-lock.js';
import { WorkspaceGiftProvider } from './provider.js';
import { WorkspaceGifts } from './service.js';
import { all, one, put } from './store.js';

const origin = 'https://flockletter-staging.onrender.com';
const workspaceId = 'fixture:gifting:checkout:v1';
const brandId = 'acb2798b-36b7-4ae4-b41f-740b9de62133';
const personId = 'ae44c147-765b-4862-8941-d62dae451e27';
const expiryPersonId = '1458fdcf-86d6-4bf7-b98e-89bc74167417';
const purchaseKey = '727b08dc-b1c1-4e1a-8c24-dd9882abf170';
// The canonical gifts.purchase ID for the frozen workspace, brand and purchase key.
const lotId = '30993927-5391-5004-8124-7990eec53e19';
const campaignId = '4149c145-2a43-44fd-b239-f15b0faf460e';
const owner: Actor = {
  workspaceId, userId: 'checkout-proof', actorId: 'fixture:checkout-proof',
  kind: 'session', owner: true, scopes: [], brandIds: [brandId],
};
const stageSchema = z.enum([
  'not_started', 'target_blocked', 'configuration_blocked', 'busy', 'fixture_blocked',
  'checkout_creation_blocked', 'checkout_session_write_required', 'awaiting_browser_payment', 'checkout_expired',
  'payment_verification_blocked', 'catalog_blocked', 'launch_blocked', 'claim_blocked',
  'claim_pending', 'claim_expired', 'expiry_blocked', 'receipt_verification_blocked', 'refund_blocked', 'ledger_blocked', 'passed',
  'private_terminal_required', 'private_link_unavailable', 'private_link_displayed',
  'report_unavailable', 'invalid_command',
]);
export type CheckoutProofStage = z.infer<typeof stageSchema>;
const report = (stage: CheckoutProofStage) => ({ stage });
const staging = () => process.env.APP_ENV === 'staging' && process.env.APP_ORIGIN === origin;
const marker = 'workspace-gifts:checkout-proof:v1';

function check(condition: unknown): asserts condition {
  if (!condition) throw new Error('Checkout proof condition failed.');
}

/** Safe GET integration. Only reads the last operator result. No SDK, setup, timers or writes. */
export async function readCheckoutProofStage(db: Database) {
  if (!staging()) return report('target_blocked');
  try {
    const row = await db.read(workspaceId, sql => one(sql, 'signal', marker));
    const stage = row ? stageSchema.safeParse(row.kind).data ?? 'report_unavailable' : 'not_started';
    if (stage === 'passed') {
      const facts = await snapshot(db, giftBindings(process.env).account);
      verifiedLedger(facts);
    }
    return report(stage);
  } catch {
    return report('report_unavailable');
  }
}

async function prepareFixture(db: Database) {
  await db.brand(workspaceId, brandId, async sql => {
    await lockWorkspace(sql, workspaceId);
    const added = await sql.query(
      'INSERT INTO workspaces(workspace_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [workspaceId, marker],
    );
    if (added.rowCount) {
      await sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [workspaceId, brandId, marker]);
      for (const [id, email] of [[personId, 'claim@example.invalid'], [expiryPersonId, 'expiry@example.invalid']]) {
        await sql.query(`INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state,confirmed_at)
          VALUES($1,$2,$3,$4,'confirmed',now())`, [workspaceId, brandId, id, email]);
        await sql.query(`INSERT INTO subscriber_consent_events(workspace_id,brand_id,id,subscriber_id,event,
          purpose,policy_version,text_digest,source,source_domain) VALUES($1,$2,gen_random_uuid(),$3,'confirmed',
          'gift_fixture','gift-fixture-v1',encode(sha256('Synthetic gift audience fixture'),'hex'),
          'customer-exercise-confirmation','example.invalid')`, [workspaceId, brandId, id]);
      }
      // Exercise onboarding projections only. This never registers a business with a carrier.
      await sql.query(`WITH carrier AS (
        INSERT INTO sms_carrier_brands(workspace_id,id,company_id,legal_name,entity_type,profile,help_contact,created_by)
        SELECT workspace_id,gen_random_uuid(),company_id,'Checkout fixture','private_profit',
          '{"vertical":"RETAIL","onboarding":{"probation":{"state":"active"}}}','fixture@example.invalid',
          'fixture:gifting:audience:v1' FROM company_brands WHERE workspace_id=$1 AND brand_id=$2 RETURNING id
        ) INSERT INTO sms_registrations(workspace_id,id,carrier_brand_id,state)
        SELECT $1,gen_random_uuid(),id,'approved' FROM carrier`, [workspaceId, brandId]);
    }
    check((await sql.query(`SELECT FROM workspaces w JOIN brands b USING(workspace_id)
      JOIN subscribers s ON (s.workspace_id,s.brand_id)=(b.workspace_id,b.id)
      WHERE w.workspace_id=$1 AND w.name=$4 AND b.id=$2 AND b.name=$4 AND s.state='confirmed'
      AND ((s.id=$3 AND s.email_normalized='claim@example.invalid') OR (s.id=$5 AND s.email_normalized='expiry@example.invalid'))`,
    [workspaceId, brandId, personId, marker, expiryPersonId])).rowCount === 2);
  });
}

async function snapshot(db: Database, account: string) {
  return db.read(workspaceId, async sql => {
    const lots = await all(sql, 'lot'), campaigns = await all(sql, 'campaign'), offers = await all(sql, 'offer');
    // close acts on the whole tenant. Refuse unexpected objects even in this reserved namespace.
    check(lots.length <= 1 && lots.every(l => l.id === lotId && l.brand === brandId && l.account === account
      && l.face === 1000 && l.fee === 100 && l.total === 1100 && !l.disputed && !l.lost));
    check(campaigns.length <= 1 && campaigns.every(c => c.id === campaignId && c.brand === brandId && c.face === 500));
    check(offers.length === campaigns.length * 2 && new Set(offers.map(o => o.person)).size === offers.length && offers.every(o => o.campaign === campaignId && [personId, expiryPersonId].includes(o.person)
      && o.brand === brandId && o.face === 500 && o.alloc.length === 1 && o.alloc[0]?.id === lotId && o.alloc[0].amount === 500));
    return { lot: lots[0], campaign: campaigns[0], offer: offers.find(o => o.person === personId), expiry: offers.find(o => o.person === expiryPersonId),
      entries: await all(sql, 'entry'), closed: !!await one(sql, 'closure', 'closed') };
  });
}

function verifyCheckoutUrl(raw: unknown, session: string | undefined) {
  check(typeof raw === 'string' && session && /^cs_test_[A-Za-z0-9]+$/.test(session));
  const url = new URL(raw);
  check(url.origin === 'https://checkout.stripe.com' && !url.username && !url.password &&
    url.pathname === '/c/pay/' + session);
  return url.href;
}

async function run(db: Database, provider: WorkspaceGiftProvider, setBlocker: (s: CheckoutProofStage) => void): Promise<CheckoutProofStage> {
  setBlocker('fixture_blocked');
  await prepareFixture(db);
  const initial = await snapshot(db, provider.account);
  // Only this fixed fixture gets this policy and a per-instance clock for the second offer.
  const options = { live: false, waitMs: 0, monthlyCap: 1000 };
  const gifts = new WorkspaceGifts(db, provider, options);
  if (!initial.closed) {
    setBlocker('checkout_creation_blocked');
    const purchase = await gifts.execute('gifts.purchase', { brandId, operationKey: purchaseKey, face: 1000 }, owner)
      .catch((error: unknown) => {
        if (error instanceof Stripe.errors.StripePermissionError && /\bcheckout_session_write\b/i.test(error.message))
          setBlocker('checkout_session_write_required');
        throw error;
      });
    check('id' in purchase && purchase.id === lotId);
    setBlocker('payment_verification_blocked');
    const payment = await gifts.execute('gifts.reconcile', { brandId, operationKey: purchaseKey, purchaseId: lotId }, owner);
    check('state' in payment);
    if (payment.state === 'expired') return 'checkout_expired';
    if (payment.state === 'checkout') {
      const lot = await db.read(workspaceId, sql => one(sql, 'lot', lotId));
      check(!lot?.payment && !lot?.spent && !lot?.reserved && 'url' in purchase);
      verifyCheckoutUrl(purchase.url, lot?.session);
      return 'awaiting_browser_payment';
    }
    check(payment.state === 'funded');
    if (!initial.campaign) {
      setBlocker('catalog_blocked');
      const catalog = await gifts.execute('gifts.catalog', { brandId, face: 500 }, owner);
      const product = 'products' in catalog && catalog.products?.[0];
      check(product);
      setBlocker('launch_blocked');
      await gifts.execute('gifts.launch', { brandId, operationKey: campaignId, title: 'Checkout proof',
        days: 15, products: [product.id], face: 500, personIds: [personId, expiryPersonId], brokerConfirmed: false }, owner);
    }
    const reserved = await snapshot(db, provider.account);
    check(reserved.lot && reserved.offer && reserved.expiry && reserved.entries.some(e =>
      e.kind === 'reserved' && e.amount === 1000 && e.ref === campaignId));
    if (reserved.offer.state !== 'claimed' && reserved.expiry.state !== 'expired')
      check(reserved.lot.reserved === 1000 && reserved.lot.spent === 0);
    setBlocker('claim_blocked');
    if (initial.offer?.state === 'expired') return 'claim_expired';
    const link = await gifts.execute('gifts.link', { brandId, campaignId, personId }, owner);
    check('path' in link);
    const params = new URLSearchParams(new URL(link.path, origin).hash.slice(1));
    const offer = params.get('offer'), token = params.get('token');
    check(params.get('workspace') === workspaceId && offer && token);
    const claim = await gifts.recipient(workspaceId, offer, token, true);
    if (claim.state === 'pending') return 'claim_pending';
    if (claim.state === 'expired') return 'claim_expired';
    check(claim.state === 'claimed' && claim.face === 500 && claim.rewardUrl &&
      new URL(claim.rewardUrl).origin === 'https://testflight.tremendous.com');
    setBlocker('expiry_blocked');
    const atExpiry = new WorkspaceGifts(db, provider, { ...options, clock: () => new Date(reserved.expiry!.expires) });
    const expired = await atExpiry.recipient(workspaceId, reserved.expiry.id, reserved.expiry.secret, false);
    check(expired.state === 'expired' && !expired.rewardUrl);

  }
  setBlocker('refund_blocked');
  const beforeClose = await snapshot(db, provider.account);
  check(beforeClose.offer?.state === 'claimed' && beforeClose.expiry?.state === 'expired' &&
    !beforeClose.expiry.order && !beforeClose.expiry.reward && beforeClose.lot?.spent === 500 && beforeClose.lot.reserved === 0 &&
    beforeClose.entries.some(e => e.kind === 'expired' && e.amount === 500 && e.ref === beforeClose.expiry?.id));
  if (beforeClose.lot.state !== 'refunded') {
    if (!beforeClose.closed) {
      const released = await gifts.execute('gifts.status', { brandId }, owner);
      check('available' in released && released.available === 500 && released.reserved === 0 && released.spent === 500);
    }
    await gifts.execute('gifts.close', { brandId, operationKey: campaignId }, owner);
  }
  setBlocker('ledger_blocked');
  const settled = verifiedLedger(await snapshot(db, provider.account));
  setBlocker('receipt_verification_blocked');
  await verifyOriginalReceipts(settled, provider.account);
  return 'passed';
}

function verifiedLedger(facts: Awaited<ReturnType<typeof snapshot>>) {
  const { closed, lot, offer, expiry, entries } = facts;
  check(closed && lot?.state === 'refunded' && lot.spent === 500 && lot.reserved === 0 && lot.returned === 550 &&
    lot.session && lot.payment && lot.charge && lot.refundId && lot.paidAt &&
    offer?.state === 'claimed' && offer.order && offer.reward && offer.claimedAt &&
    expiry?.state === 'expired' && !expiry.order && !expiry.reward && !expiry.claimedAt);
  const expected = new Map([
    ['purchased', [lotId, 1000]], ['reserved', [campaignId, 1000]], ['claimed', [offer.id, 500]],
    ['expired', [expiry.id, 500]], ['refunded', [lotId, 550]],
  ] as const);
  for (const e of entries) {
    const match = [...expected].find(([kind]) => kind === e.kind);
    check(match && e.brand === brandId && e.ref === match[1][0] && e.amount === match[1][1]);
    expected.delete(match[0]);
  }
  check(expected.size === 0);
  return { session: lot.session, payment: lot.payment, charge: lot.charge, refund: lot.refundId,
    claimed: offer.id, order: offer.order, reward: offer.reward, expired: expiry.id };
}

// Verification after a refund cannot use the unrefunded-payment verifier. Read the exact original
// IDs, including the absence of an order for the expired recipient. Never invoke create-or-recover here.
async function verifyOriginalReceipts(r: ReturnType<typeof verifiedLedger>, account: string) {
  const bindings = giftBindings(process.env);
  check(!bindings.missing.length && bindings.account === account);
  const stripe = new Stripe(bindings.key, { timeout: 10000, maxNetworkRetries: 0, httpClient: Stripe.createFetchHttpClient(fetch) });
  const matches = (m: Stripe.Metadata | null) => m?.purpose === 'flockletter_workspace_gift_v1' &&
    m.workspace === workspaceId && m.brand === brandId && m.lot === lotId;
  check((await stripe.accounts.retrieveCurrent()).id === account);
  const session = await stripe.checkout.sessions.retrieve(r.session);
  check(session.id === r.session && session.livemode === false && session.mode === 'payment' && session.status === 'complete' &&
    session.payment_status === 'paid' && session.payment_intent === r.payment && session.currency === 'usd' &&
    session.amount_total === 1100 && session.client_reference_id === lotId && matches(session.metadata));
  const pi = await stripe.paymentIntents.retrieve(r.payment);
  check(pi.id === r.payment && pi.livemode === false && pi.currency === 'usd' && pi.amount === 1100 && pi.amount_received === 1100 &&
    pi.status === 'succeeded' && pi.latest_charge === r.charge && matches(pi.metadata));
  const charge = await stripe.charges.retrieve(r.charge);
  check(charge.id === r.charge && charge.livemode === false && charge.paid && !charge.disputed && charge.currency === 'usd' &&
    charge.amount_captured === 1100 && charge.amount_refunded === 550 && charge.payment_intent === r.payment);
  const refund = await stripe.refunds.retrieve(r.refund);
  check(refund.id === r.refund && refund.payment_intent === r.payment && refund.charge === r.charge &&
    refund.currency === 'usd' && refund.amount === 550 && refund.status === 'succeeded' && matches(refund.metadata));
  const lookup = (id: string) => fetch('https://testflight.tremendous.com/api/v2/orders/' + encodeURIComponent(id),
    { headers: { Authorization: 'Bearer ' + bindings.tremendous }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  const found = await lookup(r.claimed);
  check(found.ok);
  const { order } = await found.json();
  check(order.id === r.order && order.status === 'EXECUTED' && order.external_id === r.claimed && order.rewards.length === 1);
  const [reward] = order.rewards;
  check(reward.id === r.reward && reward.order_id === r.order && reward.value.currency_code === 'USD' &&
    reward.value.denomination === 5 && reward.delivery.method === 'LINK' && reward.delivery.status === 'SUCCEEDED' &&
    reward.recipient.email === 'gift-' + r.claimed + '@example.invalid');
  check((await lookup(r.expired)).status === 404);
}

async function verifyTarget(db: Database) {
  check(staging());
  await verifyRuntimeBoundary(db.pool, { database: 'flockletter_staging', role: 'flockletter_staging_runtime' });
  check((await db.pool.query('SELECT public.flockletter_restore_blocked() AS blocked')).rows[0]?.blocked === false);
}

async function checkoutLink(db: Database) {
  await verifyTarget(db);
  const provider = WorkspaceGiftProvider.configured({ environment: 'staging', origin });
  check(provider && !provider.live);
  const { lot } = await snapshot(db, provider.account);
  check(lot?.state === 'checkout' && lot.session);
  const checkout = await provider.checkout(workspaceId, lot);
  check(!checkout.expired && checkout.id === lot.session);
  return verifyCheckoutUrl(checkout.url, lot.session);
}

// The lease and result each have one stable journal key. A transaction holds the workspace
// lock only while reading/appending the next revision. A crashed runner releases after 15 minutes.
async function advance(db: Database) {
  await verifyTarget(db);
  const lease = marker + '/lease', attempt = randomUUID();
  const started = await db.tenant(workspaceId, async sql => {
    await lockWorkspace(sql, workspaceId);
    const prior = await one(sql, 'signal', lease);
    const now: Date = (await sql.query('SELECT clock_timestamp() AS now')).rows[0].now;
    if (prior?.kind === 'running' && now.getTime() < Date.parse(prior.at) + 15 * 60000) return false;
    await put(sql, workspaceId, 'signal', lease, { kind: 'running', at: now.toISOString(), ref: attempt });
    return true;
  });
  if (!started) return report('busy');
  let stage: CheckoutProofStage = 'configuration_blocked';
  try {
    const provider = WorkspaceGiftProvider.configured({ environment: 'staging', origin });
    check(provider && !provider.live);
    stage = await run(db, provider, s => { stage = s; });
  } catch { /* Return only the allowlisted stage. Never propagate a provider response. */ }
  return db.tenant(workspaceId, async sql => {
    await lockWorkspace(sql, workspaceId);
    if ((await one(sql, 'signal', lease))?.ref !== attempt) return report('busy');
    const at = new Date().toISOString();
    if ((await one(sql, 'signal', marker))?.kind !== stage)
      await put(sql, workspaceId, 'signal', marker, { kind: stage, at, ref: marker });
    await put(sql, workspaceId, 'signal', lease, { kind: 'finished', at, ref: attempt });
    return report(stage);
  });
}

export async function operateCheckoutProof(db: Database, action: 'advance' | 'checkout-link') {
  try {
    if (!staging()) return report('target_blocked');
    if (action === 'advance') return await advance(db);
    if (action !== 'checkout-link') return report('invalid_command');
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY || process.env.CI)
      return report('private_terminal_required');
    writeSync(process.stdout.fd, await checkoutLink(db) + '\n');
    return report('private_link_displayed');
  } catch { return report(action === 'advance' ? 'target_blocked' : 'private_link_unavailable'); }
}

const route = '/api/staging/gifting/checkout';
type ProofCustomer = Pick<CustomerWorkflows, 'db' | 'env' | 'identity'>;

/** Mount once in staging. Await the returned promise inside a background startup sequence if needed. */
export function installCheckoutProof(app: Express, customer: ProofCustomer | undefined, config: Config, afterStartup?: Promise<unknown>) {
  if (!customer || config.environment !== 'staging' || config.localIdentity || config.origin !== origin ||
    customer.env.APP_ENV !== 'staging' || !staging()) return;
  const { db, identity, env } = customer;
  const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'Vary': 'Authorization' };
  app.get(route, async (_req, res) => {
    const result = await readCheckoutProofStage(db);
    res.set(headers).status(result.stage === 'passed' ? 200 : 503).json(result);
  });
  for (const action of ['link', 'advance'] as const) app.post(route + '/' + action, async (req, res) => {
    res.set(headers);
    const user = env.FLOCKLETTER_GIFT_QA_CLERK_USER, org = env.FLOCKLETTER_GIFT_QA_CLERK_ORG;
    try {
      check(config.clerkPublishableKey?.startsWith('pk_test_') && /^user_[A-Za-z0-9]+$/.test(user ?? '') &&
        /^org_[A-Za-z0-9]+$/.test(org ?? '') && req.get('origin') === origin &&
        req.get('sec-fetch-site') !== 'cross-site' && /^Bearer (?!flk_)\S{1,8000}$/.test(req.get('authorization') ?? '') &&
        !req.originalUrl.includes('?') && (!req.get('content-length') || req.get('content-length') === '0') && !req.get('transfer-encoding'));
      const session = await identity.session(req);
      check(session.userId === user && session.workspaceId === org && await identity.isOwner(session.userId, session.workspaceId));
    } catch { res.status(403).json(report('private_link_unavailable')); return; }
    try {
      if (action === 'link') res.json({ url: await checkoutLink(db) });
      else res.json(await operateCheckoutProof(db, 'advance'));
    } catch { res.status(409).json(report('private_link_unavailable')); }
  });
  const start = () => operateCheckoutProof(db, 'advance');
  return Promise.resolve(afterStartup).then(start, start);
}
