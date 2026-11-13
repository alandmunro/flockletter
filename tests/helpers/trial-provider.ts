import { randomUUID } from 'node:crypto';
import type {
  CustomerBillingProvider,
  ProviderIntent,
  ProviderSubscription,
  ProviderTrialActivation,
} from '../../src/server/customer-billing/provider.js';

export function simulatedTrialProvider() {
  let posts = 0,
    trialPosts = 0,
    complete = true,
    loseReply = false,
    noSetupSession = false;
  const setups = new Map<string, ProviderIntent>(),
    trials = new Map<string, ProviderSubscription>();
  const g: CustomerBillingProvider = {
    account: 'acct_' + randomUUID().replaceAll('-', ''),
    live: false,
    async checkout() {
      throw Error('Paid checkout unexpected');
    },
    async lookupCheckout() {
      return null;
    },
    async portal() {
      return 'https://billing.stripe.com/test';
    },
    async inspectSubscription(id) {
      const found = [...trials.values()].find((s) => s.id === id);
      if (!found) throw Error('Unknown subscription');
      return { ...found };
    },
    verify(raw, signature) {
      if (signature !== 'valid') throw Error('bad signature');
      return {
        id: raw.toString(),
        kind: 'customer.subscription.created',
        checkout: null,
        subscription: [...trials.values()].at(-1)?.id ?? null,
        risk: false,
      };
    },
    async resolve() {
      const sub = [...trials.values()].at(-1) ?? null;
      return {
        subscription: sub,
        checkoutId: null,
        intentId: sub?.intentHint ?? null,
        workspace: sub?.workspaceHint ?? null,
      };
    },
    close() {},
    async setupCheckout(i) {
      posts++;
      if (noSetupSession) throw Error('No session created');
      setups.set(i.id, i);
      return { id: 'cs_' + i.id, url: 'https://checkout.stripe.com/setup', state: 'open' };
    },
    async lookupSetupCheckout(i) {
      return setups.has(i.id)
        ? {
            id: 'cs_' + i.id,
            url: complete ? null : 'https://checkout.stripe.com/setup',
            state: complete ? 'complete' : 'open',
          }
        : null;
    },
    async inspectSetup(i) {
      if (!complete) return null;
      return {
        checkout: 'cs_' + i.id,
        setupIntent: 'seti_' + i.id,
        customer: 'cus_' + i.id,
        paymentMethod: 'pm_' + i.id,
        fingerprint: 'synthetic-shared-card',
      };
    },
    async createTrial(i) {
      trialPosts++;
      const s = snapshot(i);
      trials.set(i.id, s);
      if (loseReply) throw Error('Lost reply');
      return s;
    },
    async lookupTrial(i) {
      return trials.get(i.id) ?? null;
    },
  };
  function snapshot(i: ProviderTrialActivation): ProviderSubscription {
    return {
      ...(i.taxMode?{taxMode:i.taxMode}:{}),
      id: 'sub_' + i.id,
      customer: i.customer,
      state: 'trialing',
      plan: i.plan,
      cardVerified: true,
      workspaceHint: i.workspace,
      intentHint: i.id,
      trialStart: now,
      trialEnd: i.trialEnd,
      periodStart: now,
      periodEnd: i.trialEnd,
      cancelAt: null,
      endedAt: null,
      failedSince: null,
    };
  }
  let now = new Date();
  return {
    g,
    posts: () => posts,
    trialPosts: () => trialPosts,
    setNoSession: (v: boolean) => (noSetupSession = v),
    setComplete: (v: boolean) => (complete = v),
    setLoseReply: (v: boolean) => (loseReply = v),
    setNow: (v: Date) => (now = v),
  };
}
