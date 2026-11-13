import {eligibleBroadcastContacts,selectedDelivery} from './selection.js';
import {externalDelivery} from '../../shared/customer-delivery.js';
import {testBudget} from './test-send.js';
import type { Campaign,Gap } from '../../shared/contracts.js';
import type { CustomerCampaignPreflight } from '../../shared/customer-preflight.js';
import type { Sql } from '../db.js';
import type { Actor } from '../service.js';
import type { DeliveryOptions } from './types.js';
import { contentGaps,digest } from '../content.js';
import { senderProfile,senderEligible } from './sender.js';
import { requireCondition } from '../errors.js';
import { planAllowance,utcMonth } from '../customer-billing/policy.js';
import {deliveryPurposeAllowed} from './policy.js';
import { usage as customerUsage } from '../customer-billing/service.js';

/** Observations, never send authorization. Review and execution repeat every critical check. */
export async function customerCampaignPreflight(sql:Sql,actor:Actor,campaign:Campaign,options:DeliveryOptions,
 input:{expectedVersion?:number;segmentId?:string;dueAt?:string;purpose?:'broadcast'|'test';subscriberId?:string}={},requireSend=false):Promise<CustomerCampaignPreflight> {
 const purpose=input.purpose??'broadcast';
 const owner=actor.kind==='session'&&actor.owner;
 if(owner||actor.kind==='connection')requireCondition(await options.isOwner(actor.userId,actor.workspaceId),403,'owner_required','Current issuing-owner authority is required.');
 let summary=actor.scopes.includes('audience:summary');
 if(actor.kind==='connection') {
  const grant=(await sql.query<{scopes:string[]}>(`SELECT scopes FROM connections WHERE id::text=$1 AND issuer_id=$2
   AND revoked_at IS NULL AND expires_at>clock_timestamp() AND 'read'=ANY(scopes) AND $3::uuid=ANY(brand_ids)
   AND (NOT $4::boolean OR 'campaign:send'=ANY(scopes))`,
   [actor.actorId.slice('connection:'.length),actor.userId,campaign.brandId,requireSend])).rows[0];
  requireCondition(grant,403,'connection_revoked','This connection no longer has current campaign access.');
  summary=grant.scopes.includes('audience:summary');
 }
 const gaps:Gap[]=[...contentGaps(campaign)];
 const add=(code:string,title:string,detail:string,area:Gap['area'])=>gaps.push({code,title,detail,area});
 if(input.expectedVersion!==undefined&&input.expectedVersion!==campaign.version)add('version_conflict','Reload the campaign','The saved revision changed. Review the current version.','content');
 if(options.mode==='off')add('delivery_off','Configure delivery','A platform operator must configure the delivery mode.','delivery');
 if(!deliveryPurposeAllowed(options.scope,purpose))add('broadcasts_disabled','Use a one-recipient test','Only separately reviewed tests to one confirmed contact are enabled. Broadcasts and schedules are disabled.','delivery');
 if(!options.render)add('renderer_required','Configure the renderer','The private message renderer is not available.','delivery');
 const selected=await selectedDelivery(sql,options,actor.workspaceId,campaign.brandId);
 const profile=await senderProfile(sql,campaign.brandId),provider=selected.provider;
 if(externalDelivery(selected.mode)) {
  if(!profile)add('sender_profile_required','Complete the sender profile','Save the legal sender identity and postal footer.','sender');
  if(!provider)add('provider_unavailable','Verify the provider route','The current brand provider route could not be verified.','delivery');
  let verified=false;try{verified=await senderEligible(sql,campaign.brandId,provider);}catch{/* Unknown readiness remains blocked. */}
  if(!verified)add('sender_verification_required','Verify this sender','Refresh domain ownership and the provider’s current sender/readiness checks.','sender');
 }
 if(options.safeguards){const trust=await options.safeguards.status(sql,actor.workspaceId);
  for(const [i,code] of trust.codes.entries())if(code==='sending_reputation_hold'||selected.mode==='resend'&&code.startsWith('sending_provider_'))add(code,'Review sending safeguards',trust.reasons[i]??'Sending needs operator review.','delivery');}
 const assets=(await sql.query<{id:string;sha256:string;bytes:Buffer}>('SELECT id,sha256,bytes FROM assets WHERE brand_id=$1 AND id=ANY($2::uuid[])',[campaign.brandId,campaign.content.assetIds])).rows;
 if(campaign.content.assetIds.some(id=>!assets.some(asset=>asset.id===id&&digest(asset.bytes)===asset.sha256)))add('image_unavailable','Review the original images','A selected original image is missing or changed.','content');
 if(input.segmentId)requireCondition((await sql.query('SELECT FROM audience_segments WHERE id=$1',[input.segmentId])).rowCount,404,'group_unavailable','Choose an available group in this brand.');
 let audience:CustomerCampaignPreflight['audience']={visibility:'restricted'};
 if(purpose==='test') {
  requireCondition(input.subscriberId&&!input.segmentId&&!input.dueAt,422,'invalid_test_recipient','Choose one known confirmed contact without a group or schedule.');
  const person=(await sql.query<{id:string;state:string}>('SELECT id,state FROM subscribers WHERE id=$1',[input.subscriberId])).rows[0];
  const confirmed=person?.state==='confirmed';
  const testSelected=Number(Boolean(confirmed&&(options.mode==='capture'||await options.liveConsent?.(sql,input.subscriberId))));
  if(owner||summary)audience={visibility:'available',confirmed:Number(confirmed),selected:testSelected,excluded:1-testSelected};
  if(!testSelected)add('test_recipient_ineligible','Select a confirmed test contact','The selected contact must be confirmed and consent-eligible in this brand.','audience');
 } else if(owner||summary) {
  const population=(await sql.query<{id:string;total:number;confirmed:number}>(`WITH population AS MATERIALIZED (
    SELECT s.id,s.state FROM subscribers s WHERE $1::uuid IS NULL OR EXISTS(SELECT FROM audience_segment_members m
    WHERE (m.workspace_id,m.brand_id,m.subscriber_id)=(s.workspace_id,s.brand_id,s.id) AND m.segment_id=$1))
    SELECT id,(SELECT count(*)::int FROM population) total,(SELECT count(*)::int FROM population WHERE state='confirmed') confirmed FROM population WHERE state='confirmed' ORDER BY id LIMIT 10001`,[input.segmentId??null])).rows;
  const total=population[0]?.total??Number((await sql.query<{n:string}>(`SELECT count(*) n FROM subscribers s WHERE $1::uuid IS NULL OR EXISTS(SELECT FROM audience_segment_members m
    WHERE (m.workspace_id,m.brand_id,m.subscriber_id)=(s.workspace_id,s.brand_id,s.id) AND m.segment_id=$1)`,[input.segmentId??null])).rows[0]?.n??0);
  if(population.length>10000) {
   audience={visibility:'over_limit',confirmed:population[0]?.confirmed??0};
   add('audience_limit','Narrow the audience','Choose at most 10,000 confirmed contacts. Exact eligible/excluded counts are unavailable until the audience is narrowed.','audience');
  } else {
   const eligible=await eligibleBroadcastContacts(sql,options,selected.mode,population);
   audience={visibility:'available',confirmed:population[0]?.confirmed??0,selected:eligible.length,excluded:total-eligible.length};
   if(!eligible.length)add('confirmed_audience_required','Confirm subscribers','No confirmed, consent-eligible recipient is available for this review.','audience');
  }
 } else add('audience_review_required','Review the audience','A current owner or an explicitly granted audience-summary connection must review recipient counts.','audience');
 const budget=purpose==='test'?await testBudget(sql):undefined;
 if(budget&&budget.remaining<1)add('test_daily_limit','Daily test limit reached','This workspace has used all five approved test requests for this UTC day. Cancellation or rejection does not restore this limit.','delivery');
 const status=options.eligibilitySql?await options.eligibilitySql(sql,actor.workspaceId):await options.billing.eligibility(actor.workspaceId);
 if(!status.eligible)add('service_activation_required','Review service access',owner?status.reasons.join(' '):'The workspace owner must review current service eligibility.','billing');
 const now=new Date(status.now),due=input.dueAt?new Date(input.dueAt):now;
 if(input.dueAt&&(due<=now||due.getTime()>now.getTime()+30*86400000))add('invalid_schedule','Choose a valid schedule','Choose a future time within 30 days.','delivery');
 if(status.state==='trialing'&&status.trialEnd&&due>=new Date(status.trialEnd))add('trial_schedule','Review the trial end','Choose a time before the verified trial ends.','billing');
 if(status.cancelAt&&due>=new Date(status.cancelAt))add('cancellation_schedule','Review the service end','Choose a time before the effective service end.','billing');
 const period=status.state==='trialing'?status.usage.period:utcMonth(due);
 const limits=status.pendingPlan&&status.periodEnd&&due>=new Date(status.periodEnd)?planAllowance(status.pendingPlan):status.limits;
 let allowance:CustomerCampaignPreflight['allowance'];
 if(limits) {
  const used=period===status.usage.period?status.usage:await customerUsage(sql,period);
  const remainingEmails=Math.max(0,limits.emails-used.emails-used.reservedEmails),remainingCampaigns=Math.max(0,limits.campaigns-used.campaigns-used.reservedCampaigns);
  if(owner)allowance={period,remainingEmails,remainingCampaigns,recipientLimit:limits.recipients};
  if(purpose==='broadcast'&&remainingCampaigns<1||(purpose==='test'?1:audience.visibility==='available'?audience.selected:0)>Math.min(limits.recipients,remainingEmails))
    add('allowance_exceeded','Review remaining allowance','This review cannot fit the shared remaining campaign or recipient allowance.','billing');
 }
 return {purpose,...(budget?{testBudget:budget}:{}),campaignId:campaign.id,version:campaign.version,brandId:campaign.brandId,segmentId:input.segmentId??null,senderRevision:profile?.revision??null,
  observedAt:new Date().toISOString(),mode:selected.mode,deliveryScope:options.scope??'all',canSend:false,reviewRequired:true,contentReady:!gaps.some(g=>g.area==='content'),gaps,audience,...(allowance?{allowance}:{})};
}
