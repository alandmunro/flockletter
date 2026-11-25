import Stripe from 'stripe';
import { z } from 'zod';

export interface StagingGiftProviders {
  account: string;
  checkAccount(): Promise<void>;
  products(): Promise<string[]>;
  payment(run: string, known: string | undefined, fresh: boolean): Promise<string>;
  confirm(run: string, payment: string): Promise<number>;
  order(offer: string, person: number, products: string[]): Promise<{ order: string; reward: string }>;
  rewardLink(reward: string): Promise<string>;
  refund(
    run: string,
    payment: string,
    amount: number,
    fresh: boolean,
  ): Promise<{ id: string; total: number }>;
}
export class GiftProviderError extends Error {}

export function giftProblem(error: unknown): string {
  if (error instanceof GiftProviderError) return error.message;
  if (error instanceof Stripe.errors.StripeError) {
    if (error instanceof Stripe.errors.StripeAuthenticationError) return 'stripe_authentication';
    if (error instanceof Stripe.errors.StripePermissionError) return 'stripe_permission';
    if (error instanceof Stripe.errors.StripeInvalidRequestError) {
      if (error.code === 'parameter_unknown' && error.param === 'allowed_payment_method_types')
        return 'stripe_unknown_allowed_payment_method_types';
      if (error.code === 'resource_missing') return 'stripe_resource_missing';
      return 'stripe_invalid_request';
    }
    if (error instanceof Stripe.errors.StripeConnectionError) return 'stripe_connection';
    if (error instanceof Stripe.errors.StripeIdempotencyError) return 'stripe_idempotency';
    return 'stripe_request_failed';
  }
  if (error instanceof z.ZodError) return 'provider_response_shape';
  return 'provider_verification_incomplete';
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new GiftProviderError(code);
}
const objectId = z.string().regex(/^[A-Z0-9]{4,20}$/);
const orderSchema = z.object({
  order: z.object({
    id: objectId,
    external_id: z.string(),
    status: z.string(),
    rewards: z.array(
      z.object({
        id: objectId,
        order_id: objectId,
        value: z.object({ denomination: z.number(), currency_code: z.string() }),
        recipient: z.object({ email: z.string() }),
        delivery: z.object({ method: z.string(), status: z.string() }),
      }),
    ),
  }),
});
export function giftBindings(env: NodeJS.ProcessEnv) {
  // Existing Flockletter subscription test credentials can serve the same staging account.
  const useBilling = !env.FLOCKLETTER_STRIPE_TEST_KEY && !env.FLOCKLETTER_STRIPE_TEST_ACCOUNT;
  const key = (useBilling ? env.FLOCKLETTER_CUSTOMER_STRIPE_KEY : env.FLOCKLETTER_STRIPE_TEST_KEY) ?? '';
  const account =
    (useBilling ? env.FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT : env.FLOCKLETTER_STRIPE_TEST_ACCOUNT) ?? '';
  const tremendous = env.TREMENDOUS_SANDBOX_API_KEY ?? '';
  const missing = [];
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) missing.push('FLOCKLETTER_STRIPE_TEST_KEY');
  if (!/^acct_[A-Za-z0-9]+$/.test(account)) missing.push('FLOCKLETTER_STRIPE_TEST_ACCOUNT');
  if (!/^TEST_\S+$/.test(tremendous)) missing.push('TREMENDOUS_SANDBOX_API_KEY');
  return { missing, key, account, tremendous };
}
export async function availableGiftProviders(env: NodeJS.ProcessEnv, request: typeof fetch = fetch) {
  const { missing, key, account, tremendous } = giftBindings(env);
  check(env.APP_ENV === 'staging', 'sandbox_configuration');
  const status = { stripe: 'missing', tremendous: 'missing' };
  await Promise.all([
    (async () => {
      if (missing.some((name) => name.startsWith('FLOCKLETTER_STRIPE'))) return;
      try {
        const stripe = new Stripe(key, {
          timeout: 10000,
          maxNetworkRetries: 1,
          httpClient: Stripe.createFetchHttpClient(request),
        });
        status.stripe =
          (await stripe.accounts.retrieveCurrent()).id === account ? 'verified' : 'account_mismatch';
      } catch {
        status.stripe = 'unverified';
      }
    })(),
    (async () => {
      if (missing.includes('TREMENDOUS_SANDBOX_API_KEY')) return;
      try {
        const response = await request(
          'https://testflight.tremendous.com/api/v2/products?country=US&currency=USD',
          {
            headers: { Authorization: 'Bearer ' + tremendous },
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
          },
        );
        status.tremendous =
          response.ok && Array.isArray((await response.json()).products) ? 'verified' : 'unverified';
      } catch {
        status.tremendous = 'unverified';
      }
    })(),
  ]);
  return status;
}
export function stagingGiftProviders(
  env: NodeJS.ProcessEnv,
  request: typeof fetch = fetch,
): StagingGiftProviders {
  const { missing, key, account, tremendous } = giftBindings(env);
  check(env.APP_ENV === 'staging' && !missing.length, 'sandbox_configuration');
  const stripe = new Stripe(key, {
    timeout: 10000,
    maxNetworkRetries: 1,
    httpClient: Stripe.createFetchHttpClient(request),
  });
  async function vendor(path: string, body?: unknown, allowMissing = false) {
    const response = await request('https://testflight.tremendous.com/api/v2' + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + tremendous, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allowMissing && response.status === 404) return null;
    check(response.ok, 'tremendous_http_' + response.status);
    return response.json() as Promise<unknown>;
  }
  function checkPayment(p: Stripe.PaymentIntent, run: string) {
    check(
      !p.livemode && p.amount === 55000 && p.currency === 'usd' && p.metadata.flock_gift_run === run,
      'stripe_payment_mismatch',
    );
  }
  return {
    account,
    async checkAccount() {
      check((await stripe.accounts.retrieveCurrent()).id === account, 'stripe_account_mismatch');
    },
    async products() {
      const { products } = z
        .object({ products: z.array(z.unknown()) })
        .parse(await vendor('/products?country=US&currency=USD'));
      const product = z.object({
        id: objectId,
        name: z.string(),
        currency_codes: z.array(z.string()),
        skus: z.array(z.unknown()),
      });
      const sku = z.object({
        min: z.number(),
        max: z.number(),
        currency_code: z.string().optional(),
      });
      const allowed =
        /^(Starbucks|Amazon|Target|Chipotle|Dunkin|Panera|DoorDash|Uber Eats|Home Depot|Lowe)/i;
      const ids: string[] = [];
      for (const entry of products) {
        const parsed = product.safeParse(entry);
        if (!parsed.success) continue;
        const item = parsed.data;
        if (!allowed.test(item.name) || !item.currency_codes.includes('USD')) continue;
        if (
          item.skus.some((raw) => {
            const price = sku.safeParse(raw).data;
            return (
              price &&
              (price.currency_code === undefined || price.currency_code === 'USD') &&
              price.min <= 5 &&
              price.max >= 5
            );
          })
        )
          ids.push(item.id);
      }
      const selected = [...new Set(ids)].sort().slice(0, 5);
      check(selected.length === 5, 'tremendous_catalog_unavailable');
      return selected;
    },
    async payment(run, known, fresh) {
      if (known) {
        const p = await stripe.paymentIntents.retrieve(known);
        checkPayment(p, run);
        return p.id;
      }
      // A PaymentIntent is created unconfirmed. Never create again after the provider's key window.
      if (!fresh) {
        const found = await stripe.paymentIntents.search({
          query: "metadata['flock_gift_run']:'" + run + "'",
          limit: 2,
        });
        check(!found.has_more && found.data.length === 1, 'stripe_payment_lookup_required');
        const p = found.data[0]!;
        checkPayment(p, run);
        return p.id;
      }
      const p = await stripe.paymentIntents.create(
        {
          amount: 55000,
          currency: 'usd',
          allowed_payment_method_types: ['card'],
          metadata: { flock_gift_run: run },
          description: 'Flockletter staging gift credit',
        },
        { idempotencyKey: run + '-purchase' },
      );
      checkPayment(p, run);
      return p.id;
    },
    async confirm(run, id) {
      let p = await stripe.paymentIntents.retrieve(id);
      checkPayment(p, run);
      if (p.status === 'requires_payment_method' || p.status === 'requires_confirmation') {
        await stripe.paymentIntents.confirm(
          id,
          { payment_method: 'pm_card_visa' },
          { idempotencyKey: run + '-confirm' },
        );
        p = await stripe.paymentIntents.retrieve(id);
        checkPayment(p, run);
      }
      check(
        p.status === 'succeeded' && p.amount_received === 55000 && p.latest_charge,
        'stripe_payment_pending',
      );
      return p.amount_received;
    },
    async order(offer, person, products) {
      const path = '/orders/' + encodeURIComponent(offer),
        email = 'recipient-' + person + '@example.invalid';
      if ((await vendor(path, undefined, true)) === null)
        await vendor('/orders', {
          external_id: offer,
          payment: { funding_source_id: 'BALANCE' },
          reward: {
            value: { denomination: 5, currency_code: 'USD' },
            products,
            recipient: { name: 'Gift fixture ' + person, email },
            delivery: { method: 'LINK' },
          },
        });
      const { order } = orderSchema.parse(await vendor(path));
      check(
        order.external_id === offer && order.status === 'EXECUTED' && order.rewards.length === 1,
        'tremendous_order_pending',
      );
      const [reward] = order.rewards;
      check(
        reward &&
          reward.order_id === order.id &&
          reward.recipient.email === email &&
          reward.value.denomination === 5 &&
          reward.value.currency_code === 'USD' &&
          reward.delivery.method === 'LINK' &&
          reward.delivery.status === 'SUCCEEDED',
        'tremendous_reward_pending',
      );
      return { order: order.id, reward: reward.id };
    },
    async rewardLink(reward) {
      const data = z
        .object({ reward: z.object({ id: objectId, link: z.url() }) })
        .parse(await vendor('/rewards/' + encodeURIComponent(reward) + '/generate_link', {}));
      const url = new URL(data.reward.link);
      check(
        data.reward.id === reward &&
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          (url.hostname === 'testflight.tremendous.com' ||
            url.hostname.endsWith('.testflight.tremendous.com')),
        'tremendous_link_mismatch',
      );
      return url.href;
    },
    async refund(run, payment, amount, fresh) {
      const p = await stripe.paymentIntents.retrieve(payment);
      checkPayment(p, run);
      check(
        p.status === 'succeeded' && p.amount_received === 55000 && typeof p.latest_charge === 'string',
        'stripe_payment_mismatch',
      );
      const existing = await stripe.refunds.list({ payment_intent: payment, limit: 2 });
      check(!existing.has_more && existing.data.length <= 1, 'stripe_refund_review');
      let refund = existing.data[0];
      if (!refund) {
        check(fresh, 'stripe_refund_lookup_required');
        refund = await stripe.refunds.create(
          { payment_intent: payment, amount, metadata: { flock_gift_run: run } },
          { idempotencyKey: run + '-refund' },
        );
      }
      refund = await stripe.refunds.retrieve(refund.id);
      const charge = await stripe.charges.retrieve(p.latest_charge);
      check(
        !charge.livemode &&
          charge.payment_intent === payment &&
          charge.amount_refunded === amount &&
          refund.charge === charge.id &&
          refund.payment_intent === payment &&
          refund.metadata?.flock_gift_run === run &&
          refund.status === 'succeeded' &&
          refund.currency === 'usd' &&
          refund.amount === amount,
        'stripe_refund_unverified',
      );
      return { id: refund.id, total: refund.amount };
    },
  };
}
