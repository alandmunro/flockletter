import { createHash,createHmac } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { z } from 'zod';
import type { Database,Sql } from '../db.js';
import { AppError,requireCondition } from '../errors.js';
import { lockWorkspace } from '../workspace-lock.js';
import { suppress } from '../subscribers/intake.js';
import { boundedJson } from '../customer-support/writer.js';
import { mailbox } from '../customer-support/inbound.js';

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const eventSchema=z.object({type:z.string().max(80),created_at:z.iso.datetime({offset:true}),data:z.object({
  email_id:z.uuid(),from:z.string().max(420),to:z.array(z.string().max(420)).length(1),
  bounce:z.object({type:z.string().max(80)}).optional(),
})});
const sentSchema=z.object({id:z.uuid(),from:z.string().max(420),to:z.array(z.string().max(420)).length(1),
  tags:z.array(z.object({name:z.string().max(256),value:z.string().max(256)})).max(100),
});
type Route={workspace_id:string;brand_id:string;confirmation_id:string;recipient_digest:string;expires_at:Date};
type Kind='accepted'|'delivered'|'hard_bounce'|'complaint'|'failed'|'delayed';
export type ConfirmationFeedbackOptions={webhookSecret:string;retrieveKey:string;sendingKey:string;routeKey:Buffer;sender:string;send?:typeof fetch};
/** Signed receipts prove transport facts only. They can never establish newsletter consent. */
export class CustomerConfirmationFeedback {
  constructor(readonly db:Database,readonly options:ConfirmationFeedbackOptions) {
    if(!options.webhookSecret||!options.retrieveKey.trim()||!options.sendingKey.trim()||options.retrieveKey.trim()===options.sendingKey.trim()||options.routeKey.length!==32)
      throw Error('Configure distinct confirmation sending/retrieval credentials, webhook secret and dedicated routing key.');
    z.email().parse(options.sender);
  }
  private recipient(email:string){return createHmac('sha256',this.options.routeKey).update('recipient\0'+mailbox(email)).digest('hex');}
  async register(sql:Sql,workspace:string,brand:string,operation:string,email:string,expiresAt:Date) {
    const token=createHmac('sha256',this.options.routeKey).update(JSON.stringify(['confirmation-route-v1',workspace,brand,operation])).digest('base64url');
    // The route remains usable for delayed negative feedback after the confirmation link expires.
    const expires=new Date(expiresAt.getTime()+30*86400000);
    await sql.query('SELECT flockletter_customer_jobs.register_confirmation_route($1,$2,$3,$4,$5,$6)',
      [workspace,brand,operation,hash(token),this.recipient(email),expires]);
    return token;
  }
  async receive(body:Buffer,headers:Record<string,string>) {
    requireCondition(body.length<=16384,413,'confirmation_feedback_too_large','Confirmation feedback exceeds the intake limit.');
    const eventId=headers['svix-id']??'';
    requireCondition(eventId.length>0&&eventId.length<=200&&(headers['svix-signature']?.length??0)<=2048,401,'invalid_signature','Invalid confirmation feedback signature.');
    let raw:unknown;
    try {raw=new Webhook(this.options.webhookSecret).verify(body,{'webhook-id':eventId,'webhook-timestamp':headers['svix-timestamp']??'','webhook-signature':headers['svix-signature']??''});}
    catch {throw new AppError(401,'invalid_signature','Invalid confirmation feedback signature.');}
    const event=eventSchema.parse(raw);
    const kinds:Record<string,Kind>={'email.sent':'accepted','email.delivered':'delivered','email.complained':'complaint','email.failed':'failed','email.delivery_delayed':'delayed'};
    const kind=event.type==='email.bounced'?(event.data.bounce?.type==='Permanent'?'hard_bounce':'delayed'):Object.hasOwn(kinds,event.type)?kinds[event.type]:undefined;
    if(!kind)return {received:true};
    // Never trust tags/tenant IDs in webhook JSON. Retrieve the UUID at a fixed provider endpoint first.
    let value:unknown;
    try {
      const response=await (this.options.send??fetch)('https://api.resend.com/emails/'+event.data.email_id,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{authorization:'Bearer '+this.options.retrieveKey}});
      if(!response.ok){await response.body?.cancel();throw Error('Provider retrieval unavailable.');}
      value=await boundedJson(response,65536);
    }catch{throw new AppError(503,'confirmation_feedback_pending','The signed receipt is awaiting provider retrieval. Retry this event.');}
    const parsed=sentSchema.safeParse(value);
    requireCondition(parsed.success,503,'confirmation_feedback_pending','The provider receipt is incomplete. Retry this event.');
    const sent=parsed.data;
    requireCondition(sent.id===event.data.email_id&&mailbox(sent.from)===mailbox(this.options.sender)&&mailbox(event.data.from)===mailbox(this.options.sender)&&mailbox(sent.to[0]!)===mailbox(event.data.to[0]!),409,'confirmation_feedback_mismatch','The provider receipt does not match this event.');
    const tag=(name:string)=>{const found=sent.tags.filter(t=>t.name===name);return found.length===1?found[0]!.value:'';};
    const token=tag('fl_confirmation_route'),operation=tag('fl_confirmation');
    requireCondition(/^[A-Za-z0-9_-]{43}$/.test(token)&&z.uuid().safeParse(operation).success,409,'confirmation_feedback_unmapped','The provider receipt is not a registered confirmation.');
    const route=(await this.db.pool.query<Route>('SELECT * FROM flockletter_customer_jobs.resolve_confirmation_route($1)',[hash(token)])).rows[0];
    requireCondition(route&&route.confirmation_id===operation&&route.recipient_digest===this.recipient(sent.to[0]!),409,'confirmation_feedback_unmapped','The provider receipt is not a registered confirmation.');
    const receiptDigest=hash(body);
    await this.db.brand(route.workspace_id,route.brand_id,async sql=>{
      await lockWorkspace(sql,route.workspace_id);
      requireCondition(!(await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount,410,'workspace_retention_blocked','This workspace is erased or quarantined.');
      const job=(await sql.query<{subscriber_id:string;provider_id:string|null;email_normalized:string;state:string;attempts:number}>(`SELECT c.subscriber_id,c.provider_id,c.state,c.attempts,s.email_normalized FROM customer_audience_confirmations c
        JOIN subscribers s ON(s.workspace_id,s.brand_id,s.id)=(c.workspace_id,c.brand_id,c.subscriber_id)
        WHERE c.id=$1 AND c.mode='live' FOR UPDATE OF c,s`,[operation])).rows[0];
      requireCondition(job&&job.attempts===1&&this.recipient(job.email_normalized)===route.recipient_digest&&(!job.provider_id||job.provider_id===sent.id),409,'confirmation_feedback_mismatch','This receipt conflicts with the submitted confirmation.');
      const prior=(await sql.query<{digest:string}>('SELECT digest FROM customer_audience_feedback WHERE event_id=$1',[eventId])).rows[0];
      if(prior){requireCondition(prior.digest===receiptDigest,409,'confirmation_feedback_conflict','This receipt identifier has different content.');return;}
      await sql.query(`INSERT INTO customer_audience_feedback(workspace_id,brand_id,event_id,digest,confirmation_id,provider_id,kind,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[route.workspace_id,route.brand_id,eventId,receiptDigest,operation,sent.id,kind,event.created_at]);
      // A verified receipt can settle an unknown send; it never changes subscriber state to confirmed.
      await sql.query(`UPDATE customer_audience_confirmations SET provider_id=coalesce(provider_id,$2),
        state=CASE WHEN state IN ('submitting','uncertain') THEN 'accepted' ELSE state END WHERE id=$1`,[operation,sent.id]);
      if(kind==='hard_bounce'||kind==='complaint') {
        await suppress(sql,job.subscriber_id,null,kind==='complaint'?'complained':'hard_bounced','customer-provider-feedback');
        await sql.query(`UPDATE customer_audience_confirmations SET consumed_at=coalesce(consumed_at,now()),
          state=CASE WHEN state='confirmed' THEN state ELSE 'cancelled' END WHERE subscriber_id=$1`,[job.subscriber_id]);
      }
    }).catch((error:unknown)=>{
      if((error as {code?:string}).code==='23505')throw new AppError(409,'confirmation_feedback_conflict','This receipt conflicts with an existing event or provider binding.');
      throw error;
    });
    return {received:true};
  }
}
