import type { Database, Sql } from '../db.js';
import { TwilioMockPlatform, TwilioMockState } from './twilio-mock.js';
import { bodyDigest, CredentialSeal, type CampaignInput, type ProvisionFacts } from './twilio.js';
import { audit } from './storage.js';

type Binding = { registration: string; revision: number; account: string; profile: string; brand: string; service: string; campaign: string; number: string };
type Eligibility = Binding & { description: string | null; samples: string[] | null; privacy: string; terms: string; business: string; help: string; a2p: string };
type Progress = { binding: string; reviewAfter: number; phase: 'brand' | 'campaign' };
type UpgradeResult = { state: 'pending'; next: Date } | { state: 'approved' } | { state: 'failed'; reason: string };

/** Exercises the actual staged carrier's brand, campaign and decision APIs. Provider resources and
 * the eventual revision are bound to the current approved profile, account, service and number. */
export async function reviewPracticeUpgrade(db: Database, sql: Sql, workspace: string, registrationId: string,
  companyId: string, request: string, now: Date, origin: string): Promise<UpgradeResult> {
  const current = (await sql.query<Eligibility>(`SELECT r.id registration,r.revision,r.account_sid account,r.customer_profile_sid profile,
      r.brand_sid brand,r.messaging_service_sid service,r.campaign_sid campaign,n.provider_sid number,p.facts->>'parentSid' a2p,
      b.profile#>>'{campaign,description}' description,b.profile#>'{campaign,samples}' samples,
      b.profile->>'privacyPolicyUrl' privacy,b.profile->>'smsTermsUrl' terms,coalesce(b.dba_name,b.legal_name) business,b.help_contact help
    FROM sms_registrations r JOIN sms_carrier_brands b ON b.id=r.carrier_brand_id JOIN sms_numbers n ON n.carrier_brand_id=b.id
      AND n.state='active' AND n.messaging_service_sid=r.messaging_service_sid
    JOIN sms_registration_steps p ON p.registration_id=r.id AND p.revision=r.revision AND p.step='customer_profile' AND p.state='done'
    WHERE r.workspace_id=$1 AND r.id=$2 AND b.company_id=$3 AND r.state='approved' AND b.entity_type<>'sole_proprietor'
      AND r.brand_status IN ('APPROVED','VERIFIED') AND r.campaign_status IN ('APPROVED','VERIFIED')`, [workspace, registrationId, companyId])).rows[0];
  if (!current?.account || !current.profile || !current.a2p || !current.brand || !current.campaign || !current.description || !current.samples?.length)
    return { state: 'failed', reason: 'registration_evidence_missing' };
  const store = new TwilioMockState(db, sql), carrier = new TwilioMockPlatform(store);
  const stored = (await sql.query<{ account_sid: string; credentials: string }>('SELECT account_sid,credentials FROM flockletter_customer_jobs.texting_account($1)', [workspace])).rows[0];
  const account = stored && stored.account_sid === current.account ? CredentialSeal.mock().open(stored.credentials, workspace) : null;
  if (!account || account.accountSid !== current.account || await store.workspace(current.account) !== workspace)
    return { state: 'failed', reason: 'registration_account_mismatch' };
  const key = `commercial-standard/${workspace}/${request}`;
  const binding = bodyDigest(JSON.stringify([workspace, companyId, request, current]));
  const waiting = new Date(+now + 4_000);
  let progress = await store.get<Progress>(key);
  if (progress && progress.binding !== binding) return { state: 'failed', reason: 'registration_changed' };
  if (!progress) { progress = { binding, reviewAfter: +waiting, phase: 'brand' }; await store.put(key, progress); }
  const brandKey = request + '/standard-brand', campaignKey = request + '/standard-campaign';
  let brand = await carrier.find('brand', account, brandKey);
  if (brand.outcome === 'not_submitted') brand = await carrier.submitBrand(account, brandKey, current.profile, current.a2p, 'standard');
  if (brand.outcome === 'rejected') return { state: 'failed', reason: brand.reason ?? 'brand_rejected' };
  if (brand.outcome !== 'accepted') return { state: 'pending', next: waiting };
  const brandFacts = brand.value as ProvisionFacts & { tier?: string };
  if (brandFacts.parentSid !== current.profile || brandFacts.tier !== 'standard') return { state: 'failed', reason: 'brand_mismatch' };
  const callback = new URL('/api/v1/texting/twilio/registration', origin);
  callback.searchParams.set('w', workspace);
  const brandVerdict = await carrier.status('brand', account, brandFacts.sid);
  if (brandVerdict.value?.status === 'FAILED' || brandVerdict.value?.status === 'SUSPENDED') return { state: 'failed', reason: 'brand_rejected' };
  if (brandVerdict.value?.status !== 'APPROVED') {
    if (progress.reviewAfter <= +now) await carrier.decide('brand', account, brandFacts.sid, 'APPROVED', callback.href);
    return { state: 'pending', next: progress.reviewAfter <= +now ? now : new Date(progress.reviewAfter) };
  }
  if (progress.phase === 'brand') { progress = { binding, reviewAfter: +waiting, phase: 'campaign' }; await store.put(key, progress); }
  let campaign = await carrier.find('campaign', account, campaignKey);
  if (campaign.outcome === 'not_submitted') {
    const input: CampaignInput = { useCase: 'MARKETING', privacyPolicyUrl: current.privacy, termsUrl: current.terms,
      description: current.description, samples: current.samples, messageFlow: 'Subscribers opt in on the hosted form and confirm by replying YES.',
      optInMessage: `${current.business}: Reply YES to confirm.`, optOutMessage: `${current.business}: You are unsubscribed.`,
      helpMessage: `${current.business}: Contact ${current.help} for help.`, hasLinks: true };
    campaign = await carrier.submitCampaign(account, campaignKey, current.service, brandFacts.sid, input);
  }
  if (campaign.outcome === 'rejected') return { state: 'failed', reason: campaign.reason ?? 'campaign_rejected' };
  if (campaign.outcome !== 'accepted') return { state: 'pending', next: waiting };
  const campaignFacts = campaign.value as ProvisionFacts & { brandSid?: string };
  if (campaignFacts.parentSid !== current.service || campaignFacts.brandSid !== brandFacts.sid) return { state: 'failed', reason: 'campaign_mismatch' };
  const campaignVerdict = await carrier.status('campaign', account, campaignFacts.sid);
  if (campaignVerdict.value?.status === 'FAILED' || campaignVerdict.value?.status === 'SUSPENDED') return { state: 'failed', reason: 'campaign_rejected' };
  if (campaignVerdict.value?.status !== 'VERIFIED') {
    if (progress.reviewAfter <= +now) await carrier.decide('campaign', account, campaignFacts.sid, 'VERIFIED', callback.href);
    return { state: 'pending', next: progress.reviewAfter <= +now ? now : new Date(progress.reviewAfter) };
  }
  // Preserve earlier intents/receipts on their old revision. The active number stays on this service.
  await sql.query(`INSERT INTO sms_registration_steps(workspace_id,registration_id,revision,step,operation_key,state,provider_sid,facts,attempts)
    SELECT workspace_id,registration_id,revision+1,step,$4||'/'||CASE step WHEN 'brand' THEN 'standard-brand' WHEN 'campaign' THEN 'standard-campaign' ELSE step END,'done',
      CASE step WHEN 'brand' THEN $5 WHEN 'campaign' THEN $6 ELSE provider_sid END,
      CASE step WHEN 'brand' THEN $7::jsonb WHEN 'campaign' THEN $8::jsonb ELSE facts END,attempts
    FROM sms_registration_steps WHERE workspace_id=$1 AND registration_id=$2 AND revision=$3 AND state='done'`,
  [workspace, registrationId, current.revision, request, brandFacts.sid, campaignFacts.sid, JSON.stringify(brandFacts), JSON.stringify(campaignFacts)]);
  await sql.query(`UPDATE sms_registrations SET revision=revision+1,brand_sid=$4,campaign_sid=$5,brand_status='APPROVED',campaign_status='VERIFIED',
    updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND revision=$3`, [workspace, registrationId, current.revision, brandFacts.sid, campaignFacts.sid]);
  await audit(sql, workspace, 'mock_carrier', 'worker', 'texting.practice_standard_approved', request,
    { revision: current.revision }, { registration: registrationId, revision: current.revision + 1, brand: brandFacts.sid, campaign: campaignFacts.sid });
  return { state: 'approved' };
}
