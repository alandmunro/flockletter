import { emptyContent, type CampaignContent } from '../../shared/contracts.js';
import { giftGreetingBody, giftGreetingSubject } from '../../shared/date-automations.js';
import { digest, escapeHtml } from '../content.js';
import type { Actor } from '../service.js';
import type { DeliveryRow, PersonRow } from '../customer-delivery/types.js';
import type { Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import { eligibleGiftRecipients } from './audience.js';
import { one } from './store.js';
import { giftSendingHold } from './service.js';
import { reservedGiftLink } from './ledger.js';

export type GiftDeliveryPolicy = { mode:'capture'|'live'; account:string; verifiedBrands?:ReadonlySet<string>; recordedDecisions?:boolean };
type GiftConfiguration = {provider:{account:string};opts:{live:boolean;verifiedBrands?:ReadonlySet<string>}};
export function configuredGiftDelivery(environment:string, flag:string|undefined, gifts:GiftConfiguration|null) {
  if (!gifts) return undefined;
  const account=gifts.provider.account;
  if (environment==='production' && flag==='live' && gifts.opts.live)
    return {mode:'live' as const,account,recordedDecisions:true,verifiedBrands:gifts.opts.verifiedBrands};
  if (environment!=='production' && !gifts.opts.live && (flag===undefined||flag==='capture'))
    return {mode:'capture' as const,account};
  return undefined;
}

export function giftDeliveryAllowed(policy:GiftDeliveryPolicy|undefined, mode:string, brand:string|undefined) {
  if (!policy || !brand) return false;
  return policy.mode==='capture' ? mode==='capture'
    : ['live','ses','resend'].includes(mode) && (policy.recordedDecisions===true || policy.verifiedBrands?.has(brand)===true);
}

export type GiftRecipient = {
  workspaceId: string;
  brandId: string;
  campaignId: string;
  personId: string;
};

// A review can retain this binding and digest. Only a private, recipient-specific
// delivery payload needs the bearer link. No short-link or redirect record is created.
export async function reservedDeliveryGift(sql: Sql, recipient: GiftRecipient, origin: string, policy: GiftDeliveryPolicy) {
  const { workspaceId, brandId, campaignId, personId } = recipient;
  requireCondition((await sql.query(`SELECT 1 WHERE current_setting('app.workspace_id',true)=$1
    AND current_setting('app.intake_brand_id',true)=$2`, [workspaceId, brandId])).rowCount,
    403, 'gift_scope_mismatch', 'Use the reviewed workspace and brand.');
  requireCondition(!await one(sql,'closure','closed') && !await giftSendingHold(sql),
    409, 'gift_workspace_paused', 'Gift delivery is paused for this workspace.');
  const path = await reservedGiftLink(sql, workspaceId, brandId, campaignId, personId);
  requireCondition(path, 409, 'gift_offer_unavailable', 'This recipient has no available reserved offer in this campaign.');
  const base = new URL(origin);
  const prefix = '/workspace-gift.html#';
  const fragment = new URLSearchParams(path.slice(prefix.length));
  requireCondition(path.startsWith(prefix) && fragment.get('workspace') === workspaceId &&
    Boolean(fragment.get('offer')) && /^[a-f0-9]{64}$/.test(fragment.get('token') ?? ''),
    409, 'gift_link_unavailable', 'The reserved offer link is unavailable.');
  const campaign=await one(sql,'campaign',campaignId);
  if (policy.mode==='live') {
    const decision=policy.recordedDecisions ? await one(sql,'signal','eligibility:'+brandId) : undefined;
    const approved=decision ? ['probation','complete'].includes(decision.kind) : policy.verifiedBrands?.has(brandId);
    requireCondition(base.protocol==='https:' && approved &&
      campaign && campaign.brand===brandId && 'live' in campaign && campaign.live===true &&
      'account' in campaign && campaign.account===policy.account,
      409,'gift_provenance_mismatch','The gift campaign requires a verified live reservation for this brand.');
    const offer=await one(sql,'offer',fragment.get('offer')!);
    requireCondition(offer?.alloc.length && offer.campaign===campaignId && offer.person===personId && offer.brand===brandId,
      409,'gift_provenance_mismatch','The gift reservation is unavailable.');
    for (const allocation of offer.alloc) {
      const lot=await one(sql,'lot',allocation.id);
      requireCondition(lot && 'live' in lot && lot.live===true && lot.account===policy.account && lot.paidAt && lot.payment && lot.charge,
        409,'gift_provenance_mismatch','The gift reservation requires verified live funding.');
    }
  } else {
    requireCondition(!campaign || !('live' in campaign) || campaign.live===false,
      409,'gift_provenance_mismatch','The gift campaign is unavailable in capture mode.');
  }
  const url = new URL(path, base.origin);
  const fingerprint = digest(JSON.stringify([workspaceId, brandId, campaignId, personId, policy.mode, policy.account, url.href]));
  return { url: url.href, fingerprint };
}

export function giftCampaignContent(source: CampaignContent): CampaignContent {
  return { ...emptyContent(), title: source.title, fromName: source.fromName, replyTo: source.replyTo,
    subject: giftGreetingSubject, heading: giftGreetingSubject, body: giftGreetingBody };
}

const attachmentActor = 'workspace-gifts:delivery:v1';

// Called at the end of canonical delivery.review, inside its workspace lock, before
// returning the review ID. The operation journal grants runtime INSERT and SELECT only.
export async function reviewCampaignGifts(sql: Sql, actor: Actor, row: DeliveryRow,
  campaignId: string, origin: string, policy:GiftDeliveryPolicy) {
  requireCondition(actor.kind === 'session' && actor.owner && actor.workspaceId === row.workspace_id &&
    row.creator_id === actor.userId && row.actor_id === actor.actorId &&
    (actor.brandIds === null || actor.brandIds.includes(row.brand_id)),
    403, 'gift_owner_required', 'Review gift attachments in the current workspace owner session.');
  requireCondition(giftDeliveryAllowed(policy,row.mode,row.brand_id) && row.state === 'reviewed' && row.purpose === 'broadcast' && !row.date_automation,
    409, 'gift_review_required', 'Choose a new campaign review in the configured gift delivery mode.');
  const c = row.content;
  requireCondition(c.body === giftGreetingBody && c.subject === giftGreetingSubject && c.heading === giftGreetingSubject &&
    !c.studio && !c.preheader && !c.ctaUrl && !c.ctaLabel && !c.assetIds.length,
    409, 'gift_copy_required', 'Review the thank-you gift wording before attaching offers.');
  const result=await campaignGiftBindings(sql,row,campaignId,origin,policy);
  await sql.query('INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4,$5)',
    [row.workspace_id,attachmentActor,row.id,digest(JSON.stringify(result)),result]);
}

async function campaignGiftBindings(sql:Sql,row:DeliveryRow,campaignId:string,origin:string,policy:GiftDeliveryPolicy){
  const people = await eligibleGiftRecipients(sql, row.workspace_id, row.brand_id, policy.mode==='live'?'live':'exercise');
  const eligible = new Map(people.map(p => [p.id, p]));
  const { rows: selected } = await sql.query<Pick<PersonRow, 'id'|'subscriber_id'|'email_digest'>>(
    'SELECT id,subscriber_id,email_digest FROM customer_delivery_recipients WHERE workspace_id=$1 AND brand_id=$2 AND delivery_id=$3',
    [row.workspace_id,row.brand_id,row.id]);
  requireCondition(selected.length > 0 && selected.length === row.selected &&
    new Set(selected.map(p => p.subscriber_id)).size === selected.length,
    409, 'gift_audience_ambiguous', 'Review a deduplicated gift audience.');
  const bindings: Record<string,{personId:string; fingerprint:string}> = {};
  for (const item of selected) {
    const person = eligible.get(item.subscriber_id);
    requireCondition(person?.email && digest(person.email) === item.email_digest,
      409, 'gift_recipient_ineligible', 'A selected contact is unavailable for gift email.');
    const { fingerprint } = await reservedDeliveryGift(sql, {
      workspaceId: row.workspace_id, brandId: row.brand_id, campaignId, personId: person.id,
    }, origin,policy);
    bindings[item.id] = { personId: person.id, fingerprint };
  }
  return {brandId:row.brand_id,campaignId,bindings};
}

export async function checkGiftApproval(sql:Sql,row:DeliveryRow,campaignId:string,origin:string,policy:GiftDeliveryPolicy|undefined){
  requireCondition(policy && giftDeliveryAllowed(policy,row.mode,row.brand_id),
    409,'gift_delivery_unavailable','The reviewed gift delivery route is unavailable.');
  const current=await campaignGiftBindings(sql,row,campaignId,origin,policy);
  requireCondition((await sql.query('SELECT 1 FROM operations WHERE workspace_id=$1 AND actor_id=$2 AND operation_key=$3 AND result=$4::jsonb',
    [row.workspace_id,attachmentActor,row.id,current])).rowCount,
    409,'gift_review_changed','Review the current gift offers again.');
}

// Read the exact recipient binding from the review. A partially missing binding
// blocks delivery. Never enter this path to reconcile an earlier provider submission.
export async function reviewedCampaignGift(sql: Sql, row: DeliveryRow, person: PersonRow, origin: string, policy:GiftDeliveryPolicy) {
  const saved = (await sql.query<{brand:string;campaign:string;binding:{personId:string;fingerprint:string}|null}>(`
    SELECT result->>'brandId' brand,result->>'campaignId' campaign,result->'bindings'->$4::text binding
    FROM operations WHERE workspace_id=$1 AND actor_id=$2 AND operation_key=$3`,
    [row.workspace_id,attachmentActor,row.id,person.id])).rows[0];
  requireCondition(saved,409,'gift_review_changed','The gift review is unavailable.');
  requireCondition(giftDeliveryAllowed(policy,row.mode,row.brand_id) && saved.brand === row.brand_id && person.delivery_id === row.id &&
    (!('giftCampaignId' in row.content) || saved.campaign === row.content.giftCampaignId) &&
    person.brand_id === row.brand_id && person.workspace_id === row.workspace_id && saved.binding?.personId === person.subscriber_id,
    409, 'gift_review_changed', 'The reviewed recipient binding changed.');
  const current = (await eligibleGiftRecipients(sql, row.workspace_id, row.brand_id, policy.mode==='live'?'live':'exercise')).find(p => p.id === person.subscriber_id);
  requireCondition(current?.email && digest(current.email) === person.email_digest,
    409, 'gift_recipient_ineligible', 'This person is unavailable for a gift by email.');
  const gift = await reservedDeliveryGift(sql, {
    workspaceId: row.workspace_id, brandId: row.brand_id, campaignId: saved.campaign, personId: person.subscriber_id,
  }, origin,policy);
  requireCondition(gift.fingerprint === saved.binding.fingerprint,409,'gift_review_changed','The reviewed gift offer changed.');
  return gift.url;
}

export function attachEmailGift(message: { html: string; text: string }, reviewedUrl: string) {
  const end = message.html.lastIndexOf('</main>');
  requireCondition(end >= 0, 422, 'gift_message_invalid', 'The reviewed gift email cannot include its claim link.');
  const link = '<p><a href="' + escapeHtml(reviewedUrl) + '">View your gift</a></p>';
  return {
    html: message.html.slice(0, end) + link + message.html.slice(end),
    text: message.text + '\n\nView your gift: ' + reviewedUrl,
  };
}
