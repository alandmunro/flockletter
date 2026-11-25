import Stripe from 'stripe';
import { z } from 'zod';
import { AppError, requireCondition } from '../errors.js';
import { giftBindings } from '../gifting-providers.js';
import type { Config } from '../config.js';
import type { GiftCampaign, GiftOffer, Lot } from './store.js';

const purpose = 'flockletter_workspace_gift_v1';
export interface GiftGateway {
  account: string;
  checkout(w: string, lot: Lot): Promise<{ id: string; url: string | null; expired: boolean }>;
  payment(w: string, lot: Lot): Promise<{ payment: string; charge: string; paidAt: string } | null>;
  refund(w: string, lot: Lot, amount: number): Promise<{ id: string; amount: number }>;
  products(face: number): Promise<{ id: string; name: string }[]>;
  order(o: GiftOffer, c: GiftCampaign): Promise<{ order: string; reward: string }>;
  link(reward: string): Promise<string>;
}
const product = z.object({
  id: z.string().regex(/^[A-Z0-9]{4,20}$/),
  name: z.string().min(1),
  currency_codes: z.array(z.string()),
  skus: z.array(z.unknown()),
});
const sku = z.object({ min: z.number(), max: z.number(), currency_code: z.string().optional() });
const obj = z.string().regex(/^[A-Z0-9]{4,20}$/);
const orderResult = z.object({
  order: z.object({
    id: obj,
    external_id: z.string(),
    status: z.string(),
    rewards: z.array(
      z.object({
        id: obj,
        order_id: obj,
        recipient: z.object({ email: z.string() }),
        delivery: z.object({ method: z.string(), status: z.string() }),
        value: z.object({ currency_code: z.string(), denomination: z.number() }),
      }),
    ),
  }),
});
function verify(ok: unknown): asserts ok {
  requireCondition(ok, 503, 'gift_provider_mismatch', 'The provider receipt requires reconciliation.');
}
export class WorkspaceGiftProvider implements GiftGateway {
  private stripe: Stripe;
  constructor(
    private key: string,
    readonly account: string,
    private tremendous: string,
    readonly live: boolean,
    private origin: string,
    private request: typeof fetch = fetch,
  ) {
    verify(
      (live ? /^(rk|sk)_live_[a-zA-Z0-9]+$/ : /^(rk|sk)_test_[a-zA-Z0-9]+$/).test(key) &&
        /^acct_[A-Za-z0-9]+$/.test(account),
    );
    verify(live ? /^PROD_\S+$/.test(tremendous) : /^TEST_\S+$/.test(tremendous));
    this.stripe = new Stripe(key, {
      timeout: 10000,
      maxNetworkRetries: 1,
      httpClient: Stripe.createFetchHttpClient(request),
    });
  }
  static configured(config: Pick<Config, 'environment' | 'origin'>, env: NodeJS.ProcessEnv = process.env) {
    if (config.environment === 'staging' && env.APP_ENV === 'staging') {
      const b = giftBindings(env);
      return b.missing.length
        ? null
        : new WorkspaceGiftProvider(b.key, b.account, b.tremendous, false, config.origin);
    }
    if (
      config.environment === 'production' &&
      env.APP_ENV === 'production' &&
      env.FLOCKLETTER_WORKSPACE_GIFTS === 'live'
    )
      return new WorkspaceGiftProvider(
        env.FLOCKLETTER_GIFT_STRIPE_KEY ?? '',
        env.FLOCKLETTER_GIFT_STRIPE_ACCOUNT ?? '',
        env.FLOCKLETTER_GIFT_TREMENDOUS_KEY ?? '',
        true,
        config.origin,
      );
    return null;
  }
  private async accountCheck() {
    verify((await this.stripe.accounts.retrieveCurrent()).id === this.account);
  }
  private metadata(w: string, l: Lot) {
    return { purpose, workspace: w, lot: l.id, brand: l.brand };
  }
  private match(meta: Stripe.Metadata | null, w: string, l: Lot) {
    const expected = this.metadata(w, l);
    return Object.entries(expected).every(([k, v]) => meta?.[k] === v);
  }
  async checkout(w: string, l: Lot) {
    await this.accountCheck();
    verify(l.account === this.account);
    let s: Stripe.Checkout.Session;
    if (l.session) s = await this.stripe.checkout.sessions.retrieve(l.session);
    else {
      // Never replay an uncertain creation after Stripe's idempotency retention.
      requireCondition(
        Date.now() - Date.parse(l.created) < 23 * 3600000,
        409,
        'gift_checkout_review',
        'The checkout needs provider reconciliation.',
      );
      const meta = this.metadata(w, l);
      s = await this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          allowed_payment_method_types: ['card'],
          client_reference_id: l.id,
          metadata: meta,
          payment_intent_data: { metadata: meta, description: 'Flockletter workspace gift credit' },
          managed_payments: { enabled: false },
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: 'usd',
                unit_amount: l.total,
                product_data: { name: 'Flockletter gift credit and 10% purchase fee' },
              },
            },
          ],
          success_url: this.origin + '/?gifts=1&purchase=' + l.id + '&brand=' + l.brand,
          cancel_url: this.origin + '/?gifts=1&brand=' + l.brand,
        },
        { idempotencyKey: 'fl-gift-checkout-' + l.id },
      );
    }
    verify(
      s.livemode === this.live &&
        s.client_reference_id === l.id &&
        this.match(s.metadata, w, l) &&
        s.amount_total === l.total &&
        s.currency === 'usd' &&
        s.mode === 'payment',
    );
    if (s.url) {
      const u = new URL(s.url);
      verify(u.protocol === 'https:' && u.hostname === 'checkout.stripe.com' && !u.username && !u.password);
    }
    return { id: s.id, url: s.url, expired: s.status === 'expired' };
  }
  async payment(w: string, l: Lot) {
    await this.accountCheck();
    verify(l.account === this.account && l.session);
    const s = await this.stripe.checkout.sessions.retrieve(l.session);
    verify(
      s.livemode === this.live &&
        s.mode === 'payment' &&
        s.client_reference_id === l.id &&
        this.match(s.metadata, w, l) &&
        s.amount_total === l.total &&
        s.currency === 'usd',
    );
    if (s.payment_status !== 'paid') return null;
    verify(s.status === 'complete' && typeof s.payment_intent === 'string');
    const p = await this.stripe.paymentIntents.retrieve(s.payment_intent);
    verify(
      p.livemode === this.live &&
        this.match(p.metadata, w, l) &&
        p.amount === l.total &&
        p.amount_received === l.total &&
        p.currency === 'usd' &&
        p.status === 'succeeded' &&
        typeof p.latest_charge === 'string',
    );
    const charge = await this.stripe.charges.retrieve(p.latest_charge);
    verify(
      charge.livemode === this.live &&
        charge.payment_intent === p.id &&
        charge.paid &&
        charge.amount_captured === l.total &&
        charge.currency === 'usd' &&
        !charge.disputed &&
        !charge.amount_refunded,
    );
    return { payment: p.id, charge: charge.id, paidAt: new Date(charge.created * 1000).toISOString() };
  }
  async refund(w: string, l: Lot, amount: number) {
    await this.accountCheck();
    verify(l.account === this.account && l.payment && l.charge && amount > 0 && l.refundStarted);
    const p = await this.stripe.paymentIntents.retrieve(l.payment);
    verify(
      p.livemode === this.live &&
        this.match(p.metadata, w, l) &&
        p.latest_charge === l.charge &&
        p.amount_received === l.total &&
        p.currency === 'usd',
    );
    const list = await this.stripe.refunds.list({ payment_intent: p.id, limit: 2 });
    verify(!list.has_more && list.data.length <= 1);
    let ref = list.data[0];
    if (!ref) {
      verify(Date.now() - Date.parse(l.refundStarted) < 23 * 3600000);
      ref = await this.stripe.refunds.create(
        { payment_intent: p.id, amount, metadata: this.metadata(w, l) },
        { idempotencyKey: 'fl-gift-close-' + l.id },
      );
    }
    const settled = await this.stripe.refunds.retrieve(ref.id),
      ch = await this.stripe.charges.retrieve(l.charge);
    verify(
      settled.amount === amount &&
        settled.currency === 'usd' &&
        settled.status === 'succeeded' &&
        settled.charge === l.charge &&
        settled.payment_intent === p.id &&
        this.match(settled.metadata, w, l) &&
        ch.livemode === this.live &&
        ch.amount_refunded === amount,
    );
    return { id: settled.id, amount: settled.amount };
  }
  private async vendor(path: string, body?: unknown, missing = false) {
    const host = this.live ? 'https://api.tremendous.com' : 'https://testflight.tremendous.com';
    const response = await this.request(host + '/api/v2' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + this.tremendous, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok)
      throw new AppError(
        503,
        response.status === 402 ? 'gift_vendor_funding' : 'gift_vendor_unavailable',
        'The rewards provider needs reconciliation.',
      );
    return response.json() as Promise<unknown>;
  }
  async products(face: number) {
    const { products } = z
      .object({ products: z.array(z.unknown()) })
      .parse(await this.vendor('/products?country=US&currency=USD'));
    const found = new Map<string, { id: string; name: string }>();
    for (const raw of products) {
      const p = product.safeParse(raw).data;
      if (
        !p ||
        !p.currency_codes.includes('USD') ||
        !p.skus.some((raw) => {
          const v = sku.safeParse(raw).data;
          return (
            v &&
            (!v.currency_code || v.currency_code === 'USD') &&
            Math.round(v.min * 100) <= face &&
            Math.round(v.max * 100) >= face
          );
        })
      )
        continue;
      // Gift cards only. Exclude cash transfers and prepaid debit instruments.
      if (
        /^(Starbucks|Amazon|Target|Chipotle|Dunkin|Panera|DoorDash|Uber Eats|Home Depot|Lowe)/i.test(p.name)
      )
        found.set(p.id, { id: p.id, name: p.name });
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  async order(o: GiftOffer, c: GiftCampaign) {
    const path = '/orders/' + encodeURIComponent(o.id),
      email = 'gift-' + o.id + '@example.invalid';
    if ((await this.vendor(path, undefined, true)) === null)
      await this.vendor('/orders', {
        external_id: o.id,
        payment: { funding_source_id: 'BALANCE' },
        reward: {
          value: { denomination: o.face / 100, currency_code: 'USD' },
          products: c.products,
          recipient: { name: 'Gift recipient', email },
          delivery: { method: 'LINK' },
        },
      });
    const { order } = orderResult.parse(await this.vendor(path));
    requireCondition(
      order.status === 'EXECUTED',
      503,
      'gift_vendor_review',
      'Your gift is awaiting provider confirmation.',
    );
    const reward = order.rewards[0];
    verify(
      order.external_id === o.id &&
        order.rewards.length === 1 &&
        reward &&
        reward.order_id === order.id &&
        reward.delivery.method === 'LINK' &&
        reward.delivery.status === 'SUCCEEDED' &&
        reward.recipient.email === email &&
        reward.value.currency_code === 'USD' &&
        Math.round(reward.value.denomination * 100) === o.face,
    );
    return { order: order.id, reward: reward.id };
  }
  async link(id: string) {
    const { reward } = z
      .object({ reward: z.object({ id: obj, link: z.url() }) })
      .parse(await this.vendor('/rewards/' + encodeURIComponent(id) + '/generate_link', {}));
    const u = new URL(reward.link);
    const hosts = this.live
      ? ['www.tremendous.com', 'tremendous.com', 'rewards.tremendous.com']
      : ['testflight.tremendous.com'];
    verify(
      reward.id === id && u.protocol === 'https:' && !u.username && !u.password && hosts.includes(u.hostname),
    );
    return u.href;
  }
  signedEvent(raw: Buffer, signature: string, secret: string) {
    requireCondition(
      /^whsec_/.test(secret),
      503,
      'gift_webhook_unconfigured',
      'Gift event verification is unavailable.',
    );
    let e: Stripe.Event;
    try {
      e = this.stripe.webhooks.constructEvent(raw, signature, secret);
    } catch {
      throw new AppError(403, 'signature_rejected', 'Invalid gift event signature.');
    }
    verify(e.livemode === this.live && (!e.account || e.account === this.account));
    return e;
  }
  async dispute(id: string) {
    await this.accountCheck();
    const d = await this.stripe.disputes.retrieve(id);
    verify(d.livemode === this.live && typeof d.charge === 'string' && typeof d.payment_intent === 'string');
    const p = await this.stripe.paymentIntents.retrieve(d.payment_intent);
    if (p.metadata.purpose !== purpose) return null;
    verify(
      p.livemode === this.live &&
        p.latest_charge === d.charge &&
        p.currency === 'usd' &&
        d.currency === 'usd' &&
        Number.isSafeInteger(d.amount) &&
        d.amount > 0 &&
        d.amount <= p.amount_received,
    );
    return {
      id: d.id,
      workspace: p.metadata.workspace!,
      lot: p.metadata.lot!,
      charge: d.charge,
      payment: p.id,
      amount: d.amount,
      state: d.status,
      opened: new Date(d.created * 1000).toISOString(),
    };
  }
  async submitEvidence(id: string, summary: string) {
    await this.stripe.disputes.update(
      id,
      { evidence: { uncategorized_text: summary }, submit: true },
      { idempotencyKey: 'fl-gift-evidence-' + id },
    );
  }
}
