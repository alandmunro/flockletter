import type {ResendRoute} from './resend-route.js';
import {Webhook} from 'standardwebhooks';
import {z} from 'zod';
import type {Database} from '../db.js';
import {AppError,requireCondition} from '../errors.js';
import {digest} from '../content.js';
import {boundedJson} from '../customer-support/writer.js';
import {locked,deliveryRow} from './storage.js';
import type {CustomerDeliveryWorker} from './worker.js';
import {resendReceipt,resendReceiptMaxBytes,receiptTag,routeReceipt,type customerResendRuntime} from './resend.js';

const eventSchema=z.object({type:z.string().max(80),created_at:z.iso.datetime({offset:true}),data:z.object({email_id:z.uuid(),from:z.string().max(420),to:z.array(z.email()).length(1),bounce:z.object({type:z.string().max(80)}).optional()})});
type Receipt=z.infer<typeof resendReceipt>;
/** Signed provider event + independently retrieved receipt + frozen DB intent bind every fact. */
export class CustomerResendFeedback {
 // A sent message's identity, original destination and operation tags are immutable.
 // Keep only verified projections, briefly, so later signed events need no second provider read.
 private receipts=new Map<string,{expires:number;receipt:Receipt}>();
 private async receipt(id:string):Promise<Receipt>{
  const cached=this.receipts.get(id);
  if(cached&&cached.expires>Date.now())return cached.receipt;
  let raw:unknown;
  try{
   const response=await this.runtime.send('https://api.resend.com/emails/'+id,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{authorization:'Bearer '+this.runtime.retrieveKey}});
   if(!response.ok){await response.body?.cancel();throw Error('Unavailable');}
   raw=await boundedJson(response,resendReceiptMaxBytes);
  }catch{throw new AppError(503,'delivery_feedback_pending','The signed receipt is awaiting provider retrieval. Retry this event.');}
  const parsed=resendReceipt.safeParse(raw);
  requireCondition(parsed.success,503,'delivery_feedback_pending','The provider receipt is incomplete. Retry this event.');
  return parsed.data;
 }
 constructor(private db:Database,private runtime:Pick<NonNullable<ReturnType<typeof customerResendRuntime>>,'send'|'retrieveKey'|'webhookSecret'|'entries'|'register'>,private worker:CustomerDeliveryWorker,private resolveRoute?:(fingerprint:string)=>Promise<ResendRoute|null>){}
 async receive(body:Buffer,headers:Record<string,string>) {
  requireCondition(body.length<=16384,413,'delivery_feedback_too_large','Delivery feedback exceeds the intake limit.');
  const eventId=headers['svix-id']??'';
  requireCondition(eventId.length>0&&eventId.length<=200&&(headers['svix-signature']?.length??0)<=2048,401,'invalid_signature','Invalid delivery feedback signature.');
  let raw:unknown;
  try{raw=new Webhook(this.runtime.webhookSecret).verify(body,{'webhook-id':eventId,'webhook-timestamp':headers['svix-timestamp']??'','webhook-signature':headers['svix-signature']??''});}
  catch{throw new AppError(401,'invalid_signature','Invalid delivery feedback signature.');}
  const event=eventSchema.parse(raw);
  const kind=event.type==='email.sent'||event.type==='email.failed'?'accepted':event.type==='email.delivered'?'delivered':event.type==='email.complained'?'complaint':event.type==='email.delivery_delayed'?'temporary_bounce':event.type==='email.bounced'?(event.data.bounce?.type==='Permanent'?'hard_bounce':'temporary_bounce'):null;
  if(!kind)return {received:true};
  const sent=await this.receipt(event.data.email_id),operation=receiptTag(sent.tags,'fl_operation'),fingerprint=receiptTag(sent.tags,'fl_route');
  let entry=this.runtime.entries.find(e=>e.route.fingerprint===fingerprint);
  if(!entry&&/^[a-f0-9]{64}$/.test(fingerprint)&&this.resolveRoute){const route=await this.resolveRoute(fingerprint);if(route){this.runtime.register(route,false);entry=this.runtime.entries.find(e=>e.route.fingerprint===fingerprint);}}
  requireCondition(entry&&sent.id===event.data.email_id&&z.uuid().safeParse(operation).success&&routeReceipt(sent,entry.route)&&
   sent.from===event.data.from&&sent.to[0]===event.data.to[0],409,'delivery_feedback_unmapped','This event does not match a configured customer delivery.');
  const route=entry.route;
  await locked(this.db,route.workspaceId,async sql=>{
   await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[route.brandId]);
   requireCondition(!(await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount,410,'workspace_retention_blocked','This workspace is erased or quarantined.');
   const person=(await sql.query<{delivery_id:string;email_digest:string;message_id:string|null;attempts:number;state:string}>('SELECT delivery_id,email_digest,message_id,attempts,state FROM customer_delivery_recipients WHERE id=$1 AND brand_id=$2 FOR UPDATE',[operation,route.brandId])).rows[0];
   requireCondition(person&&person.attempts>0&&['submitting','uncertain','accepted'].includes(person.state)&&person.email_digest===digest(sent.to[0]!)&&(!person.message_id||person.message_id===sent.id),409,'delivery_feedback_unmapped','This receipt does not match a submitted recipient.');
   const row=await deliveryRow(sql,person.delivery_id,route.brandId);
   requireCondition(row.mode==='resend'&&row.provider_binding.split(':')[0]===route.fingerprint,409,'delivery_feedback_unmapped','This receipt belongs to a different provider route.');
   const receiptEvidence=digest(body),key='resend-'+eventId;
   const prior=(await sql.query<{evidence:string}>('SELECT evidence FROM customer_delivery_events WHERE event_id=$1',[key])).rows[0];
   requireCondition(!prior||prior.evidence===receiptEvidence,409,'delivery_feedback_conflict','This event identifier already has different content.');
   if(prior)return;
   if(kind!=='accepted')await this.worker.feedback(sql,row,operation,kind,key+'-outcome');
   await sql.query('INSERT INTO customer_delivery_events(workspace_id,brand_id,delivery_id,recipient_id,event_id,kind,evidence) VALUES($1,$2,$3,$4,$5,$6,$7)',[route.workspaceId,route.brandId,row.id,operation,key,kind,receiptEvidence]);
   await sql.query("UPDATE customer_delivery_recipients SET state='accepted',message_id=coalesce(message_id,$2),reason=CASE WHEN $3::boolean THEN 'provider_delivery_failed' ELSE reason END,next_check_at=NULL WHERE id=$1",[operation,sent.id,event.type==='email.failed']);
   await this.worker.settle(sql,row);
  });
  if(!this.receipts.has(sent.id)||this.receipts.get(sent.id)!.expires<=Date.now()){
   this.receipts.delete(sent.id);
   if(this.receipts.size>=1024)this.receipts.delete(this.receipts.keys().next().value!);
   this.receipts.set(sent.id,{receipt:sent,expires:Date.now()+300000});
  }
  return {received:true};
 }
}
