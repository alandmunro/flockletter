import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { expect, it } from 'vitest';
import { stripeCustomerProvider, type ProviderNotice } from '../src/server/customer-billing/provider.js';

const environment = {
  APP_ENV: 'staging',
  FLOCKLETTER_CUSTOMER_BILLING: 'stripe_test',
  FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT: 'acct_fixture',
  FLOCKLETTER_CUSTOMER_STRIPE_KEY: 'sk_test_SYNTHETIC',
  FLOCKLETTER_CUSTOMER_STRIPE_WEBHOOK: 'whsec_fixture',
  FLOCKLETTER_CUSTOMER_STRIPE_CARD_CONFIG: 'pmc_fixture',
  FLOCKLETTER_CUSTOMER_STARTER_PRICE: 'price_starter',
  FLOCKLETTER_CUSTOMER_GROWTH_PRICE: 'price_growth',
  FLOCKLETTER_CUSTOMER_PRO_PRICE: 'price_pro',
};
const base = 1804777200;
function subscription(price = 'price_growth', quantity = 1) {
  return {
    id: 'sub_fixture',
    object: 'subscription',
    livemode: false,
    collection_method: 'charge_automatically',
    status: 'active',
    customer: 'cus_fixture',
    metadata: { fl_workspace: 'org_fixture', fl_intent: 'intent_fixture' },
    default_payment_method: { id: 'pm_fixture', type: 'card' },
    latest_invoice: { id: 'in_fixture', status: 'paid' },
    trial_start: null,
    trial_end: null,
    cancel_at: null,
    cancel_at_period_end: false,
    ended_at: null,
    items: {
      object: 'list',
      has_more: false,
      data: [
        {
          id: 'si_fixture',
          quantity,
          current_period_start: base,
          current_period_end: base + 30 * 86400,
          price: {
            id: price,
            livemode: false,
            unit_amount: 2500,
            unit_amount_decimal: '2500',
            currency: 'usd',
            billing_scheme: 'per_unit',
            recurring: {
              interval: 'month',
              interval_count: 1,
              usage_type: 'licensed',
            },
          },
        },
      ],
    },
  };
}
function fixture(respond: (url: URL, body: URLSearchParams) => object) {
  const calls: { url: URL; body: URLSearchParams }[] = [];
  const stripe = new Stripe('sk_test_SYNTHETIC', {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (input, init) => {
      const url = new URL(String(input)),
        body = new URLSearchParams(String(init?.body ?? ''));
      calls.push({ url, body });
      return new Response(JSON.stringify(respond(url, body)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  });
  const provider = stripeCustomerProvider('https://flockletter.example.test', environment, () => stripe)!;
  return { stripe, provider, calls };
}
it('requires complete isolated settings and explicit production activation for live billing', () => {
  expect(stripeCustomerProvider('https://mail.example.test', {})).toBeUndefined();
  expect(() =>
    stripeCustomerProvider('https://mail.example.test', {
      ...environment,
      FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT: '',
    }),
  ).toThrow();
  expect(() =>
    stripeCustomerProvider('https://mail.example.test', {
      ...environment,
      FLOCKLETTER_CUSTOMER_BILLING: 'stripe_live',
      FLOCKLETTER_CUSTOMER_STRIPE_KEY: 'sk_live_SYNTHETIC',
    }),
  ).toThrow();
});
it('creates one provider-held card trial with exact account and catalogue fields through the real SDK', async () => {
  const id = randomUUID(),
    workspace = 'org_fixture';
  const site = fixture((url, body) => {
    if (url.pathname === '/v1/account') return { id: 'acct_fixture' };
    if (url.pathname === '/v1/prices/price_growth')
      return {
        id: 'price_growth',
        active: true,
        livemode: false,
        unit_amount: 2500,
        currency: 'usd',
        recurring: { interval: 'month', interval_count: 1 },
      };
    if (url.pathname === '/v1/checkout/sessions')
      return {
        id: 'cs_test_fixture',
        mode: 'subscription',
        livemode: false,
        status: 'open',
        client_reference_id: workspace,
        metadata: {
          fl_intent: body.get('metadata[fl_intent]'),
          fl_workspace: workspace,
          fl_rejoin_of: body.get('metadata[fl_rejoin_of]') ?? undefined,
          fl_rejoin_revision: body.get('metadata[fl_rejoin_revision]') ?? undefined,
        },
        customer: body.get('customer'),
        url: 'https://checkout.stripe.com/c/test',
      };
    throw Error('Unexpected SDK request');
  });
  expect(
    await site.provider.checkout({
      id,
      workspace,
      plan: 'growth',
      createdAt: new Date(),
      reference: null,
      trialDays: 14,
    }),
  ).toMatchObject({ id: 'cs_test_fixture' });
  const posted = site.calls.find((c) => c.url.pathname === '/v1/checkout/sessions')!.body;
  expect(posted.get('payment_method_collection')).toBe('always');
  expect(posted.get('payment_method_configuration')).toBe('pmc_fixture');
  expect(posted.get('subscription_data[trial_period_days]')).toBe('14');
  expect(posted.get('subscription_data[trial_settings][end_behavior][missing_payment_method]')).toBe(
    'cancel',
  );
  expect(posted.has('payment_method_types[0]')).toBe(false);
  for (const trialDays of [0, undefined] as const) {
    await site.provider.checkout({
      id: randomUUID(),
      workspace,
      plan: 'growth',
      createdAt: new Date(),
      reference: null,
      trialDays,
    });
    const paid = site.calls.filter((call) => call.url.pathname === '/v1/checkout/sessions').at(-1)!.body;
    expect(paid.has('subscription_data[trial_period_days]')).toBe(false);
    expect(paid.has('subscription_data[trial_settings][end_behavior][missing_payment_method]')).toBe(false);
    expect(paid.get('payment_method_collection')).toBe('always');
    expect(paid.get('line_items[0][price]')).toBe('price_growth');
  }
  await site.provider.checkout({
    id: randomUUID(),
    workspace,
    plan: 'growth',
    createdAt: new Date(),
    reference: null,
    trialDays: 0,
    customer: 'cus_existing',
    previousSubscription: 'sub_ended',
    previousRevision: 7,
  });
  const rejoin = site.calls.filter((call) => call.url.pathname === '/v1/checkout/sessions').at(-1)!.body;
  expect(rejoin.get('customer')).toBe('cus_existing');
  expect(rejoin.get('subscription_data[metadata][fl_rejoin_of]')).toBe('sub_ended');
  expect(rejoin.get('subscription_data[metadata][fl_rejoin_revision]')).toBe('7');
  expect(rejoin.has('subscription_data[trial_period_days]')).toBe(false);
});
it('checks signatures and mode before resolving a webhook', () => {
  const site = fixture(() => {
    throw Error('No network needed');
  });
  const raw = JSON.stringify({
    id: 'evt_fixture',
    object: 'event',
    livemode: false,
    type: 'invoice.payment_failed',
    data: { object: { id: 'in_fixture' } },
  });
  const signature = site.stripe.webhooks.generateTestHeaderString({
    payload: raw,
    secret: 'whsec_fixture',
  });
  expect(site.provider.verify(Buffer.from(raw), signature)).toMatchObject({
    id: 'evt_fixture',
    kind: 'invoice.payment_failed',
  });
  expect(() => site.provider.verify(Buffer.from(raw), 'invalid')).toThrow();
  const live = raw.replace('"livemode":false', '"livemode":true');
  expect(() =>
    site.provider.verify(
      Buffer.from(live),
      site.stripe.webhooks.generateTestHeaderString({
        payload: live,
        secret: 'whsec_fixture',
      }),
    ),
  ).toThrow();
  expect(site.calls).toHaveLength(0);
});
it('reads the current single allowed subscription item and rejects quantity or foreign prices', async () => {
  let current = subscription();
  const site = fixture((url) => {
    if (url.pathname === '/v1/account') return { id: 'acct_fixture' };
    if (url.pathname === '/v1/subscriptions/sub_fixture') return current;
    throw Error('Unexpected request');
  });
  const notice: ProviderNotice = {
    id: 'evt_current',
    kind: 'customer.subscription.updated',
    checkout: null,
    subscription: 'sub_fixture',
    risk: false,
  };
  expect((await site.provider.resolve(notice)).subscription).toMatchObject({
    state: 'active',
    plan: 'growth',
    customer: 'cus_fixture',
  });
  current = subscription('price_growth', 2);
  await expect(site.provider.resolve(notice)).rejects.toThrow();
  current = subscription('price_foreign');
  await expect(site.provider.resolve(notice)).rejects.toThrow();
});
it('resolves a dispute through its charge, invoice payment and subscription instead of charge metadata', async () => {
  const site = fixture((url) => {
    const path = url.pathname;
    if (path === '/v1/account') return { id: 'acct_fixture' };
    if (path === '/v1/events/evt_risk')
      return {
        id: 'evt_risk',
        livemode: false,
        type: 'charge.dispute.created',
        data: { object: { id: 'dp_fixture', charge: 'ch_fixture' } },
      };
    if (path === '/v1/charges/ch_fixture')
      return {
        id: 'ch_fixture',
        livemode: false,
        payment_intent: 'pi_fixture',
        metadata: { fl_workspace: 'org_wrong' },
      };
    if (path === '/v1/invoice_payments')
      return {
        object: 'list',
        has_more: false,
        data: [{ id: 'inpay_fixture', invoice: 'in_fixture' }],
      };
    if (path === '/v1/invoices/in_fixture')
      return {
        id: 'in_fixture',
        livemode: false,
        parent: { subscription_details: { subscription: 'sub_fixture' } },
      };
    if (path === '/v1/subscriptions/sub_fixture') return subscription();
    throw Error('Unexpected request');
  });
  const result = await site.provider.resolve({
    id: 'evt_risk',
    kind: 'charge.dispute.created',
    checkout: null,
    subscription: null,
    risk: true,
  });
  expect(result.subscription).toMatchObject({
    id: 'sub_fixture',
    workspaceHint: 'org_fixture',
  });
  expect(
    site.calls
      .find((c) => c.url.pathname === '/v1/invoice_payments')
      ?.url.searchParams.get('payment[payment_intent]'),
  ).toBe('pi_fixture');
});
