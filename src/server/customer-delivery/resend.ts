import {z} from 'zod';
import type {CustomerProvider} from './types.js';
import type {DeliveryEnvelope} from '../campaign/delivery-provider.js';
import type {DeliveryScope} from '../../shared/customer-delivery.js';
import {inlineOriginals} from '../campaign/ses-simulator.js';
import {boundedJson} from '../customer-support/writer.js';
import {customerDeliveryScope,deliveryPurposeAllowed,requireMailingActivation} from './policy.js';
import {parseResendRoute,type ResendRoute} from './resend-route.js';

export const resendEvents=['email.sent','email.delivered','email.bounced','email.complained','email.failed','email.delivery_delayed'] as const;
// Resend returns null for absent recipient lists on real receipts. Nonempty lists still fail closed.
const noAdditionalRecipients=z.array(z.string()).max(0).nullish().transform(value=>value??[]);
export const resendReceipt=z.object({id:z.uuid(),from:z.string().max(420),to:z.array(z.email()).length(1),cc:noAdditionalRecipients,bcc:noAdditionalRecipients,tags:z.array(z.object({name:z.string().max(256),value:z.string().max(256)})).max(100)});
export const receiptTag=(tags:{name:string;value:string}[],name:string)=>{const found=tags.filter(t=>t.name===name);return found.length===1?found[0]!.value:'';};
export function routeReceipt(receipt:z.infer<typeof resendReceipt>,route:ResendRoute) {
 const from=receipt.from.match(/<([^<>]+)>$/)?.[1]??receipt.from;
 return from===route.from&&receiptTag(receipt.tags,'fl_route')===route.fingerprint&&receiptTag(receipt.tags,'fl_workspace')===route.workspaceId&&receiptTag(receipt.tags,'fl_brand')===route.brandId&&receiptTag(receipt.tags,'fl_kind')==='customer';
}
export class CustomerResendProvider implements CustomerProvider {
 readonly from:string;
 readonly fingerprint:string;
 readonly route:ResendRoute;
 constructor(route:ResendRoute,private origin:string,private key:string,readonly ready:()=>Promise<boolean>,private scope:DeliveryScope='all',private send:typeof fetch=fetch,private retrieveKey?:string) {
  this.route=Object.freeze({...route});this.from=route.from;this.fingerprint=route.fingerprint;
 }
 async submit(message:DeliveryEnvelope):ReturnType<CustomerProvider['submit']> {
  if(!deliveryPurposeAllowed(this.scope,message.purpose??'broadcast')||message.workspaceId!==this.route.workspaceId||message.brandId!==this.route.brandId||
   !z.uuid().safeParse(message.operationKey).success||!z.email().safeParse(message.to).success||/[\p{Cc}\p{Cf}]/u.test(message.subject)||message.subject.length>150||
   (message.sender&&(!z.email().safeParse(message.sender.replyTo).success||/[\p{Cc}\p{Cf}]/u.test(message.sender.name))))return {outcome:'rejected'};
  const unsubscribe=message.unsubscribe?.url;
  let link:URL;try{link=new URL(unsubscribe??'');}catch{return {outcome:'rejected'};}
  if(!unsubscribe||/[\p{Cc}\p{Cf}]/u.test(unsubscribe)||link.origin!==this.origin||link.pathname!=='/newsletter/opt-out'||link.username||link.password||link.searchParams.size!==1||
   !/^[A-Za-z0-9_-]{1,1000}$/.test(link.searchParams.get('t')??'')||link.hash||link.href!==unsubscribe)return {outcome:'rejected'};
  const originals=inlineOriginals(message);if(!originals)return {outcome:'rejected'};
  try{if(!await this.ready())return {outcome:'not_submitted'};}catch{return {outcome:'not_submitted'};}
  try {
   const response=await this.send('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
    headers:{authorization:'Bearer '+this.key,'content-type':'application/json','Idempotency-Key':'flockletter-customer/'+message.operationKey},
    body:JSON.stringify({from:message.sender?'"'+message.sender.name.replace(/["\\]/g,'')+'" <'+this.from+'>':this.from,to:[message.to],subject:message.subject,html:message.html,text:message.text,
     ...(message.sender?{reply_to:message.sender.replyTo}:{}),headers:{'List-Unsubscribe':'<'+unsubscribe+'>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'},
     tags:[{name:'fl_kind',value:'customer'},{name:'fl_operation',value:message.operationKey},{name:'fl_workspace',value:this.route.workspaceId},{name:'fl_brand',value:this.route.brandId},{name:'fl_route',value:this.fingerprint}],
     attachments:originals.map(a=>({filename:a.FileName,content:Buffer.from(a.RawContent).toString('base64'),content_type:a.ContentType,content_id:a.ContentId}))})});
   if(!response.ok){await response.body?.cancel();return {outcome:response.status>=500||[408,409,429].includes(response.status)?'unknown':'rejected'};}
   const result=z.object({id:z.uuid()}).safeParse(await boundedJson(response,16384));
   return result.success?{outcome:'accepted',messageId:result.data.id}:{outcome:'unknown'};
  }catch{return {outcome:'unknown'};}
 }
 async lookup(operation:string,messageId?:string|null):ReturnType<CustomerProvider['lookup']> {
  // Never repeat POST to recover an unknown response; Resend's idempotency window expires.
  if(!this.retrieveKey||!z.uuid().safeParse(messageId).success)return {outcome:'unknown'};
  try {
   const response=await this.send('https://api.resend.com/emails/'+messageId,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{authorization:'Bearer '+this.retrieveKey}});
   if(!response.ok){await response.body?.cancel();return {outcome:'unknown'};}
   const receipt=resendReceipt.safeParse(await boundedJson(response,65536));
   return receipt.success&&receipt.data.id===messageId&&routeReceipt(receipt.data,this.route)&&receiptTag(receipt.data.tags,'fl_operation')===operation?{outcome:'accepted',messageId:receipt.data.id}:{outcome:'unknown'};
  }catch{return {outcome:'unknown'};}
 }
}

export function customerResendRuntime(origin:string,env:NodeJS.ProcessEnv,send:typeof fetch=fetch) {
 const mode=env.FLOCKLETTER_CUSTOMER_DELIVERY;
 const raw=env.FLOCKLETTER_CUSTOMER_RESEND_BINDINGS;
 if(mode==='capture'||(!raw&&mode!=='resend'))return;
 if(!raw&&mode!=='resend')return;
 const scope=customerDeliveryScope(env);
 if(mode==='ses'||mode==='resend')requireMailingActivation(env.APP_ENV??'',env,scope);
 const key=env.FLOCKLETTER_CUSTOMER_RESEND_KEY?.trim(),retrieveKey=env.FLOCKLETTER_CUSTOMER_RESEND_RETRIEVE_KEY?.trim(),webhookSecret=env.FLOCKLETTER_CUSTOMER_RESEND_WEBHOOK_SECRET?.trim();
 if(!raw||raw.length>65536||!key||!retrieveKey||key===retrieveKey||!webhookSecret)throw Error('Configure distinct customer Resend sending/retrieval credentials, signed feedback and brand bindings.');
 const routes=z.array(z.unknown()).min(1).max(20).parse(JSON.parse(raw)).map(parseResendRoute);
 const scopes=new Set<string>(),domains=new Map<string,string>(),senders=new Map<string,string>();
 for(const r of routes){const scope=r.workspaceId+'/'+r.brandId,domain=r.from.split('@')[1]!;
  if(scopes.has(scope)||(domains.has(r.domainId)&&domains.get(r.domainId)!==r.workspaceId)||(senders.has(domain)&&senders.get(domain)!==r.workspaceId))
   throw Error('Resend requires distinct brand routes and workspace-owned sending domains.');
  scopes.add(scope);domains.set(r.domainId,r.workspaceId);senders.set(domain,r.workspaceId);
 }
 const read=async(path:string)=>{const response=await send('https://api.resend.com/'+path,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{authorization:'Bearer '+retrieveKey}});
  if(!response.ok){await response.body?.cancel();throw Error('Provider inspection unavailable.');}return boundedJson(response,65536);};
 const makeEntry=(route:ResendRoute)=>{
  let cached:{until:number;value:Promise<boolean>}|undefined;
  const inspect=async()=>{
   try{const [domain,hook]=await Promise.all([read('domains/'+route.domainId),read('webhooks/'+route.webhookId)]);
    const d=z.object({id:z.uuid(),name:z.string(),status:z.string(),region:z.string(),open_tracking:z.boolean(),click_tracking:z.boolean(),capabilities:z.object({sending:z.string()})}).parse(domain);
    const h=z.object({id:z.uuid(),status:z.string(),endpoint:z.string(),events:z.array(z.string()),signing_secret:z.string()}).parse(hook);
    return d.id===route.domainId&&d.name===route.from.split('@')[1]&&d.region===route.region&&d.status==='verified'&&d.capabilities.sending==='enabled'&&d.open_tracking===false&&d.click_tracking===false&&
     h.id===route.webhookId&&h.status==='enabled'&&h.endpoint===origin+'/api/v1/customer-delivery/resend-events'&&h.signing_secret===webhookSecret&&resendEvents.every(e=>h.events.includes(e));
   }catch{return false;}
  };
  const ready=()=>{if(mode!=='ses'&&mode!=='resend')return Promise.resolve(false);if(!cached||Date.now()>=cached.until)cached={until:Date.now()+60000,value:inspect()};return cached.value;};
  return {route,provider:new CustomerResendProvider(route,origin,key,ready,scope,send,retrieveKey)};
 };
 const entries=routes.map(makeEntry);
 const active=new Map(routes.map(route=>[route.workspaceId+'/'+route.brandId,route.fingerprint]));
 const register=(route:ResendRoute,activate=true)=>{
  const parsed=parseResendRoute({workspaceId:route.workspaceId,brandId:route.brandId,from:route.from,domainId:route.domainId,webhookId:route.webhookId,region:route.region});
  if(parsed.fingerprint!==route.fingerprint)throw Error('Invalid stored Resend route.');
  if(!entries.some(e=>e.route.fingerprint===parsed.fingerprint)){
   if(entries.length>=2000||entries.some(e=>e.route.workspaceId!==parsed.workspaceId&&(e.route.domainId===parsed.domainId||e.route.from.split('@')[1]===parsed.from.split('@')[1])))throw Error('Resend route capacity or workspace conflict.');
   entries.push(makeEntry(parsed));
  }
  if(activate)active.set(parsed.workspaceId+'/'+parsed.brandId,parsed.fingerprint);
 };
 return {entries,register,webhookSecret,retrieveKey,send,provider:(workspace:string,brand:string)=>entries.find(e=>e.route.fingerprint===active.get(workspace+'/'+brand))?.provider};
}
