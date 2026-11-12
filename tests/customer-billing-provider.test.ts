import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { expect, it } from 'vitest';
import { stripeCustomerProvider, type ProviderNotice } from '../src/server/customer-billing/provider.js';
import type { CustomerPlan } from '../src/shared/customer-billing.js';

const environment = {
  APP_ENV: 'staging',
  FLOCKLETTER_CUSTOMER_BILLING: 'stripe_test',
  FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT: 'acct_fixture',
  FLOCKLETTER_CUSTOMER_STRIPE_KEY: 'sk_test_SYNTHETIC',
  FLOCKLETTER_CUSTOMER_STRIPE_WEBHOOK: 'whsec_fixture',
  FLOCKLETTER_CUSTOMER_STRIPE_CARD_CONFIG: 'pmc_fixture',
  FLOCKLETTER_CUSTOMER_STRIPE_PORTAL_CONFIG: 'bpc_fixture',
  FLOCKLETTER_CUSTOMER_STARTER_PORTAL_CONFIG:'bpc_starter',
  FLOCKLETTER_CUSTOMER_GROWTH_PORTAL_CONFIG:'bpc_growth',
  FLOCKLETTER_CUSTOMER_PRO_PORTAL_CONFIG:'bpc_pro',
  FLOCKLETTER_CUSTOMER_STARTER_PRICE: 'price_starter',
  FLOCKLETTER_CUSTOMER_GROWTH_PRICE: 'price_growth',
  FLOCKLETTER_CUSTOMER_PRO_PRICE: 'price_pro',
};
const base = 1804777200;
function billingPrice(plan: CustomerPlan) {
  const amounts = { starter: 1500, growth: 2500, pro: 3900 };
  return {
    id: 'price_' + plan,
    active: true,
    livemode: false,
    currency: 'usd',
    unit_amount: amounts[plan],
    unit_amount_decimal: null,
    billing_scheme: 'per_unit',
    metadata: { fl_application: 'flockletter', fl_plan: plan },
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    product: {
      id: 'prod_flockletter',
      active: true,
      livemode: false,
      metadata: { fl_application: 'flockletter' },
    },
  };
}
function billingPortal(plan?: CustomerPlan) {
  return {
    id: plan ? 'bpc_'+plan : 'bpc_fixture', active: true, is_default: false, livemode: false,
    metadata: { fl_application: 'flockletter', ...(plan ? {fl_plan:plan} : {}) },
    default_return_url: 'https://flockletter.example.test/',
    login_page: { enabled: false },
    features: {
      customer_update: { enabled: false },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true, payment_method_configuration: 'pmc_fixture' },
      subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' },
      subscription_pause: { enabled: false },
      subscription_update: {
        enabled: Boolean(plan),
        default_allowed_updates: plan ? ['price'] : [],
        billing_cycle_anchor: 'unchanged', proration_behavior: 'always_invoice',
        trial_update_behavior: 'continue_trial',
        schedule_at_period_end: { conditions: [{ type: 'decreasing_item_amount' }] },
        products: plan ? [{ product: 'prod_flockletter', prices: ['price_'+plan] }] : [],
      },
    },
  };
}
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
          price: { ...billingPrice('growth'), id: price },
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
  const provider = stripeCustomerProvider(
    'https://flockletter.example.test',
    environment,
    () => stripe,
  )!;
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
      return billingPrice('growth');
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
  expect(posted.get('managed_payments[enabled]')).toBe('false');
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
    expect(paid.has('subscription_data[trial_settings][end_behavior][missing_payment_method]')).toBe(
      false,
    );
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
it('collects a card in setup-only Checkout and obtains its fingerprint only from authenticated provider facts', async () => {
  const id = randomUUID(),
    workspace = 'org_fixture';
  let fingerprint = 'synthetic_fingerprint',
    methodCustomer = 'cus_fixture';
  const site = fixture((url, body) => {
    if (url.pathname === '/v1/account') return { id: 'acct_fixture' };
    if (url.pathname === '/v1/checkout/sessions')
      return {
        id: 'cs_setup',
        mode: 'setup',
        livemode: false,
        status: 'open',
        client_reference_id: workspace,
        metadata: { fl_workspace: workspace, fl_intent: body.get('metadata[fl_intent]') },
        url: 'https://checkout.stripe.com/setup',
      };
    if (url.pathname === '/v1/checkout/sessions/cs_setup')
      return {
        id: 'cs_setup',
        mode: 'setup',
        livemode: false,
        status: 'complete',
        client_reference_id: workspace,
        metadata: { fl_workspace: workspace, fl_intent: id },
        setup_intent: 'seti_fixture',
        customer: 'cus_fixture',
      };
    if (url.pathname === '/v1/setup_intents/seti_fixture')
      return {
        id: 'seti_fixture',
        status: 'succeeded',
        livemode: false,
        usage: 'off_session',
        customer: 'cus_fixture',
        metadata: { fl_workspace: workspace, fl_intent: id },
        payment_method: {
          id: 'pm_fixture',
          type: 'card',
          livemode: false,
          customer: methodCustomer,
          card: { fingerprint },
        },
      };
    throw Error('Unexpected request');
  });
  const intent = { id, workspace, plan: 'starter' as const, createdAt: new Date(), reference: null };
  const beforeSetup = Date.now();
  await site.provider.setupCheckout!(intent);
  const afterSetup = Date.now();
  const posted = site.calls.find((c) => c.url.pathname === '/v1/checkout/sessions')!.body;
  expect(posted.get('mode')).toBe('setup');
  expect(posted.get('managed_payments[enabled]')).toBe('false');
  expect(posted.get('currency')).toBe('usd');
  expect(Number(posted.get('expires_at'))).toBeGreaterThanOrEqual(
    Math.floor(beforeSetup / 1000) + 31 * 60,
  );
  expect(Number(posted.get('expires_at'))).toBeLessThanOrEqual(Math.floor(afterSetup / 1000) + 31 * 60);
  const postedCount = site.calls.filter((c) => c.url.pathname === '/v1/checkout/sessions').length;
  await expect(
    site.provider.setupCheckout!({
      ...intent,
      id: randomUUID(),
      createdAt: new Date(Date.now() - 121000),
    }),
  ).rejects.toThrow('could not be verified');
  expect(site.calls.filter((c) => c.url.pathname === '/v1/checkout/sessions')).toHaveLength(postedCount);
  expect(posted.has('line_items[0][price]')).toBe(false);
  expect(posted.has('subscription_data[trial_period_days]')).toBe(false);
  expect(await site.provider.inspectSetup!({ ...intent, reference: 'cs_setup' })).toMatchObject({
    fingerprint: 'synthetic_fingerprint',
    customer: 'cus_fixture',
    paymentMethod: 'pm_fixture',
  });
  fingerprint = '';
  await expect(site.provider.inspectSetup!({ ...intent, reference: 'cs_setup' })).rejects.toThrow(
    'could not be verified',
  );
  fingerprint = 'synthetic';
  methodCustomer = 'cus_wrong';
  await expect(site.provider.inspectSetup!({ ...intent, reference: 'cs_setup' })).rejects.toThrow(
    'could not be verified',
  );
});
it('creates only the approved trial end under an activation idempotency key and reconciles authoritative subscriptions', async () => {
  const id = randomUUID(),
    activationKey = randomUUID(),
    end = new Date((base + 14 * 86400) * 1000);
  const current = {
    ...subscription(),
    status: 'trialing',
    trial_start: base,
    trial_end: base + 14 * 86400,
    metadata: { fl_workspace: 'org_fixture', fl_intent: id, fl_trial_activation: activationKey },
  };
  const site = fixture((url, body) => {
    if (url.pathname === '/v1/account') return { id: 'acct_fixture' };
    if (url.pathname === '/v1/prices/price_growth')
      return { ...current.items.data[0]!.price, active: true };
    if (url.pathname === '/v1/subscriptions' && body.has('customer')) return { id: 'sub_fixture' };
    if (url.pathname === '/v1/subscriptions') return { data: [current], has_more: false };
    if (url.pathname === '/v1/subscriptions/sub_fixture') return current;
    throw Error('Unexpected request');
  });
  const intent = {
    id,
    workspace: 'org_fixture',
    plan: 'growth' as const,
    createdAt: new Date(),
    reference: null,
    customer: 'cus_fixture',
    paymentMethod: 'pm_fixture',
    activationKey,
    trialEnd: end,
  };
  expect(await site.provider.createTrial!(intent)).toMatchObject({ state: 'trialing', trialEnd: end });
  const posted = site.calls.find(
    (c) => c.url.pathname === '/v1/subscriptions' && c.body.has('customer'),
  )!.body;
  expect(posted.get('trial_end')).toBe(String(base + 14 * 86400));
  expect(posted.has('trial_period_days')).toBe(false);
  expect(posted.get('default_payment_method')).toBe('pm_fixture');
  expect(await site.provider.lookupTrial!(intent)).toMatchObject({ id: 'sub_fixture' });
  await expect(
    site.provider.lookupTrial!({ ...intent, trialEnd: new Date(end.getTime() + 1000) }),
  ).rejects.toThrow('could not be verified');
});

it('binds hosted portal sessions to the verified dedicated configuration and rejects changed policy before POST', async () => {
  let portal = billingPortal();
  const site = fixture((url) => {
    if (url.pathname === '/v1/account') return { id: 'acct_fixture' };
    for (const plan of ['starter', 'growth', 'pro'] as const)
      if (url.pathname === '/v1/prices/price_' + plan) return billingPrice(plan);
    if (url.pathname === '/v1/billing_portal/configurations/bpc_fixture') return portal;
    if (url.pathname === '/v1/billing_portal/sessions')
      return { id: 'bps_fixture', url: 'https://billing.stripe.com/p/session_fixture' };
    throw Error('Unexpected request');
  });
  expect(await site.provider.portal('cus_fixture', 'stable_portal_operation')).toBe(
    'https://billing.stripe.com/p/session_fixture',
  );
  const posts = () => site.calls.filter((call) => call.url.pathname === '/v1/billing_portal/sessions');
  expect(posts()).toHaveLength(1);
  expect(posts()[0]!.body.get('configuration')).toBe('bpc_fixture');
  expect(posts()[0]!.body.get('customer')).toBe('cus_fixture');
  expect(posts()[0]!.body.get('return_url')).toBe('https://flockletter.example.test/subscription');
  expect(site.calls.find(call => call.url.pathname.endsWith('/bpc_fixture'))!.url.searchParams.get('expand[0]'))
    .toBe('features.subscription_update.products');
  portal = billingPortal();
  portal.features.subscription_cancel.mode = 'immediately';
  await expect(site.provider.portal('cus_fixture', 'new_portal_operation')).rejects.toThrow(
    'The Flockletter billing provider could not be verified.',
  );
  expect(posts()).toHaveLength(1);
});

it.each(['starter', 'growth', 'pro'] as const)('opens only the selected %s destination profile and refuses a retagged profile', async plan => {
  let portal = billingPortal(plan);
  const site = fixture(url => {
    if (url.pathname === '/v1/account') return {id:'acct_fixture'};
    for (const tier of ['starter','growth','pro'] as const)
      if(url.pathname === '/v1/prices/price_'+tier) return billingPrice(tier);
    if(url.pathname === '/v1/billing_portal/configurations/bpc_'+plan) return portal;
    if(url.pathname === '/v1/subscriptions/sub_fixture') { const current=subscription(); current.items.data[0]!.price=billingPrice(plan==='growth'?'starter':'growth'); return current; }
    if(url.pathname === '/v1/billing_portal/sessions') return {id:'bps_fixture',url:'https://billing.stripe.com/p/review'};
    throw Error('Unexpected provider request');
  });
  expect(await site.provider.portal('cus_fixture','destination_operation',plan,'sub_fixture')).toBe('https://billing.stripe.com/p/review');
  const posts=()=>site.calls.filter(call=>call.url.pathname==='/v1/billing_portal/sessions');
  expect(posts()[0]!.body.get('configuration')).toBe('bpc_'+plan);
  expect(posts()[0]!.body.get('flow_data[type]')).toBe('subscription_update_confirm');
  expect(posts()[0]!.body.get('flow_data[after_completion][redirect][return_url]')).toBe('https://flockletter.example.test/subscription');
  expect(posts()[0]!.body.get('flow_data[subscription_update_confirm][subscription]')).toBe('sub_fixture');
  expect(posts()[0]!.body.get('flow_data[subscription_update_confirm][items][0][id]')).toBe('si_fixture');
  expect(posts()[0]!.body.get('flow_data[subscription_update_confirm][items][0][price]')).toBe('price_'+plan);
  expect(posts()[0]!.body.get('flow_data[subscription_update_confirm][items][0][quantity]')).toBe('1');
  expect(posts()[0]!.body.get('customer')).toBe('cus_fixture');
  expect(posts()[0]!.body.get('return_url')).toBe('https://flockletter.example.test/subscription');
  portal = {...portal,metadata:{fl_application:'flockletter',fl_plan:plan==='starter'?'growth':'starter'}};
  await expect(site.provider.portal('cus_fixture','changed_policy_operation',plan,'sub_fixture')).rejects.toThrow('could not be verified');
  expect(posts()).toHaveLength(1);
});

function subscriptionSchedule(status: 'active' | 'released' = 'active') {
  return {
    id: 'sub_sched_fixture',
    object: 'subscription_schedule',
    livemode: false,
    status,
    customer: 'cus_fixture',
    subscription: status === 'active' ? 'sub_fixture' : null,
    released_subscription: status === 'released' ? 'sub_fixture' : null,
    metadata: { fl_workspace: 'org_wrong', fl_subscription: 'sub_wrong' },
    current_phase: { start_date: base, end_date: base + 30 * 86400 },
    phases: [
      { start_date: base, end_date: base + 30 * 86400, items: [{ price: 'price_growth', quantity: 1 }] },
      { start_date: base + 30 * 86400, end_date: base + 60 * 86400, items: [{ price: 'price_starter', quantity: 1 }] },
    ],
  };
}

it('projects the next renewal downgrade only after retrieving its bound schedule and current catalogue price', async () => {
  let schedule = subscriptionSchedule();
  let nextPrice = billingPrice('starter');
  const site = fixture((url) => {
    if (url.pathname === '/v1/account') return { id: 'acct_fixture' };
    if (url.pathname === '/v1/subscriptions/sub_fixture')
      return { ...subscription(), schedule: 'sub_sched_fixture' };
    if (url.pathname === '/v1/subscription_schedules/sub_sched_fixture') return schedule;
    if (url.pathname === '/v1/prices/price_starter') return nextPrice;
    throw Error('Unexpected request');
  });
  expect(await site.provider.inspectSubscription!('sub_fixture')).toMatchObject({
    plan: 'growth', pendingPlan: 'starter', customer: 'cus_fixture',
  });
  const priceRead = site.calls.find((call) => call.url.pathname === '/v1/prices/price_starter')!;
  expect(priceRead.url.searchParams.get('expand[0]')).toBe('product');
  nextPrice = { ...billingPrice('starter'), product: { ...billingPrice('starter').product, metadata: { fl_application: 'other_application' } } };
  await expect(site.provider.inspectSubscription!('sub_fixture')).rejects.toThrow(
    'The Flockletter billing catalogue could not be verified.',
  );
  nextPrice = billingPrice('starter');
  schedule = { ...subscriptionSchedule(), customer: 'cus_foreign' };
  await expect(site.provider.inspectSubscription!('sub_fixture')).rejects.toThrow(
    'The Flockletter billing schedule could not be verified.',
  );
});

it.each(['updated', 'released'] as const)(
  'resolves a signed schedule %s event through the authoritative subscription reference',
  async (kind) => {
    const eventType = 'subscription_schedule.' + kind;
    const schedule = subscriptionSchedule(kind === 'released' ? 'released' : 'active');
    const event = {
      id: 'evt_schedule', object: 'event', livemode: false, type: eventType,
      data: { object: { id: schedule.id, metadata: { fl_subscription: 'sub_wrong', fl_workspace: 'org_wrong' } } },
    };
    const site = fixture((url) => {
      if (url.pathname === '/v1/account') return { id: 'acct_fixture' };
      if (url.pathname === '/v1/events/evt_schedule') return event;
      if (url.pathname === '/v1/subscription_schedules/sub_sched_fixture') return schedule;
      if (url.pathname === '/v1/subscriptions/sub_fixture')
        return { ...subscription(), schedule: kind === 'released' ? null : schedule.id };
      if (url.pathname === '/v1/prices/price_starter') return billingPrice('starter');
      throw Error('Unexpected request');
    });
    const raw = JSON.stringify(event);
    const signature = site.stripe.webhooks.generateTestHeaderString({ payload: raw, secret: 'whsec_fixture' });
    const notice = site.provider.verify(Buffer.from(raw), signature);
    expect(notice).toMatchObject({ id: 'evt_schedule', kind: eventType, subscription: null, risk: false });
    const resolved = await site.provider.resolve(notice!);
    expect(resolved).toMatchObject({
      checkoutId: null, intentId: null, workspace: null,
      subscription: { id: 'sub_fixture', workspaceHint: 'org_fixture', pendingPlan: kind === 'released' ? null : 'starter' },
    });
    expect(site.calls.some((call) => call.url.pathname === '/v1/subscriptions/sub_wrong')).toBe(false);
  },
);


it.each(['foreign customer','wrong mode','multiple items','unknown price','missing subscription','current plan','attached schedule','past due'] as const)(
  'rejects selected-plan confirmation for %s before issuing a portal session', async reason => {
    const current = { ...subscription(), schedule: null as string | null };
    if(reason==='foreign customer') current.customer='cus_other';
    if(reason==='wrong mode') current.livemode=true;
    if(reason==='multiple items') current.items.data.push({...current.items.data[0]!,id:'si_other'});
    if(reason==='unknown price') current.items.data[0]!.price.id='price_unknown';
    if(reason==='current plan') current.items.data[0]!.price=billingPrice('starter');
    if(reason==='attached schedule') current.schedule='sub_sched_fixture';
    if(reason==='past due') current.status='past_due';
    const site=fixture(url=>{
      if(url.pathname==='/v1/account')return{id:'acct_fixture'};
      for(const tier of ['starter','growth','pro'] as const)
        if(url.pathname==='/v1/prices/price_'+tier)return billingPrice(tier);
      if(url.pathname==='/v1/billing_portal/configurations/bpc_starter')return billingPortal('starter');
      if(url.pathname==='/v1/subscriptions/sub_fixture')return current;
      throw Error('Unexpected provider request');
    });
    await expect(site.provider.portal('cus_fixture','guard_operation','starter',reason==='missing subscription'?undefined:'sub_fixture')).rejects.toThrow('could not be verified');
    expect(site.calls.filter(call=>call.url.pathname==='/v1/billing_portal/sessions')).toHaveLength(0);
  });
