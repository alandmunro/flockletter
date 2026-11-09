import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { billingPortalMatches } from '../src/server/customer-billing/configuration-inspection.js';
import type { BillingInspectionTarget } from '../src/server/customer-billing/configuration-inspection.js';
import type { CustomerPlan } from '../src/shared/customer-billing.js';

type Catalogue = Record<CustomerPlan, Stripe.Price>;

const target: BillingInspectionTarget = {
  account: 'acct_test',
  live: false,
  origin: 'https://app.flockletter.test',
  cardConfiguration: 'pmc_test',
  portalConfiguration: 'bpc_manage',
  planPortalConfigurations: { starter: 'bpc_starter', growth: 'bpc_growth', pro: 'bpc_pro' },
  prices: { starter: 'price_starter', growth: 'price_growth', pro: 'price_pro' },
};

function makeProduct(): Stripe.Product {
  return {
    id: 'prod_tagged',
    object: 'product',
    active: true,
    livemode: false,
    metadata: { fl_application: 'flockletter' },
  } as unknown as Stripe.Product;
}

function makePrice(id: string, unitAmount: number): Stripe.Price {
  return {
    id,
    object: 'price',
    active: true,
    livemode: false,
    currency: 'usd',
    unit_amount: unitAmount,
    billing_scheme: 'per_unit',
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    metadata: { fl_application: 'flockletter', fl_plan: id === 'price_starter' ? 'starter' : id === 'price_growth' ? 'growth' : 'pro' },
    product: makeProduct(),
  } as unknown as Stripe.Price;
}

const catalogue: Catalogue = {
  starter: makePrice('price_starter', 1500),
  growth: makePrice('price_growth', 2500),
  pro: makePrice('price_pro', 3900),
};

function basePortal(overrides: Partial<Stripe.BillingPortal.Configuration> = {}): Stripe.BillingPortal.Configuration {
  return {
    id: 'bpc_manage',
    object: 'billing_portal.configuration',
    active: true,
    is_default: false,
    livemode: false,
    metadata: { fl_application: 'flockletter' },
    default_return_url: target.origin + '/',
    login_page: { enabled: false },
    features: {
      customer_update: { enabled: false, allowed_updates: [] },
      invoice_history: { enabled: true },
      payment_method_update: {
        enabled: true,
        payment_method_configuration: target.cardConfiguration,
      },
      subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' },
      subscription_pause: { enabled: false },
      subscription_update: {
        enabled: false,
        default_allowed_updates: [],
        billing_cycle_anchor: 'unchanged',
        proration_behavior: 'always_invoice',
        trial_update_behavior: 'end_trial',
        schedule_at_period_end: { conditions: [] },
        products: [],
      },
    },
    ...overrides,
  } as unknown as Stripe.BillingPortal.Configuration;
}

function makePlanPortal(plan: CustomerPlan, overrides: Partial<Stripe.BillingPortal.Configuration> = {}): Stripe.BillingPortal.Configuration {
  return basePortal({
    id: target.planPortalConfigurations[plan],
    metadata: { fl_application: 'flockletter', fl_plan: plan },
    features: {
      ...basePortal().features,
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price'],
        billing_cycle_anchor: 'unchanged',
        proration_behavior: 'always_invoice',
        trial_update_behavior: 'continue_trial',
        schedule_at_period_end: {
          conditions: [{ type: 'decreasing_item_amount' }],
        },
        products: [
          {
            product: 'prod_tagged',
            prices: [target.prices[plan]],
            adjustable_quantity: { enabled: false },
          },
        ],
      },
    },
    ...overrides,
  } as unknown as Stripe.BillingPortal.Configuration);
}

describe('billingPortalMatches', () => {
  it('accepts the general portal with subscription_update disabled and empty products', () => {
    const portal = basePortal();
    expect(billingPortalMatches(portal, target, catalogue)).toBe(true);
  });

  it.each(['starter', 'growth', 'pro'] as const)(
    'accepts the %s plan portal with exact price-only update and single selected price',
    (plan) => {
      const portal = makePlanPortal(plan);
      expect(billingPortalMatches(portal, target, catalogue, plan)).toBe(true);
    }
  );

  it('rejects a plan portal with multiple prices in the same product entry', () => {
    const plan = 'starter' as CustomerPlan;
    const portal = makePlanPortal(plan, {
      features: {
        ...makePlanPortal(plan).features,
        subscription_update: {
          ...makePlanPortal(plan).features.subscription_update,
          products: [
            {
              product: 'prod_tagged',
              prices: ['price_starter', 'price_growth'],
              adjustable_quantity: { enabled: false },
            },
          ],
        },
      },
    } as unknown as Partial<Stripe.BillingPortal.Configuration>);
    expect(billingPortalMatches(portal, target, catalogue, plan)).toBe(false);
  });

  it('rejects a portal with wrong id', () => {
    const portal = basePortal({ id: 'bpc_wrong' });
    expect(billingPortalMatches(portal, target, catalogue)).toBe(false);
  });

  it('rejects a portal with wrong metadata.fl_application', () => {
    const portal = basePortal({ metadata: { fl_application: 'other' } });
    expect(billingPortalMatches(portal, target, catalogue)).toBe(false);
  });

  it('rejects a plan portal with wrong metadata.fl_plan', () => {
    const plan = 'starter' as CustomerPlan;
    const portal = makePlanPortal(plan, { metadata: { fl_application: 'flockletter', fl_plan: 'growth' } });
    expect(billingPortalMatches(portal, target, catalogue, plan)).toBe(false);
  });

  it('rejects a plan portal whose product price does not match the target price', () => {
    const plan = 'starter' as CustomerPlan;
    const portal = makePlanPortal(plan, {
      features: {
        ...makePlanPortal(plan).features,
        subscription_update: {
          ...makePlanPortal(plan).features.subscription_update,
          products: [
            {
              product: 'prod_tagged',
              prices: ['price_growth'],
              adjustable_quantity: { enabled: false },
            },
          ],
        },
      },
    } as unknown as Partial<Stripe.BillingPortal.Configuration>);
    expect(billingPortalMatches(portal, target, catalogue, plan)).toBe(false);
  });

  it('rejects the general portal if subscription_update is enabled', () => {
    const portal = basePortal({
      features: {
        ...basePortal().features,
        subscription_update: {
          enabled: true,
          default_allowed_updates: ['price'],
          billing_cycle_anchor: 'unchanged',
          proration_behavior: 'always_invoice',
          trial_update_behavior: 'continue_trial',
          schedule_at_period_end: { conditions: [] },
          products: [],
        },
      },
    } as unknown as Partial<Stripe.BillingPortal.Configuration>);
    expect(billingPortalMatches(portal, target, catalogue)).toBe(false);
  });

  it('rejects a plan portal with immediate cancellation mode', () => {
    const plan = 'starter' as CustomerPlan;
    const portal = makePlanPortal(plan, {
      features: {
        ...makePlanPortal(plan).features,
        subscription_cancel: { enabled: true, mode: 'at_period_end' as const, proration_behavior: 'none' },
      },
    } as unknown as Partial<Stripe.BillingPortal.Configuration>);
    // Override to immediate mode
    portal.features.subscription_cancel.mode = 'immediately';
    expect(billingPortalMatches(portal, target, catalogue, plan)).toBe(false);
  });

  it('rejects a plan portal with end_trial behavior', () => {
    const plan = 'starter' as CustomerPlan;
    const portal = makePlanPortal(plan, {
      features: {
        ...makePlanPortal(plan).features,
        subscription_update: {
          ...makePlanPortal(plan).features.subscription_update,
          trial_update_behavior: 'end_trial',
        },
      },
    } as unknown as Partial<Stripe.BillingPortal.Configuration>);
    expect(billingPortalMatches(portal, target, catalogue, plan)).toBe(false);
  });
});
