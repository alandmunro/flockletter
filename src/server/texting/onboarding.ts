import { randomInt, randomUUID } from 'node:crypto';
import type { OnboardingBusiness, OnboardingView, TextingOnboardingCommand, VerificationChannel } from '../../shared/texting-onboarding.js';
import { textingOnboardingCommands as commands } from '../../shared/texting-onboarding.js';
import { businessRefusals, twilioBusiness } from '../../shared/texting-business.js';
import type { Database, Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import type { Actor } from '../service.js';
import { lockWorkspace } from '../workspace-lock.js';
import { signupPage, type TextingRegistration } from './registration.js';
import { practiceTextPlans, setupFeeFor } from '../../shared/texting-commercial.js';
import { acceptEnrollmentPlan } from './commercial.js';
import { hostedBusinessUrls, makeHostedPolicySnapshot } from '../../shared/texting-policy-pages.js';
import { scanEnrollmentPages } from './website-preflight.js';
import type { SetupReceipt, StripeTestSetupPayment } from './setup-payment.js';
import { enrollmentNotices, restartPracticeProbation } from './enrollment-recovery.js';
import { audit, once, requestHash, type Interface } from './storage.js';

const policyVersion = 'sms-enrollment-v1';
const checkLifetime = 24 * 3600_000;
const reviewMessages = {
  ein_conflict: 'This EIN already belongs to another owner. Ask for a correction review before registering.',
  dba_conflict: 'This business identity is already registered. Review the owner and the business name.',
  payer_mismatch: 'The payer details differ from the registered business. Supply practice ownership evidence for review.',
  hosted_ownership: 'This business uses hosted pages. Supply a practice ownership letter for operator review.',
};
const publicMailHosts = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com']);
type Channel = VerificationChannel;
const channelsFor = (sole: boolean): Channel[] => sole ? ['email', 'phone', 'carrier'] : ['email', 'phone'];
type Challenge = { issuedAt: number; attempts: number; verified: boolean; nonce?: string; digest?: string };
type Enrollment = {
  revision: number; owner: string; acceptedAt: string; policyVersion: string;
  challenges: Partial<Record<Channel, Challenge>>;
  payment?: { state: 'paid' | 'declined' | 'pending'; source: 'capture' | 'stripe_test'; receipt: string;
    amount: number; currency: string; revision: number; requestedAt?: number; sessionId?: string; attempt?: number };
  review?: 'ein_conflict' | 'dba_conflict' | 'payer_mismatch' | 'hosted_ownership';
  hostedApproved?: boolean;
  evidence?: NonNullable<OnboardingView['evidence']>;
  pendingScan?: { id: string; at: number };
  pageCheck?: NonNullable<OnboardingView['pageCheck']>;
  submittedAt?: string;
  probation?: { state: 'canary' | 'paused' | 'active' | 'complete' | 'suspended'; startsAt: string; sendId?: string; members?: string[]; overrideAt?: string };
};
type Row = {
  id: string; dba_name: string | null; registration_id: string; state: string; legal_name: string; rejection_reason: string | null;
  profile: Record<string, unknown> & { onboarding?: Enrollment; campaign?: { samples: string[] } };
};

// These fixtures contain no business data and have no value as real identity documents.
function practiceLetter(workspace: string, row: Row, revision: number, document: 'CP575' | '147C') {
  const ref = requestHash(['practice-ownership-letter-v1', workspace, row.id, revision, document]);
  return ['FLOCKLETTER STAGING PRACTICE', 'Fictional ownership letter: ' + document,
    'Enrollment revision: ' + revision, 'Practice reference: ' + ref,
    'For the simulated enrollment review only. Contains no taxpayer information.', ''].join('\n');
}

function campaign(business: OnboardingBusiness) {
  const topics = business.vertical === 'FOOD_AND_BEVERAGE'
    ? ['Reservations are open for our weekend special.', 'Here are our new hours for the holiday weekend.']
    : business.vertical === 'REAL_ESTATE'
      ? ['Your annual home maintenance reminder is available.', 'Here is this month’s home care update for past clients.']
      : ['Our latest business update is available.', 'We have new hours for the holiday weekend.'];
  const sender = business.dbaName ?? business.legalName;
  const purpose = business.vertical === 'REAL_ESTATE' ? 'home care updates to past clients' : 'business updates';
  return {
    description: `${sender} sends ${purpose} to subscribers who opt in on its Flockletter sign-up page and confirm by replying YES.`,
    samples: topics.map(topic => `${sender}: ${topic} Reply STOP to opt out.`),
    useCase: business.plan === 'text_2500' ? 'MARKETING' : 'LOW_VOLUME',
  };
}

function readBusiness(row: Row): OnboardingBusiness {
  const profile = row.profile;
  const address = profile.address as { street: string; city: string; region: string; postalCode: string };
  const urls = { website: String(profile.website), privacyPolicyUrl: String(profile.privacyPolicyUrl), smsTermsUrl: String(profile.smsTermsUrl) };
  const result = commands['sms.onboardingSave'].schema.shape.business.parse({
    legalName: row.legal_name, ein: profile.ein ?? '', registrationType: profile.registrationType, dbaName: row.dba_name ?? undefined,
    hostedPages: profile.hostedPages, publicContact: profile.publicContact, description: profile.description, plan: profile.plan, businessType: profile.businessType, vertical: profile.vertical,
    ...(profile.hostedPages ? { website: '', privacyPolicyUrl: '', smsTermsUrl: '' } : urls),
    street: address.street, city: address.city, region: address.region, postalCode: address.postalCode,
    ...(profile.contact as object),
  });
  return { ...result, ...urls };
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
    private readonly readPage?: (url: string) => Promise<string>,
  ) {}

  private async row(sql: Sql, companyId: string) {
    const company = await sql.query('SELECT id FROM companies WHERE id=$1', [companyId]);
    requireCondition(company.rowCount, 404, 'not_found', 'This company is unavailable in this workspace.');
    return (await sql.query<Row>(`SELECT b.id,b.dba_name,b.legal_name,b.profile,r.id registration_id,r.state,r.rejection_reason
      FROM sms_carrier_brands b JOIN sms_registrations r ON r.carrier_brand_id=b.id WHERE b.company_id=$1`, [companyId])).rows[0];
  }

  private async view(sql: Sql, workspace: string, row: Row | undefined, user: string): Promise<OnboardingView> {
    const current = row?.profile.onboarding;
    const owned = current?.owner === user;
    const personal = owned && row ? current : undefined;
    const business = personal && row ? readBusiness(row) : null;
    const progress = personal && row ? await this.registration.progress(sql, workspace, row.registration_id) : null;
    return {
      available: true, blocked: !!row && !owned,
      revision: owned ? current.revision : null,
      business: row && owned && ['draft', 'rejected'].includes(row.state) ? business : null,
      requiredChannels: channelsFor(business?.registrationType === 'sole_proprietor'),
      carrierVerified: personal?.challenges.carrier?.verified === true,
      pageCheck: personal?.pageCheck ?? null, review: personal?.review ?? null, evidence: personal?.evidence ?? null,
      ...(row && personal && (personal.review === 'payer_mismatch' || personal.review === 'hosted_ownership') && {
        evidenceFiles: { CP575: practiceLetter(workspace, row, personal.revision, 'CP575'), '147C': practiceLetter(workspace, row, personal.revision, '147C') },
      }),
      publicPages: business?.hostedPages ? { website: business.website, privacyPolicyUrl: business.privacyPolicyUrl, smsTermsUrl: business.smsTermsUrl } : null,
      progress, probation: personal?.probation?.state ?? null,
      notices: personal && row ? await enrollmentNotices(sql, row.id) : [],
      verified: { email: owned && current.challenges.email?.verified === true, phone: owned && current.challenges.phone?.verified === true },
      checkout: owned ? current.payment?.state ?? 'unpaid' : 'unpaid',
      checkoutMode: this.stripe ? 'stripe_test' : 'capture',
      setupFee: setupFeeFor(business?.plan), state: owned && current.review ? 'review'
        : owned && row?.state === 'rejected' && !current.submittedAt ? 'draft' : row?.state ?? 'not_started',
      message: owned && current.review
        ? reviewMessages[current.review]
        : row?.state === 'rejected' && owned && current.submittedAt ? rejectionMessage(row.rejection_reason) : null,
      samples: owned ? row?.profile.campaign?.samples ?? [] : [],
    };
  }

  async execute(name: TextingOnboardingCommand, raw: unknown, actor: Actor, via: Interface) {
    const workspace = actor.workspaceId;
    if (name === 'sms.onboardingStatus') {
      const { companyId } = commands[name].schema.parse(raw);
      return this.db.read(workspace, async sql => this.view(sql, workspace, await this.row(sql, companyId), actor.userId));
    }
    if (name === 'sms.onboardingScan') {
      const input = commands[name].schema.parse(raw);
      return this.scan(actor, input.companyId, input.expectedRevision, input.operationKey, true);
    }
    if (name === 'sms.onboardingSave') {
      const input = commands[name].schema.parse(raw);
      const saved = await this.change(name, input, actor, via) as { revision: number };
      await this.scan(actor, input.companyId, saved.revision, input.operationKey, false);
      return saved;
    }
    if (name === 'sms.onboardingPay' || name === 'sms.onboardingSubmit' || name === 'sms.onboardingFinish') {
      const input = commands[name].schema.parse(raw);
      await this.scan(actor, input.companyId, input.expectedRevision, input.operationKey, false);
    }
    if (name === 'sms.onboardingPay' && this.stripe) {
      const input = commands[name].schema.parse(raw);
      requireCondition(input.result === 'paid', 422, 'checkout_mode_mismatch', 'Use the Stripe test checkout to exercise payment results.');
      return this.openTestCheckout(actor, via, input.companyId, input.expectedRevision);
    }
    return this.change(name, raw, actor, via);
  }

  private async change(name: Exclude<TextingOnboardingCommand, 'sms.onboardingStatus' | 'sms.onboardingScan'>, raw: unknown, actor: Actor, via: Interface) {
    const workspace = actor.workspaceId;
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
        if (name === 'sms.onboardingResume') {
          const { reason } = commands[name].schema.parse(raw);
          return restartPracticeProbation(sql, workspace, row.id, row.registration_id, actor.actorId, via, reason, this.now(), 'paused');
        }
        if (name === 'sms.onboardingEvidence') {
          const { document, contents } = commands[name].schema.parse(raw);
          requireCondition(state.review === 'hosted_ownership' || state.review === 'payer_mismatch', 409, 'review_unavailable',
            'A practice ownership letter is available for hosted-page and payer reviews.');
          const expected = practiceLetter(workspace, row, state.revision, document);
          requireCondition(contents === undefined || contents === expected, 422, 'practice_letter_mismatch',
            'Use the practice letter downloaded for this company, letter type and enrollment revision.');
          requireCondition(!state.evidence || state.evidence.document === document, 409, 'evidence_already_attached',
            'A different practice letter is already attached to this review.');
          if (!state.evidence) {
            const source = contents === undefined ? 'template' : 'upload';
            const fingerprint = requestHash(expected);
            state.evidence = { document, fingerprint, source, attachedAt: this.now().toISOString() };
            await this.record(sql, row, state);
            await audit(sql, workspace, actor.actorId, via, 'onboarding.practice_evidence', row.id, null, { revision: state.revision, document, fingerprint, source });
          }
          return { attached: true };
        }
        if ((name === 'sms.onboardingSubmit' || name === 'sms.onboardingFinish') && state.submittedAt) return { submitted: true };
        requireCondition(row.state === 'draft' || row.state === 'rejected', 409, 'registration_in_progress', 'This enrollment is already with the carrier.');
        requireCondition(!state.review || (state.review === 'hosted_ownership' && (name === 'sms.onboardingChallenge' || name === 'sms.onboardingVerify')), 409, 'onboarding_review', 'An operator must resolve the pending review before registration.');
        const required = channelsFor(row.profile.registrationType === 'sole_proprietor');
        const now = this.now().getTime();
        if (name === 'sms.onboardingChallenge') {
          const { channel } = commands[name].schema.parse(raw);
          requireCondition(required.includes(channel), 422, 'verification_channel', 'This verification does not apply to the selected registration type.');
          const previous = state.challenges[channel];
          if (previous?.verified) return { verified: true };
          requireCondition(!previous || now - previous.issuedAt >= 60_000, 429, 'verification_cooldown', 'Wait a minute before requesting another verification code.');
          const captureCode = randomInt(0, 1_000_000).toString().padStart(6, '0');
          const nonce = randomUUID();
          state.challenges[channel] = { issuedAt: now, attempts: 0, verified: false, nonce, digest: requestHash([workspace, row.id, state.revision, channel, nonce, captureCode]) };
          await this.record(sql, row, state);
          return { verified: false, captureCode };
        }
        if (name === 'sms.onboardingVerify') {
          const { channel, code } = commands[name].schema.parse(raw);
          const attempt = state.challenges[channel];
          if (attempt?.verified) return { verified: true };
          requireCondition(attempt && now - attempt.issuedAt < 600_000 && attempt.attempts < 5, 409, 'verification_expired', 'Request a new verification code.');
          attempt.attempts++;
          attempt.verified = !!attempt.nonce && attempt.digest === requestHash([workspace, row.id, state.revision, channel, attempt.nonce, code]);
          await this.record(sql, row, state);
          if (attempt.verified) await audit(sql, workspace, actor.actorId, via, 'onboarding.verified', row.id, null, { channel, revision: state.revision });
          return { verified: attempt.verified };
        }
        requireCondition(channelsFor(row.profile.registrationType === 'sole_proprietor').every(channel => state.challenges[channel]?.verified), 409, 'identity_unverified', 'Verify the business email and phone first.');
        this.requireCheck(state, row.profile.hostedPages);
        const business = readBusiness(row);
        const setupFee = setupFeeFor(business.plan);
        const finish = name === 'sms.onboardingFinish';
        if ((name === 'sms.onboardingSubmit' || name === 'sms.onboardingFinish') && !this.stripe) {
          const acceptance = commands[name].schema.parse(raw);
          const plan = business.plan;
          requireCondition(acceptance.acceptedPlan === plan && acceptance.acceptedMonthlyUsdCents === (plan ? practiceTextPlans[plan].monthly : undefined),
            409, 'setup_agreement_changed', 'Review the selected texting plan and its monthly practice price before submitting.');
        }
        if (finish) {
          const acceptance = commands[name].schema.parse(raw);
          requireCondition(!this.stripe && acceptance.acceptedFee === setupFee.amount, 409, 'setup_agreement_changed', 'Review the current practice setup fee before submitting.');
        }
        if (name === 'sms.onboardingPay' || (finish && state.payment?.state !== 'paid')) {
          requireCondition(!state.payment || state.payment.source === 'capture', 409, 'checkout_mode_mismatch', 'Use the payment mode that started this checkout.');
          if (state.payment?.state === 'paid') return { paid: true };
          const result = name === 'sms.onboardingPay' ? commands[name].schema.parse(raw).result : 'paid';
          await this.requireSignup(sql, input.companyId, state);
          if (result === 'paid' && !await this.claimIdentity(sql, row, state.owner)) {
            state.review = row.profile.registrationType === 'sole_proprietor' || row.dba_name ? 'dba_conflict' : 'ein_conflict';
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
          if (!finish) return { paid: result === 'paid' };
        }
        requireCondition(state.payment?.state === 'paid' && state.payment.revision === state.revision &&
          state.payment.amount === setupFee.amount && state.payment.currency === setupFee.currency &&
          state.payment.source === (this.stripe ? 'stripe_test' : 'capture'),
        409, 'setup_payment_required', 'Complete the setup payment before submitting.');
        await this.requireSignup(sql, input.companyId, state);
        state.submittedAt = this.now().toISOString();
        await this.record(sql, row, state);
        await this.registration.submit(sql, workspace, row.registration_id, actor.actorId, via, true);
        if (business.plan && !this.stripe) await acceptEnrollmentPlan(sql, workspace, input.companyId, business.plan, actor.actorId, via, this.now(), row.registration_id);
        return { submitted: true };
      });
    });
  }

  private requireCheck(state: Enrollment, hosted: unknown) {
    requireCondition(state.pageCheck && !state.pageCheck.issues.length && this.now().getTime() - Date.parse(state.pageCheck.checkedAt) < checkLifetime,
      409, 'website_check_required', 'Resolve the website checks and check the pages again before continuing.');
    requireCondition(!state.review && (!hosted || state.hostedApproved), 409, 'onboarding_review', 'Resolve the enrollment review before continuing.');
  }

  // Read public pages after committing the draft. Never hold a database connection while a website responds.
  private async scan(actor: Actor, companyId: string, revision: number, operationKey: string, force: boolean) {
    const workspace = actor.workspaceId;
    const claim = await this.db.tenant(workspace, async sql => {
      await lockWorkspace(sql, workspace);
      const row = await this.row(sql, companyId), state = row?.profile.onboarding;
      requireCondition(row && state?.owner === actor.userId, 404, 'enrollment_not_found', 'This enrollment is unavailable.');
      if (!force && state.revision !== revision) return null;
      requireCondition(state.revision === revision, 409, 'revision_conflict', 'The enrollment changed. Reload it first.');
      if (!['draft', 'rejected'].includes(row.state) || state.submittedAt) return null;
      const now = this.now().getTime();
      if (state.pendingScan && now - state.pendingScan.at < 60_000) return null;
      const signupUrl = await signupPage(sql, companyId, this.origin);
      if (state.pageCheck?.signupUrl === signupUrl && now - Date.parse(state.pageCheck.checkedAt) < (force ? 5_000 : checkLifetime)) return null;
      state.pendingScan = { id: operationKey, at: now };
      await this.record(sql, row, state);
      return { business: readBusiness(row), signupUrl };
    });
    if (!claim) return { checked: false };
    const { website, privacyPolicyUrl, smsTermsUrl, hostedPages } = claim.business;
    const result = claim.signupUrl
      ? await scanEnrollmentPages({ website, privacyPolicyUrl, smsTermsUrl, hostedPages, signupUrl: claim.signupUrl }, this.readPage)
      : { issues: [{ page: 'signup', message: 'Enable a public signup page for this company and turn on its mobile number field.' }] };
    return this.db.tenant(workspace, async sql => {
      await lockWorkspace(sql, workspace);
      const row = await this.row(sql, companyId), state = row?.profile.onboarding;
      if (!row || state?.revision !== revision || state.pendingScan?.id !== operationKey) return { checked: false };
      delete state.pendingScan;
      if (claim.signupUrl !== await signupPage(sql, companyId, this.origin)) {
        delete state.pageCheck;
        await this.record(sql, row, state);
        return { checked: false };
      }
      state.pageCheck = { checkedAt: this.now().toISOString(), signupUrl: claim.signupUrl, issues: result.issues };
      await this.record(sql, row, state);
      return { checked: true, issues: result.issues };
    });
  }

  private async requireSignup(sql: Sql, companyId: string, state: Enrollment) {
    const signup = await signupPage(sql, companyId, this.origin);
    requireCondition(signup, 409, 'signup_page_missing',
      'Enable a Flockletter sign-up page for this company and turn on the mobile number field in Texting settings.');
    requireCondition(state.pageCheck?.signupUrl === signup, 409, 'website_check_required', 'The signup address changed. Check the published pages again.');
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
      requireCondition(channelsFor(row.profile.registrationType === 'sole_proprietor').every(channel => state.challenges[channel]?.verified), 409, 'identity_unverified', 'Verify the business email and phone first.');
      this.requireCheck(state, row.profile.hostedPages);
      const setupFee = setupFeeFor(readBusiness(row).plan);
      await this.requireSignup(sql, companyId, state);
      requireCondition(!state.payment || state.payment.source === 'stripe_test', 409, 'checkout_mode_mismatch', 'Use the payment mode that started this checkout.');
      if (state.payment?.state === 'paid') return { paid: true } as const;
      if (!await this.claimIdentity(sql, row, state.owner)) {
        state.review = row.profile.registrationType === 'sole_proprietor' || row.dba_name ? 'dba_conflict' : 'ein_conflict';
        await this.record(sql, row, state);
        await audit(sql, workspace, actor.actorId, via, 'onboarding.review', row.id, null, { reason: state.review });
        return null;
      }
      if (!state.payment || state.payment.state === 'declined') {
        const attempt = state.payment ? (state.payment.attempt ?? 1) + 1 : 1;
        const receipt = 'sms-setup/' + row.registration_id + '/' + revision + (attempt > 1 ? '/' + attempt : '');
        state.payment = { ...setupFee, state: 'pending', source: 'stripe_test', receipt, revision, attempt, requestedAt: this.now().getTime() };
        await this.record(sql, row, state);
        await audit(sql, workspace, actor.actorId, via, 'onboarding.checkout_requested', row.id, null, { revision, attempt });
      }
      // An authoritative lookup is safe past Stripe's idempotency window. An unknown session ID is not.
      const stale = !state.payment.requestedAt || this.now().getTime() - state.payment.requestedAt >= 20 * 3600000;
      requireCondition(!stale || state.payment.sessionId, 409, 'checkout_reconciliation_required', 'The original checkout needs reconciliation before retrying.');
      return { brandId: row.id, registration: row.registration_id, email: readBusiness(row).email, plan: readBusiness(row).plan,
        receipt: state.payment.receipt, attempt: state.payment.attempt ?? 1, lookup: stale ? state.payment.sessionId : undefined };
    });
    if (!intent) return { paid: false };
    if ('paid' in intent) return intent;
    const target = { workspace, registration: intent.registration, revision, ...(intent.plan && { plan: intent.plan }), ...(intent.attempt > 1 && { attempt: intent.attempt }) };
    const checkout = await this.stripe!.open(target, intent.email, intent.receipt, intent.lookup);
    return this.db.tenant(workspace, async sql => {
      await lockWorkspace(sql, workspace);
      const row = await this.row(sql, companyId);
      const state = row?.profile.onboarding;
      requireCondition(row && state?.revision === revision && row.id === intent.brandId && state.payment?.source === 'stripe_test' &&
        state.payment.receipt === intent.receipt && (state.payment.attempt ?? 1) === intent.attempt,
        409, 'revision_conflict', 'This enrollment changed. Reload it first.');
      requireCondition(!state.payment.sessionId || state.payment.sessionId === checkout.id, 409, 'checkout_mismatch', 'The checkout session did not match enrollment.');
      if (state.payment.state === 'paid') return { paid: true };
      state.payment.sessionId = checkout.id;
      if (checkout.expired) state.payment.state = 'declined';
      await this.record(sql, row, state);
      return { paid: false, checkoutUrl: state.payment.state === 'pending' ? checkout.url : null };
    });
  }

  async stripeEvent(raw: Buffer, signature: string) {
    requireCondition(this.stripe, 503, 'checkout_unavailable', 'Stripe test setup checkout is unavailable.');
    const receipt = this.stripe.receipt(raw, signature);
    if (!receipt) return;
    const { workspace, registration, revision } = receipt.target;
    await this.db.tenant(workspace, async sql => {
      await lockWorkspace(sql, workspace);
      const row = (await sql.query<Row>(`SELECT b.id,b.dba_name,b.legal_name,b.profile,r.id registration_id,r.state,r.rejection_reason
        FROM sms_carrier_brands b JOIN sms_registrations r ON r.carrier_brand_id=b.id WHERE r.id=$1`, [registration])).rows[0];
      const state = row?.profile.onboarding;
      if (!row || state?.revision !== revision || state.payment?.source !== 'stripe_test' ||
        (receipt.target.attempt ?? 1) !== (state.payment.attempt ?? 1)) return;
      requireCondition(receipt.target.plan === readBusiness(row).plan, 409, 'checkout_mismatch', 'The setup receipt did not match the selected plan.');
      requireCondition(!state.payment.sessionId || state.payment.sessionId === receipt.sessionId,
        409, 'checkout_mismatch', 'The Stripe session did not match enrollment.');
      requireCondition(receipt.amount === state.payment.amount, 409, 'checkout_mismatch', 'The setup receipt amount does not match this enrollment.');
      if (state.payment.state === 'paid') return;
      requireCondition(state.payment.state !== 'declined' || receipt.outcome === 'declined', 409, 'checkout_reconciliation_required',
        'Stripe recorded conflicting outcomes for this checkout. Review the original attempt before continuing.');
      const received = await sql.query(`INSERT INTO sms_provider_events(workspace_id,event_key,digest) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [workspace, 'sms-setup-stripe:' + receipt.eventId, requestHash([registration, revision, receipt.sessionId])]);
      if (!received.rowCount) return;
      if (receipt.outcome === 'declined') {
        state.payment = { ...state.payment, state: 'declined', sessionId: receipt.sessionId };
        await this.record(sql, row, state);
        await audit(sql, workspace, 'stripe', 'webhook', 'onboarding.checkout_declined', row.id, null, { revision, attempt: state.payment.attempt ?? 1 });
        return;
      }
      state.payment = { ...state.payment, state: 'paid', sessionId: receipt.sessionId };
      if (!matchPayer(readBusiness(row), receipt.payer)) state.review = 'payer_mismatch';
      await this.record(sql, row, state);
      await audit(sql, workspace, 'stripe', 'webhook', 'onboarding.checkout_verified', row.id, null, { revision, review: state.review ?? null });
    });
  }

  async review(sql: Sql, workspace: string, companyId: string, expectedRevision: number,
    action: 'request_correction' | 'complete_probation' | 'accept_evidence' | 'lift_suspension', actor: string, via: Interface, reason: string) {
    const row = await this.row(sql, companyId);
    const state = row?.profile.onboarding;
    requireCondition(row && state, 404, 'enrollment_not_found', 'This enrollment is unavailable.');
    requireCondition(state.revision === expectedRevision, 409, 'revision_conflict', 'This enrollment changed. Reload it first.');
    if (action === 'lift_suspension') return restartPracticeProbation(sql, workspace, row.id, row.registration_id, actor, via, reason, this.now(), 'suspended');
    if (action === 'accept_evidence') {
      requireCondition(state.evidence && (state.review === 'hosted_ownership' || state.review === 'payer_mismatch'), 409, 'evidence_unavailable', 'Review a practice letter for this revision. An ownership conflict requires corrected business details.');
      if (row.profile.hostedPages) state.hostedApproved = true;
      delete state.review;
    } else if (action === 'request_correction') {
      requireCondition(state.review, 409, 'review_unavailable', 'This enrollment does not need identity review.');
      requireCondition(state.payment?.state !== 'paid' || state.review !== 'payer_mismatch', 409, 'checkout_reconciliation_required', 'Review the paid receipt and its evidence before resolving this mismatch.');
      delete state.review;
      delete state.evidence;
      state.challenges = {};
    } else {
      requireCondition(row.state === 'approved' && !['paused', 'suspended'].includes(state.probation?.state ?? ''), 409, 'registration_not_approved', 'The sender must be approved and clear of holds before ending probation.');
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
    const signup = business.hostedPages ? await signupPage(sql, companyId, this.origin) : null;
    if (business.hostedPages) {
      requireCondition(signup, 409, 'signup_page_missing', 'Enable the company’s hosted signup page and its mobile field before publishing practice pages.');
      business = { ...business, ...hostedBusinessUrls(signup) };
    }
    const domain = hostname(business.website);
    requireCondition(business.hostedPages || (domain === business.email.split('@')[1]?.toLowerCase() && !publicMailHosts.has(domain)),
      422, 'business_domain_mismatch', 'Use a business email address on the website domain.');
    requireCondition(business.hostedPages || (hostname(business.privacyPolicyUrl) === domain && hostname(business.smsTermsUrl) === domain &&
      business.privacyPolicyUrl !== business.smsTermsUrl), 422, 'policy_domain_mismatch', 'Use distinct public privacy and SMS terms URLs on the business domain.');

    const { street, city, region, postalCode, firstName, lastName, email, phone, title } = business;
    const ein = business.ein.replace('-', '');
    const previous = row?.profile.onboarding;
    const revision = (previous?.revision ?? 0) + 1;
    const state: Enrollment = { revision, owner: actor.userId, acceptedAt: this.now().toISOString(), policyVersion, challenges: {} };
    if (business.hostedPages) state.review = 'hosted_ownership';
    if (previous?.payment?.state === 'paid' && row) {
      const original = readBusiness(row);
      requireCondition(original.ein.replace('-', '') === ein && original.legalName === business.legalName && original.street === street &&
        original.region === region && original.postalCode === postalCode && (original.registrationType ?? 'ein') === (business.registrationType ?? 'ein') &&
        original.dbaName === business.dbaName && original.city === city && original.plan === business.plan &&
        previous.payment.amount === setupFeeFor(business.plan).amount, 409, 'paid_enrollment_locked',
      'Ask an operator to reconcile the setup payment before changing the registered business or its billing address.');
      state.payment = { ...previous.payment, revision };
    }
    const hostedPolicy = signup && business.hostedPages ? makeHostedPolicySnapshot({ legalName: business.dbaName ?? business.legalName,
      publicContact: business.publicContact!, description: business.description!, signupUrl: signup, revision, acceptedAt: state.acceptedAt }) : undefined;
    const profile = {
      registrationType: business.registrationType, plan: business.plan, hostedPages: business.hostedPages, publicContact: business.publicContact,
      description: business.description, hostedPolicy, ein, website: business.website, privacyPolicyUrl: business.privacyPolicyUrl, smsTermsUrl: business.smsTermsUrl,
      businessType: business.businessType, vertical: business.vertical, campaign: campaign(business),
      address: { street, city, region, postalCode, country: 'US' }, contact: { firstName, lastName, email, phone, title }, onboarding: state,
    };
    const id = row?.id ?? randomUUID();
    await sql.query(`INSERT INTO sms_carrier_brands(workspace_id,id,company_id,legal_name,entity_type,profile,help_contact,created_by,privacy_policy_confirmed_at,sms_terms_confirmed_at,dba_name)
      VALUES($1,$2,$3,$4,$8,$5,$6,$7,clock_timestamp(),clock_timestamp(),$9)
      ON CONFLICT(workspace_id,id) DO UPDATE SET legal_name=EXCLUDED.legal_name,dba_name=EXCLUDED.dba_name,entity_type=EXCLUDED.entity_type,profile=EXCLUDED.profile,help_contact=EXCLUDED.help_contact,
      privacy_policy_confirmed_at=EXCLUDED.privacy_policy_confirmed_at,sms_terms_confirmed_at=EXCLUDED.sms_terms_confirmed_at,updated_at=clock_timestamp()`,
    [actor.workspaceId, id, companyId, business.legalName, JSON.stringify(profile), email.length <= 120 ? email : phone, actor.actorId, business.registrationType === 'sole_proprietor' ? 'sole_proprietor' : 'private_profit', business.dbaName ?? null]);
    if (hostedPolicy) await audit(sql, actor.workspaceId, actor.actorId, via, 'onboarding.policy_published', id, null, hostedPolicy);
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
  private async claimIdentity(sql: Sql, row: Row, owner: string) {
    if (row.profile.registrationType === 'sole_proprietor') {
      return this.claim(sql, 'enrollment-sole/' + requestHash(readBusiness(row).phone), requestHash(row.id));
    }
    if (!await this.claim(sql, 'enrollment-ein/' + requestHash(row.profile.ein), requestHash(owner))) return false;
    const name = (row.dba_name ?? row.legal_name).normalize('NFKC').trim().toLowerCase();
    return this.claim(sql, 'enrollment-brand/' + requestHash([row.profile.ein, name]), requestHash(row.id));
  }

  private async claim(sql: Sql, key: string, holder: string) {
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
