import { randomUUID } from 'node:crypto';
import type { OnboardingBusiness, OnboardingView, TextingOnboardingCommand } from '../../shared/texting-onboarding.js';
import { textingOnboardingCommands as commands } from '../../shared/texting-onboarding.js';
import { businessRefusals, twilioBusiness } from '../../shared/texting-business.js';
import type { Database, Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import type { Actor } from '../service.js';
import { lockWorkspace } from '../workspace-lock.js';
import { signupPage, type TextingRegistration } from './registration.js';
import { textingSetupFee as setupFee, type SetupReceipt, type StripeTestSetupPayment } from './setup-payment.js';
import { audit, once, requestHash, type Interface } from './storage.js';

const policyVersion = 'sms-enrollment-v1';
const captureCode = '123456';
const publicMailHosts = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com']);
type Channel = 'email' | 'phone';
type Challenge = { issuedAt: number; attempts: number; verified: boolean };
type Enrollment = {
  revision: number; owner: string; acceptedAt: string; policyVersion: string;
  challenges: Partial<Record<Channel, Challenge>>;
  payment?: { state: 'paid' | 'declined' | 'pending'; source: 'capture' | 'stripe_test'; receipt: string;
    amount: number; currency: string; revision: number; requestedAt?: number; sessionId?: string };
  review?: 'ein_conflict' | 'payer_mismatch';
  submittedAt?: string;
  probation?: { state: 'canary' | 'paused' | 'active' | 'complete'; startsAt: string; sendId?: string; members?: string[]; overrideAt?: string };
};
type Row = {
  id: string; registration_id: string; state: string; legal_name: string; rejection_reason: string | null;
  profile: Record<string, unknown> & { onboarding?: Enrollment; campaign?: { samples: string[] } };
};

function campaign(business: OnboardingBusiness) {
  const topics = business.vertical === 'FOOD_AND_BEVERAGE'
    ? ['Reservations are open for our weekend special.', 'Here are our new hours for the holiday weekend.']
    : business.vertical === 'REAL_ESTATE'
      ? ['Our next open house is this Saturday.', 'Our monthly neighborhood update is available.']
      : ['Our latest business update is available.', 'We have new hours for the holiday weekend.'];
  return {
    description: `${business.legalName} sends business updates to subscribers who opt in on its Flockletter sign-up page and confirm by replying YES.`,
    samples: topics.map(topic => `${business.legalName}: ${topic} Reply STOP to opt out.`),
    useCase: 'LOW_VOLUME',
  };
}

function readBusiness(row: Row): OnboardingBusiness {
  const profile = row.profile;
  const address = profile.address as { street: string; city: string; region: string; postalCode: string };
  return commands['sms.onboardingSave'].schema.shape.business.parse({
    legalName: row.legal_name, ein: profile.ein, businessType: profile.businessType, vertical: profile.vertical,
    website: profile.website, privacyPolicyUrl: profile.privacyPolicyUrl, smsTermsUrl: profile.smsTermsUrl,
    street: address.street, city: address.city, region: address.region, postalCode: address.postalCode,
    ...(profile.contact as object),
  });
}

function rejectionMessage(reason: string | null) {
  if (reason?.includes('30908') || reason?.includes('30933')) return 'Review the public privacy policy URL and add your SMS privacy disclosures.';
  if (reason?.includes('30882')) return 'Review the public SMS terms URL and make sure it describes the texting program.';
  if (reason?.includes('signup_page_missing')) return 'Enable your Flockletter sign-up page and its mobile number field.';
  return 'The carrier rejected this registration. Review the business information, campaign examples and published SMS policies before correcting it.';
}

export class TextingOnboarding {
  constructor(
    private readonly db: Database,
    private readonly registration: TextingRegistration,
    private readonly origin: string,
    private readonly now: () => Date,
    private readonly stripe?: StripeTestSetupPayment,
  ) {}

  private async row(sql: Sql, companyId: string) {
    const company = await sql.query('SELECT id FROM companies WHERE id=$1', [companyId]);
    requireCondition(company.rowCount, 404, 'not_found', 'This company is unavailable in this workspace.');
    return (await sql.query<Row>(`SELECT b.id,b.legal_name,b.profile,r.id registration_id,r.state,r.rejection_reason
      FROM sms_carrier_brands b JOIN sms_registrations r ON r.carrier_brand_id=b.id WHERE b.company_id=$1`, [companyId])).rows[0];
  }

  private view(row: Row | undefined, user: string): OnboardingView {
    const current = row?.profile.onboarding;
    const owned = current?.owner === user;
    return {
      available: true, blocked: !!row && !owned,
      revision: owned ? current.revision : null,
      business: row && owned && ['draft', 'rejected'].includes(row.state) ? readBusiness(row) : null,
      verified: { email: owned && current.challenges.email?.verified === true, phone: owned && current.challenges.phone?.verified === true },
      checkout: owned ? current.payment?.state ?? 'unpaid' : 'unpaid',
      checkoutMode: this.stripe ? 'stripe_test' : 'capture',
      setupFee, state: owned && current.review ? 'review'
        : owned && row?.state === 'rejected' && !current.submittedAt ? 'draft' : row?.state ?? 'not_started',
      message: owned && current.review
        ? current.review === 'ein_conflict' ? 'This business needs an ownership review before registration.' : 'The payer details need operator review before registration.'
        : row?.state === 'rejected' && owned && current.submittedAt ? rejectionMessage(row.rejection_reason) : null,
      samples: owned ? row?.profile.campaign?.samples ?? [] : [],
    };
  }

  async execute(name: TextingOnboardingCommand, raw: unknown, actor: Actor, via: Interface) {
    const workspace = actor.workspaceId;
    if (name === 'sms.onboardingStatus') {
      const { companyId } = commands[name].schema.parse(raw);
      return this.db.read(workspace, async sql => this.view(await this.row(sql, companyId), actor.userId));
    }
    if (name === 'sms.onboardingPay' && this.stripe) {
      const input = commands[name].schema.parse(raw);
      requireCondition(input.result === 'paid', 422, 'checkout_mode_mismatch', 'Use the Stripe test checkout to exercise payment results.');
      return this.openTestCheckout(actor, via, input.companyId, input.expectedRevision);
    }
    const input = commands[name].schema.parse(raw);
    return this.db.tenant(workspace, async sql => {
      await lockWorkspace(sql, workspace);
      return once(sql, workspace, actor.actorId, input.operationKey, [name, input], async () => {
        const row = await this.row(sql, input.companyId);
        const state = row?.profile.onboarding;
        if (name === 'sms.onboardingSave') {
          const { business, expectedRevision } = commands[name].schema.parse(raw);
          requireCondition(!row || state?.owner === actor.userId, 409, 'registration_managed', 'This company already has a carrier registration managed elsewhere.');
          requireCondition(expectedRevision === (state?.revision ?? null), 409, 'revision_conflict', 'This enrollment changed. Reload it first.');
          requireCondition(!row || row.state === 'draft' || row.state === 'rejected', 409, 'registration_in_progress', 'This enrollment is already with the carrier.');
          requireCondition(!state?.review, 409, 'onboarding_review', 'An operator must resolve the pending review before the enrollment can change.');
          requireCondition(state?.payment?.state !== 'pending', 409, 'checkout_pending', 'Resolve the existing checkout before editing the enrollment.');
          return this.save(sql, actor, via, input.companyId, row, business);
        }
        requireCondition(row && state?.owner === actor.userId, 404, 'enrollment_not_found', 'This enrollment is unavailable.');
        requireCondition(state.revision === input.expectedRevision, 409, 'revision_conflict', 'This enrollment changed. Reload it first.');
        if (name === 'sms.onboardingSubmit' && state.submittedAt) return { submitted: true };
        requireCondition(row.state === 'draft' || row.state === 'rejected', 409, 'registration_in_progress', 'This enrollment is already with the carrier.');
        requireCondition(!state.review, 409, 'onboarding_review', 'An operator must resolve the pending review before registration.');
        const now = this.now().getTime();
        if (name === 'sms.onboardingChallenge') {
          const { channel } = commands[name].schema.parse(raw);
          const previous = state.challenges[channel];
          if (previous?.verified) return { verified: true };
          requireCondition(!previous || now - previous.issuedAt >= 60_000, 429, 'verification_cooldown', 'Wait a minute before requesting another verification code.');
          state.challenges[channel] = { issuedAt: now, attempts: 0, verified: false };
          await this.record(sql, row, state);
          return { verified: false, captureCode };
        }
        if (name === 'sms.onboardingVerify') {
          const { channel, code } = commands[name].schema.parse(raw);
          const attempt = state.challenges[channel];
          if (attempt?.verified) return { verified: true };
          requireCondition(attempt && now - attempt.issuedAt < 600_000 && attempt.attempts < 5, 409, 'verification_expired', 'Request a new verification code.');
          attempt.attempts++;
          attempt.verified = code === captureCode;
          await this.record(sql, row, state);
          if (attempt.verified) await audit(sql, workspace, actor.actorId, via, 'onboarding.verified', row.id, null, { channel, revision: state.revision });
          return { verified: attempt.verified };
        }
        requireCondition(state.challenges.email?.verified && state.challenges.phone?.verified, 409, 'identity_unverified', 'Verify the business email and phone first.');
        if (name === 'sms.onboardingPay') {
          requireCondition(!state.payment || state.payment.source === 'capture', 409, 'checkout_mode_mismatch', 'Use the payment mode that started this checkout.');
          if (state.payment?.state === 'paid') return { paid: true };
          const { result } = commands[name].schema.parse(raw);
          await this.requireSignup(sql, input.companyId);
          if (result === 'paid' && !await this.claimEin(sql, row, state.owner)) {
            state.review = 'ein_conflict';
            await this.record(sql, row, state);
            await audit(sql, workspace, actor.actorId, via, 'onboarding.review', row.id, null, { reason: state.review });
            return { paid: false };
          }
          if (result === 'payer_mismatch') {
            state.review = 'payer_mismatch';
            await this.record(sql, row, state);
            await audit(sql, workspace, actor.actorId, via, 'onboarding.review', row.id, null, { reason: state.review });
            return { paid: false };
          }
          state.payment = { ...setupFee, source: 'capture', state: result, receipt: 'capture/' + row.registration_id + '/' + state.revision, revision: state.revision };
          await this.record(sql, row, state);
          await audit(sql, workspace, actor.actorId, via, 'onboarding.checkout_capture', row.id, null, { revision: state.revision, state: result });
          return { paid: result === 'paid' };
        }
        requireCondition(state.payment?.state === 'paid' && state.payment.revision === state.revision &&
          state.payment.amount === setupFee.amount && state.payment.currency === setupFee.currency &&
          state.payment.source === (this.stripe ? 'stripe_test' : 'capture'),
        409, 'setup_payment_required', 'Complete the setup payment before submitting.');
        await this.requireSignup(sql, input.companyId);
        state.submittedAt = this.now().toISOString();
        await this.record(sql, row, state);
        await this.registration.submit(sql, workspace, row.registration_id, actor.actorId, via, true);
        return { submitted: true };
      });
    });
  }

  private async requireSignup(sql: Sql, companyId: string) {
    requireCondition(await signupPage(sql, companyId, this.origin), 409, 'signup_page_missing',
      'Enable a Flockletter sign-up page for this company and turn on the mobile number field in Texting settings.');
  }

  private async openTestCheckout(actor: Actor, via: Interface, companyId: string, revision: number) {
    const workspace = actor.workspaceId;
    const intent = await this.db.tenant(workspace, async sql => {
      await lockWorkspace(sql, workspace);
      const row = await this.row(sql, companyId);
      const state = row?.profile.onboarding;
      requireCondition(row && state?.owner === actor.userId, 404, 'enrollment_not_found', 'This enrollment is unavailable.');
      requireCondition(state.revision === revision, 409, 'revision_conflict', 'This enrollment changed. Reload it first.');
      requireCondition(!state.review && !state.submittedAt && ['draft', 'rejected'].includes(row.state), 409, 'onboarding_review', 'This enrollment is not ready for checkout.');
      requireCondition(state.challenges.email?.verified && state.challenges.phone?.verified, 409, 'identity_unverified', 'Verify the business email and phone first.');
      await this.requireSignup(sql, companyId);
      requireCondition(!state.payment || state.payment.source === 'stripe_test', 409, 'checkout_mode_mismatch', 'Use the payment mode that started this checkout.');
      if (state.payment?.state === 'paid') return { paid: true } as const;
      if (!await this.claimEin(sql, row, state.owner)) {
        state.review = 'ein_conflict';
        await this.record(sql, row, state);
        await audit(sql, workspace, actor.actorId, via, 'onboarding.review', row.id, null, { reason: state.review });
        return null;
      }
      const receipt = 'sms-setup/' + row.registration_id + '/' + revision;
      if (!state.payment || state.payment.state !== 'pending') {
        state.payment = { ...setupFee, state: 'pending', source: 'stripe_test', receipt, revision, requestedAt: this.now().getTime() };
        await this.record(sql, row, state);
        await audit(sql, workspace, actor.actorId, via, 'onboarding.checkout_requested', row.id, null, { revision });
      }
      requireCondition(state.payment.requestedAt && this.now().getTime() - state.payment.requestedAt < 20 * 3600000,
        409, 'checkout_reconciliation_required', 'This checkout needs operator reconciliation before retrying.');
      return { brandId: row.id, registration: row.registration_id, email: readBusiness(row).email, receipt };
    });
    if (!intent) return { paid: false };
    if ('paid' in intent) return intent;
    const checkout = await this.stripe!.open({ workspace, registration: intent.registration, revision }, intent.email, intent.receipt);
    return this.db.tenant(workspace, async sql => {
      await lockWorkspace(sql, workspace);
      const row = await this.row(sql, companyId);
      const state = row?.profile.onboarding;
      requireCondition(row && state?.revision === revision && row.id === intent.brandId && state.payment?.source === 'stripe_test',
        409, 'revision_conflict', 'This enrollment changed. Reload it first.');
      requireCondition(!state.payment.sessionId || state.payment.sessionId === checkout.id, 409, 'checkout_mismatch', 'The checkout session did not match enrollment.');
      if (state.payment.state === 'paid') return { paid: true };
      state.payment.sessionId = checkout.id;
      await this.record(sql, row, state);
      return { paid: false, checkoutUrl: checkout.url };
    });
  }

  async stripeEvent(raw: Buffer, signature: string) {
    requireCondition(this.stripe, 503, 'checkout_unavailable', 'Stripe test setup checkout is unavailable.');
    const receipt = this.stripe.receipt(raw, signature);
    if (!receipt) return;
    const { workspace, registration, revision } = receipt.target;
    await this.db.tenant(workspace, async sql => {
      await lockWorkspace(sql, workspace);
      const row = (await sql.query<Row>(`SELECT b.id,b.legal_name,b.profile,r.id registration_id,r.state,r.rejection_reason
        FROM sms_carrier_brands b JOIN sms_registrations r ON r.carrier_brand_id=b.id WHERE r.id=$1`, [registration])).rows[0];
      const state = row?.profile.onboarding;
      if (!row || state?.revision !== revision || state.payment?.source !== 'stripe_test') return;
      requireCondition(!state.payment.sessionId || state.payment.sessionId === receipt.sessionId,
        409, 'checkout_mismatch', 'The Stripe session did not match enrollment.');
      if (state.payment.state === 'paid') return;
      const received = await sql.query(`INSERT INTO sms_provider_events(workspace_id,event_key,digest) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [workspace, 'sms-setup-stripe:' + receipt.eventId, requestHash([registration, revision, receipt.sessionId])]);
      if (!received.rowCount) return;
      state.payment = { ...state.payment, state: 'paid', sessionId: receipt.sessionId };
      if (!matchPayer(readBusiness(row), receipt.payer)) state.review = 'payer_mismatch';
      await this.record(sql, row, state);
      await audit(sql, workspace, 'stripe', 'webhook', 'onboarding.checkout_verified', row.id, null, { revision, review: state.review ?? null });
    });
  }

  async review(sql: Sql, workspace: string, companyId: string, expectedRevision: number,
    action: 'request_correction' | 'complete_probation', actor: string, via: Interface, reason: string) {
    const row = await this.row(sql, companyId);
    const state = row?.profile.onboarding;
    requireCondition(row && state, 404, 'enrollment_not_found', 'This enrollment is unavailable.');
    requireCondition(state.revision === expectedRevision, 409, 'revision_conflict', 'This enrollment changed. Reload it first.');
    if (action === 'request_correction') {
      requireCondition(state.review, 409, 'review_unavailable', 'This enrollment does not need identity review.');
      requireCondition(state.payment?.source !== 'stripe_test' || state.payment.state !== 'paid', 409, 'checkout_reconciliation_required',
        'Reconcile this Stripe test payment before clearing the payer review.');
      delete state.review;
      state.challenges = {};
    } else {
      requireCondition(row.state === 'approved', 409, 'registration_not_approved', 'Wait for carrier approval before ending probation.');
      state.probation = { state: 'complete', startsAt: state.probation?.startsAt ?? this.now().toISOString(), overrideAt: this.now().toISOString() };
    }
    await this.record(sql, row, state);
    await audit(sql, workspace, actor, via, 'onboarding.' + action, row.id, null, { revision: state.revision, reason });
    return { reviewed: true };
  }

  private async save(sql: Sql, actor: Actor, via: Interface, companyId: string, row: Row | undefined, business: OnboardingBusiness) {
    const valid = twilioBusiness('private_profit', business.businessType, business.vertical);
    requireCondition(!('reason' in valid), 422, 'business_type_mismatch',
      'reason' in valid ? businessRefusals[valid.reason]! : '');
    const hostname = (value: string) => new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    const domain = hostname(business.website);
    requireCondition(domain === business.email.split('@')[1]?.toLowerCase() && !publicMailHosts.has(domain),
      422, 'business_domain_mismatch', 'Use a business email address on the website domain.');
    requireCondition(hostname(business.privacyPolicyUrl) === domain && hostname(business.smsTermsUrl) === domain &&
      business.privacyPolicyUrl !== business.smsTermsUrl, 422, 'policy_domain_mismatch', 'Use distinct public privacy and SMS terms URLs on the business domain.');

    const { street, city, region, postalCode, firstName, lastName, email, phone, title } = business;
    const ein = business.ein.replace('-', '');
    const previous = row?.profile.onboarding;
    const revision = (previous?.revision ?? 0) + 1;
    const state: Enrollment = { revision, owner: actor.userId, acceptedAt: this.now().toISOString(), policyVersion, challenges: {} };
    if (previous?.payment?.state === 'paid' && row) {
      const original = readBusiness(row);
      requireCondition(original.ein === ein && original.legalName === business.legalName && original.street === street &&
        original.region === region && original.postalCode === postalCode, 409, 'paid_enrollment_locked',
      'Ask an operator to reconcile the setup payment before changing the registered business or its billing address.');
      state.payment = { ...previous.payment, revision };
    }
    const profile = {
      ein, website: business.website, privacyPolicyUrl: business.privacyPolicyUrl, smsTermsUrl: business.smsTermsUrl,
      businessType: business.businessType, vertical: business.vertical, campaign: campaign(business),
      address: { street, city, region, postalCode, country: 'US' }, contact: { firstName, lastName, email, phone, title }, onboarding: state,
    };
    const id = row?.id ?? randomUUID();
    await sql.query(`INSERT INTO sms_carrier_brands(workspace_id,id,company_id,legal_name,entity_type,profile,help_contact,created_by,privacy_policy_confirmed_at,sms_terms_confirmed_at)
      VALUES($1,$2,$3,$4,'private_profit',$5,$6,$7,clock_timestamp(),clock_timestamp())
      ON CONFLICT(workspace_id,id) DO UPDATE SET legal_name=EXCLUDED.legal_name,profile=EXCLUDED.profile,help_contact=EXCLUDED.help_contact,
      privacy_policy_confirmed_at=EXCLUDED.privacy_policy_confirmed_at,sms_terms_confirmed_at=EXCLUDED.sms_terms_confirmed_at,updated_at=clock_timestamp()`,
    [actor.workspaceId, id, companyId, business.legalName, JSON.stringify(profile), email.length <= 120 ? email : phone, actor.actorId]);
    if (!row) await sql.query(`INSERT INTO sms_registrations(workspace_id,id,carrier_brand_id,state) VALUES($1,$2,$3,'draft')`,
      [actor.workspaceId, randomUUID(), id]);
    await audit(sql, actor.workspaceId, actor.actorId, via, 'onboarding.saved', id, null, { revision, policyVersion });
    return { revision };
  }

  private async record(sql: Sql, row: Row, value: Enrollment) {
    await sql.query(`UPDATE sms_carrier_brands SET profile=jsonb_set(profile,'{onboarding}',$2::jsonb),updated_at=clock_timestamp() WHERE id=$1`,
      [row.id, JSON.stringify(value)]);
  }

  /** Synthetic registry only. Capture keys are deliberately isolated from real provider data. */
  private async claimEin(sql: Sql, row: Row, owner: string) {
    const key = 'enrollment-ein/' + requestHash(row.profile.ein);
    const holder = requestHash(owner);
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
    const existing = (await sql.query<{ value: string | null }>('SELECT flockletter_customer_jobs.texting_mock_get($1) value', [key])).rows[0]?.value;
    if (existing) return existing === holder;
    await sql.query('SELECT flockletter_customer_jobs.texting_mock_put($1,$2::jsonb)', [key, JSON.stringify(holder)]);
    return true;
  }
}

function matchPayer(business: OnboardingBusiness, payer: SetupReceipt['payer']) {
  const normalize = (value: string | null) => value?.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return payer.country === 'US' && normalize(payer.name) === normalize(business.legalName) &&
    normalize(payer.street) === normalize(business.street) && normalize(payer.region) === normalize(business.region) &&
    payer.postalCode?.slice(0, 5) === business.postalCode;
}
