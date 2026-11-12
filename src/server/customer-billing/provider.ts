import Stripe from 'stripe';
import { plans } from '../../shared/contracts.js';
import type { CustomerBillingState, CustomerPlan } from '../../shared/customer-billing.js';
import { billingPortalMatches, billingProviderEvents, readBillingCatalogue, readBillingPrice, type BillingInspectionTarget } from './configuration-inspection.js';
import { scheduledDowngradePlan } from './scheduled-plan.js';

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
export type ProviderSetupProof = {
  checkout: string;
  setupIntent: string;
  customer: string;
  paymentMethod: string;
  fingerprint: string;
};
export type ProviderTrialActivation = ProviderIntent & {
  customer: string;
  paymentMethod: string;
  activationKey: string;
  trialEnd: Date;
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
  pendingPlan?: CustomerPlan | null;
};
export type CustomerBillingProvider = {
  account: string;
  live: boolean;
  checkout(intent: ProviderIntent): Promise<ProviderCheckout>;
  lookupCheckout(intent: ProviderIntent): Promise<ProviderCheckout | null>;
  setupCheckout?(intent: ProviderIntent): Promise<ProviderCheckout>;
  /** Null means an exhaustive authenticated account lookup found no setup; incomplete search must throw. */
  lookupSetupCheckout?(intent: ProviderIntent): Promise<ProviderCheckout | null>;
  inspectSetup?(intent: ProviderIntent): Promise<ProviderSetupProof | null>;
  createTrial?(intent: ProviderTrialActivation): Promise<ProviderSubscription>;
  lookupTrial?(intent: ProviderTrialActivation): Promise<ProviderSubscription | null>;
  inspectSubscription?(id: string): Promise<ProviderSubscription>;
  portal(customer: string, key: string, plan?: CustomerPlan, subscription?: string): Promise<string>;
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
const acceptedEvents = new Set<string>(billingProviderEvents);
/** Public readiness only. No account IDs, keys, prices or secret values leave this function. */
export function customerBillingConfiguration(env: NodeJS.ProcessEnv) {
  const mode = env.FLOCKLETTER_CUSTOMER_BILLING ?? 'off';
  const required = [
    'FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT',
    'FLOCKLETTER_CUSTOMER_STRIPE_KEY',
    'FLOCKLETTER_CUSTOMER_STRIPE_WEBHOOK',
    'FLOCKLETTER_CUSTOMER_STRIPE_CARD_CONFIG',
    'FLOCKLETTER_CUSTOMER_STRIPE_PORTAL_CONFIG',
    'FLOCKLETTER_CUSTOMER_STARTER_PORTAL_CONFIG',
    'FLOCKLETTER_CUSTOMER_GROWTH_PORTAL_CONFIG',
    'FLOCKLETTER_CUSTOMER_PRO_PORTAL_CONFIG',
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
    card = env.FLOCKLETTER_CUSTOMER_STRIPE_CARD_CONFIG ?? '',
    portalConfiguration = env.FLOCKLETTER_CUSTOMER_STRIPE_PORTAL_CONFIG ?? '';
  const prices: Record<CustomerPlan, string> = {
    starter: env.FLOCKLETTER_CUSTOMER_STARTER_PRICE ?? '',
    growth: env.FLOCKLETTER_CUSTOMER_GROWTH_PRICE ?? '',
    pro: env.FLOCKLETTER_CUSTOMER_PRO_PRICE ?? '',
  };
  const planPortalConfigurations: Record<CustomerPlan, string> = {
    starter: env.FLOCKLETTER_CUSTOMER_STARTER_PORTAL_CONFIG ?? '',
    growth: env.FLOCKLETTER_CUSTOMER_GROWTH_PORTAL_CONFIG ?? '',
    pro: env.FLOCKLETTER_CUSTOMER_PRO_PORTAL_CONFIG ?? '',
  };
  if (
    !['stripe_test', 'stripe_live'].includes(mode) ||
    !/^acct_[A-Za-z0-9]+$/.test(account) ||
    !new RegExp('^(sk|rk)_' + (live ? 'live' : 'test') + '_[A-Za-z0-9]+$').test(key) ||
    !webhook.startsWith('whsec_') ||
    !/^pmc_[A-Za-z0-9]+$/.test(card) ||
    !/^bpc_[A-Za-z0-9]+$/.test(portalConfiguration) ||
    !Object.values(planPortalConfigurations).every(id => /^bpc_[A-Za-z0-9]+$/.test(id)) ||
    new Set([portalConfiguration, ...Object.values(planPortalConfigurations)]).size !== 4 ||
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
  const inspectionTarget: BillingInspectionTarget = { account, live, origin, prices, cardConfiguration: card, portalConfiguration, planPortalConfigurations };
  async function accountCheck() {
    if ((await stripe.accounts.retrieveCurrent()).id !== account) throw invalid();
  }
  function planFor(item: Pick<Stripe.SubscriptionItem, 'price' | 'quantity'>) {
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
    let pendingPlan: CustomerPlan | null = null;
    const scheduleId = reference(s.schedule);
    if (scheduleId) {
      const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
      pendingPlan = scheduledDowngradePlan(schedule, {
        scheduleId, subscriptionId: s.id, customerId: customer, live, currentPlan: plan, prices,
        periodStart: item.current_period_start, periodEnd: item.current_period_end,
      });
      if (pendingPlan) {
        const nextPrice = await readBillingPrice(stripe, inspectionTarget, pendingPlan);
        if (!nextPrice.active || planFor({ price: nextPrice, quantity: 1 }) !== pendingPlan) throw invalid();
      }
    }
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
      pendingPlan,
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
  async function setupProjection(
    s: Stripe.Checkout.Session,
    intent: ProviderIntent,
  ): Promise<ProviderCheckout> {
    if (
      s.livemode !== live ||
      s.mode !== 'setup' ||
      s.client_reference_id !== intent.workspace ||
      s.metadata?.fl_intent !== intent.id ||
      s.metadata?.fl_workspace !== intent.workspace ||
      !['open', 'complete', 'expired'].includes(s.status ?? '')
    )
      throw invalid();
    return {
      id: s.id,
      state: s.status as 'open' | 'complete' | 'expired',
      url: s.status === 'open' ? s.url : null,
      customer: reference(s.customer),
    };
  }
  async function lookupSetup(intent: ProviderIntent) {
    if (intent.reference)
      return setupProjection(await stripe.checkout.sessions.retrieve(intent.reference), intent);
    let starting_after: string | undefined;
    for (let page = 0; page < 5; page++) {
      const list = await stripe.checkout.sessions.list({
        limit: 100,
        created: { gte: Math.floor(intent.createdAt.getTime() / 1000) - 60 },
        starting_after,
      });
      const matches = list.data.filter((s) => s.metadata?.fl_intent === intent.id);
      if (matches.length > 1) throw invalid();
      if (matches[0]) return setupProjection(matches[0], intent);
      if (!list.has_more) return null;
      starting_after = list.data.at(-1)?.id;
      if (!starting_after) return null;
    }
    throw invalid();
  }
  async function verifyTrial(s: ProviderSubscription, intent: ProviderTrialActivation) {
    if (
      s.workspaceHint !== intent.workspace ||
      s.intentHint !== intent.id ||
      s.customer !== intent.customer ||
      s.plan !== intent.plan ||
      !s.cardVerified ||
      s.trialEnd?.getTime() !== intent.trialEnd.getTime()
    )
      throw invalid();
    return s;
  }
  return {
    account,
    live,
    async setupCheckout(intent) {
      await accountCheck();
      const metadata = { fl_workspace: intent.workspace, fl_intent: intent.id };
      const requestTime = Date.now(),
        age = requestTime - intent.createdAt.getTime();
      // Stripe requires >=30 minutes from actual creation, not from our earlier durable intent.
      // A fresh 31-minute session plus at most two minutes of preparation stays inside the 35-minute lease.
      if (!Number.isFinite(age) || age < -30000 || age > 120000) throw invalid();
      const result = await stripe.checkout.sessions.create(
        {
          mode: 'setup',
          managed_payments: { enabled: false },
          currency: 'usd',
          client_reference_id: intent.workspace,
          metadata,
          customer_creation: 'always',
          payment_method_configuration: card,
          setup_intent_data: { metadata },
          expires_at: Math.floor(requestTime / 1000) + 31 * 60,
          success_url: origin + '/?billing=card-returned',
          cancel_url: origin + '/?billing=card-cancelled',
        },
        { idempotencyKey: 'flockletter-trial-setup-' + intent.id },
      );
      return setupProjection(result, intent);
    },
    async lookupSetupCheckout(intent) {
      await accountCheck();
      return lookupSetup(intent);
    },
    async inspectSetup(intent) {
      await accountCheck();
      const session = intent.reference
        ? await stripe.checkout.sessions.retrieve(intent.reference)
        : null;
      if (!session) return null;
      await setupProjection(session, intent);
      if (session.status !== 'complete') return null;
      const setupId = reference(session.setup_intent),
        customer = reference(session.customer);
      if (!setupId || !customer) throw invalid();
      const setup = await stripe.setupIntents.retrieve(setupId, { expand: ['payment_method'] });
      const method = setup.payment_method;
      if (
        setup.livemode !== live ||
        setup.status !== 'succeeded' ||
        setup.usage !== 'off_session' ||
        reference(setup.customer) !== customer ||
        setup.metadata?.fl_workspace !== intent.workspace ||
        setup.metadata?.fl_intent !== intent.id ||
        typeof method !== 'object' ||
        !method ||
        method.type !== 'card' ||
        method.livemode !== live ||
        reference(method.customer) !== customer ||
        !method.card?.fingerprint
      )
        throw invalid();
      return {
        checkout: session.id,
        setupIntent: setup.id,
        customer,
        paymentMethod: method.id,
        fingerprint: method.card.fingerprint,
      };
    },
    async createTrial(intent) {
      await accountCheck();
      const price = await readBillingPrice(stripe, inspectionTarget, intent.plan);
      // Reuse the same exact monthly-price checks used on authoritative subscription snapshots.
      if (!price.active) throw invalid();
      planFor({ price, quantity: 1 });
      const result = await stripe.subscriptions.create(
        {
          customer: intent.customer,
          default_payment_method: intent.paymentMethod,
          items: [{ price: price.id, quantity: 1 }],
          trial_end: Math.floor(intent.trialEnd.getTime() / 1000),
          trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
          payment_behavior: 'default_incomplete',
          metadata: {
            fl_workspace: intent.workspace,
            fl_intent: intent.id,
            fl_trial_activation: intent.activationKey,
          },
        },
        { idempotencyKey: 'flockletter-trial-activate-' + intent.activationKey },
      );
      return verifyTrial(await snapshot(result.id), intent);
    },
    async lookupTrial(intent) {
      await accountCheck();
      let starting_after: string | undefined;
      for (let page = 0; page < 5; page++) {
        const list = await stripe.subscriptions.list({
          customer: intent.customer,
          status: 'all',
          limit: 100,
          starting_after,
        });
        const matches = list.data.filter(
          (s) =>
            s.metadata.fl_intent === intent.id &&
            s.metadata.fl_trial_activation === intent.activationKey,
        );
        if (matches.length > 1) throw invalid();
        if (matches[0]) return verifyTrial(await snapshot(matches[0].id), intent);
        if (!list.has_more) return null;
        starting_after = list.data.at(-1)?.id;
        if (!starting_after) throw invalid();
      }
      throw invalid();
    },
    async inspectSubscription(id) {
      await accountCheck();
      return snapshot(id);
    },
    async checkout(intent) {
      await accountCheck();
      const price = await readBillingPrice(stripe, inspectionTarget, intent.plan),
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
          managed_payments: { enabled: false },
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
        if (!starting_after) throw invalid();
      }
      throw invalid();
    },
    async portal(customer, key, plan, subscription) {
      await accountCheck();
      const catalogue = await readBillingCatalogue(stripe, inspectionTarget);
      const selectedConfiguration = plan ? planPortalConfigurations[plan] : portalConfiguration;
      if (!selectedConfiguration) throw invalid();
      const configuration = await stripe.billingPortal.configurations.retrieve(selectedConfiguration, { expand: ['features.subscription_update.products'] });
      if (!billingPortalMatches(configuration, inspectionTarget, catalogue, plan)) throw invalid();
      let flow: Stripe.BillingPortal.SessionCreateParams.FlowData | undefined;
      if (plan) {
        if (!subscription) throw invalid();
        const current = await stripe.subscriptions.retrieve(subscription);
        const item = current.items.data[0];
        if (current.id !== subscription || current.livemode !== live || reference(current.customer) !== customer ||
            !['active', 'trialing'].includes(current.status) || current.collection_method !== 'charge_automatically' ||
            current.items.has_more || current.items.data.length !== 1 || !item || current.schedule ||
            planFor(item) === plan) throw invalid();
        flow = {
          type: 'subscription_update_confirm',
          subscription_update_confirm: { subscription: current.id, items: [{ id: item.id, price: prices[plan], quantity: 1 }] },
          after_completion: { type: 'redirect', redirect: { return_url: origin + '/subscription' } },
        };
      }
      const result = await stripe.billingPortal.sessions.create(
        { customer, return_url: origin + '/subscription', configuration: selectedConfiguration, ...(flow ? { flow_data: flow } : {}) },
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
        risk: [
          'charge.dispute.created',
          'charge.refunded',
          'radar.early_fraud_warning.created',
        ].includes(event.type),
      };
    },
    async resolve(notice) {
      await accountCheck();
      if (notice.checkout) {
        const s = await stripe.checkout.sessions.retrieve(notice.checkout);
        if (s.livemode !== live) throw invalid();
        if (s.mode === 'setup')
          return {
            subscription: null,
            checkoutId: s.id,
            intentId: s.metadata?.fl_intent ?? null,
            workspace: s.client_reference_id,
          };
        if (s.mode !== 'subscription') throw invalid();
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
        if (event.type.startsWith('subscription_schedule.')) {
          const schedule = await stripe.subscriptionSchedules.retrieve(id);
          if (schedule.id !== id || schedule.livemode !== live) throw invalid();
          subscription = reference(schedule.subscription) ?? reference(schedule.released_subscription);
          if (!subscription) throw invalid();
          const observed = await snapshot(subscription);
          if (observed.customer !== reference(schedule.customer)) throw invalid();
          return { subscription: observed, checkoutId: null, intentId: null, workspace: null };
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
