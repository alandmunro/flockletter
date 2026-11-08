import Stripe from 'stripe';
import { plans } from '../../shared/contracts.js';
import type { CustomerBillingState, CustomerPlan } from '../../shared/customer-billing.js';

export type ProviderIntent = {
  id: string;
  workspace: string;
  plan: CustomerPlan;
  createdAt: Date;
  reference: string | null;
  trialDays?: 0 | 14;
  customer?: string;
  previousSubscription?: string;
  previousRevision?: number;
};
export type ProviderNotice = {
  id: string;
  kind: string;
  checkout: string | null;
  subscription: string | null;
  risk: boolean;
};
export type ProviderSubscription = {
  workspaceHint: string | null;
  intentHint: string | null;
  id: string;
  customer: string;
  state: CustomerBillingState;
  plan: CustomerPlan;
  cardVerified: boolean;
  trialStart: Date | null;
  trialEnd: Date | null;
  periodStart: Date;
  periodEnd: Date;
  cancelAt: Date | null;
  endedAt: Date | null;
  failedSince: Date | null;
  previousSubscription?: string | null;
  previousRevision?: string | null;
};
export type CustomerBillingProvider = {
  account: string;
  live: boolean;
  checkout(intent: ProviderIntent): Promise<ProviderCheckout>;
  lookupCheckout(intent: ProviderIntent): Promise<ProviderCheckout | null>;
  inspectSubscription?(id: string): Promise<ProviderSubscription>;
  portal(customer: string, key: string): Promise<string>;
  verify(raw: Buffer, signature: string): ProviderNotice | null;
  resolve(notice: ProviderNotice): Promise<{
    subscription: ProviderSubscription | null;
    checkoutId: string | null;
    intentId: string | null;
    workspace: string | null;
  }>;
  close(): void;
};
export type ProviderCheckout = {
  id: string;
  url: string | null;
  state?: 'open' | 'complete' | 'expired';
  customer?: string | null;
  subscription?: string | null;
};
const invalid = () => Error('The Flockletter billing provider could not be verified.');
const reference = (v: string | { id: string } | null | undefined) =>
  typeof v === 'string' ? v : (v?.id ?? null);
const date = (n: number | null | undefined) => (n ? new Date(n * 1000) : null);
function resourceId(value: unknown) {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string')
    throw invalid();
  return value.id;
}
const acceptedEvents = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.dispute.created',
  'charge.refunded',
  'radar.early_fraud_warning.created',
]);
/** Public readiness only. No account IDs, keys, prices or secret values leave this function. */
export function customerBillingConfiguration(env: NodeJS.ProcessEnv) {
  const mode = env.FLOCKLETTER_CUSTOMER_BILLING ?? 'off';
  const required = [
    'FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT',
    'FLOCKLETTER_CUSTOMER_STRIPE_KEY',
    'FLOCKLETTER_CUSTOMER_STRIPE_WEBHOOK',
    'FLOCKLETTER_CUSTOMER_STRIPE_CARD_CONFIG',
    'FLOCKLETTER_CUSTOMER_STARTER_PRICE',
    'FLOCKLETTER_CUSTOMER_GROWTH_PRICE',
    'FLOCKLETTER_CUSTOMER_PRO_PRICE',
  ];
  const missing = mode.startsWith('stripe_') ? required.filter((name) => !env[name]) : [];
  if (mode === 'stripe_live' && env.FLOCKLETTER_LIVE_BILLING_APPROVED !== 'true')
    missing.push('FLOCKLETTER_LIVE_BILLING_APPROVED');
  return {
    mode,
    enabled: mode === 'stripe_test' || mode === 'stripe_live',
    exercise: mode === 'exercise' && env.APP_ENV !== 'production',
    missing,
    readiness:
      mode === 'off'
        ? 'disabled'
        : mode === 'exercise'
          ? 'captured_only'
          : missing.length
            ? 'configuration_required'
            : 'provider_verification_required',
  };
}
export function stripeCustomerProvider(
  origin: string,
  env: NodeJS.ProcessEnv,
  clientFactory?: (key: string) => Stripe,
): CustomerBillingProvider | undefined {
  const mode = env.FLOCKLETTER_CUSTOMER_BILLING ?? 'off';
  if (['off', 'exercise'].includes(mode)) return;
  const live = mode === 'stripe_live',
    account = env.FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT ?? '',
    key = env.FLOCKLETTER_CUSTOMER_STRIPE_KEY ?? '',
    webhook = env.FLOCKLETTER_CUSTOMER_STRIPE_WEBHOOK ?? '',
    card = env.FLOCKLETTER_CUSTOMER_STRIPE_CARD_CONFIG ?? '';
  const prices: Record<CustomerPlan, string> = {
    starter: env.FLOCKLETTER_CUSTOMER_STARTER_PRICE ?? '',
    growth: env.FLOCKLETTER_CUSTOMER_GROWTH_PRICE ?? '',
    pro: env.FLOCKLETTER_CUSTOMER_PRO_PRICE ?? '',
  };
  if (
    !['stripe_test', 'stripe_live'].includes(mode) ||
    !/^acct_[A-Za-z0-9]+$/.test(account) ||
    !new RegExp('^(sk|rk)_' + (live ? 'live' : 'test') + '_[A-Za-z0-9]+$').test(key) ||
    !webhook.startsWith('whsec_') ||
    !/^pmc_[A-Za-z0-9]+$/.test(card) ||
    !Object.values(prices).every((v) => /^price_[A-Za-z0-9]+$/.test(v)) ||
    new Set(Object.values(prices)).size !== 3 ||
    new URL(origin).origin !== origin ||
    !origin.startsWith('https://') ||
    (live && (env.APP_ENV !== 'production' || env.FLOCKLETTER_LIVE_BILLING_APPROVED !== 'true'))
  )
    throw invalid();
  const stripe = clientFactory
    ? clientFactory(key)
    : new Stripe(key, { maxNetworkRetries: 0, timeout: 7000 });
  async function accountCheck() {
    if ((await stripe.accounts.retrieveCurrent()).id !== account) throw invalid();
  }
  function planFor(item: Stripe.SubscriptionItem) {
    const p = item.price,
      plan = plans.find((plan) => prices[plan.id] === p.id);
    if (
      !plan ||
      p.livemode !== live ||
      item.quantity !== 1 ||
      p.currency !== 'usd' ||
      p.unit_amount !== plan.priceMinor ||
      p.billing_scheme !== 'per_unit' ||
      p.recurring?.interval !== 'month' ||
      p.recurring.interval_count !== 1 ||
      p.recurring.usage_type !== 'licensed' ||
      (p.unit_amount_decimal !== null &&
        !new RegExp('^' + plan.priceMinor + '(?:\\.0+)?$').test(p.unit_amount_decimal.toString()))
    )
      throw invalid();
    return plan.id;
  }
  async function snapshot(id: string): Promise<ProviderSubscription> {
    const s = await stripe.subscriptions.retrieve(id, {
      expand: ['default_payment_method', 'latest_invoice'],
    });
    if (
      s.livemode !== live ||
      s.items.has_more ||
      s.items.data.length !== 1 ||
      s.collection_method !== 'charge_automatically'
    )
      throw invalid();
    const item = s.items.data[0]!,
      plan = planFor(item),
      customer = reference(s.customer);
    if (!customer) throw invalid();
    let payment = s.default_payment_method;
    if (!payment) {
      const c = await stripe.customers.retrieve(customer, {
        expand: ['invoice_settings.default_payment_method'],
      });
      if (!c.deleted) payment = c.invoice_settings.default_payment_method;
    }
    const cardVerified = typeof payment === 'object' && payment !== null && payment.type === 'card';
    const invoice = typeof s.latest_invoice === 'object' ? s.latest_invoice : null;
    let state: CustomerBillingState = 'preparation';
    if (s.status === 'trialing' && cardVerified) state = 'trialing';
    if (s.status === 'active' && invoice?.status === 'paid') state = 'active';
    if (s.status === 'past_due') state = 'past_due';
    if (s.status === 'unpaid' || s.status === 'paused') state = 'suspended';
    if (s.status === 'canceled' || s.status === 'incomplete_expired') state = 'canceled';
    return {
      id: s.id,
      customer,
      state,
      plan,
      cardVerified,
      workspaceHint: s.metadata.fl_workspace ?? null,
      intentHint: s.metadata.fl_intent ?? null,
      trialStart: date(s.trial_start),
      trialEnd: date(s.trial_end),
      periodStart: new Date(item.current_period_start * 1000),
      periodEnd: new Date(item.current_period_end * 1000),
      cancelAt:
        date(s.cancel_at) ?? (s.cancel_at_period_end ? new Date(item.current_period_end * 1000) : null),
      endedAt: date(s.ended_at),
      failedSince: state === 'past_due' ? date(invoice?.created) : null,
      previousSubscription: s.metadata.fl_rejoin_of ?? null,
      previousRevision: s.metadata.fl_rejoin_revision ?? null,
    };
  }
  async function checkoutProjection(
    s: Stripe.Checkout.Session,
    intent: ProviderIntent,
  ): Promise<ProviderCheckout> {
    if (
      s.livemode !== live ||
      s.mode !== 'subscription' ||
      s.client_reference_id !== intent.workspace ||
      s.metadata?.fl_intent !== intent.id ||
      s.metadata?.fl_workspace !== intent.workspace ||
      (intent.customer && reference(s.customer) !== intent.customer) ||
      (intent.previousSubscription &&
        (s.metadata?.fl_rejoin_of !== intent.previousSubscription ||
          s.metadata?.fl_rejoin_revision !== String(intent.previousRevision)))
    )
      throw invalid();
    const state =
      s.status === 'open'
        ? 'open'
        : s.status === 'complete'
          ? 'complete'
          : s.status === 'expired'
            ? 'expired'
            : null;
    if (!state) throw invalid();
    return {
      id: s.id,
      url: state === 'open' ? s.url : null,
      state,
      customer: reference(s.customer),
      subscription: reference(s.subscription),
    };
  }
  return {
    account,
    live,
    async inspectSubscription(id) {
      await accountCheck();
      return snapshot(id);
    },
    async checkout(intent) {
      await accountCheck();
      const price = await stripe.prices.retrieve(prices[intent.plan]),
        plan = plans.find((p) => p.id === intent.plan)!;
      if (
        !price.active ||
        price.livemode !== live ||
        price.unit_amount !== plan.priceMinor ||
        price.currency !== 'usd' ||
        price.recurring?.interval !== 'month' ||
        price.recurring.interval_count !== 1
      )
        throw invalid();
      const metadata = {
        fl_intent: intent.id,
        fl_workspace: intent.workspace,
        ...(intent.previousSubscription
          ? {
              fl_rejoin_of: intent.previousSubscription,
              fl_rejoin_revision: String(intent.previousRevision),
            }
          : {}),
      };
      const result = await stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          client_reference_id: intent.workspace,
          metadata,
          ...(intent.customer ? { customer: intent.customer } : {}),
          payment_method_collection: 'always',
          payment_method_configuration: card,
          line_items: [{ price: price.id, quantity: 1 }],
          subscription_data: {
            metadata,
            ...(intent.trialDays === 14
              ? {
                  trial_period_days: 14,
                  trial_settings: { end_behavior: { missing_payment_method: 'cancel' as const } },
                }
              : {}),
          },
          success_url: origin + '/?billing=returned',
          cancel_url: origin + '/?billing=cancelled',
          integration_identifier:
            'flockletter_' +
            intent.id
              .replaceAll('-', '')
              .slice(0, 8)
              .replace(/[0-9a-f]/g, (v) => String.fromCharCode(97 + parseInt(v, 16))),
        },
        { idempotencyKey: 'flockletter-customer-checkout-' + intent.id },
      );
      return checkoutProjection(result, intent);
    },
    async lookupCheckout(intent) {
      await accountCheck();
      if (intent.reference)
        return checkoutProjection(await stripe.checkout.sessions.retrieve(intent.reference), intent);
      let starting_after: string | undefined;
      for (let page = 0; page < 5; page++) {
        const items = await stripe.checkout.sessions.list({
          limit: 100,
          created: { gte: Math.floor(intent.createdAt.getTime() / 1000) - 60 },
          starting_after,
        });
        const matches = items.data.filter((s) => s.metadata?.fl_intent === intent.id);
        if (matches.length > 1) throw invalid();
        if (matches[0]) return checkoutProjection(matches[0], intent);
        if (!items.has_more) return null;
        starting_after = items.data.at(-1)?.id;
        if (!starting_after) return null;
      }
      return null;
    },
    async portal(customer, key) {
      await accountCheck();
      const result = await stripe.billingPortal.sessions.create(
        { customer, return_url: origin + '/' },
        { idempotencyKey: 'flockletter-customer-portal-' + key },
      );
      if (new URL(result.url).origin !== 'https://billing.stripe.com') throw invalid();
      return result.url;
    },
    verify(raw, signature) {
      const event = stripe.webhooks.constructEvent(raw, signature, webhook);
      if (event.livemode !== live || (event.account && event.account !== account)) throw invalid();
      if (!acceptedEvents.has(event.type)) return null;
      const id = resourceId(event.data.object);
      return {
        id: event.id,
        kind: event.type,
        checkout: event.type.startsWith('checkout.session.') ? id : null,
        subscription: event.type.startsWith('customer.subscription.') ? id : null,
        risk: ['charge.dispute.created', 'charge.refunded', 'radar.early_fraud_warning.created'].includes(
          event.type,
        ),
      };
    },
    async resolve(notice) {
      await accountCheck();
      if (notice.checkout) {
        const s = await stripe.checkout.sessions.retrieve(notice.checkout);
        if (s.livemode !== live || s.mode !== 'subscription') throw invalid();
        const subscription = reference(s.subscription),
          observed = subscription ? await snapshot(subscription) : null;
        if (
          observed &&
          (observed.customer !== reference(s.customer) ||
            observed.workspaceHint !== s.client_reference_id ||
            observed.workspaceHint !== s.metadata?.fl_workspace ||
            observed.intentHint !== s.metadata?.fl_intent ||
            observed.previousSubscription !== (s.metadata?.fl_rejoin_of ?? null) ||
            observed.previousRevision !== (s.metadata?.fl_rejoin_revision ?? null))
        )
          throw invalid();
        return {
          subscription: observed,
          checkoutId: s.id,
          intentId: s.metadata?.fl_intent ?? null,
          workspace: s.client_reference_id ?? null,
        };
      }
      let subscription = notice.subscription;
      if (!subscription) {
        const event = await stripe.events.retrieve(notice.id);
        if (
          event.id !== notice.id ||
          event.type !== notice.kind ||
          event.livemode !== live ||
          (event.account && event.account !== account)
        )
          throw invalid();
        const object = event.data.object,
          id = resourceId(object);
        let invoice: Stripe.Invoice | null = null;
        if (event.type.startsWith('invoice.')) invoice = await stripe.invoices.retrieve(id);
        if (notice.risk) {
          let chargeId: string | null = null;
          if (event.type === 'charge.dispute.created')
            chargeId = reference((object as Stripe.Dispute).charge);
          if (event.type === 'charge.refunded') chargeId = id;
          if (event.type === 'radar.early_fraud_warning.created')
            chargeId = reference((object as Stripe.Radar.EarlyFraudWarning).charge);
          if (chargeId) {
            const charge = await stripe.charges.retrieve(chargeId),
              paymentIntent = reference(charge.payment_intent);
            if (charge.livemode !== live) throw invalid();
            if (paymentIntent) {
              const matches = await stripe.invoicePayments.list({
                limit: 2,
                payment: {
                  type: 'payment_intent',
                  payment_intent: paymentIntent,
                },
              });
              if (!matches.has_more && matches.data.length === 1)
                invoice = await stripe.invoices.retrieve(reference(matches.data[0]!.invoice)!);
            }
          }
        }
        if (invoice) {
          if (invoice.livemode !== live) throw invalid();
          subscription = reference(invoice.parent?.subscription_details?.subscription);
        }
      }
      return {
        subscription: subscription ? await snapshot(subscription) : null,
        checkoutId: null,
        intentId: null,
        workspace: null,
      };
    },
    close() {
      /* Stripe owns no persistent connection in this adapter. */
    },
  };
}
