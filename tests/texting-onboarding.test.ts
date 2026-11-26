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
const sole = owner('org_onboarding_sole'), hosted = owner('org_onboarding_hosted'), secondHosted = owner('org_onboarding_hosted_other');
const retryOrg = owner('org_retrying_enrollment'), draftOrg = owner('org_private_draft'), racing = owner('org_check_lease');
const business = {
  legalName: 'Robin’s Garden LLC', ein: '00-0072321', businessType: 'Limited Liability Corporation', vertical: 'RETAIL',
  website: 'https://garden.example.test', privacyPolicyUrl: 'https://garden.example.test/privacy', smsTermsUrl: 'https://garden.example.test/terms',
  street: '1 Example Street', city: 'New York', region: 'NY', postalCode: '10001',
  firstName: 'Sample', lastName: 'Owner', title: 'Owner', email: 'owner@garden.example.test', phone: '+12125550120',
};
// The mock carrier never needs to fetch an unrelated business site. The preflight still parses all four fixture pages.
const readEnrollmentPage = async (url: string) => {
  const canonical = new URL(url);
  const page = canonical.origin + canonical.pathname.replace('/signup/', '/business/');
  const links = `<a href="${business.privacyPolicyUrl}">Privacy</a><a href="${business.smsTermsUrl}">Terms</a><a href="${page}/privacy">Hosted privacy</a><a href="${page}/sms-terms">Hosted terms</a>`;
  return `<p>Business news. We do not share mobile opt-in data for marketing. Frequency varies. Msg and data rates may apply. Reply STOP to opt out and HELP for help.</p><input type="checkbox" name="smsConsent">${links}`;
};
const operator = { userId: 'operator', via: 'operator_api' } as const;
let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database, service: CommandService, texting: Texting;
let clock = 0;
const ids = new Map<string, string>();
const settings = {
  carrier_daily_limit: 100, monthly_segment_allowance: 1000, probation_canary_count: 1,
  probation_canary_minutes: 1, probation_min_days: 2, probation_delivered_min: 2,
  probation_risk_window_days: 2, probation_risk_minimum: 9, probation_pause_optout_bps: 2500, probation_suspend_optout_bps: 4000,
    probation_pause_filter_bps: 2500, probation_suspend_filter_bps: 4000, probation_initial_days: 1, probation_initial_daily_limit: 10, probation_daily_limit: 20,
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
  texting = Texting.mock(db, { origin, linkOrigin: origin + '/l', isOwner: checkOwner, onboardingCapture: true, readEnrollmentPage, evidenceReviewers:[operator.userId,"backup-reviewer"], now: () => new Date(clock) });
  service = new CommandService(db, undefined, checkOwner);
  Object.assign(service, { customer: { texting, owns: () => false } });
  const audience = new CustomerAudience(db, { origin, mode: 'exercise', checkOwner, contactLimit: async () => 250, texting });
  for (const actor of [a, b, c, sole, hosted, secondHosted, retryOrg, draftOrg, racing]) {
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
  const testService = Texting.mock(db, { origin, linkOrigin: origin + '/l', isOwner: async () => true, onboardingCapture: true, readEnrollmentPage, onboardingStripe: payment });
  const companyId = ids.get(c.workspaceId)!;
  const open = vi.spyOn(payment, 'open').mockResolvedValue({ id: 'cs_test_synthetic', url: 'https://checkout.stripe.com/test' });
  const cmd = (name: Parameters<Texting['execute']>[0], input: Record<string, unknown> = {}) =>
    testService.execute(name, { operationKey: randomUUID(), companyId, expectedRevision: 1, ...input }, c, 'api');
  await cmd('sms.onboardingSave', { business: { ...business, ein: '00-0072322' }, accepted: true, expectedRevision: null });
  for (const channel of ['email', 'phone']) {
    const { captureCode } = await cmd('sms.onboardingChallenge', { channel }) as { captureCode:string };
    await cmd('sms.onboardingVerify', { channel, code:captureCode });
  }
  await cmd('sms.onboardingPay');
  await cmd('sms.onboardingPay');
  expect(open).toHaveBeenCalledTimes(2);
  expect(open.mock.calls[0]).toEqual(open.mock.calls[1]);
  await expect(cmd('sms.onboardingSubmit')).rejects.toMatchObject({ code: 'setup_payment_required' });
  const target = open.mock.calls[0]![0];
  const send = (session: Record<string, unknown> = {}, signed = true, type = 'checkout.session.completed', eventId = 'evt_synthetic') => {
    const payload = JSON.stringify({ id: eventId, type, livemode: false, account: 'acct_synthetic', data: { object: {
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
  await send({ payment_status:'unpaid', status:'expired' }, true, 'checkout.session.expired', 'evt_expired');
  expect((await testService.execute('sms.onboardingStatus', {companyId}, c, 'api') as OnboardingView).checkout).toBe('declined');
  await expect(send({},true,'checkout.session.completed','evt_conflicting')).rejects.toMatchObject({code:'checkout_reconciliation_required'});
  open.mockResolvedValue({id:'cs_test_second',url:'https://checkout.stripe.com/test2'});
  await Promise.all([cmd('sms.onboardingPay'), cmd('sms.onboardingPay')]);
  expect(open.mock.calls.at(-1)![2]).not.toBe(open.mock.calls[0]![2]);
  expect(open.mock.calls.at(-1)).toEqual(open.mock.calls.at(-2));
  await send(); // A delayed signed event for the superseded attempt cannot unlock the new one.
  await expect(cmd('sms.onboardingSubmit')).rejects.toMatchObject({code:'setup_payment_required'});
  const metadata = { ...target, revision:String(target.revision), attempt:'2',purpose:'flockletter_texting_setup' };
  await expect(send({id:'cs_test_second',metadata:{...metadata,plan:'text_1000'}},true,'checkout.session.completed','evt_wrong_plan')).rejects.toMatchObject({code:'checkout_mismatch'});
  const latest = {id:'cs_test_second',metadata};
  await Promise.all([send(latest, true, 'checkout.session.completed','evt_new'), send(latest, true, 'checkout.session.completed','evt_new')]);
  await expect(cmd('sms.onboardingSave',{business:{...business,ein:'00-0072322',plan:'text_1000'},accepted:true})).rejects.toMatchObject({code:'paid_enrollment_locked'});
  await send({...latest, payment_status:'unpaid'}, true,'checkout.session.async_payment_failed','evt_stale_failure');
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
      const { captureCode } = await mutation(actor, 'sms.onboardingChallenge', { channel }) as { captureCode:string };
      expect(captureCode).toMatch(/^\d{6}$/);
      const wrong = captureCode === '999999' ? '888888' : '999999';
      expect(await mutation(actor, 'sms.onboardingVerify', { channel, code:wrong })).toMatchObject({ verified: false });
      expect(await mutation(actor, 'sms.onboardingVerify', { channel, code:captureCode })).toMatchObject({ verified: true });
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

  await texting.operator('platform.textingOnboardingReview', {operationKey:randomUUID(),workspaceId:b.workspaceId,
    companyId:ids.get(b.workspaceId),expectedRevision:1,action:'request_correction',reason:'Private operator investigation note.'},operator);
  const correction = await status(b);
  expect(correction).toMatchObject({state:'correction_required',message:expect.stringContaining('EIN')});
  expect(JSON.stringify(correction)).not.toContain('Private operator investigation note');
  await expect(mutation(b,'sms.onboardingChallenge',{channel:'email'})).rejects.toMatchObject({code:'enrollment_correction_required'});
  await mutation(b,'sms.onboardingSave',{accepted:true,business:{...business,ein:'00-0900812'}});
  expect(await status(b)).toMatchObject({state:'draft',revision:2,message:null,verified:{email:false,phone:false}});

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
  for (const phone of ['+12125550121', '+12125550122', '+12125550123']) {
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
    operationKey: randomUUID(), workspaceId: a.workspaceId, action: { kind: 'fault', target: 'send', faults: ['failed'] },
  }, operator);
  await tick(a);
  clock += 65_000;
  await tick(a);
  const result = await run<{ counts: { state: string; reason: string; n: number }[] }>(a, 'sms.sendStatus', { id: draft.id });
  expect(result.counts).toEqual(expect.arrayContaining([
    expect.objectContaining({ state: 'failed', n: 1 }), expect.objectContaining({ state: 'pending', reason: 'probation_paused', n: 2 }),
  ]));
  const registration = (workspaceId: string) => texting.operator('platform.textingRegistration', { workspaceId }, operator);
  expect(await registration(a.workspaceId)).toMatchObject({ registrations: [{ probationState: 'paused', firstBroadcast: [
    { first: true, state: 'failed', reason: 'twilio_30005', texts: 1, attempts: 1 },
    { first: false, state: 'pending', reason: 'probation_paused', texts: 2, attempts: 0 },
  ] }] });
  expect(await registration(b.workspaceId)).toMatchObject({ registrations: [{ firstBroadcast: [] }] });
  expect((await status(a)).notices.some(n => n.message.startsWith('Sending paused.'))).toBe(true);
  expect(await run(a, 'sms.status')).toMatchObject({companies:[{canSend:false,sendingHold:'probation_paused'}]});
  await expect(texting.operator('platform.textingOnboardingReview', {workspaceId:a.workspaceId,companyId:company,expectedRevision:1,
    operationKey:randomUUID(),action:'complete_probation',reason:'Try ending probation while the first cohort is held.'},operator)).rejects.toMatchObject({code:'registration_not_approved'});
  const resume = () => mutation(a,'sms.onboardingResume',{ reason:'Reviewed the synthetic recipient failure and prepared a new cohort.' });
  expect(await resume()).toEqual({resumed:true});
  await expect(resume()).rejects.toMatchObject({ code:'probation_state_changed' });
  await tick(a);
  expect(await status(a)).toMatchObject({probation:'awaiting_canary'});
  expect(await db.read(a.workspaceId,sql=>sql.query(`SELECT state,attempts FROM sms_messages WHERE send_id=$1 AND state='cancelled'`,[draft.id]).then(r=>r.rows)))
    .toEqual([{state:'cancelled',attempts:0},{state:'cancelled',attempts:0}]);
});


async function practiceVerify(actor: Actor, channel: string) {
  const { captureCode } = await mutation(actor, 'sms.onboardingChallenge', {channel}) as {captureCode: string};
  expect(await mutation(actor,'sms.onboardingVerify',{channel,code:captureCode})).toEqual({verified:true});
}

it('completes an authorized setup once and requires a separate carrier verification for the practice sole proprietor', async () => {
  await mutation(sole,'sms.onboardingSave',{expectedRevision:null,accepted:true,business:{...business,
    registrationType:'sole_proprietor',legalName:'Robin Garden',ein:'',plan:'text_300',phone:'+12125550140'}});
  await practiceVerify(sole,'email');
  await practiceVerify(sole,'phone');
  const finish = (amount=4900, monthly=1900) => mutation(sole,'sms.onboardingFinish',{
    acceptedPlan:'text_300',acceptedMonthlyUsdCents:monthly,acceptedFee:amount,currency:'USD'});
  await expect(finish()).rejects.toMatchObject({code:'identity_unverified'});
  await practiceVerify(sole,'carrier');
  await expect(finish(4900,3900)).rejects.toMatchObject({code:'setup_agreement_changed'});
  await expect(finish(9900)).rejects.toMatchObject({code:'setup_agreement_changed'});
  expect(await Promise.all([finish(),finish()])).toEqual([{submitted:true},{submitted:true}]);
  for(let pass=0;pass<7;pass++) await tick(sole);
  const view=await status(sole);
  expect(view).toMatchObject({state:'approved',checkout:'paid',requiredChannels:['email','phone','carrier']});
  expect(view.notices.filter(n=>n.message === 'Registration approved. Your assigned number is active.')).toHaveLength(1);
  const sender = () => run(sole, 'sms.status');
  expect(await sender()).toMatchObject({companies:[{registration:'approved',numberState:'active',canSend:false,sendingHold:'texting_setting_required'}]});
  for (const [key, value] of Object.entries(settings)) {
    await texting.operator('platform.textingSetSetting', {workspaceId:sole.workspaceId,operationKey:randomUUID(),key,value,expectedRevision:0,
      reason:'Synthetic workspace sending-readiness exercise.'},operator);
    if (key === 'monthly_segment_allowance') expect(await sender()).toMatchObject({companies:[{canSend:false,sendingHold:'probation_settings_required'}]});
  }
  expect(await sender()).toMatchObject({companies:[{canSend:true,sendingHold:null}]});
  expect(await db.read(sole.workspaceId,sql=>sql.query("SELECT id FROM sms_audit WHERE action='onboarding.checkout_capture'").then(r=>r.rowCount))).toBe(1);
});

it('keeps domainless practice ownership in review until a bound synthetic letter is accepted',async()=>{
  await mutation(hosted,'sms.onboardingSave',{expectedRevision:null,accepted:true,business:{...business,ein:'00-9400041',
    hostedPages:true,description:'Fictional gardening updates.',publicContact:'help@example.test',website:'',smsTermsUrl:'',privacyPolicyUrl:''}});
  expect(await status(hosted)).toMatchObject({state:'review',review:'hosted_ownership',pageCheck:{issues:[]}});
  const review=()=>texting.operator('platform.textingOnboardingReview',{operationKey:randomUUID(),workspaceId:hosted.workspaceId,
    companyId:ids.get(hosted.workspaceId),expectedRevision:1,action:'accept_evidence',reason:'Reviewed the attached synthetic ownership evidence.'},{...operator,mfaAt:new Date(clock).toISOString()});
  await expect(review()).rejects.toMatchObject({code:'evidence_unavailable'});
  await expect(mutation(sole,'sms.onboardingEvidence',{companyId:ids.get(hosted.workspaceId),document:'CP575'})).rejects.toMatchObject({code:'not_found'});
  const template = (await status(hosted)).evidenceFiles!.CP575!;
  await expect(mutation(hosted,'sms.onboardingEvidence',{document:'147C',contents:template})).rejects.toMatchObject({code:'practice_letter_mismatch'});
  await expect(mutation(hosted,'sms.onboardingEvidence',{document:'CP575',contents:template.replace('revision: 1','revision: 2')})).rejects.toMatchObject({code:'practice_letter_mismatch'});
  await mutation(secondHosted,'sms.onboardingSave',{expectedRevision:null,accepted:true,business:{...business,ein:'00-9400042',hostedPages:true,
    description:'Fictional second garden.',publicContact:'care@example.test',website:'',smsTermsUrl:'',privacyPolicyUrl:''}});
  const other = (await status(secondHosted)).evidenceFiles!.CP575!;
  await expect(mutation(hosted,'sms.onboardingEvidence',{document:'CP575',contents:other})).rejects.toMatchObject({code:'practice_letter_mismatch'});
  await mutation(hosted,'sms.onboardingEvidence',{document:'CP575',contents:template});
  expect((await status(hosted)).evidence).toMatchObject({document:'CP575',source:'upload',fingerprint:expect.stringMatching(/^[0-9a-f]{64}$/)});
  await practiceVerify(hosted,'phone'); await practiceVerify(hosted,'email');
  const finish=()=>mutation(hosted,'sms.onboardingFinish',{acceptedFee:4900,currency:'USD'});
  await expect(finish()).rejects.toMatchObject({code:'onboarding_review'});
  expect(await texting.operator('platform.textingRegistration',{workspaceId:hosted.workspaceId},operator)).toMatchObject({reviewQueue:[{reason:'hosted_ownership'}]});
  const caseId=(await status(hosted)).evidence!.caseId!;
  const viewParams={workspaceId:hosted.workspaceId,companyId:ids.get(hosted.workspaceId)!,caseId,action:'view',operationKey:randomUUID()};
  await expect(texting.operator('platform.textingEvidenceCase',viewParams,operator)).rejects.toMatchObject({code:'operator_mfa_required'});
  await expect(review()).rejects.toMatchObject({code:'evidence_view_required'});
  const verified={...operator,mfaAt:new Date(clock).toISOString()};
  await expect(texting.operator('platform.textingEvidenceCase',{...viewParams,workspaceId:secondHosted.workspaceId,companyId:ids.get(secondHosted.workspaceId)},verified)).rejects.toMatchObject({code:'evidence_unavailable'});
  await expect(texting.operator('platform.textingEvidenceCase',viewParams,{...verified,userId:'unassigned'})).rejects.toMatchObject({code:'evidence_reviewer_required'});
  await expect(texting.operator('platform.textingEvidenceCase',viewParams,{...verified,userId:'backup-reviewer'})).rejects.toMatchObject({code:'evidence_assignment_required'});
  expect(await texting.operator('platform.textingEvidenceCase',viewParams,verified)).toEqual({contents:template});
  await review();
  expect(await finish()).toMatchObject({submitted:true});
  for(let pass=0;pass<7;pass++) await tick(hosted);
  expect(await status(hosted)).toMatchObject({state:'approved',publicPages:{website:expect.stringContaining('/business/')}});
});


it('binds browser draft access to the authenticated owner, company and editable revision', async () => {
  const cmd = (user: Actor, companyId: string, revision: number | null) => texting.execute('sms.onboardingDraftAccess',
    { companyId, expectedRevision:revision, operationKey:randomUUID() }, user, 'ui') as Promise<{id:string;key:string}>;
  const company = ids.get(draftOrg.workspaceId)!;
  const [one, two] = await Promise.all([cmd(draftOrg,company,null),cmd(draftOrg,company,null)]);
  expect(one).toEqual(two);
  expect((await status(draftOrg)).draftId).toBe(one.id);
  expect(Buffer.from(one.key,'base64')).toHaveLength(32);
  expect(JSON.stringify(await status(draftOrg))).not.toContain(one.key);
  await expect(cmd(retryOrg,company,null)).rejects.toMatchObject({code:'not_found'});
  await expect(cmd({...draftOrg,owner:false},company,null)).rejects.toMatchObject({code:'owner_required'});
  const sibling = randomUUID();
  await db.tenant(draftOrg.workspaceId,sql=>sql.query('INSERT INTO companies(workspace_id,id,name) VALUES($1,$2,$3)',[draftOrg.workspaceId,sibling,'Private draft sibling']));
  expect((await cmd(draftOrg,sibling,null)).key).not.toBe(one.key);
  const other = {...draftOrg,userId:'another-owner',actorId:'user:another-owner'};
  const multiOwner = Texting.mock(db, {origin,linkOrigin:origin+'/l',isOwner:async()=>true,onboardingCapture:true,readEnrollmentPage});
  const otherAccess = await multiOwner.execute('sms.onboardingDraftAccess',{companyId:company,expectedRevision:null,operationKey:randomUUID()},other,'ui');
  expect(otherAccess).not.toEqual(one);
  await mutation(draftOrg,'sms.onboardingSave',{expectedRevision:null,accepted:true,business});
  await expect(cmd(draftOrg,company,null)).rejects.toMatchObject({code:'revision_conflict'});
  expect((await cmd(draftOrg,company,1)).key).not.toBe(one.key);
  await expect(multiOwner.execute('sms.onboardingDraftAccess',{companyId:company,expectedRevision:1,operationKey:randomUUID()},other,'ui'))
    .rejects.toMatchObject({code:'enrollment_unavailable'});
});

it('retries temporary page failures without a browser, recovers a lost lease and stops after the retry budget', async () => {
  let offline = true;
  const read = vi.fn(async (url: string) => {
    if (offline && url === business.website) throw Error('Temporary site outage');
    return readEnrollmentPage(url);
  });
  const service = Texting.mock(db,{origin,linkOrigin:origin+'/l',onboardingCapture:true,isOwner:async()=>true,now:()=>new Date(clock),readEnrollmentPage:read});
  const companyId = ids.get(retryOrg.workspaceId)!;
  const save = (revision: number | null) => service.execute('sms.onboardingSave',{companyId,expectedRevision:revision,operationKey:randomUUID(),business,accepted:true},retryOrg,'ui');
  const readView = () => service.execute('sms.onboardingStatus',{companyId},retryOrg,'ui') as Promise<OnboardingView>;
  const worker = () => service.tick(retryOrg.workspaceId);
  await save(null);
  expect((await readView()).pageCheck).toMatchObject({attempts:1,retryAt:expect.any(String)});
  await worker();
  expect(read).toHaveBeenCalledTimes(4);
  offline = false;
  clock += 60_001;
  await Promise.all([worker(),worker()]);
  expect(read).toHaveBeenCalledTimes(8);
  expect((await readView()).pageCheck).toMatchObject({attempts:2,issues:[]});
  offline = true;
  await save(1);
  for (const delay of [60_001,300_001,900_001]) { clock += delay; await worker(); }
  const exhausted = (await readView()).pageCheck!;
  expect(exhausted.attempts).toBe(4);
  expect(exhausted.retryAt).toBeUndefined();
  const calls = read.mock.calls.length;
  clock += 3_600_000;
  await worker();
  expect(read).toHaveBeenCalledTimes(calls);
  await db.tenant(retryOrg.workspaceId,sql=>sql.query(`UPDATE sms_carrier_brands SET profile=jsonb_set(profile,'{onboarding,pendingScan}',$1::jsonb)
    WHERE company_id=$2`,[JSON.stringify({id:randomUUID(),at:clock-61_000,attempt:1}),companyId]));
  offline = false;
  await worker();
  expect((await readView()).pageCheck).toMatchObject({attempts:2,issues:[]});
  expect((await readView()).state).toBe('draft');
});

it('waits for the current page check before submission and ignores a late response from a previous lease', async () => {
  let visit = 0;
  let started!: () => void, release!: (html: string) => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const delayed = new Promise<string>(resolve => { release = resolve; });
  const test = Texting.mock(db,{origin,linkOrigin:origin+'/l',onboardingCapture:true,isOwner:async()=>true,
    now:()=>new Date(clock),readEnrollmentPage:async url => {
      if (url === business.website) {
        visit++;
        if (visit === 2) { started(); return delayed; }
        if (visit === 3) return '';
      }
      return readEnrollmentPage(url);
    }});
  const companyId = ids.get(racing.workspaceId)!;
  const ctx = { companyId, expectedRevision:1, operationKey:randomUUID() };
  await test.execute('sms.onboardingSave',{...ctx,expectedRevision:null,accepted:true,business},racing,'ui');
  for (const channel of ['email','phone']) {
    const response = await test.execute('sms.onboardingChallenge',{...ctx,operationKey:randomUUID(),channel},racing,'ui') as {captureCode:string};
    await test.execute('sms.onboardingVerify',{...ctx,operationKey:randomUUID(),channel,code:response.captureCode},racing,'ui');
  }
  clock += 6_000;
  const first = test.execute('sms.onboardingScan',ctx,racing,'ui');
  await reading;
  try {
    await expect(test.execute('sms.onboardingFinish',{...ctx,operationKey:randomUUID(),acceptedFee:4900,currency:'USD'},racing,'ui'))
      .rejects.toMatchObject({code:'website_check_required'});
    clock += 61_000;
    await test.execute('sms.onboardingScan',ctx,racing,'ui');
  } finally { release('<p>Late successful response</p>'); await first; }
  const current = await test.execute('sms.onboardingStatus',{companyId},racing,'ui') as OnboardingView;
  expect(current.pageCheck?.issues).toEqual([{page:'website',message:'Publish a readable business website page.'}]);
  expect(current.checkout).toBe('unpaid');
});

it('retains a held fictional letter, audits its deletion, and refuses an older restored receipt', async () => {
  const owner = secondHosted,
    workspace = owner.workspaceId,
    companyId = ids.get(workspace)!;
  const template = (await status(owner)).evidenceFiles!.CP575!;
  await mutation(owner, 'sms.onboardingEvidence', { document: 'CP575', contents: template });
  const caseId = (await status(owner)).evidence!.caseId!;
  let reviewService=texting;
  const action = (
    name: 'view' | 'claim' | 'hold' | 'release_hold',
    extra: Record<string, string> = {},
    userId: string = operator.userId,
  ) =>
    reviewService.operator(
      'platform.textingEvidenceCase',
      { operationKey: randomUUID(), workspaceId: workspace, companyId, caseId, action: name, ...extra },
      { ...operator, userId, mfaAt: new Date(clock).toISOString() },
    );
  const snapshot = await db.read(
    workspace,
    async (sql) =>
      (await sql.query('SELECT profile FROM sms_carrier_brands WHERE company_id=$1', [companyId])).rows[0]!
        .profile,
  );
  const recoveryId='texting-letter/'+caseId;
  const reference=await db.read(workspace,async sql=>(await sql.query("SELECT body FROM platform_exercise_records WHERE kind='hold' AND id=$1",[recoveryId])).rows[0]!.body);
  expect(JSON.stringify(reference)).not.toContain('FLOCKLETTER STAGING PRACTICE');
  await action('claim', {}, 'backup-reviewer');
  await expect(action('view')).rejects.toMatchObject({ code: 'evidence_assignment_required' });
  await expect(
    action(
      'hold',
      { holdReason: 'legal_hold', reviewAt: new Date(clock - 1).toISOString() },
      'backup-reviewer',
    ),
  ).rejects.toMatchObject({ code: 'review_date_required' });
  await action(
    'hold',
    { holdReason: 'legal_hold', reviewAt: new Date(clock + 86400000).toISOString() },
    'backup-reviewer',
  );
  await mutation(owner, 'sms.onboardingCorrect');
  expect(await status(owner)).toMatchObject({ state: 'correction_required' });
  const initial = clock;
  try {
    // A replacement web instance starts with an empty filesystem. An intact current hold
    // recovers the exact uploaded fixture despite both ordinary deadlines having passed.
    reviewService=new Texting(db,{...texting.options});
    clock += 31 * 86400000;
    expect(await action('view', {}, 'backup-reviewer')).toEqual({ contents: template });
    await action('release_hold', {}, 'backup-reviewer');
    await expect(action('view', {}, 'backup-reviewer')).rejects.toMatchObject({ code: 'evidence_expired' });
    await reviewService.tick(workspace);
    const facts = await db.read(
      workspace,
      async (sql) =>
        (
          await sql.query(
            `SELECT action,new_value FROM sms_audit WHERE new_value->>'caseId'=$1 ORDER BY at`,
            [caseId],
          )
        ).rows,
    );
    expect(facts.map((f) => f.action)).toEqual(
      expect.arrayContaining([
        'onboarding.evidence_viewed',
        'onboarding.evidence_hold',
        'onboarding.evidence_closed',
        'onboarding.evidence_deleted',
      ]),
    );
    expect(JSON.stringify(facts)).not.toContain(template);
    expect(facts.find((f) => f.action === 'onboarding.evidence_deleted').new_value).toMatchObject({
      company: companyId,
      document: 'CP575',
      outcome: 'correction',
    });
    const stored = await db.read(
      workspace,
      async (sql) => (await sql.query('SELECT result FROM operations')).rows,
    );
    expect(stored.some((r) => JSON.stringify(r.result).includes('FLOCKLETTER STAGING PRACTICE'))).toBe(false);
    // Restore the earlier metadata alone; it cannot recreate the original even if the clock is rolled back.
    await db.tenant(workspace, (sql) =>
      sql.query('UPDATE sms_carrier_brands SET profile=$1 WHERE company_id=$2', [snapshot, companyId]),
    );
    clock = initial;
    await expect(action('view')).rejects.toMatchObject({ code: 'evidence_expired' });
    expect((await status(owner)).evidence).toBeNull();
    // Replaying both logical records gives the recovery reference a new PostgreSQL row version.
    await db.tenant(workspace,sql=>sql.query("UPDATE platform_exercise_records SET body=$1 WHERE kind='hold' AND id=$2",[reference,recoveryId]));
    await expect(action('view')).rejects.toMatchObject({code:'evidence_expired'});
    reviewService=texting;
    await expect(action('view')).rejects.toMatchObject({code:'evidence_expired'});
    await reviewService.tick(workspace);
    expect(await texting.onboarding!.letters.retention(snapshot.practiceEvidenceCases[caseId])).toBeNull();
  } finally {
    clock = initial;
  }
});
