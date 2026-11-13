import {describe, expect, it} from 'vitest';
import type Stripe from 'stripe';

import {billingTaxMode, verifyNoTaxSubscription} from '../src/server/customer-billing/tax-policy.js';

function makeSubscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  const base = {
    id: 'sub_test',
    object: 'subscription',
    status: 'active',
    customer: 'cus_test',
    items: {
      object: 'list',
      data: [
        {
          id: 'si_test',
          object: 'subscription_item',
          price: {id:'price_test'},
          tax_rates: [],
        },
      ],
    },
    automatic_tax: {enabled: false},
    managed_payments: null,
    default_tax_rates: [],
    latest_invoice: null,
  };
  return {...base, ...overrides} as unknown as Stripe.Subscription;
}

describe('billingTaxMode', () => {
  it('accepts "off"', () => {
    expect(billingTaxMode('off')).toBe('off');
  });

  it('accepts "stripe-automatic"', () => {
    expect(billingTaxMode('stripe-automatic')).toBe('stripe-automatic');
  });

  it('returns undefined when value is absent and required=false', () => {
    expect(billingTaxMode(undefined, false)).toBeUndefined();
  });

  it('rejects when required=true and value is absent', () => {
    expect(() => billingTaxMode(undefined, true)).toThrow(
      'An explicit supported Flockletter tax collection mode is required.',
    );
  });

  it.each(['false', 'true', '', 'unknown', 'off ', ' stripe-automatic'])(
    'rejects unsupported value %s',
    (value) => {
      expect(() => billingTaxMode(value)).toThrow(
        'An explicit supported Flockletter tax collection mode is required.',
      );
    },
  );
});

describe('verifyNoTaxSubscription', () => {
  it('accepts a valid no-tax subscription with empty invoice total_taxes', () => {
    const sub = makeSubscription({
      latest_invoice: {
        id: 'in_test',
        object: 'invoice',
        automatic_tax: {enabled: false},
        default_tax_rates: [],
        total_taxes: [],
      },
    });
    expect(() => verifyNoTaxSubscription(sub)).not.toThrow();
  });

  it('accepts a valid no-tax subscription with null latest_invoice', () => {
    const sub = makeSubscription({latest_invoice: null});
    expect(() => verifyNoTaxSubscription(sub)).not.toThrow();
  });

  it('rejects when automatic_tax.enabled is true', () => {
    const sub = makeSubscription({automatic_tax: {enabled: true}});
    expect(() => verifyNoTaxSubscription(sub)).toThrow(
      'The subscription tax collection facts could not be verified.',
    );
  });

  it('rejects Managed Payments being enabled',()=>{
    expect(()=>verifyNoTaxSubscription(makeSubscription({managed_payments:{enabled:true}}))).toThrow('The subscription tax collection facts could not be verified.');
  });

  it('rejects when automatic_tax is missing (undefined)', () => {
    const sub = makeSubscription({automatic_tax: undefined});
    expect(() => verifyNoTaxSubscription(sub)).toThrow(
      'The subscription tax collection facts could not be verified.',
    );
  });

  it('rejects when subscription default_tax_rates is non-empty', () => {
    const sub = makeSubscription({default_tax_rates: [{id: 'tr_1'}]});
    expect(() => verifyNoTaxSubscription(sub)).toThrow(
      'The subscription tax collection facts could not be verified.',
    );
  });

  it('rejects when a subscription item has tax rates', () => {
    const sub = makeSubscription({
      items: {
        object: 'list',
        data: [
          {
            id: 'si_test',
            object: 'subscription_item',
            price: {id:'price_test'},
            tax_rates: [{id: 'tr_item'}],
          },
        ],
      },
    });
    expect(() => verifyNoTaxSubscription(sub)).toThrow(
      'The subscription tax collection facts could not be verified.',
    );
  });

  it('rejects when latest_invoice automatic_tax.enabled is true', () => {
    const sub = makeSubscription({
      latest_invoice: {
        id: 'in_test',
        object: 'invoice',
        automatic_tax: {enabled: true},
        default_tax_rates: [],
        total_taxes: [],
      },
    });
    expect(() => verifyNoTaxSubscription(sub)).toThrow(
      'The subscription tax collection facts could not be verified.',
    );
  });

  it('rejects when latest_invoice default_tax_rates is non-empty', () => {
    const sub = makeSubscription({
      latest_invoice: {
        id: 'in_test',
        object: 'invoice',
        automatic_tax: {enabled: false},
        default_tax_rates: [{id: 'tr_inv'}],
        total_taxes: [],
      },
    });
    expect(() => verifyNoTaxSubscription(sub)).toThrow(
      'The subscription tax collection facts could not be verified.',
    );
  });

  it('rejects when latest_invoice total_taxes has a positive amount', () => {
    const sub = makeSubscription({
      latest_invoice: {
        id: 'in_test',
        object: 'invoice',
        automatic_tax: {enabled: false},
        default_tax_rates: [],
        total_taxes: [{amount: 100, currency: 'usd'}],
      },
    });
    expect(() => verifyNoTaxSubscription(sub)).toThrow(
      'The subscription tax collection facts could not be verified.',
    );
  });

  it('rejects when latest_invoice is a non-object value', () => {
    const sub = makeSubscription({latest_invoice: 'in_string'});
    expect(() => verifyNoTaxSubscription(sub)).toThrow(
      'The subscription tax collection facts could not be verified.',
    );
  });

  it('accepts when latest_invoice total_taxes is null', () => {
    const sub = makeSubscription({
      latest_invoice: {
        id: 'in_test',
        object: 'invoice',
        automatic_tax: {enabled: false},
        default_tax_rates: [],
        total_taxes: null,
      },
    });
    expect(() => verifyNoTaxSubscription(sub)).not.toThrow();
  });

  it('rejects when latest_invoice total_taxes is missing', () => {
    const sub = makeSubscription({
      latest_invoice: {
        id: 'in_test',
        object: 'invoice',
        automatic_tax: {enabled: false},
        default_tax_rates: [],
      },
    });
    expect(() => verifyNoTaxSubscription(sub)).toThrow(
      'The subscription tax collection facts could not be verified.',
    );
  });
});
