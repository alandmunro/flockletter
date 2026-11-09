import Stripe from 'stripe';
import { plans } from '../../shared/contracts.js';
import type { CustomerPlan } from '../../shared/customer-billing.js';

export const billingProviderEvents = [
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'subscription_schedule.created', 'subscription_schedule.updated', 'subscription_schedule.released',
  'subscription_schedule.canceled', 'subscription_schedule.completed',
  'invoice.paid', 'invoice.payment_failed', 'charge.dispute.created', 'charge.refunded',
  'radar.early_fraud_warning.created',
] as const;

export type BillingInspectionTarget = {
  account: string;
  live: boolean;
  origin: string;
  cardConfiguration: string;
  portalConfiguration: string;
  prices: Record<CustomerPlan, string>;
};
type Catalogue = Record<CustomerPlan, Stripe.Price>;
export type BillingConfigurationCheck = {
  name: 'account' | 'catalogue' | 'payment_methods' | 'portal' | 'webhook';
  status: 'pass' | 'fail' | 'unavailable';
};
const same = (actual: string[], expected: readonly string[]) =>
  actual.length === expected.length && new Set(actual).size === actual.length &&
  expected.every(value => actual.includes(value));
const ref = (value: string | { id: string } | null) => typeof value === 'string' ? value : value?.id;

export async function readBillingPrice(stripe: Stripe, target: BillingInspectionTarget, planId: CustomerPlan) {
  const plan = plans.find(plan => plan.id === planId);
  if (!plan) throw new Error('The Flockletter billing catalogue could not be verified.');
  const price = await stripe.prices.retrieve(target.prices[plan.id], { expand: ['product'] });
  const product = price.product;
  if (price.id !== target.prices[plan.id] || !price.active || price.livemode !== target.live ||
      price.currency !== 'usd' || price.unit_amount !== plan.priceMinor || price.billing_scheme !== 'per_unit' ||
      price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1 ||
      price.recurring.usage_type !== 'licensed' ||
      (price.unit_amount_decimal !== null && !new RegExp('^' + plan.priceMinor + '(?:\\.0+)?$').test(price.unit_amount_decimal.toString())) ||
      price.metadata.fl_application !== 'flockletter' || price.metadata.fl_plan !== plan.id ||
      typeof product !== 'object' || product.deleted || !product.active || product.livemode !== target.live ||
      product.metadata.fl_application !== 'flockletter')
    throw new Error('The Flockletter billing catalogue could not be verified.');
  return price;
}

/** Verify only Flockletter-owned, exact monthly prices; no settings are changed. */
export async function readBillingCatalogue(stripe: Stripe, target: BillingInspectionTarget): Promise<Catalogue> {
  const entries = await Promise.all(plans.map(async plan => {
    const price = await readBillingPrice(stripe, target, plan.id);
    return [plan.id, price] as const;
  }));
  // Stripe's portal can defer a downgrade only between prices of the same product.
  if (new Set(entries.map(([, price]) => ref(price.product))).size !== 1)
    throw new Error('The Flockletter billing catalogue could not be verified.');
  const byPlan = new Map(entries), starter = byPlan.get('starter'), growth = byPlan.get('growth'), pro = byPlan.get('pro');
  if (!starter || !growth || !pro) throw new Error('The Flockletter billing catalogue could not be verified.');
  return { starter, growth, pro };
}

/** D-049 policy, explicitly bound to a nondefault Flockletter portal. */
export function billingPortalMatches(portal: Stripe.BillingPortal.Configuration, target: BillingInspectionTarget, catalogue: Catalogue) {
  const features = portal.features, update = features.subscription_update;
  const products = update.products ?? [];
  return portal.id === target.portalConfiguration && portal.active && !portal.is_default &&
    portal.livemode === target.live && portal.metadata?.fl_application === 'flockletter' &&
    portal.default_return_url === target.origin + '/' && !portal.login_page.enabled &&
    !features.customer_update.enabled && features.invoice_history.enabled &&
    features.payment_method_update.enabled && features.payment_method_update.payment_method_configuration === target.cardConfiguration &&
    features.subscription_cancel.enabled && features.subscription_cancel.mode === 'at_period_end' &&
    features.subscription_cancel.proration_behavior === 'none' && !features.subscription_pause?.enabled &&
    update.enabled && same(update.default_allowed_updates, ['price']) &&
    update.billing_cycle_anchor === 'unchanged' && update.proration_behavior === 'always_invoice' &&
    update.trial_update_behavior === 'continue_trial' &&
    update.schedule_at_period_end.conditions.length === 1 &&
    update.schedule_at_period_end.conditions[0]?.type === 'decreasing_item_amount' &&
    products.length === 1 && products[0]!.product === ref(catalogue.starter.product) &&
    same(products[0]!.prices, plans.map(plan => target.prices[plan.id])) && !products[0]!.adjustable_quantity?.enabled;
}

/** Bounded, read-only operator inspection. Results contain no IDs, keys or SDK error text. */
export async function inspectStripeBillingConfiguration(stripe: Stripe, target: BillingInspectionTarget) {
  const checks: BillingConfigurationCheck[] = [];
  let catalogue: Catalogue | undefined;
  async function check(name: BillingConfigurationCheck['name'], inspect: () => Promise<boolean>) {
    try { checks.push({ name, status: await inspect() ? 'pass' : 'fail' }); }
    catch { checks.push({ name, status: 'unavailable' }); }
  }
  await check('account', async () => (await stripe.accounts.retrieveCurrent()).id === target.account);
  // Do not read any other resources through an unexpected merchant account.
  if (checks[0]?.status !== 'pass') return { verified: false, live: target.live, checks };
  await check('catalogue', async () => { catalogue = await readBillingCatalogue(stripe, target); return true; });
  await check('payment_methods', async () => {
    const card = await stripe.paymentMethodConfigurations.retrieve(target.cardConfiguration);
    return card.id === target.cardConfiguration && card.active && card.livemode === target.live && card.card?.available === true &&
      card.card.display_preference.value === 'on';
  });
  await check('portal', async () => {
    const portal = await stripe.billingPortal.configurations.retrieve(target.portalConfiguration);
    return Boolean(catalogue && billingPortalMatches(portal, target, catalogue));
  });
  await check('webhook', async () => {
    const matches: Stripe.WebhookEndpoint[] = [];
    let starting_after: string | undefined;
    for (let page = 0; page < 5; page++) {
      const endpoints = await stripe.webhookEndpoints.list({ limit: 100, starting_after });
      matches.push(...endpoints.data.filter(endpoint => endpoint.url === target.origin + '/api/v1/customer-billing/stripe-events'));
      if (!endpoints.has_more) return matches.length === 1 && matches[0]!.livemode === target.live &&
        matches[0]!.status === 'enabled' && same(matches[0]!.enabled_events, billingProviderEvents);
      starting_after = endpoints.data.at(-1)?.id;
      if (!starting_after) throw new Error('Incomplete provider lookup.');
    }
    throw new Error('Incomplete provider lookup.');
  });
  return { verified: checks.every(check => check.status === 'pass'), live: target.live, checks };
}
