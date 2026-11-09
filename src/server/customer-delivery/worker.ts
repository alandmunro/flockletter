import {sameTestDay,testRecipient} from './test-send.js';
import { randomUUID } from 'node:crypto';
import type { Database,Sql } from '../db.js';
import { digest } from '../content.js';
import { requireCondition } from '../errors.js';
import { suppress } from '../subscribers/intake.js';
import type { DeliveryEnvelope,DeliveryOutcome } from '../campaign/delivery-provider.js';
import { locked,deliveryRow,originalEnvelope } from './storage.js';
import type { DeliveryOptions,DeliveryRow,PersonRow } from './types.js';
import { senderProfile,senderEligible,profileFingerprint } from './sender.js';

type Work={id:string;deliveryId:string;brand:string;kind:'render'|'submit'|'reconcile';claim:string|null};
type StoredEnvelope=Pick<DeliveryEnvelope,'to'|'subject'|'html'|'text'|'unsubscribe'>;
function messageDigest(message:StoredEnvelope) {
  return digest(JSON.stringify([message.to,message.subject,message.html,message.text,message.unsubscribe?.url??null]));
}

export class CustomerDeliveryWorker {
  constructor(readonly db:Database,readonly options:DeliveryOptions) {}
  private now(){return this.options.now?.()??new Date();}
  private async scoped<T>(workspace:string,brand:string,fn:(sql:Sql)=>Promise<T>) {
    return locked(this.db,workspace,async sql=>{
      await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[brand]);return fn(sql);
    });
  }
  async tick(workspace:string,deliveryId?:string):Promise<{processed:boolean}> {
    const work=await locked(this.db,workspace,async(sql):Promise<Work|undefined>=>{
      const found=(await sql.query<PersonRow&{delivery_state:string;due_at:Date;purpose:'broadcast'|'test'}>(`
        SELECT p.*,d.state delivery_state,d.due_at,d.purpose FROM customer_delivery_recipients p
        JOIN customer_deliveries d ON(d.workspace_id,d.brand_id,d.id)=(p.workspace_id,p.brand_id,p.delivery_id)
        WHERE ($1::uuid IS NULL OR d.id=$1) AND
          ((p.state IN('pending','prepared') AND d.state='queued' AND d.due_at<=$2) OR
           (p.state='preparing' AND d.state='queued' AND p.next_check_at<=$2) OR
           (p.state IN('submitting','uncertain') AND (p.next_check_at IS NULL OR p.next_check_at<=$2)))
        ORDER BY coalesce(p.next_check_at,d.due_at),p.id LIMIT 1 FOR UPDATE OF p`,[deliveryId??null,this.now()])).rows[0];
      if(!found)return;
      const kind=found.state==='prepared'?'submit':found.state==='submitting'||found.state==='uncertain'?'reconcile':'render';
      if(found.purpose==='test'&&kind!=='reconcile') {
        const row=await deliveryRow(sql,found.delivery_id,found.brand_id);
        if(!await sameTestDay(sql,row)) {
          await sql.query("UPDATE customer_deliveries SET state='blocked',reason='test_day_expired' WHERE id=$1 AND state IN('queued','paused')",[row.id]);
          await sql.query("UPDATE customer_delivery_recipients SET state='cancelled',reason='test_day_expired' WHERE delivery_id=$1 AND state IN('pending','preparing','prepared')",[row.id]);
          await this.settle(sql,row);return;
        }
        if(kind==='submit')await sql.query("SELECT set_config('app.customer_test_dispatch','v1',true)");
      }
      const claim=kind==='render'?randomUUID():null;
      if(kind==='render'&&found.render_attempts>=3) {
        await sql.query("UPDATE customer_delivery_recipients SET state='rejected',reason='renderer_failed' WHERE id=$1",[found.id]);
        const row=await deliveryRow(sql,found.delivery_id,found.brand_id);await this.settle(sql,row);return;
      }
      await sql.query(`UPDATE customer_delivery_recipients SET state=$2,render_claim=coalesce($3,render_claim),
        render_attempts=render_attempts+$4,attempts=attempts+$5,next_check_at=$6 WHERE id=$1`,
        [found.id,kind==='render'?'preparing':kind==='submit'?'submitting':'uncertain',claim,
          Number(kind==='render'),Number(kind==='submit'),new Date(this.now().getTime()+60000)]);
      return {id:found.id,deliveryId:found.delivery_id,brand:found.brand_id,kind,claim};
    });
    if(!work)return {processed:false};
    if(work.kind==='render')await this.prepare(workspace,work);
    else await this.forward(workspace,work);
    return {processed:true};
  }
  async block(sql:Sql,row:DeliveryRow):Promise<string|null> {
    if((await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount)return 'workspace_erased';
    if(row.state!=='queued')return row.reason??'cancelled_by_owner';
    if(row.mode!==this.options.mode)return 'delivery_configuration_changed';
    if(row.purpose==='test') {
      if(!await sameTestDay(sql,row))return 'test_day_expired';
      if(!(await testRecipient(sql,row,undefined,this.options)).matches)return 'test_snapshot_invalid';
    }
    if(!this.options.render)return 'renderer_unavailable';
    const provider=this.options.provider?.(row.workspace_id,row.brand_id);
    if(profileFingerprint(row.sender_profile)!==profileFingerprint(await senderProfile(sql,row.brand_id)))return 'delivery_configuration_changed';
    if(row.mode==='ses'&&!provider)return 'provider_unavailable';
    if(row.provider_binding.split(':')[0]!==(provider?.fingerprint??'customer-capture-v1'))return 'delivery_configuration_changed';
    if(row.mode==='ses'&&!await senderEligible(sql,row.brand_id,provider))return 'sender_ineligible';
    if(!await this.options.isOwner(row.creator_id,row.workspace_id))return 'authority_revoked';
    if(row.actor_id.startsWith('connection:')) {
      const allowed=await sql.query(`SELECT id FROM connections WHERE id=$1 AND issuer_id=$2 AND revoked_at IS NULL
        AND expires_at>clock_timestamp() AND 'campaign:send'=ANY(scopes) AND 'read'=ANY(scopes) AND $3::uuid=ANY(brand_ids)`,
        [row.actor_id.slice('connection:'.length),row.creator_id,row.brand_id]);
      if(!allowed.rowCount)return 'authority_revoked';
    }
    if(!(await sql.query('SELECT id FROM campaigns WHERE id=$1 AND version=$2',[row.campaign_id,row.version])).rowCount)return 'draft_changed';
    const current=this.options.eligibilitySql?await this.options.eligibilitySql(sql,row.workspace_id):await this.options.billing.eligibility(row.workspace_id);
    if(!current.eligible)return 'subscription_ineligible';
    if(!current.limits||row.selected>current.limits.recipients)return 'plan_limit_changed';
    if(row.reservation_key) {
      const reservation=(await sql.query<{period:string}>('SELECT period FROM customer_usage_reservations WHERE operation_key=$1',[row.reservation_key])).rows[0];
      if(!reservation||reservation.period!==current.usage.period)return 'usage_period_changed';
    }
    return null;
  }
  private async eligible(sql:Sql,row:DeliveryRow,p:PersonRow) {
    const contact=(await sql.query<{email_normalized:string;state:string}>(
      'SELECT email_normalized,state FROM subscribers WHERE id=$1 AND brand_id=$2 FOR UPDATE',[p.subscriber_id,row.brand_id])).rows[0];
    if(!contact||contact.state!=='confirmed'||digest(contact.email_normalized)!==p.email_digest)return null;
    if(row.mode==='ses'&&!await this.options.liveConsent?.(sql,p.subscriber_id))return null;
    return contact.email_normalized;
  }
  private async stop(sql:Sql,row:DeliveryRow,reason:string) {
    if(row.state==='paused'||['provider_unavailable','sender_ineligible','renderer_unavailable'].includes(reason)) {
      await sql.query("UPDATE customer_deliveries SET state='paused',reason=$2 WHERE id=$1 AND state IN ('queued','paused')",[row.id,reason]);
      await sql.query("UPDATE customer_delivery_recipients SET state='pending',render_claim=NULL,next_check_at=NULL,reason=$2 WHERE delivery_id=$1 AND state='preparing'",[row.id,reason]);
      return;
    }
    await sql.query("UPDATE customer_deliveries SET state='blocked',reason=$2 WHERE id=$1 AND state='queued'",[row.id,reason]);
    await sql.query("UPDATE customer_delivery_recipients SET state='cancelled',reason=$2 WHERE delivery_id=$1 AND state IN ('pending','preparing','prepared')",[row.id,reason]);
    await this.settle(sql,row);
  }
  private async prepare(workspace:string,work:Work) {
    const envelope=await this.scoped(workspace,work.brand,async sql=>{
      const row=await deliveryRow(sql,work.deliveryId,work.brand),p=(await sql.query<PersonRow>('SELECT * FROM customer_delivery_recipients WHERE id=$1',[work.id])).rows[0]!;
      if(p.state!=='preparing'||p.render_claim!==work.claim)return null;
      const blocked=await this.block(sql,row);
      if(blocked){
        await sql.query('UPDATE customer_delivery_recipients SET render_attempts=greatest(0,render_attempts-1) WHERE id=$1 AND render_claim=$2',[p.id,work.claim]);
        await this.stop(sql,row,blocked);return null;
      }
      const email=await this.eligible(sql,row,p);
      if(!email){await sql.query("UPDATE customer_delivery_recipients SET state='excluded',reason='consent_changed' WHERE id=$1",[p.id]);await this.settle(sql,row);return null;}
      const message=await originalEnvelope(sql,row,p,email);
      if(!message){await this.stop(sql,row,'image_unavailable');return null;}
      return message;
    });
    if(!envelope)return;
    try {
      requireCondition(this.options.render,503,'renderer_unavailable','The private mailing renderer is unavailable.');
      // The rendering engine receives a reserved address. Only the guarded provider sees the subscriber.
      await this.options.render({...envelope,to:'reader@campaign.test'});
    } catch {
      await this.scoped(workspace,work.brand,async sql=>{
        await sql.query("UPDATE customer_delivery_recipients SET reason='renderer_unavailable',next_check_at=$3 WHERE id=$1 AND state='preparing' AND render_claim=$2",
          [work.id,work.claim,new Date(this.now().getTime()+15000)]);
      });
      return;
    }
    await this.scoped(workspace,work.brand,async sql=>{
      const row=await deliveryRow(sql,work.deliveryId,work.brand),p=(await sql.query<PersonRow>('SELECT * FROM customer_delivery_recipients WHERE id=$1 FOR UPDATE',[work.id])).rows[0]!;
      if(p.state!=='preparing'||p.render_claim!==work.claim)return;
      const blocked=await this.block(sql,row);if(blocked){await this.stop(sql,row,blocked);return;}
      const email=await this.eligible(sql,row,p);
      if(!email){await sql.query("UPDATE customer_delivery_recipients SET state='excluded',reason='consent_changed' WHERE id=$1",[p.id]);await this.settle(sql,row);return;}
      const original=await originalEnvelope(sql,row,p,email);
      requireCondition(original&&this.options.optOut,503,'unsubscribe_unavailable','Configure the brand unsubscribe route.');
      const prior=(await sql.query<{envelope:StoredEnvelope}>('SELECT envelope FROM customer_delivery_payloads WHERE recipient_id=$1',[p.id])).rows[0];
      if(!prior) {
        const {url}=await this.options.optOut(sql,workspace,row.brand_id,p.subscriber_id,this.options.origin);
        const footer='<p style="text-align:center;font:14px Arial,sans-serif"><a href="'+url+'">Unsubscribe from this newsletter</a></p>';
        const final:StoredEnvelope={to:email,subject:original.subject,
          html:original.html.replace(/<\/body><\/html>$/i,footer+'</body></html>'),
          text:original.text+'\n\nUnsubscribe from this newsletter: '+url,unsubscribe:{url}};
        requireCondition(final.html!==original.html,422,'message_invalid','The reviewed message cannot include its required footer.');
        const checksum=messageDigest(final);
        await sql.query('INSERT INTO customer_delivery_payloads(workspace_id,brand_id,delivery_id,recipient_id,envelope,message_digest) VALUES($1,$2,$3,$4,$5,$6)',
          [workspace,row.brand_id,row.id,p.id,JSON.stringify(final),checksum]);
      }
      await sql.query("UPDATE customer_delivery_recipients SET state='prepared',render_received_at=now(),reason=NULL,next_check_at=NULL WHERE id=$1",[p.id]);
    });
  }
  private async forward(workspace:string,work:Work) {
    await this.scoped(workspace,work.brand,async sql=>{
      const row=await deliveryRow(sql,work.deliveryId,work.brand),p=(await sql.query<PersonRow>('SELECT * FROM customer_delivery_recipients WHERE id=$1 FOR UPDATE',[work.id])).rows[0]!;
      if(!['submitting','uncertain'].includes(p.state))return;
      const capture=(await sql.query<{message_digest:string}>('SELECT message_digest FROM customer_delivery_captures WHERE recipient_id=$1',[p.id])).rows[0];
      let outcome:DeliveryOutcome='unknown',messageId:string|undefined;
      const provider=this.options.provider?.(workspace,row.brand_id);
      if(work.kind==='reconcile') {
        if(row.mode==='capture')outcome=capture?'accepted':'not_submitted';
        else if(provider&&provider.fingerprint===row.provider_binding.split(':')[0]) {
          try {const result=await provider.lookup(p.id);outcome=result.outcome;messageId=result.messageId;}catch{/* Keep the original uncertainty. */}
        }
      } else {
        const blocked=await this.block(sql,row);
        if(blocked){
          const paused=row.state==='paused'||['provider_unavailable','sender_ineligible','renderer_unavailable'].includes(blocked);
          await sql.query("UPDATE customer_delivery_recipients SET state=$2,reason=$3,attempts=attempts-1,next_check_at=NULL WHERE id=$1",[p.id,paused?'prepared':'cancelled',blocked]);
          await this.stop(sql,row,blocked);return;
        }
        const email=await this.eligible(sql,row,p);
        if(!email){await sql.query("UPDATE customer_delivery_recipients SET state='excluded',reason='consent_changed',attempts=attempts-1 WHERE id=$1",[p.id]);await this.settle(sql,row);return;}
        const original=await originalEnvelope(sql,row,p,email);
        const payload=(await sql.query<{envelope:StoredEnvelope;message_digest:string}>('SELECT envelope,message_digest FROM customer_delivery_payloads WHERE recipient_id=$1',[p.id])).rows[0];
        if(!original||!payload||payload.envelope.to!==email||messageDigest(payload.envelope)!==payload.message_digest){
          await sql.query("UPDATE customer_delivery_recipients SET state='rejected',reason='payload_unavailable',attempts=attempts-1 WHERE id=$1",[p.id]);await this.stop(sql,row,'payload_unavailable');return;
        }
        if(row.mode==='capture') {
          await sql.query('INSERT INTO customer_delivery_captures(workspace_id,brand_id,delivery_id,recipient_id,payload,message_digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
            [workspace,row.brand_id,row.id,p.id,JSON.stringify({...payload.envelope,mode:'capture'}),payload.message_digest]);
          outcome='accepted';messageId='capture-'+p.id;
        } else if(provider) {
          try{const result=await provider.submit({...original,...payload.envelope});outcome=result.outcome;messageId=result.messageId;}catch{/* The committed intent could already have reached the provider. */}
        }
      }
      if(outcome==='accepted')await sql.query("UPDATE customer_delivery_recipients SET state='accepted',message_id=coalesce($2,message_id),reason=NULL,next_check_at=NULL WHERE id=$1",[p.id,messageId??null]);
      else if(outcome==='rejected')await sql.query("UPDATE customer_delivery_recipients SET state='rejected',reason='provider_rejected',next_check_at=NULL WHERE id=$1",[p.id]);
      else if(outcome==='not_submitted')await sql.query("UPDATE customer_delivery_recipients SET state=$2,reason='verified_not_submitted',next_check_at=NULL WHERE id=$1",
        [p.id,['queued','paused'].includes(row.state)&&p.attempts<3&&await sameTestDay(sql,row)?'prepared':'cancelled']);
      else await sql.query("UPDATE customer_delivery_recipients SET state='uncertain',reason='provider_unknown',next_check_at=$2 WHERE id=$1",[p.id,new Date(this.now().getTime()+30000)]);
      if(outcome==='accepted'&&row.mode==='capture')await this.feedback(sql,row,p.id,'delivered','capture-'+p.id);
      await this.settle(sql,row);
    });
  }
  async settle(sql:Sql,row:DeliveryRow) {
    const counts=(await sql.query<{accepted:number;excluded:number;open:number}>(
      "SELECT count(*) FILTER(WHERE state='accepted')::int accepted,count(*) FILTER(WHERE state IN('excluded','rejected','cancelled'))::int excluded,count(*) FILTER(WHERE state IN('pending','preparing','prepared','submitting','uncertain'))::int open FROM customer_delivery_recipients WHERE delivery_id=$1",[row.id])).rows[0]!;
    if(row.reservation_key)await this.options.billing.settle(sql,row.workspace_id,row.reservation_key,{accepted:counts.accepted,excluded:counts.excluded});
    if(!counts.open)await sql.query("UPDATE customer_deliveries SET state=CASE WHEN state IN('cancelled','blocked') THEN state ELSE 'completed' END,finished_at=coalesce(finished_at,now()) WHERE id=$1",[row.id]);
  }
  async feedback(sql:Sql,row:DeliveryRow,personId:string,kind:string,eventId:string) {
    const person=(await sql.query<PersonRow>('SELECT * FROM customer_delivery_recipients WHERE id=$1 AND delivery_id=$2 FOR UPDATE',[personId,row.id])).rows[0];
    requireCondition(person&&person.attempts>0&&['accepted','submitting','uncertain'].includes(person.state),409,'feedback_unmapped','This feedback does not match a submitted recipient.');
    const evidence=digest(JSON.stringify([row.id,personId,kind,row.mode,row.provider_binding]));
    const prior=(await sql.query<{evidence:string}>('SELECT evidence FROM customer_delivery_events WHERE event_id=$1',[eventId])).rows[0];
    requireCondition(!prior||prior.evidence===evidence,409,'feedback_conflict','This event identity already describes a different outcome.');
    if(prior)return;
    await sql.query('INSERT INTO customer_delivery_events(workspace_id,brand_id,delivery_id,recipient_id,event_id,kind,evidence) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [row.workspace_id,row.brand_id,row.id,personId,eventId,kind,evidence]);
    const priority:Record<string,number>={delivered:1,temporary_bounce:2,hard_bounce:3,complaint:4};
    requireCondition(kind in priority,422,'invalid_feedback','Choose a supported feedback outcome.');
    if(!person.feedback||priority[kind]! > priority[person.feedback]!)
      await sql.query("UPDATE customer_delivery_recipients SET state='accepted',feedback=$2,reason=NULL,next_check_at=NULL WHERE id=$1",[personId,kind]);
    if(kind==='hard_bounce'||kind==='complaint') {
      const event=(await sql.query<{id:string}>('SELECT id FROM subscriber_consent_events WHERE subscriber_id=$1 ORDER BY recorded_at DESC,id DESC LIMIT 1',[person.subscriber_id])).rows[0];
      await suppress(sql,person.subscriber_id,event?.id??null,kind==='complaint'?'complained':'hard_bounced',
        row.mode==='capture'?'customer-captured-feedback':'customer-provider-feedback');
      await sql.query("UPDATE customer_audience_confirmations SET state='cancelled',consumed_at=coalesce(consumed_at,now()) WHERE subscriber_id=$1 AND state NOT IN ('confirmed','cancelled')",[person.subscriber_id]);
    }
  }
}
