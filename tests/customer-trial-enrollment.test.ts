import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { startBillingFixture } from './helpers/billing-fixture.js';
import { CommandService } from '../src/server/service.js';
import { CustomerBilling } from '../src/server/customer-billing/service.js';
import { TrialRegistry } from '../src/server/customer-abuse/registry.js';
import { OperatorStore } from '../src/server/platform/store.js';
import type {
  CustomerBillingProvider,
  ProviderIntent,
  ProviderSubscription,
  ProviderTrialActivation,
} from '../src/server/customer-billing/provider.js';
import type { CustomerBillingStatus, TrialReview } from '../src/shared/customer-billing.js';
let f: Awaited<ReturnType<typeof startBillingFixture>>, admin: pg.Client;
beforeAll(async () => {
  f = await startBillingFixture();
  admin = new pg.Client({ connectionString: f.adminUrl });
  await admin.connect();
  if (!(await admin.query("SELECT to_regclass('public.customer_trial_setups') t")).rows[0].t)
    await admin.query(
      await readFile(new URL('../migrations/025_trial_abuse.sql', import.meta.url), 'utf8'),
    );
  await admin.query('GRANT SELECT,INSERT,UPDATE ON customer_trial_setups TO flockletter_runtime');
  await admin.query(
    'GRANT EXECUTE ON FUNCTION flockletter_customer_jobs.trial_claim(text,text,text,text,integer,integer,text,uuid,text,text,text) TO flockletter_runtime',
  );
});
afterAll(async () => {
  await admin?.end();
  await f?.close();
});
function provider() {
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
async function shop(p: ReturnType<typeof provider>, owner?: string) {
  const actor = f.actor();
  if (owner) {
    actor.userId = owner;
    actor.actorId = 'user:' + owner;
  }
  await new CommandService(f.db).execute(
    'workspace.initialize',
    { operationKey: randomUUID(), name: 'Synthetic shop', brandName: 'Synthetic' },
    actor,
  );
  let now = new Date();
  const registry = new TrialRegistry({
    key: 'synthetic-stable-key-only-for-isolated-test',
    source: 'stripe_test',
    account: p.g.account,
    historyBaseline: 'verified-empty',
    policy: {
      id: 'synthetic-lifetime-policy',
      version: 1,
      mode: 'lifetime',
      retentionDays: null,
      approved: true,
    },
  });
  const billing = new CustomerBilling(f.db, {
    environment: 'test',
    exerciseEnabled: false,
    gateway: p.g,
    trialRegistry: registry,
    now: () => now,
  });
  const call = (name: string, input: object = {}) =>
    billing.execute(
      name,
      name === 'customerBilling.status' ? input : { operationKey: randomUUID(), ...input },
      actor,
    );
  return {
    actor,
    billing,
    call,
    setNow: (v: Date) => {
      now = v;
      p.setNow(v);
    },
  };
}
async function review(s: Awaited<ReturnType<typeof shop>>) {
  await s.call('customerBilling.checkout', { plan: 'starter' });
  const status = (await s.call('customerBilling.status')) as CustomerBillingStatus;
  return (
    (await s.call('customerBilling.trialReview', { setupId: status.trialSetup!.id })) as {
      review: TrialReview;
    }
  ).review;
}
it('card-only setup and review never create a recurring agreement; exact explicit approval does', async () => {
  const p = provider(),
    s = await shop(p),
    r = await review(s);
  expect(p.posts()).toBe(1);
  expect(p.trialPosts()).toBe(0);
  await expect(
    s.call('customerBilling.paidCheckout', { plan: 'starter', accepted: true, priceMinor: 1500 }),
  ).rejects.toMatchObject({ code: 'trial_setup_pending' });
  await expect(
    s.call('customerBilling.activateTrial', {
      setupId: r.setupId,
      expectedRevision: r.revision,
      reviewHash: r.hash,
      accepted: true,
      fingerprint: 'forged-card',
    }),
  ).rejects.toThrow('Unrecognized key');
  await expect(
    s.call('customerBilling.activateTrial', {
      setupId: r.setupId,
      expectedRevision: r.revision,
      reviewHash: '0'.repeat(64),
      accepted: true,
    }),
  ).rejects.toMatchObject({ code: 'trial_review_changed' });
  const key = randomUUID();
  expect(
    await s.call('customerBilling.activateTrial', {
      operationKey: key,
      setupId: r.setupId,
      expectedRevision: r.revision,
      reviewHash: r.hash,
      accepted: true,
    }),
  ).toEqual({ state: 'awaiting_verification' });
  expect(p.trialPosts()).toBe(1);
  expect(
    await s.call('customerBilling.activateTrial', {
      operationKey: key,
      setupId: r.setupId,
      expectedRevision: r.revision,
      reviewHash: r.hash,
      accepted: true,
    }),
  ).toEqual({ state: 'awaiting_verification' });
  expect(p.trialPosts()).toBe(1);
  expect(((await s.call('customerBilling.status')) as CustomerBillingStatus).eligible).toBe(false); // callback/creation alone cannot establish provider-event eligibility.
  await s.billing.webhook(Buffer.from('evt_' + randomUUID()), 'valid');
  expect(await s.call('customerBilling.status')).toMatchObject({
    eligible: true,
    state: 'trialing',
    source: 'stripe',
  });
  await admin.query(
    "UPDATE flockletter_customer_jobs.trial_claims SET state='reserved',expires_at=now()-interval '1 second' WHERE intent_id=$1",
    [r.setupId],
  );
  expect(((await s.call('customerBilling.status')) as CustomerBillingStatus).reasons).toContain(
    'The trial’s protected eligibility requires review.',
  );
});
it('recovers lost activation replies by lookup without a second subscription POST', async () => {
  const p = provider(),
    s = await shop(p),
    r = await review(s),
    key = randomUUID(),
    request = {
      operationKey: key,
      setupId: r.setupId,
      expectedRevision: r.revision,
      reviewHash: r.hash,
      accepted: true,
    };
  p.setLoseReply(true);
  expect(await s.call('customerBilling.activateTrial', request)).toEqual({
    state: 'awaiting_reconciliation',
  });
  p.setLoseReply(false);
  expect(await s.call('customerBilling.activateTrial', request)).toEqual({
    state: 'awaiting_verification',
  });
  expect(p.trialPosts()).toBe(1);
});
it('rejects reused card without creating paid access or subscription for the second workspace', async () => {
  const p = provider(),
    a = await shop(p),
    ra = await review(a);
  await a.call('customerBilling.activateTrial', {
    setupId: ra.setupId,
    expectedRevision: ra.revision,
    reviewHash: ra.hash,
    accepted: true,
  });
  const b = await shop(p),
    rb = await review(b);
  expect(
    await b.call('customerBilling.activateTrial', {
      setupId: rb.setupId,
      expectedRevision: rb.revision,
      reviewHash: rb.hash,
      accepted: true,
    }),
  ).toEqual({ state: 'trial_unavailable' });
  expect(p.trialPosts()).toBe(1);
  expect(((await b.call('customerBilling.status')) as CustomerBillingStatus).trialSetup?.state).toBe(
    'denied',
  );
  expect(((await b.call('customerBilling.status')) as CustomerBillingStatus).source).toBe('preparation');
});
it('requires original current owner, current review and explicit live retention approval', async () => {
  const p = provider(),
    s = await shop(p),
    r = await review(s);
  s.setNow(new Date(Date.now() + 11 * 60000));
  await expect(
    s.call('customerBilling.activateTrial', {
      setupId: r.setupId,
      expectedRevision: r.revision,
      reviewHash: r.hash,
      accepted: true,
    }),
  ).rejects.toMatchObject({ code: 'trial_review_changed' });
  const unprotected = new CustomerBilling(f.db, {
    environment: 'test',
    exerciseEnabled: false,
    gateway: p.g,
  });
  await expect(
    unprotected.execute(
      'customerBilling.checkout',
      { operationKey: randomUUID(), plan: 'starter' },
      s.actor,
    ),
  ).rejects.toMatchObject({ code: 'trial_protection_required' });
  const other = { ...s.actor, userId: 'user_other', actorId: 'user:user_other' };
  await expect(
    s.billing.execute(
      'customerBilling.trialReview',
      { operationKey: randomUUID(), setupId: r.setupId },
      other,
    ),
  ).rejects.toMatchObject({ code: 'trial_setup_unavailable' });
  expect(p.trialPosts()).toBe(0);
});
it('platform holds block new starts and activation without resetting private trial history', async () => {
  const p = provider(),
    s = await shop(p),
    r = await review(s);
  const hold = async (value: boolean) =>
    admin.query(
      `INSERT INTO public.platform_exercise_records(workspace_id,kind,id,body) VALUES($1,'hold','current',$2)
 ON CONFLICT(workspace_id,kind,id) DO UPDATE SET body=excluded.body`,
      [s.actor.workspaceId, JSON.stringify({ held: value })],
    );
  await hold(true);
  await expect(
    s.call('customerBilling.activateTrial', {
      setupId: r.setupId,
      expectedRevision: r.revision,
      reviewHash: r.hash,
      accepted: true,
    }),
  ).rejects.toMatchObject({ code: 'platform_review_required' });
  expect(((await s.call('customerBilling.status')) as CustomerBillingStatus).reasons).toContain(
    'This workspace requires a platform review.',
  );
  expect(p.trialPosts()).toBe(0);
  await hold(false);
  await s.call('customerBilling.activateTrial', {
    setupId: r.setupId,
    expectedRevision: r.revision,
    reviewHash: r.hash,
    accepted: true,
  });
  expect(p.trialPosts()).toBe(1);
  const a = await shop(p, s.actor.userId);
  expect(await a.call('customerBilling.checkout', { plan: 'starter' })).toEqual({
    state: 'trial_unavailable',
  });
});
it('protected captured exercises use a separate registry and payment recovery never clears a platform hold', async () => {
  const p = provider(),
    s = await shop(p),
    other = await shop(p),
    sameOwner = await shop(p, s.actor.userId);
  const registry = new TrialRegistry({
    key: 'synthetic-capture-private-key-not-a-live-secret',
    source: 'exercise',
    account: 'captured_' + randomUUID(),
    policy: { id: 'synthetic-bounded', version: 1, mode: 'bounded', retentionDays: 90, approved: true },
  });
  const captured = new CustomerBilling(f.db, {
    environment: 'test',
    exerciseEnabled: true,
    trialRegistry: registry,
  });
  const start = (a: typeof s.actor) =>
    captured.execute(
      'customerBilling.startTrial',
      {
        operationKey: randomUUID(),
        plan: 'starter',
        simulatedCardConfirmed: true,
        simulatedCardReference: 'synthetic-shared-card',
      },
      a,
    );
  expect(await start(s.actor)).toMatchObject({ eligible: true, source: 'exercise', state: 'trialing' });
  await expect(start(other.actor)).rejects.toMatchObject({ code: 'trial_unavailable' });
  await expect(start(sameOwner.actor)).rejects.toMatchObject({ code: 'trial_unavailable' });
  await admin.query(
    `INSERT INTO platform_exercise_records(workspace_id,kind,id,body) VALUES($1,'hold','current','{"held":true}')`,
    [s.actor.workspaceId],
  );
  await captured.execute(
    'customerBilling.exercisePayment',
    { operationKey: randomUUID(), result: 'succeeded' },
    s.actor,
  );
  expect(await captured.status(s.actor.workspaceId)).toMatchObject({
    eligible: false,
    state: 'active',
    reasons: expect.arrayContaining(['This workspace requires a platform review.']),
  });
  await expect(
    captured.execute(
      'customerBilling.startTrial',
      { operationKey: randomUUID(), plan: 'starter', simulatedCardConfirmed: true },
      s.actor,
    ),
  ).rejects.toMatchObject({ code: 'platform_review_required' });
});
it('recovers absent card-only Checkout only after the lease using a distinct durable intent', async () => {
  const p = provider(),
    s = await shop(p),
    firstKey = randomUUID();
  p.setNoSession(true);
  expect(await s.call('customerBilling.checkout', { operationKey: firstKey, plan: 'starter' })).toEqual({
    state: 'awaiting_reconciliation',
  });
  const first = ((await s.call('customerBilling.status')) as CustomerBillingStatus).trialSetup!;
  expect(
    await s.call('customerBilling.checkout', { operationKey: randomUUID(), plan: 'starter' }),
  ).toEqual({ state: 'awaiting_reconciliation' });
  expect(p.posts()).toBe(1);
  await admin.query(
    "UPDATE flockletter_customer_jobs.trial_attempts SET expires_at=now()-interval '1 second' WHERE intent_id=$1",
    [first.id],
  );
  await admin.query(
    "UPDATE flockletter_customer_jobs.trial_claims SET expires_at=now()-interval '1 second' WHERE intent_id=$1",
    [first.id],
  );
  s.setNow(new Date(Date.now() + 36 * 60000 + 1000));
  p.setNoSession(false);
  expect(
    await s.call('customerBilling.checkout', { operationKey: randomUUID(), plan: 'starter' }),
  ).toMatchObject({ state: 'checkout_ready' });
  expect(p.posts()).toBe(2);
  const next = ((await s.call('customerBilling.status')) as CustomerBillingStatus).trialSetup!;
  expect(next.id).not.toBe(first.id);
  expect(
    (await admin.query('SELECT state FROM customer_trial_setups WHERE id=$1', [first.id])).rows[0].state,
  ).toBe('expired');
});
it('commits approval before the provider boundary and serializes new trial POSTs with hold writes', async () => {
  const p = provider(),
    s = await shop(p),
    r = await review(s);
  let entered!: () => void, release!: () => void;
  const inProvider = new Promise<void>((resolve) => (entered = resolve)),
    mayFinish = new Promise<void>((resolve) => (release = resolve));
  const create = p.g.createTrial!;
  p.g.createTrial = async (intent) => {
    entered();
    await mayFinish;
    return create(intent);
  };
  const activation = s.call('customerBilling.activateTrial', {
    setupId: r.setupId,
    expectedRevision: r.revision,
    reviewHash: r.hash,
    accepted: true,
  });
  await inProvider;
  expect(
    (await admin.query('SELECT state FROM customer_billing_intents WHERE id=$1', [r.setupId])).rows[0]
      .state,
  ).toBe('unknown');
  await admin.query('BEGIN');
  try {
    expect(
      (
        await admin.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired', [
          s.actor.workspaceId,
        ])
      ).rows[0].acquired,
    ).toBe(false);
  } finally {
    await admin.query('ROLLBACK');
  }
  const store = new OperatorStore(f.db, 'capture');
  let holdCommitted = false;
  const hold = store
    .transaction(s.actor.workspaceId, (records) => records.put('hold', 'current', { held: true }))
    .then(() => {
      holdCommitted = true;
    });
  await Promise.resolve();
  expect(holdCommitted).toBe(false);
  release();
  await activation;
  await hold;
  await store.close();
  expect(p.trialPosts()).toBe(1);
  expect(((await s.call('customerBilling.status')) as CustomerBillingStatus).reasons).toContain(
    'This workspace requires a platform review.',
  );
});
it('allows independently verified pending agreement management without granting subscription access', async () => {
  const p = provider(),
    s = await shop(p),
    r = await review(s);
  await s.call('customerBilling.activateTrial', {
    setupId: r.setupId,
    expectedRevision: r.revision,
    reviewHash: r.hash,
    accepted: true,
  });
  expect(((await s.call('customerBilling.status')) as CustomerBillingStatus).eligible).toBe(false);
  const inspect = p.g.inspectSubscription!;
  let opened = 0;
  p.g.portal = async () => {
    opened++;
    return 'https://billing.stripe.com/test';
  };
  p.g.inspectSubscription = async (id) => ({ ...(await inspect(id)), customer: 'cus_foreign' });
  await expect(s.call('customerBilling.portal')).rejects.toMatchObject({
    code: 'pending_agreement_unverified',
  });
  expect(opened).toBe(0);
  p.g.inspectSubscription = inspect;
  s.billing.options.checkOwner = async () => false;
  await expect(s.call('customerBilling.portal')).rejects.toMatchObject({ code: 'owner_required' });
  expect(opened).toBe(0);
  s.billing.options.checkOwner = async () => true;
  expect(await s.call('customerBilling.portal')).toMatchObject({
    url: 'https://billing.stripe.com/test',
  });
  expect(opened).toBe(1);
  const selectedKey = randomUUID();
  let selectedCalls = 0;
  p.g.portal = async (_customer, key, plan, subscription) => {
    expect(subscription).toBe('sub_'+r.setupId);
    expect(key).toBe(selectedKey);
    expect(plan).toBe('pro');
    selectedCalls++;
    if(selectedCalls===1) throw Error('Lost provider reply');
    return 'https://billing.stripe.com/test';
  };
  await expect(s.call('customerBilling.portal',{operationKey:selectedKey,plan:'pro'})).rejects.toMatchObject({code:'portal_pending'});
  await expect(s.call('customerBilling.portal',{operationKey:selectedKey,plan:'growth'})).rejects.toMatchObject({code:'operation_conflict'});
  await expect(s.call('customerBilling.portal',{operationKey:selectedKey})).rejects.toMatchObject({code:'operation_conflict'});
  expect(selectedCalls).toBe(1);
  expect(await s.call('customerBilling.portal',{operationKey:selectedKey,plan:'pro'})).toMatchObject({url:'https://billing.stripe.com/test'});
  expect(await s.call('customerBilling.portal',{operationKey:selectedKey,plan:'pro'})).toMatchObject({alreadyIssued:true,url:null});
  expect(selectedCalls).toBe(2);
  expect(await s.call('customerBilling.status')).toMatchObject({
    source: 'preparation',
    eligible: false,
  });
});
