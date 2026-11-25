import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { startDatabase } from '../scripts/database-fixture.js';
import { CustomerAudience } from '../src/server/customer-audience/service.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { Texting } from '../src/server/texting/service.js';
import { StripeTestSetupPayment } from '../src/server/texting/setup-payment.js';
import { twilioSignature } from '../src/server/texting/twilio.js';
import type { CommandName } from '../src/shared/contracts.js';
import type { OnboardingView } from '../src/shared/texting-onboarding.js';

const origin = 'http://127.0.0.1:4310';
const owner = (workspaceId: string): Actor => ({
  workspaceId, userId: 'user_' + workspaceId, actorId: 'user:' + workspaceId, kind: 'session', owner: true, scopes: ['read'], brandIds: null,
});
const a = owner('org_onboarding_a'), b = owner('org_onboarding_b'), c = owner('org_onboarding_stripe');
const business = {
  legalName: 'Robin’s Garden LLC', ein: '00-0072321', businessType: 'Limited Liability Corporation', vertical: 'RETAIL',
  website: 'https://garden.example.test', privacyPolicyUrl: 'https://garden.example.test/privacy', smsTermsUrl: 'https://garden.example.test/terms',
  street: '1 Example Street', city: 'New York', region: 'NY', postalCode: '10001',
  firstName: 'Sample', lastName: 'Owner', title: 'Owner', email: 'owner@garden.example.test', phone: '+12125550120',
};
const operator = { userId: 'operator', via: 'operator_api' } as const;
let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database, service: CommandService, texting: Texting;
let clock = 0;
const ids = new Map<string, string>();
const settings = {
  carrier_daily_limit: 100, monthly_segment_allowance: 1000, probation_canary_count: 1,
  probation_canary_minutes: 1, probation_min_days: 2, probation_delivered_min: 2,
  probation_initial_days: 1, probation_initial_daily_limit: 10, probation_daily_limit: 20,
};
const run = <T = unknown>(actor: Actor, name: CommandName, input: unknown = {}) => service.execute(name, input, actor) as Promise<T>;
const mutation = (actor: Actor, name: CommandName, input: Record<string, unknown> = {}) =>
  run(actor, name, { companyId: ids.get(actor.workspaceId), operationKey: randomUUID(), expectedRevision: 1, ...input });
const status = (actor: Actor) => run<OnboardingView>(actor, 'sms.onboardingStatus', { companyId: ids.get(actor.workspaceId) });
async function tick(actor: Actor) {
  clock += 6000;
  await texting.tick(actor.workspaceId);
}

beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  clock = Date.now() + 60_000;
  const checkOwner = async (user: string, workspace: string) => user === 'user_' + workspace;
  texting = Texting.mock(db, { origin, linkOrigin: origin + '/l', isOwner: checkOwner, onboardingCapture: true, now: () => new Date(clock) });
  service = new CommandService(db, undefined, checkOwner);
  Object.assign(service, { customer: { texting, owns: () => false } });
  const audience = new CustomerAudience(db, { origin, mode: 'exercise', checkOwner, contactLimit: async () => 250, texting });
  for (const actor of [a, b, c]) {
    await run(actor, 'workspace.initialize', { operationKey: randomUUID(), name: 'Synthetic workspace', brandName: 'Garden' });
    const context = await db.read(actor.workspaceId, async sql => ({
      company: (await sql.query<{ id: string }>('SELECT id FROM companies')).rows[0]!.id,
      brand: (await sql.query<{ id: string }>('SELECT id FROM brands')).rows[0]!.id,
    }));
    ids.set(actor.workspaceId, context.company);
    await run(actor, 'sms.configure', { operationKey: randomUUID(), expectedRevision: 1, phoneField: true });
    await audience.execute('audienceOnboarding.configure', {
      brandId: context.brand, operationKey: randomUUID(), enabled: true, purpose: 'garden_news', policyVersion: 'v1',
      consentText: 'Send me garden updates. I can unsubscribe at any time.', sourceDomain: 'garden.example.test',
    }, actor);
  }
  for (const [key, value] of Object.entries(settings)) await texting.operator('platform.textingSetSetting', {
    operationKey: randomUUID(), workspaceId: a.workspaceId, key, expectedRevision: 0, value, reason: 'Synthetic probation exercise.',
  }, operator);
});

it('opens one Stripe test checkout intent and accepts only a matching signed paid receipt', async () => {
  const secret = 'whsec_synthetic_fixture';
  const stripe = new Stripe('sk_test_synthetic');
  const payment = new StripeTestSetupPayment('sk_test_synthetic', secret, 'acct_synthetic', origin);
  const testService = Texting.mock(db, { origin, linkOrigin: origin + '/l', isOwner: async () => true, onboardingCapture: true, onboardingStripe: payment });
  const companyId = ids.get(c.workspaceId)!;
  const open = vi.spyOn(payment, 'open').mockResolvedValue({ id: 'cs_test_synthetic', url: 'https://checkout.stripe.com/test' });
  const cmd = (name: Parameters<Texting['execute']>[0], input: Record<string, unknown> = {}) =>
    testService.execute(name, { operationKey: randomUUID(), companyId, expectedRevision: 1, ...input }, c, 'api');
  await cmd('sms.onboardingSave', { business: { ...business, ein: '00-0072322' }, accepted: true, expectedRevision: null });
  for (const channel of ['email', 'phone']) {
    await cmd('sms.onboardingChallenge', { channel });
    await cmd('sms.onboardingVerify', { channel, code: '123456' });
  }
  await cmd('sms.onboardingPay');
  await cmd('sms.onboardingPay');
  expect(open).toHaveBeenCalledTimes(2);
  expect(open.mock.calls[0]).toEqual(open.mock.calls[1]);
  await expect(cmd('sms.onboardingSubmit')).rejects.toMatchObject({ code: 'setup_payment_required' });
  const target = open.mock.calls[0]![0];
  const send = (session: Record<string, unknown> = {}, signed = true) => {
    const payload = JSON.stringify({ id: 'evt_synthetic', type: 'checkout.session.completed', livemode: false, account: 'acct_synthetic', data: { object: {
      id: 'cs_test_synthetic', livemode: false, mode: 'payment', payment_status: 'paid', amount_total: 4900, currency: 'usd',
      client_reference_id: target.registration, metadata: { ...target, revision: String(target.revision), purpose: 'flockletter_texting_setup' },
      customer_details: { business_name: business.legalName, address: { line1: business.street, state: business.region, postal_code: business.postalCode, country: 'US' } },
      ...session,
    } } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: signed ? secret : 'whsec_wrong' });
    return testService.onboarding!.stripeEvent(Buffer.from(payload), signature);
  };
  await expect(send({}, false)).rejects.toMatchObject({ code: 'signature_rejected' });
  await expect(send({ amount_total: 48 })).rejects.toMatchObject({ code: 'checkout_mismatch' });
  await expect(send({ id: 'cs_test_other' })).rejects.toMatchObject({ code: 'checkout_mismatch' });
  await send({ payment_status: 'unpaid' });
  await expect(cmd('sms.onboardingSubmit')).rejects.toMatchObject({ code: 'setup_payment_required' });
  await Promise.all([send(), send()]);
  await expect(cmd('sms.onboardingSubmit')).resolves.toEqual({ submitted: true });
  const verified = await db.read(c.workspaceId, sql => sql.query("SELECT 1 FROM sms_audit WHERE action='onboarding.checkout_verified'"));
  expect(verified.rowCount).toBe(1);
});
afterAll(async () => { await db?.close(); await fixture?.stop(); });

it('resumes the verified and paid owner flow, isolates EIN claims and holds a failed first broadcast cohort', async () => {
  for (const actor of [a, b]) {
    await mutation(actor, 'sms.onboardingSave', { expectedRevision: null, business, accepted: true });
    expect(await status(actor)).toMatchObject({ revision: 1, state: 'draft', business: { legalName: business.legalName } });
    await expect(mutation(actor, 'sms.onboardingPay')).rejects.toMatchObject({ code: 'identity_unverified' });
    for (const channel of ['email', 'phone']) {
      expect(await mutation(actor, 'sms.onboardingChallenge', { channel })).toMatchObject({ captureCode: '123456' });
      expect(await mutation(actor, 'sms.onboardingVerify', { channel, code: '999999' })).toMatchObject({ verified: false });
      expect(await mutation(actor, 'sms.onboardingVerify', { channel, code: '123456' })).toMatchObject({ verified: true });
    }
    await expect(mutation(actor, 'sms.onboardingSubmit')).rejects.toMatchObject({ code: 'setup_payment_required' });
  }
  await expect(run(b, 'sms.onboardingStatus', { companyId: ids.get(a.workspaceId) })).rejects.toMatchObject({ code: 'not_found' });
  await expect(run({ ...a, owner: false }, 'sms.onboardingStatus', { companyId: ids.get(a.workspaceId) })).rejects.toMatchObject({ code: 'owner_required' });
  expect(await mutation(a, 'sms.onboardingPay', { result: 'declined' })).toEqual({ paid: false });
  const receipt = () => mutation(a, 'sms.onboardingPay');
  expect(await Promise.all([receipt(), receipt()])).toEqual([{ paid: true }, { paid: true }]);
  expect(await mutation(b, 'sms.onboardingPay')).toEqual({ paid: false });
  expect(await status(b)).toMatchObject({ state: 'review', checkout: 'unpaid' });
  await expect(mutation(b, 'sms.onboardingSubmit')).rejects.toMatchObject({ code: 'onboarding_review' });

  const submit = () => mutation(a, 'sms.onboardingSubmit');
  expect(await Promise.all([submit(), submit()])).toEqual([{ submitted: true }, { submitted: true }]);
  for (let i = 0; i < 5; i++) await tick(a);
  expect(await status(a)).toMatchObject({ state: 'approved', checkout: 'paid' });
  const facts = await db.read(a.workspaceId, async sql => ({
    payments: (await sql.query(`SELECT 1 FROM sms_audit WHERE action='onboarding.checkout_capture' AND new_value->>'state'='paid'`)).rowCount,
    numbers: (await sql.query<{ id: string; provider_sid: string; messaging_service_sid: string }>('SELECT * FROM sms_numbers')).rows,
    account: await texting.registration.account(sql, a.workspaceId),
  }));
  expect(facts.payments).toBe(1);
  expect(facts.numbers).toHaveLength(1);

  // Carrier evidence is bound to the owning account and exact number and survives duplicate events.
  const number = facts.numbers[0]!;
  await db.tenant(a.workspaceId, async sql => {
    await sql.query("UPDATE sms_numbers SET state='reserved' WHERE id=$1", [number.id]);
    await sql.query("UPDATE sms_registrations SET state='campaign_pending'");
  });
  const raw = Buffer.from(JSON.stringify([{
    id: 'CE-synthetic-number', type: 'com.twilio.messaging.compliance.number-registration.successful', time: new Date(clock).toISOString(),
    data: { accountsid: facts.account!.accountSid, externalstatus: 'registered', messagingservicesid: number.messaging_service_sid, phonenumbersid: number.provider_sid },
  }]));
  const url = origin + '/api/v1/texting/twilio/carrier-events?bodySHA256=' + createHash('sha256').update(raw).digest('hex');
  await expect(texting.carrierEvents(url, raw, twilioSignature(url, {}, 'wrong'))).rejects.toMatchObject({ code: 'signature_rejected' });
  const signature = twilioSignature(url, {}, facts.account!.authToken);
  await texting.carrierEvents(url, raw, signature);
  await texting.carrierEvents(url, raw, signature);
  await tick(a);
  expect(await status(a)).toMatchObject({ state: 'approved' });

  // Fictional opted-in contacts let the worker exercise its real queue admission rules.
  const company = ids.get(a.workspaceId)!;
  for (const phone of ['+12125550121', '+12125550122']) {
    const result = await run<{ contactId: string }>(a, 'sms.addContact', { operationKey: randomUUID(), companyId: company, phone });
    await db.tenant(a.workspaceId, sql => sql.query("UPDATE sms_consents SET state='opted_in' WHERE contact_id=$1", [result.contactId]));
  }
  const draft = await run<{ id: string; revision: number }>(a, 'sms.draft', {
    operationKey: randomUUID(), companyId: company, body: (await status(a)).samples[0],
  });
  const review = await run<{ digest: string; gaps: string[]; preview: string }>(a, 'sms.review', { id: draft.id, expectedRevision: draft.revision });
  expect(review.preview).toBe("Robin's Garden LLC: Our latest business update is available. Reply STOP to opt out.");
  expect(review.gaps).toEqual([]);
  const custom = await run<{ id: string; revision: number }>(a, 'sms.draft', {
    operationKey: randomUUID(), companyId: company, body: 'Here is a different update.',
  });
  const customReview = await run<{ gaps: string[] }>(a, 'sms.review', { id: custom.id, expectedRevision: custom.revision });
  expect(customReview.gaps).toContain('probation_template_required');
  await run(a, 'sms.confirm', { operationKey: randomUUID(), id: draft.id, expectedRevision: draft.revision, digest: review.digest });
  clock = Date.UTC(new Date(clock).getUTCFullYear(), new Date(clock).getUTCMonth(), new Date(clock).getUTCDate() + 1, 18);
  await texting.operator('platform.textingMock', {
    operationKey: randomUUID(), workspaceId: a.workspaceId, action: { kind: 'fault', target: 'send', faults: ['undelivered'] },
  }, operator);
  await tick(a);
  clock += 65_000;
  await tick(a);
  const result = await run<{ counts: { state: string; reason: string; n: number }[] }>(a, 'sms.sendStatus', { id: draft.id });
  expect(result.counts).toEqual(expect.arrayContaining([
    expect.objectContaining({ state: 'undelivered', n: 1 }), expect.objectContaining({ state: 'pending', reason: 'probation_paused', n: 1 }),
  ]));
});
