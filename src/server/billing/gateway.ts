import Stripe from 'stripe';
import { plans } from '../../shared/contracts.js';
import { hostedTrial } from '../../shared/trial.js';
import type { PlanId } from '../../shared/rehearsal.js';
import { AppError, requireCondition } from '../errors.js';

export type BillingIntent = {
  workspace_id: string;
  id: string;
  operation_key: string;
  actor_id: string;
  plan: PlanId;
  sandbox_account: string;
  provider_price: string;
  session_id: string | null;
  customer_id: string | null;
  subscription_id: string | null;
  status: string;
  created_at: Date;
  trial_end: Date | null;
};
export type GatewayEvent = { id: string; kind: string; workspace: string; intent: string; objectId: string };
export type SessionResult = {
  id: string;
  url: string | null;
  customer: string | null;
  subscription: string | null;
  status: string;
  trialEnd: Date | null;
};
export interface BillingGateway {
  account: string;
  prices: Record<PlanId, string>;
  open(intent: BillingIntent): Promise<SessionResult>;
  observe(intent: BillingIntent, sessionId: string): Promise<SessionResult>;
  portal(customer: string, key: string): Promise<string>;
  verify(raw: Buffer, signature: string): GatewayEvent | null;
}
const invalid = () =>
  new AppError(503, 'sandbox_mismatch', 'The Flockletter billing sandbox could not be verified.');
export function sandboxGateway(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
): BillingGateway | undefined {
  if (env.FLOCKLETTER_BILLING_MODE === undefined || env.FLOCKLETTER_BILLING_MODE === 'off') return;
  if (env.FLOCKLETTER_BILLING_MODE !== 'sandbox')
    throw Error('Only isolated Stripe sandbox billing is supported.');
  const key = env.FLOCKLETTER_STRIPE_TEST_KEY ?? '',
    account = env.FLOCKLETTER_STRIPE_TEST_ACCOUNT ?? '',
    webhook = env.FLOCKLETTER_STRIPE_TEST_WEBHOOK ?? '';
  const prices = {
    starter: env.FLOCKLETTER_STRIPE_STARTER_PRICE ?? '',
    growth: env.FLOCKLETTER_STRIPE_GROWTH_PRICE ?? '',
    pro: env.FLOCKLETTER_STRIPE_PRO_PRICE ?? '',
  };
  const config = env.FLOCKLETTER_STRIPE_CARD_CONFIG ?? '';
  if (
    !/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key) ||
    !/^acct_[A-Za-z0-9]+$/.test(account) ||
    !webhook.startsWith('whsec_') ||
    !/^pmc_[A-Za-z0-9]+$/.test(config) ||
    !Object.values(prices).every((id) => /^price_[A-Za-z0-9]+$/.test(id)) ||
    new Set(Object.values(prices)).size !== 3
  )
    throw Error('Complete the isolated Flockletter billing sandbox configuration.');
  const stripe = new Stripe(key, { maxNetworkRetries: 1, timeout: 7000 });
  async function validateAccount() {
    const accountInfo = await stripe.accounts.retrieveCurrent();
    if (accountInfo.id !== account) throw invalid();
  }
  async function validatePrice(intent: BillingIntent) {
    const price = await stripe.prices.retrieve(intent.provider_price),
      plan = plans.find((p) => p.id === intent.plan)!;
    if (
      intent.sandbox_account !== account ||
      prices[intent.plan] !== price.id ||
      price.livemode ||
      !price.active ||
      price.unit_amount !== plan.priceMinor ||
      price.currency !== 'usd' ||
      price.recurring?.interval !== 'month' ||
      price.recurring.interval_count !== 1
    )
      throw invalid();
  }
  const ref = (item: string | { id: string } | null) =>
    typeof item === 'string' ? item : (item?.id ?? null);
  async function observe(intent: BillingIntent, sessionId: string) {
    await validateAccount();
    const s = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription.default_payment_method'],
    });
    if (
      s.livemode ||
      s.mode !== 'subscription' ||
      s.client_reference_id !== intent.workspace_id ||
      s.metadata?.fl_intent !== intent.id ||
      s.metadata?.fl_workspace !== intent.workspace_id ||
      !s.id.startsWith('cs_test_')
    )
      throw invalid();
    let status = s.status ?? 'open',
      trialEnd: Date | null = null;
    const subscription = typeof s.subscription === 'object' && s.subscription ? s.subscription : null;
    if (s.status === 'complete' && subscription) {
      if (
        subscription.livemode ||
        subscription.metadata.fl_intent !== intent.id ||
        subscription.metadata.fl_workspace !== intent.workspace_id ||
        ref(subscription.customer) !== ref(s.customer) ||
        subscription.items.data.length !== 1 ||
        subscription.items.data[0]?.price.id !== intent.provider_price
      )
        throw invalid();
      let pm = subscription.default_payment_method;
      if (!pm && subscription.status === 'trialing' && typeof s.customer === 'string') {
        const customer = await stripe.customers.retrieve(s.customer, {
          expand: ['invoice_settings.default_payment_method'],
        });
        if (!customer.deleted) pm = customer.invoice_settings.default_payment_method;
      }
      status =
        subscription.status === 'trialing' && (typeof pm !== 'object' || !pm || pm.type !== 'card')
          ? 'card_unverified'
          : subscription.status;
      trialEnd = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null;
    }
    if (s.status === 'complete' && !subscription) status = 'awaiting_subscription';
    return {
      id: s.id,
      url: s.status === 'open' ? s.url : null,
      status,
      customer: ref(s.customer),
      subscription: ref(s.subscription),
      trialEnd,
    };
  }
  return {
    account,
    prices,
    observe,
    async open(intent) {
      await validateAccount();
      await validatePrice(intent);
      if (intent.session_id) return observe(intent, intent.session_id);
      // Use a deterministic eight-letter suffix so ambiguous retries have identical parameters.
      const suffix = intent.id
        .replaceAll('-', '')
        .slice(0, 8)
        .split('')
        .map((ch) => String.fromCharCode(97 + parseInt(ch, 16)))
        .join('');
      const meta = { fl_workspace: intent.workspace_id, fl_intent: intent.id };
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          client_reference_id: intent.workspace_id,
          metadata: meta,
          payment_method_collection: 'always',
          payment_method_configuration: config,
          line_items: [{ price: intent.provider_price, quantity: 1 }],
          subscription_data: {
            trial_period_days: hostedTrial.days,
            metadata: meta,
            trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
          },
          success_url: origin + '/?billing=returned',
          cancel_url: origin + '/?billing=cancelled',
          integration_identifier: 'flockletter_' + suffix,
        },
        { idempotencyKey: 'flockletter-checkout-' + intent.id },
      );
      return observe(intent, session.id);
    },
    async portal(customer, key) {
      await validateAccount();
      const session = await stripe.billingPortal.sessions.create(
        { customer, return_url: origin + '/' },
        { idempotencyKey: 'flockletter-portal-' + key },
      );
      requireCondition(
        new URL(session.url).hostname === 'billing.stripe.com',
        503,
        'sandbox_mismatch',
        'The sandbox portal URL was rejected.',
      );
      return session.url;
    },
    verify(raw, signature) {
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(raw, signature, webhook);
      } catch {
        throw new AppError(400, 'invalid_signature', 'Invalid sandbox event signature.');
      }
      if (event.livemode || (event.account && event.account !== account))
        throw new AppError(400, 'sandbox_only', 'The event does not belong to this sandbox.');
      if (
        ![
          'checkout.session.completed',
          'checkout.session.expired',
          'checkout.session.async_payment_succeeded',
          'customer.subscription.created',
          'customer.subscription.updated',
          'customer.subscription.deleted',
        ].includes(event.type)
      )
        return null;
      const object = event.data.object as { id: string; metadata?: Record<string, string> | null };
      const workspace = object.metadata?.fl_workspace,
        intent = object.metadata?.fl_intent;
      if (
        !workspace ||
        !intent ||
        !/^org_[A-Za-z0-9_-]{1,120}$/.test(workspace) ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(intent)
      )
        return null;
      return { id: event.id, kind: event.type, workspace, intent, objectId: object.id };
    },
  };
}
