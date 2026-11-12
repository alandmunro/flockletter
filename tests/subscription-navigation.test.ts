import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authenticationReturnUrl,
  browserSubscriptionEntry,
  subscriptionEntry,
  subscriptionSignupUrl,
  subscriptionUrl,
} from '../src/client/subscription-navigation.js';

import type {CustomerPlan} from '../src/shared/customer-billing.js';
import type {BillingReturn} from '../src/client/subscription-navigation.js';
afterEach(()=>vi.unstubAllGlobals());

describe('subscriptionEntry', () => {
  it('recognizes valid plan hints on allowed paths', () => {
    expect(subscriptionEntry({ pathname: '/sign-up', search: '?plan=starter' })).toEqual({
      plan: 'starter',
      billingReturn: undefined,
      subscription: true,
    });
    expect(subscriptionEntry({ pathname: '/subscription', search: '?plan=growth' })).toEqual({
      plan: 'growth',
      billingReturn: undefined,
      subscription: true,
    });
    expect(subscriptionEntry({ pathname: '/', search: '?plan=pro' })).toEqual({
      plan: 'pro',
      billingReturn: undefined,
      subscription: true,
    });
  });

  it('ignores unknown plan hints', () => {
    expect(subscriptionEntry({ pathname: '/sign-up', search: '?plan=unknown' })).toEqual({
      plan: undefined,
      billingReturn: undefined,
      subscription: true, // path is allowed and it's sign-up
    });
  });

  it('ignores duplicate plan hints', () => {
    expect(subscriptionEntry({ pathname: '/sign-up', search: '?plan=starter&plan=growth' })).toEqual({
      plan: undefined,
      billingReturn: undefined,
      subscription: true, // path is allowed and it's sign-up
    });
  });

  it('recognizes valid billing return hints on allowed paths', () => {
    expect(subscriptionEntry({ pathname: '/subscription', search: '?billing=card-returned' })).toEqual({
      plan: undefined,
      billingReturn: 'card-returned',
      subscription: true,
    });
    expect(subscriptionEntry({ pathname: '/subscription', search: '?billing=cancelled' })).toEqual({
      plan: undefined,
      billingReturn: 'cancelled',
      subscription: true,
    });
  });

  it('ignores unknown billing return hints', () => {
    expect(subscriptionEntry({ pathname: '/subscription', search: '?billing=invalid' })).toEqual({
      plan: undefined,
      billingReturn: undefined,
      subscription: true, // path is allowed and it's /subscription
    });
  });

  it('ignores duplicate billing return hints', () => {
    expect(subscriptionEntry({ pathname: '/subscription', search: '?billing=returned&billing=cancelled' })).toEqual({
      plan: undefined,
      billingReturn: undefined,
      subscription: true, // path is allowed and it's /subscription
    });
  });

  it('does not start signup on unknown paths', () => {
    expect(subscriptionEntry({ pathname: '/unknown', search: '?plan=starter' })).toEqual({
      plan: undefined,
      billingReturn: undefined,
      subscription: false,
    });
  });

  it('discards foreign redirect and next URLs', () => {
    // These are not plan or billing params, so they should be ignored.
    const entry = subscriptionEntry({ pathname: '/sign-up', search: '?redirect=https://evil.com&next=/admin' });
    expect(entry).toEqual({
      plan: undefined,
      billingReturn: undefined,
      subscription: true, // path is allowed and it's sign-up
    });
  });
});

describe('authenticationReturnUrl', () => {
  it('returns /operator for operator path', () => {
    expect(authenticationReturnUrl({ pathname: '/operator', search: '' })).toBe('/operator');
  });

  it('returns subscription URL for valid subscription entry', () => {
    expect(
      authenticationReturnUrl({ pathname: '/sign-up', search: '?plan=starter' }),
    ).toBe('/subscription?plan=starter');
  });

  it('returns root for non-subscription paths', () => {
    expect(authenticationReturnUrl({ pathname: '/about', search: '' })).toBe('/');
  });
});

describe('subscriptionSignupUrl and subscriptionUrl', () => {
  it('generates signup URL with valid plan only', () => {
    expect(subscriptionSignupUrl('starter')).toBe('/sign-up?plan=starter');
    expect(subscriptionSignupUrl(undefined)).toBe('/sign-up');
  });

  it('generates subscription URL with valid plan and billing return', () => {
    expect(subscriptionUrl('growth', 'card-returned')).toBe('/subscription?plan=growth&billing=card-returned');
    expect(subscriptionUrl('pro')).toBe('/subscription?plan=pro');
    expect(subscriptionUrl(undefined, 'cancelled')).toBe('/subscription?billing=cancelled');
    expect(subscriptionUrl()).toBe('/subscription');
  });

  it('ignores invalid plan IDs in URL generation', () => {
    // The helper checks planIds.has(plan), so invalid plans are dropped.
    expect(subscriptionSignupUrl('invalid' as CustomerPlan)).toBe('/sign-up');
  });

  it('ignores invalid billing returns in URL generation', () => {
    expect(subscriptionUrl(undefined, 'invalid' as BillingReturn)).toBe('/subscription');
  });
});

describe('browserSubscriptionEntry', () => {
  it('returns default entry when window is undefined (SSR)', () => {
    vi.stubGlobal('window',undefined);
    expect(browserSubscriptionEntry()).toEqual({plan:undefined,billingReturn:undefined,subscription:false});
  });
});


it.each(['card-returned','card-cancelled','returned','cancelled','managed'] as const)('keeps %s only as a return navigation hint',billing=>{
  expect(authenticationReturnUrl({pathname:'/',search:'?billing='+billing+'&next=https://untrusted.example'})).toBe('/subscription?billing='+billing);
});
it('resumes the browser plan and discards URL-supplied redirect authority',()=>{
  vi.stubGlobal('window',{location:{pathname:'/sign-up',search:'?plan=growth&redirect_url=//untrusted.example'}});
  expect(browserSubscriptionEntry()).toEqual({plan:'growth',billingReturn:undefined,subscription:true});
  expect(authenticationReturnUrl(window.location)).toBe('/subscription?plan=growth');
  expect(authenticationReturnUrl({pathname:'//untrusted.example',search:'?plan=pro'})).toBe('/');
});
