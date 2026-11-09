import type { Sql } from '../db.js';
import type { CustomerBilling } from '../customer-billing/service.js';
import type { Actor } from '../service.js';
import type { CampaignContent } from '../../shared/contracts.js';
import type { DeliveryEnvelope, DeliveryOutcome } from '../campaign/delivery-provider.js';
import type { DeliveryMode } from '../../shared/customer-delivery.js';
import type { CustomerSenderProfile } from '../../shared/customer-delivery.js';
import type { CustomerBillingStatus } from '../../shared/customer-billing.js';

export type DeliveryRow = {
  workspace_id:string; brand_id:string; id:string; campaign_id:string; version:number; actor_id:string; creator_id:string;
  mode:'capture'|'ses'; state:string; content:CampaignContent; rendered_html:string; rendered_text:string;
  asset_digests:{id:string;name:string;sha256:string}[]; provider_binding:string; due_at:Date;
  selected:number; excluded:number; reason:string|null; reservation_key:string|null; created_at:Date;
  sender_profile:CustomerSenderProfile|null;
};
export type PersonRow = {
  workspace_id:string;brand_id:string;delivery_id:string;id:string;subscriber_id:string;email_digest:string;
  engine_reference:string;state:string;attempts:number;render_attempts:number;render_claim:string|null;
  render_received_at:Date|null;next_check_at:Date|null;reason:string|null;feedback:string|null;message_id:string|null;
};
export type CustomerProvider = {
  fingerprint:string;
  ready?:()=>Promise<boolean>;
  from?:string;
  submit(message:DeliveryEnvelope):Promise<{outcome:DeliveryOutcome;messageId?:string}>;
  lookup(operation:string):Promise<{outcome:DeliveryOutcome;messageId?:string}>;
};
export type DeliveryOptions = {
  mode:DeliveryMode; origin:string; environment:'local'|'test'|'staging'|'production';
  billing:Pick<CustomerBilling,'eligibility'|'reserve'|'settle'|'release'>;
  eligibilitySql?:(sql:Sql,workspace:string)=>Promise<CustomerBillingStatus>;
  isOwner:(user:string,workspace:string)=>Promise<boolean>;
  provider?:(workspace:string,brand:string)=>CustomerProvider|undefined;
  render?:(message:DeliveryEnvelope)=>Promise<void>;
  optOut?:(sql:Sql,workspace:string,brand:string,subscriber:string,origin:string)=>Promise<{url:string}>;
  liveConsent?:(sql:Sql,subscriber:string)=>Promise<boolean>;
  liveConsentBatch?:(sql:Sql,subscribers:string[])=>Promise<string[]>;
  now?:()=>Date;
};

export function permittedBrand(actor:Actor,brand:string) {
  return actor.brandIds === null || actor.brandIds.includes(brand);
}
