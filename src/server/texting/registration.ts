// FL-SMS-004: the registration state machine. Operators drive it now; self-serve onboarding reuses it later.
// Every provider call is preceded by a committed intent row (`calling`) with a stable operation key.
// An uncertain call is only ever looked up. A missing resource is retried only after the operator's settle time.
import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import { lockWorkspace } from '../workspace-lock.js';
import { requireCondition } from '../errors.js';
import { registrationSteps, type CampaignUseCase, type RegistrationState, type RegistrationStep } from '../../shared/texting.js';
import { businessRefusals, twilioBusiness, type TwilioBusinessType } from '../../shared/texting-business.js';
import { audit, readSettings, type Interface } from './storage.js';
import { registrationRank, type AccountCredentials, type BusinessProfile, type CredentialSeal, type ProvisionFacts, type Result, type TwilioPlatformPort } from './twilio.js';

export type StepRow = { registration_id: string; revision: number; step: RegistrationStep; operation_key: string; state: string; attempts: number; next_check_at: Date | null; provider_sid: string | null; facts: ProvisionFacts & Record<string, unknown>; operator_approval_id: string | null; updated_at: Date };
export type RegistrationRow = { id: string; carrier_brand_id: string; state: RegistrationState; revision: number; rejection_reason: string | null; account_sid: string | null; customer_profile_sid: string | null; brand_sid: string | null; messaging_service_sid: string | null; campaign_sid: string | null; brand_status: string | null; campaign_status: string | null; status_checked_at: Date | null };
type BrandRow = { id: string; company_id: string; legal_name: string; dba_name: string | null; entity_type: string; profile: Record<string, unknown>; help_contact: string };
export type RegistrationOptions = {
  db: Database; platform: TwilioPlatformPort; seal: CredentialSeal; origin: string;
  /** Live phase 2 binds the existing staging subaccount (from Bitwarden) instead of creating one. */
  liveAccount?: AccountCredentials;
  now?: () => Date;
};
const gated: RegistrationStep[] = ['brand', 'campaign', 'number'];
/** The business's own campaign description and samples, stored with the carrier brand profile. */
function campaignWording(profile: Record<string, unknown>): { description: string; samples: string[]; useCase: CampaignUseCase; stayTexts: boolean } | null {
  const c = profile.campaign as { description?: unknown; samples?: unknown; useCase?: unknown; stayTexts?: unknown } | undefined;
  return c && typeof c.description === 'string' && Array.isArray(c.samples) && c.samples.length >= 2 && c.samples.every(x => typeof x === 'string')
    ? { description: c.description, samples: c.samples as string[], useCase: c.useCase === 'LOW_VOLUME' ? 'LOW_VOLUME' : 'MARKETING', stayTexts: c.stayTexts === true } : null;
}
export const operationKey = (registration: string, revision: number, step: RegistrationStep) => `sms-reg/${registration}/${revision}/${step}`;

export class TextingRegistration {
  constructor(readonly options: RegistrationOptions) {}
  private now() { return this.options.now?.() ?? new Date(); }
  callbacks(workspace: string) {
    const base = this.options.origin + '/api/v1/texting/twilio';
    return { inbound: base + '/inbound', status: base + '/status', registration: base + '/registration?w=' + encodeURIComponent(workspace) };
  }
  async account(sql: Sql, workspace: string): Promise<AccountCredentials | null> {
    const row = (await sql.query<{ account_sid: string; credentials: string }>('SELECT * FROM flockletter_customer_jobs.texting_account($1)', [workspace])).rows[0];
    return row ? this.options.seal.open(row.credentials, workspace) : null;
  }
  /** Operator submit or resubmit after correction: a new revision gets fresh operation keys. */
  async submit(sql: Sql, workspace: string, registrationId: string, actor: string, via: Interface) {
    await lockWorkspace(sql, workspace);
    const reg = (await sql.query<RegistrationRow>('SELECT * FROM sms_registrations WHERE id=$1 FOR UPDATE', [registrationId])).rows[0];
    requireCondition(reg, 404, 'registration_unavailable', 'This registration is unavailable.');
    requireCondition(reg.state === 'draft' || reg.state === 'rejected', 409, 'registration_in_progress', 'Only a draft or a corrected rejected registration can be submitted.');
    const brand = (await sql.query<{ privacy_policy_confirmed_at: Date | null; sms_terms_confirmed_at: Date | null; entity_type: string; profile: Record<string, unknown> }>('SELECT privacy_policy_confirmed_at,sms_terms_confirmed_at,entity_type,profile FROM sms_carrier_brands WHERE id=$1', [reg.carrier_brand_id])).rows[0]!;
    requireCondition(brand.privacy_policy_confirmed_at && brand.sms_terms_confirmed_at, 409, 'policies_unconfirmed',
      'Record that the business’s website privacy policy and SMS terms are live before carrier registration.');
    if (this.options.platform.mode === 'live') {
      // Refuse before any provider call: a brand Twilio would refuse, or a campaign without this business's own wording.
      const business = twilioBusiness(brand.entity_type, brand.profile.businessType, brand.profile.vertical);
      requireCondition(!('reason' in business), 409, 'reason' in business ? business.reason : 'business_invalid',
        'reason' in business ? (businessRefusals[business.reason] ?? 'This business cannot be registered.') + ' Correct the carrier brand first.' : '');
      requireCondition(campaignWording(brand.profile), 409, 'campaign_wording_missing',
        'Set this business’s campaign description and sample texts on the carrier brand before live registration.');
    }
    const revision = reg.state === 'rejected' ? reg.revision + 1 : reg.revision;
    await sql.query(`UPDATE sms_registrations SET state='provisioning',revision=$2,rejection_reason=NULL,updated_at=clock_timestamp(),
      brand_sid=CASE WHEN $3 THEN NULL ELSE brand_sid END,brand_status=CASE WHEN $3 THEN NULL ELSE brand_status END,
      campaign_sid=CASE WHEN $3 THEN NULL ELSE campaign_sid END,campaign_status=CASE WHEN $3 THEN NULL ELSE campaign_status END WHERE id=$1`, [reg.id, revision, revision !== reg.revision]);
    for (const step of registrationSteps) {
      // A step already done in an earlier revision (for example the subaccount) is carried forward.
      const prior = (await sql.query<StepRow>(`SELECT * FROM sms_registration_steps WHERE registration_id=$1 AND step=$2 AND state='done' ORDER BY revision DESC LIMIT 1`, [reg.id, step])).rows[0];
      const reuse = prior && ['subaccount', 'customer_profile', 'messaging_service', 'number'].includes(step);
      await sql.query(`INSERT INTO sms_registration_steps(workspace_id,registration_id,revision,step,operation_key,state,provider_sid,facts,next_check_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()) ON CONFLICT DO NOTHING`,
        [workspace, reg.id, revision, step, operationKey(reg.id, revision, step), reuse ? 'done' : 'queued', reuse ? prior.provider_sid : null, JSON.stringify(reuse ? prior.facts : {})]);
    }
    await audit(sql, workspace, actor, via, 'registration.submit', reg.id, { state: reg.state, revision: reg.revision }, { state: 'provisioning', revision });
    return { id: reg.id, state: 'provisioning' as const, revision };
  }
  /** One pass over a workspace's registrations. Returns the next time work is due, if any. */
  async tick(workspace: string): Promise<Date | null> {
    const db = this.options.db;
    const regs = await db.read(workspace, async sql => (await sql.query<RegistrationRow>(`SELECT * FROM sms_registrations WHERE state IN ('provisioning','brand_pending','campaign_pending') ORDER BY created_at`)).rows);
    let due: Date | null = null;
    for (const reg of regs) {
      for (let i = 0; i < registrationSteps.length; i++) {
        const next = await this.advance(workspace, reg.id);
        if (next === 'progress') continue;
        if (next instanceof Date && (!due || next < due)) due = next;
        break;
      }
      const poll = await this.poll(workspace, reg.id);
      if (poll && (!due || poll < due)) due = poll;
    }
    return due;
  }
  private async approval(sql: Sql, reg: RegistrationRow, step: StepRow) {
    if (this.options.platform.mode !== 'live' || !gated.includes(step.step)) return true;
    const approval = (await sql.query<{ id: string }>(`SELECT id FROM sms_operator_approvals WHERE registration_id=$1 AND revision=$2 AND step=$3 AND used_at IS NULL FOR UPDATE`, [reg.id, step.revision, step.step])).rows[0];
    if (!approval) return false;
    await sql.query('UPDATE sms_operator_approvals SET used_at=clock_timestamp() WHERE id=$1', [approval.id]);
    await sql.query('UPDATE sms_registration_steps SET operator_approval_id=$2 WHERE operation_key=$1', [step.operation_key, approval.id]);
    return true;
  }
  /** Runs the first unfinished step that is ready. */
  async advance(workspace: string, registrationId: string): Promise<'progress' | Date | null> {
    const db = this.options.db, now = this.now();
    const claim = await db.tenant(workspace, async sql => {
      await lockWorkspace(sql, workspace);
      const reg = (await sql.query<RegistrationRow>('SELECT * FROM sms_registrations WHERE id=$1 FOR UPDATE', [registrationId])).rows[0];
      if (!reg || !['provisioning', 'brand_pending', 'campaign_pending'].includes(reg.state)) return null;
      const steps = (await sql.query<StepRow>('SELECT * FROM sms_registration_steps WHERE registration_id=$1 AND revision=$2', [reg.id, reg.revision])).rows;
      const ordered = registrationSteps.map(name => steps.find(s => s.step === name)!).filter(Boolean);
      const step = ordered.find(s => s.state !== 'done');
      if (!step) return { kind: 'complete' as const, reg };
      if (step.state === 'rejected') return null;
      // The carrier must approve the brand before the campaign is filed.
      if (step.step === 'campaign' && !['APPROVED', 'VERIFIED'].includes(reg.brand_status ?? '')) return { kind: 'wait' as const, at: null };
      // Wording changed after submit (platform.textingCampaignWording) clears the policy confirmation: file only once it is confirmed again.
      if (step.step === 'campaign' && !(await sql.query('SELECT 1 FROM sms_carrier_brands WHERE id=$1 AND privacy_policy_confirmed_at IS NOT NULL AND sms_terms_confirmed_at IS NOT NULL', [reg.carrier_brand_id])).rowCount) return { kind: 'wait' as const, at: null };
      if (step.next_check_at && step.next_check_at > now) return { kind: 'wait' as const, at: step.next_check_at };
      if (step.state === 'held' || step.state === 'queued') {
        if (!await this.approval(sql, reg, step)) {
          if (step.state !== 'held') {
            await sql.query(`UPDATE sms_registration_steps SET state='held',reason='operator_approval_required',updated_at=clock_timestamp() WHERE operation_key=$1`, [step.operation_key]);
            await audit(sql, workspace, 'worker', 'worker', 'registration.held', step.operation_key, { state: step.state }, { state: 'held', reason: 'operator_approval_required' });
          }
          return null;
        }
        // Durable intent: committed before the provider is called.
        await sql.query(`UPDATE sms_registration_steps SET state='calling',attempts=attempts+1,reason=NULL,next_check_at=NULL,updated_at=clock_timestamp() WHERE operation_key=$1`, [step.operation_key]);
        await audit(sql, workspace, 'worker', 'worker', 'registration.call', step.operation_key, { state: step.state }, { state: 'calling', attempt: step.attempts + 1 });
        const brand = (await sql.query<BrandRow>('SELECT * FROM sms_carrier_brands WHERE id=$1', [reg.carrier_brand_id])).rows[0]!;
        const company = (await sql.query<{ name: string }>('SELECT name FROM companies WHERE id=$1', [brand.company_id])).rows[0]!;
        const profile = (await sql.query<{ notification_email: string | null }>('SELECT notification_email FROM sms_workspace_profile')).rows[0];
        const signupUrl = step.step === 'campaign' ? await signupPage(sql, brand.company_id, this.options.origin) : null;
        return { kind: 'call' as const, reg, step, steps: ordered, brand, company: company.name, notificationEmail: profile?.notification_email ?? null, signupUrl, account: await this.account(sql, workspace) };
      }
      return { kind: 'reconcile' as const, reg, step, steps: ordered, account: await this.account(sql, workspace) };
    });
    if (!claim) return null;
    if (claim.kind === 'wait') return claim.at;
    if (claim.kind === 'complete') return this.complete(workspace, registrationId);
    if (claim.kind === 'call') {
      const result = await this.call(workspace, claim.reg, claim.step, claim.steps, claim.brand, claim.company, claim.notificationEmail, claim.signupUrl, claim.account).catch((): Result<ProvisionFacts & { account?: AccountCredentials }> => ({ outcome: 'unknown', reason: 'adapter_error' }));
      return this.apply(workspace, claim.step, result, 'call');
    }
    const found = claim.step.step === 'subaccount' && this.options.platform.mode === 'live' ? { outcome: 'not_submitted' as const }
      : await this.options.platform.find(claim.step.step, claim.account, claim.step.operation_key, this.parentFor(claim.step.step, claim.steps)).catch(() => ({ outcome: 'unknown' as const }));
    let facts: Result<ProvisionFacts & { account?: AccountCredentials }> = found;
    if (found.outcome === 'accepted' && claim.step.step === 'subaccount' && 'subaccount' in this.options.platform) {
      const account = await (this.options.platform as unknown as { subaccount(op: string): Promise<AccountCredentials | null> }).subaccount(claim.step.operation_key);
      facts = account ? { outcome: 'accepted', value: { sid: account.accountSid, account } } : { outcome: 'unknown' };
    }
    return this.apply(workspace, claim.step, facts, 'reconcile');
  }
  private parentFor(step: RegistrationStep, steps: StepRow[]) {
    const sid = (name: RegistrationStep) => steps.find(s => s.step === name)?.provider_sid ?? undefined;
    return step === 'brand' ? sid('customer_profile') : step === 'campaign' ? sid('messaging_service') : undefined;
  }
  private async call(workspace: string, reg: RegistrationRow, step: StepRow, steps: StepRow[], brand: BrandRow, company: string, notificationEmail: string | null, signupUrl: string | null, account: AccountCredentials | null): Promise<Result<ProvisionFacts & { account?: AccountCredentials }>> {
    const platform = this.options.platform, op = step.operation_key, facts = (name: RegistrationStep) => steps.find(s => s.step === name)?.facts;
    if (step.step === 'subaccount') {
      if (platform.mode === 'live') return this.options.liveAccount ? { outcome: 'accepted', value: { sid: this.options.liveAccount.accountSid, account: this.options.liveAccount } } : { outcome: 'rejected', reason: 'live_account_not_configured' };
      const created = await platform.createSubaccount(op);
      return created.outcome === 'accepted' ? { outcome: 'accepted', value: { sid: created.value!.accountSid, account: created.value! } } : { outcome: created.outcome, ...(created.reason ? { reason: created.reason } : {}), ...(created.retryAfterSeconds ? { retryAfterSeconds: created.retryAfterSeconds } : {}) };
    }
    if (!account) return { outcome: 'rejected', reason: 'provider_account_missing' };
    const p = brand.profile as { ein: string; website: string; businessType?: string; vertical: string; areaCode?: string; address: BusinessProfile['address']; contact: BusinessProfile['contact']; privacyPolicyUrl?: string; smsTermsUrl?: string };
    const callbacks = this.callbacks(workspace);
    if (step.step === 'customer_profile') {
      const business = twilioBusiness(brand.entity_type, p.businessType, p.vertical);
      if ('reason' in business) return { outcome: 'rejected', reason: business.reason };
      return platform.createCustomerProfile(account, op, {
      legalName: brand.legal_name, dbaName: brand.dba_name, entityType: brand.entity_type, businessType: p.businessType as TwilioBusinessType, companyType: business.companyType, ein: p.ein, website: p.website, vertical: p.vertical,
      address: p.address, contact: p.contact, notificationEmail: notificationEmail ?? p.contact.email,
    } satisfies BusinessProfile, callbacks.registration);
    }
    if (step.step === 'brand') return platform.submitBrand(account, op, facts('customer_profile')!.sid, String(facts('customer_profile')!.parentSid ?? ''));
    if (step.step === 'messaging_service') return platform.createMessagingService(account, op, callbacks);
    const name = brand.dba_name ?? brand.legal_name;
    if (step.step === 'campaign') {
      const wording = campaignWording(brand.profile);
      // Generic wording is for the mock only. Live campaigns file the business's own description and samples.
      if (!wording && platform.mode === 'live') return { outcome: 'rejected', reason: 'campaign_wording_missing' };
      // Carrier vetting checks the opt-in. The SMS box only appears once a number is active, so reviewers get the
      // live page and its view-only SMS preview. Refused here, before the campaign fee, if there is no page to show.
      if (!signupUrl && platform.mode === 'live') return { outcome: 'rejected', reason: 'signup_page_missing' };
      const optIn = signupUrl ? ` Sign-up page: ${signupUrl}. The SMS box appears there once this campaign's number is active; until then the same form with the SMS box can be viewed at ${signupUrl}?preview=sms.` : '';
      const policies = p.privacyPolicyUrl && p.smsTermsUrl ? ` SMS terms: ${p.smsTermsUrl}. Privacy policy: ${p.privacyPolicyUrl}.` : '';
      const stay = wording?.stayTexts ? ` The same checkbox also covers texts about the subscriber's own booked stays (arrival details, check-in and checkout reminders). Stay texts go only to subscribers who opted in this way and confirmed with YES.` : '';
      return platform.submitCampaign(account, op, facts('messaging_service')!.sid, facts('brand')!.sid, {
      useCase: wording?.useCase ?? 'MARKETING',
      description: wording?.description ?? `${name} sends marketing texts (offers, events and updates) to customers who opted in on ${name}'s Flockletter-hosted sign-up page.`,
      messageFlow: `Customers opt in on ${name}'s hosted sign-up page by checking an optional, unchecked SMS box that shows the program name, message frequency, "Msg & data rates may apply", STOP and HELP instructions, and links to the privacy policy and SMS terms. They then reply YES to a confirmation text before any other message.${stay}${optIn}${policies}`,
      samples: wording?.samples ?? [`${name}: This week only, 15% off in store. Reply STOP to opt out.`, `${name}: Our spring hours start Monday, 9am-6pm. Reply STOP to opt out.`],
      optInMessage: `${name}: Reply YES to confirm you want texts from us. Msg & data rates may apply. Reply STOP to opt out.`,
      optOutMessage: `${name}: You are unsubscribed and will receive no more texts. Reply START to resubscribe.`,
      helpMessage: `${name}: For help contact ${brand.help_contact}. Reply STOP to opt out.`, hasLinks: true });
    }
    return platform.buyNumber(account, op, facts('messaging_service')!.sid, typeof p.areaCode === 'string' ? p.areaCode : null);
  }
  private async apply(workspace: string, step: StepRow, result: Result<ProvisionFacts & { account?: AccountCredentials }>, via: 'call' | 'reconcile'): Promise<'progress' | Date | null> {
    const now = this.now();
    return this.options.db.tenant(workspace, async sql => {
      await lockWorkspace(sql, workspace);
      const current = (await sql.query<StepRow>('SELECT * FROM sms_registration_steps WHERE operation_key=$1 FOR UPDATE', [step.operation_key])).rows[0]!;
      if (current.state === 'done' || current.state === 'rejected') return 'progress';
      const reg = (await sql.query<RegistrationRow>('SELECT * FROM sms_registrations WHERE id=$1 FOR UPDATE', [step.registration_id])).rows[0]!;
      if (reg.revision !== step.revision) return null;
      const settings = await readSettings(sql, workspace);
      let next: { state: string; reason?: string | null; at?: Date | null };
      if (result.outcome === 'accepted' && result.value) {
        const value = result.value;
        if (value.account) {
          await sql.query('SELECT flockletter_customer_jobs.texting_bind_account($1,$2,$3)', [workspace, value.account.accountSid, this.options.seal.seal(value.account, workspace)]);
          delete value.account;
        }
        await sql.query(`UPDATE sms_registration_steps SET state='done',provider_sid=$2,facts=$3,reason=NULL,next_check_at=NULL,updated_at=clock_timestamp() WHERE operation_key=$1`, [step.operation_key, value.sid, JSON.stringify(value)]);
        const column = { subaccount: 'account_sid', customer_profile: 'customer_profile_sid', brand: 'brand_sid', messaging_service: 'messaging_service_sid', campaign: 'campaign_sid', number: null }[step.step];
        if (column) await sql.query(`UPDATE sms_registrations SET ${column}=$2,updated_at=clock_timestamp() WHERE id=$1`, [reg.id, value.sid]);
        if (step.step === 'brand') await sql.query(`UPDATE sms_registrations SET state='brand_pending',brand_status=coalesce(brand_status,$2) WHERE id=$1`, [reg.id, (value.status ?? 'PENDING').toUpperCase()]);
        if (step.step === 'campaign') await sql.query(`UPDATE sms_registrations SET state='campaign_pending',campaign_status=coalesce(campaign_status,$2) WHERE id=$1`, [reg.id, (value.status ?? 'IN_PROGRESS').toUpperCase()]);
        if (step.step === 'number' && value.e164) {
          const brand = (await sql.query<{ id: string }>('SELECT id FROM sms_carrier_brands WHERE id=$1', [reg.carrier_brand_id])).rows[0]!;
          const numberId = randomUUID();
          const service = (await sql.query<{ provider_sid: string }>(`SELECT provider_sid FROM sms_registration_steps WHERE registration_id=$1 AND revision=$2 AND step='messaging_service'`, [reg.id, reg.revision])).rows[0]!;
          const inserted = (await sql.query<{ id: string }>(`INSERT INTO sms_numbers(workspace_id,id,carrier_brand_id,e164,provider_sid,messaging_service_sid,state) VALUES($1,$2,$3,$4,$5,$6,'active')
            ON CONFLICT(e164) DO NOTHING RETURNING id`, [workspace, numberId, brand.id, value.e164, value.sid, service.provider_sid])).rows[0];
          if (inserted) await sql.query('SELECT flockletter_customer_jobs.texting_bind_number($1,$2,$3)', [workspace, value.e164, inserted.id]);
        }
        next = { state: 'done' };
      } else if (result.outcome === 'rejected') {
        await sql.query(`UPDATE sms_registration_steps SET state='rejected',reason=$2,updated_at=clock_timestamp() WHERE operation_key=$1`, [step.operation_key, result.reason ?? 'rejected']);
        await sql.query(`UPDATE sms_registrations SET state='rejected',rejection_reason=$2,updated_at=clock_timestamp() WHERE id=$1`, [reg.id, `${step.step}: ${result.reason ?? 'rejected'}`]);
        next = { state: 'rejected', reason: result.reason ?? 'rejected' };
      } else if (result.outcome === 'not_submitted' && via === 'call') {
        // Nothing was created (rate limit or similar): safe to try again after the delay.
        const at = new Date(now.getTime() + 1000 * Math.max(1, result.retryAfterSeconds ?? 30));
        await sql.query(`UPDATE sms_registration_steps SET state='queued',reason=$2,next_check_at=$3,updated_at=clock_timestamp() WHERE operation_key=$1`, [step.operation_key, result.reason ?? 'not_submitted', at]);
        next = { state: 'queued', reason: result.reason ?? null, at };
      } else if (result.outcome === 'not_submitted') {
        // Reconcile found nothing. Retry only once the operator's settle time has passed since the last call.
        const settle = settings.reconcile_settle_minutes;
        const ready = settle !== undefined && current.updated_at.getTime() + settle * 60000 <= now.getTime();
        const at = ready ? now : new Date(now.getTime() + 60000);
        await sql.query(`UPDATE sms_registration_steps SET state=$2,reason=$3,next_check_at=$4,updated_at=CASE WHEN $2='queued' THEN clock_timestamp() ELSE updated_at END WHERE operation_key=$1`,
          [step.operation_key, ready ? 'queued' : 'uncertain', ready ? 'not_found_after_settle' : 'not_found_yet', at]);
        next = { state: ready ? 'queued' : 'uncertain', at };
      } else {
        const at = new Date(now.getTime() + 30000);
        await sql.query(`UPDATE sms_registration_steps SET state='uncertain',reason=$2,next_check_at=$3 WHERE operation_key=$1`, [step.operation_key, result.reason ?? 'unknown', at]);
        next = { state: 'uncertain', reason: result.reason ?? 'unknown', at };
      }
      await audit(sql, workspace, 'worker', 'worker', 'registration.' + via, step.operation_key, { state: current.state }, { state: next.state, ...(next.reason ? { reason: next.reason } : {}) });
      return next.state === 'done' ? 'progress' : next.at ?? null;
    });
  }
  /** All steps done: approved once the carrier has verified the campaign. */
  private async complete(workspace: string, registrationId: string) {
    return this.options.db.tenant(workspace, async sql => {
      const reg = (await sql.query<RegistrationRow>('SELECT * FROM sms_registrations WHERE id=$1 FOR UPDATE', [registrationId])).rows[0];
      if (reg && reg.state !== 'approved' && ['VERIFIED', 'APPROVED'].includes(reg.campaign_status ?? '')) {
        await sql.query(`UPDATE sms_registrations SET state='approved',updated_at=clock_timestamp() WHERE id=$1`, [reg.id]);
        await audit(sql, workspace, 'worker', 'worker', 'registration.approved', reg.id, { state: reg.state }, { state: 'approved' });
      }
      return null;
    });
  }
  /** A carrier status from a signed callback or a poll. Applied only as a forward move. */
  async status(sql: Sql, workspace: string, kind: 'brand' | 'campaign', sid: string, status: string, reason: string | null, source: Interface) {
    const column = kind === 'brand' ? 'brand' : 'campaign';
    const reg = (await sql.query<RegistrationRow>(`SELECT * FROM sms_registrations WHERE ${column}_sid=$1 FOR UPDATE`, [sid])).rows[0];
    if (!reg) return false;
    const previous = (kind === 'brand' ? reg.brand_status : reg.campaign_status) ?? 'PENDING', upper = status.toUpperCase();
    if ((registrationRank[upper] ?? 0) <= (registrationRank[previous] ?? 0) && upper !== previous) {
      await audit(sql, workspace, source === 'webhook' ? 'twilio' : 'worker', source, `registration.${kind}_status_ignored`, reg.id, { status: previous }, { status: upper });
      return true;
    }
    if (upper === previous) return true;
    await sql.query(`UPDATE sms_registrations SET ${column}_status=$2,status_checked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`, [reg.id, upper]);
    let state: RegistrationState = reg.state;
    if (upper === 'FAILED') state = 'rejected';
    else if (upper === 'SUSPENDED') state = 'suspended';
    if (state !== reg.state) await sql.query('UPDATE sms_registrations SET state=$2,rejection_reason=$3 WHERE id=$1', [reg.id, state, upper === 'FAILED' ? `${kind}: ${reason ?? 'carrier rejected'}` : reg.rejection_reason]);
    await audit(sql, workspace, source === 'webhook' ? 'twilio' : 'worker', source, `registration.${kind}_status`, reg.id, { status: previous, state: reg.state }, { status: upper, state });
    return true;
  }
  private async poll(workspace: string, registrationId: string): Promise<Date | null> {
    const minutes = await this.options.db.read(workspace, async sql => (await readSettings(sql, workspace)).registration_poll_minutes);
    if (minutes === undefined) return null;
    const work = await this.options.db.read(workspace, async sql => {
      const reg = (await sql.query<RegistrationRow>('SELECT * FROM sms_registrations WHERE id=$1', [registrationId])).rows[0];
      if (!reg || !['brand_pending', 'campaign_pending'].includes(reg.state)) return null;
      const due = new Date((reg.status_checked_at?.getTime() ?? 0) + minutes * 60000);
      return { reg, due, account: await this.account(sql, workspace) };
    });
    if (!work || !work.account) return null;
    if (work.due > this.now()) return work.due;
    const checks: ['brand' | 'campaign', string | null, string | undefined][] = [['brand', work.reg.brand_sid, undefined], ['campaign', work.reg.campaign_sid, work.reg.messaging_service_sid ?? undefined]];
    for (const [kind, sid, parent] of checks) {
      if (!sid) continue;
      const result = await this.options.platform.status(kind, work.account, sid, parent).catch(() => ({ outcome: 'unknown' as const, value: undefined }));
      await this.options.db.tenant(workspace, async sql => {
        await sql.query('UPDATE sms_registrations SET status_checked_at=clock_timestamp() WHERE id=$1', [registrationId]);
        if (result.outcome === 'accepted' && result.value) await this.status(sql, workspace, kind, sid, result.value.status, result.value.reason ?? null, 'worker');
      });
    }
    return new Date(this.now().getTime() + minutes * 60000);
  }
}

/**
 * The company's enabled hosted sign-up page, when the workspace shows the phone field. Audience settings are
 * brand-scoped, so each of the company's brands is checked under its own brand context, which is then cleared.
 */
export async function signupPage(sql: Sql, companyId: string, origin: string): Promise<string | null> {
  const fields = (await sql.query<{ phone_field: boolean }>('SELECT phone_field FROM sms_workspace_profile')).rows[0];
  if (!fields?.phone_field) return null;
  const brands = (await sql.query<{ brand_id: string }>('SELECT brand_id FROM company_brands WHERE company_id=$1 ORDER BY brand_id', [companyId])).rows;
  let url: string | null = null;
  for (const { brand_id } of brands) {
    await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [brand_id]);
    const slug = (await sql.query<{ slug: string | null }>('SELECT public.flockletter_signup_slug(form_token) slug FROM customer_audience_settings WHERE brand_id=$1 AND enabled', [brand_id])).rows[0]?.slug;
    if (slug) { url = new URL('/signup/' + slug, origin).href; break; }
  }
  await sql.query("SELECT set_config('app.intake_brand_id','',true)");
  return url;
}
