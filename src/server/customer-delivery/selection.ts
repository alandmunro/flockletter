import {externalDelivery,type DeliveryProviders,type SendingProvider} from '../../shared/customer-delivery.js';
import type {Sql} from '../db.js';
import type {DeliveryOptions} from './types.js';
import {requireCondition} from '../errors.js';

export async function selectedDelivery(sql:Sql,options:DeliveryOptions,workspace:string,brand:string) {
 const choice=(await sql.query<{provider:SendingProvider;revision:number}>('SELECT provider,revision FROM customer_delivery_providers WHERE brand_id=$1',[brand])).rows[0];
 const mode=externalDelivery(options.mode)?choice?.provider??options.mode:options.mode;
 return {mode,revision:choice?.revision??0,provider:externalDelivery(mode)?options.provider?.(workspace,brand,mode):undefined};
}
/** Apply the same current consent test to the selected, confirmed population in preflight and review. */
export async function eligibleBroadcastContacts<T extends {id:string}>(sql:Sql,options:DeliveryOptions,mode:DeliveryOptions['mode'],contacts:T[]):Promise<T[]> {
 if(!externalDelivery(mode))return contacts;
 if(options.liveConsentBatch){
  const eligible=new Set(await options.liveConsentBatch(sql,contacts.map(contact=>contact.id)));
  return contacts.filter(contact=>eligible.has(contact.id));
 }
 const eligible:T[]=[];
 for(const contact of contacts)if(await options.liveConsent?.(sql,contact.id))eligible.push(contact);
 return eligible;
}

export async function deliveryProviders(sql:Sql,options:DeliveryOptions,workspace:string,brand:string):Promise<DeliveryProviders> {
 const selected=await selectedDelivery(sql,options,workspace,brand);
 const choices=await Promise.all((['ses','resend'] as const).map(async provider=>{
  const port=externalDelivery(options.mode)?options.provider?.(workspace,brand,provider):undefined;
  let ready=false;try{ready=!!port&&await port.ready?.()===true;}catch{/* Unknown readiness fails closed. */}
  return {provider,configured:!!port,ready};
 }));
 return {selected:externalDelivery(selected.mode)?selected.mode:null,revision:selected.revision,mode:selected.mode,choices};
}
/** Caller holds the workspace lock and has verified the current workspace owner. */
export async function selectDeliveryProvider(sql:Sql,options:DeliveryOptions,workspace:string,input:{brandId:string;provider:SendingProvider;expectedRevision:number}) {
 requireCondition(externalDelivery(options.mode),409,'delivery_off','A platform operator must configure external delivery before a service can be selected.');
 const current=await selectedDelivery(sql,options,workspace,input.brandId);
 requireCondition(current.revision===input.expectedRevision,409,'provider_revision_conflict','The sending service changed. Refresh before saving your choice.');
 requireCondition(options.provider?.(workspace,input.brandId,input.provider),422,'provider_unavailable','This service is not configured for this brand. Ask the platform operator to complete its setup.');
 await sql.query(`INSERT INTO customer_delivery_providers(workspace_id,brand_id,provider,revision) VALUES($1,$2,$3,$4)
  ON CONFLICT(workspace_id,brand_id) DO UPDATE SET provider=excluded.provider,revision=excluded.revision,updated_at=now()`,[workspace,input.brandId,input.provider,current.revision+1]);
 return deliveryProviders(sql,options,workspace,input.brandId);
}
