import {selectedDelivery,deliveryProviders,selectDeliveryProvider} from './selection.js';
import {externalDelivery} from '../../shared/customer-delivery.js';
import {admitTest,testRecipient} from './test-send.js';
import type {TestDeliveryReview,TestDeliveryDetails} from '../../shared/customer-test-send.js';
import {customerCampaignPreflight} from './preflight.js';
import { randomUUID } from 'node:crypto';
import { customerDeliveryCommands } from '../../shared/customer-delivery.js';
import type { Campaign,CampaignContent } from '../../shared/contracts.js';
import { authorize,type Actor } from '../service.js';
import type { Database,Sql } from '../db.js';
import { contentGaps,digest,renderPreview } from '../content.js';
import { requireCondition } from '../errors.js';
import { listmonkReference } from '../campaign/listmonk-callback.js';
import { brandScope,deliveryRow,deliveryView,deliveryViews,locked,audit } from './storage.js';
import type { DeliveryOptions,DeliveryRow } from './types.js';
import { CustomerDeliveryWorker } from './worker.js';
import { senderProfile,senderFingerprint,senderEligible,legalFooter } from './sender.js';
import { deliveryOutcomes } from './outcomes.js';
import {deliveryPurposeAllowed} from './policy.js';
import type {CustomerDeliveryStatus} from '../../shared/customer-delivery.js';

export class CustomerDelivery {
  readonly worker:CustomerDeliveryWorker;
  constructor(readonly db:Database,readonly options:DeliveryOptions) {
    if(options.environment==='production'&&options.mode==='capture')throw Error('Captured customer delivery belongs to a test environment.');
    if(options.scope!==undefined&&options.scope!=='all'&&options.scope!=='tests')throw Error('Choose a supported delivery scope.');
    this.worker=new CustomerDeliveryWorker(db,options);
  }
  async execute(name:string,raw:unknown,actor:Actor):Promise<unknown> {
    if(!(name in customerDeliveryCommands))return undefined;
    authorize(actor,name as keyof typeof customerDeliveryCommands);
    const command=customerDeliveryCommands[name as keyof typeof customerDeliveryCommands];
    const parsed=command.schema.parse(raw);
    if(name==='delivery.preflight') {
      const input=customerDeliveryCommands['delivery.preflight'].schema.parse(raw);
      return this.db.read(actor.workspaceId,async sql=>{
        await brandScope(sql,actor,input.brandId);
        const row=(await sql.query<Campaign&{brand_id:string;created_at:Date;updated_at:Date}>('SELECT * FROM campaigns WHERE id=$1 AND brand_id=$2',[input.campaignId,input.brandId])).rows[0];
        requireCondition(row,404,'campaign_unavailable','Choose an available saved campaign in this brand.');
        return this.preflight(sql,actor,{...row,brandId:row.brand_id,status:'draft',createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()},input,true);
      });
    }
    if(name==='delivery.status')return this.status(actor,customerDeliveryCommands['delivery.status'].schema.parse(raw).brandId);
    const input=parsed as {operationKey?:string;brandId:string;id?:string};
    let processId:string|undefined;
    const result=await locked(this.db,actor.workspaceId,async sql=>{
      await brandScope(sql,actor,input.brandId);
      if(command.mutation||name==='delivery.providers')requireCondition(await this.options.isOwner(actor.userId,actor.workspaceId),403,'owner_required','Current workspace ownership is required.');
      if(actor.kind==='connection')requireCondition((await sql.query(`SELECT FROM connections
        WHERE id=$1 AND issuer_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()
        AND $4::text=ANY(scopes) AND 'read'=ANY(scopes) AND $3::uuid=ANY(brand_ids) FOR SHARE`,
        [actor.actorId.slice('connection:'.length),actor.userId,input.brandId,['delivery.providers','delivery.selectProvider'].includes(name)?'delivery:configure':'campaign:send'])).rowCount,
        403,'connection_revoked','This connection no longer has current delivery access.');
      if(name==='delivery.list') {
        const filter=customerDeliveryCommands['delivery.list'].schema.parse(raw);
        const rows=(await sql.query<DeliveryRow>('SELECT *,test_day::text AS test_day FROM customer_deliveries WHERE brand_id=$1 AND ($2::text IS NULL OR purpose=$2) ORDER BY created_at DESC,id DESC LIMIT 100',[input.brandId,filter.purpose??null])).rows;
        return deliveryViews(sql,rows);
      }
      if(name==='delivery.providers')return deliveryProviders(sql,this.options,actor.workspaceId,input.brandId);
      if(name==='delivery.sender') {
        const selected=await selectedDelivery(sql,this.options,actor.workspaceId,input.brandId);
        return {profile:await senderProfile(sql,input.brandId),eligible:externalDelivery(selected.mode)&&await senderEligible(sql,input.brandId,selected.provider),mode:selected.mode};
      }
      if(!command.mutation)return this.read(name,raw,actor,sql);
      const requestHash=digest(JSON.stringify({name,input:parsed}));
      const existing=(await sql.query<{request_hash:string;result:unknown}>('SELECT request_hash,result FROM operations WHERE actor_id=$1 AND operation_key=$2',[actor.actorId,input.operationKey])).rows[0];
      if(existing) {
        requireCondition(existing.request_hash===requestHash,409,'operation_conflict','Retry the original request with this operation key.');
        return existing.result;
      }
      let value:unknown;
      if(name==='delivery.selectProvider')value=await selectDeliveryProvider(sql,this.options,actor.workspaceId,customerDeliveryCommands['delivery.selectProvider'].schema.parse(raw));
      else if(name==='delivery.saveSender') {
        const profile=customerDeliveryCommands['delivery.saveSender'].schema.parse(raw),prior=await senderProfile(sql,profile.brandId);
        const next={fromName:profile.fromName,fromEmail:profile.fromEmail,replyTo:profile.replyTo,organization:profile.organization,postalAddress:profile.postalAddress,revision:(prior?.revision??0)+1};
        await sql.query('INSERT INTO customer_sender_profiles(workspace_id,brand_id,profile) VALUES($1,$2,$3) ON CONFLICT(workspace_id,brand_id) DO UPDATE SET profile=excluded.profile,updated_at=now()',
          [actor.workspaceId,profile.brandId,JSON.stringify(next)]);
        value=next;
      } else if(name==='delivery.review')value=await this.review(sql,actor,customerDeliveryCommands['delivery.review'].schema.parse(raw));
      else if(name==='delivery.reviewTest') {
        const test=customerDeliveryCommands['delivery.reviewTest'].schema.parse(raw);
        value=await this.review(sql,actor,{operationKey:test.operationKey,brandId:test.brandId,campaignId:test.campaignId,expectedVersion:test.expectedVersion},test.subscriberId);
      }
      else {
        const row=await deliveryRow(sql,input.id!,input.brandId);
        if(name==='delivery.approve')value=await this.approve(sql,actor,row);
        else if(name==='delivery.approveTest')value=await this.approve(sql,actor,row,customerDeliveryCommands['delivery.approveTest'].schema.parse(raw));
        else if(name==='delivery.pause') {
          requireCondition(['queued','paused'].includes(row.state),409,'pause_unavailable','Only approved pending work can be paused.');
          await sql.query("UPDATE customer_deliveries SET state='paused',reason='paused_by_owner' WHERE id=$1",[row.id]);
          value=await deliveryView(sql,await deliveryRow(sql,row.id,row.brand_id));
        } else if(name==='delivery.resume') {
          requireCondition(row.state==='paused',409,'resume_unavailable','Only a paused delivery can be resumed.');
          const blocked=await this.worker.block(sql,{...row,state:'queued',reason:null});
          requireCondition(!blocked,409,'resume_blocked','Resolve the paused cause before resuming: '+(blocked??'').replaceAll('_',' ')+'. Changed reviews need a fresh review.');
          await sql.query("UPDATE customer_deliveries SET state='queued',reason=NULL WHERE id=$1",[row.id]);
          value=await deliveryView(sql,await deliveryRow(sql,row.id,row.brand_id));
        }
        else if(name==='delivery.cancel') {
          await sql.query("UPDATE customer_deliveries SET state='cancelled',reason='cancelled_by_owner' WHERE id=$1 AND state NOT IN ('completed','cancelled')",[row.id]);
          await sql.query("UPDATE customer_delivery_recipients SET state='cancelled',reason='cancelled_by_owner' WHERE delivery_id=$1 AND state IN ('pending','preparing','prepared')",[row.id]);
          await this.worker.settle(sql,row);
          value=await deliveryView(sql,await deliveryRow(sql,row.id,row.brand_id));
        } else if(name==='delivery.process') {processId=row.id;value={processingRequested:true,id:row.id};}
        else {
          const feedback=customerDeliveryCommands['delivery.exerciseFeedback'].schema.parse(raw);
          requireCondition(row.mode==='capture'&&this.options.mode==='capture',403,'exercise_required','This action applies only to a captured delivery.');
          await this.worker.feedback(sql,row,feedback.recipientId,feedback.kind,'exercise-'+input.operationKey);
          value=await deliveryView(sql,await deliveryRow(sql,row.id,row.brand_id));
        }
      }
      await sql.query('INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4,$5)',
        [actor.workspaceId,actor.actorId,input.operationKey,requestHash,JSON.stringify(value)]);
      await audit(sql,actor,name,input.id??null);
      return value;
    });
    if(processId)await this.worker.tick(actor.workspaceId,processId);
    return result;
  }
  preflight(sql:Sql,actor:Actor,campaign:Campaign,input:{expectedVersion?:number;segmentId?:string;dueAt?:string;purpose?:'broadcast'|'test';subscriberId?:string}={},requireSend=false) {
    return customerCampaignPreflight(sql,actor,campaign,this.options,input,requireSend);
  }
  async status(actor:Actor,brandId?:string):Promise<CustomerDeliveryStatus> {
    const eligibility=await this.options.billing.eligibility(actor.workspaceId);
    let senderVerified:boolean|null=null;
    let providerConfigured:boolean|null=null;
    let mode=this.options.mode;
    if(brandId)await this.db.tenant(actor.workspaceId,async sql=>{
      await brandScope(sql,actor,brandId);
      const selected=await selectedDelivery(sql,this.options,actor.workspaceId,brandId);mode=selected.mode;
      if(externalDelivery(mode)) {
        providerConfigured=Boolean(selected.provider);
        try {senderVerified=await senderEligible(sql,brandId,selected.provider);}
        catch {senderVerified=false;}
      }
    });
    const providerName=mode==='resend'?'Resend':'AWS SES';
    const gaps=this.options.mode==='off'?['Delivery is off. A platform operator must configure the intended sending service.']:this.options.mode==='capture'?[]:
      !brandId?['Choose a brand to inspect its current sender and provider readiness.']:
      !providerConfigured?[`No ${providerName} route is configured for this brand on this service. Ask the platform operator to verify the brand binding and matching website/worker setup; do not switch providers to retry an uncertain send.`]:
      senderVerified?[]:[`Refresh this brand’s legal sender profile, domain ownership and ${providerName} readiness checks. A configured route alone does not verify the sender or provider.`];
    if(this.options.mode!=='off'&&!this.options.render)gaps.push('The private message renderer is unavailable. Ask the platform operator to restore it before reviewing a delivery.');
    return {mode,scope:this.options.scope??'all',
      externalSendingEnabled:externalDelivery(mode)&&deliveryPurposeAllowed(this.options.scope,'broadcast'),
      testSendingEnabled:externalDelivery(mode)&&deliveryPurposeAllowed(this.options.scope,'test'),
      broadcastsEnabled:this.options.mode!=='off'&&deliveryPurposeAllowed(this.options.scope,'broadcast'),
      eligible:eligibility.eligible,eligibility,brandId:brandId??null,senderVerified,providerConfigured,rendererConfigured:Boolean(this.options.render),gaps,
      context:{environment:this.options.environment,workspaceId:actor.workspaceId,observedAt:new Date().toISOString()}};
  }
  private async read(name:string,raw:unknown,actor:Actor,sql:Sql) {
    if(name==='delivery.testDetails') {
      requireCondition(actor.kind==='session'&&actor.owner&&await this.options.isOwner(actor.userId,actor.workspaceId),403,'owner_required','Use the current workspace owner session.');
      const input=customerDeliveryCommands['delivery.testDetails'].schema.parse(raw),row=await deliveryRow(sql,input.id,input.brandId);
      requireCondition(row.purpose==='test',404,'test_review_unavailable','Choose a test review in this brand.');
      const selected=await testRecipient(sql,row,undefined,this.options);
      requireCondition(selected.matches&&selected.person,409,'test_snapshot_invalid','This test requires a fresh one-recipient review.');
      const person=selected.person,review={...await deliveryView(sql,row),purpose:'test' as const,testSubscriberId:person.subscriber_id};
      const current=(await sql.query('SELECT FROM campaigns WHERE id=$1 AND version=$2',[row.campaign_id,row.version])).rowCount;
      return {review,recipient:{id:person.subscriber_id,email:digest(person.email_normalized)===person.email_digest?person.email_normalized:null,eligible:selected.eligible},
        canApprove:row.state==='reviewed'&&row.actor_id===actor.actorId&&row.creator_id===actor.userId&&selected.eligible&&Boolean(current)} satisfies TestDeliveryDetails;
    }

    if(name==='delivery.outcomes') {
      const input=customerDeliveryCommands['delivery.outcomes'].schema.parse(raw);
      return deliveryOutcomes(sql,await deliveryRow(sql,input.id,input.brandId),input);
    }
    if(name==='delivery.report') {
      const input=customerDeliveryCommands['delivery.report'].schema.parse(raw);
      return deliveryView(sql,await deliveryRow(sql,input.id,input.brandId));
    }
    const input=customerDeliveryCommands['delivery.message'].schema.parse(raw);
    const row=await deliveryRow(sql,input.id,input.brandId);
    requireCondition(actor.kind==='session'&&actor.owner&&row.mode==='capture',403,'captured_owner_required','Use the owner session to inspect a captured exercise message.');
    const capture=(await sql.query<{payload:Record<string,unknown>}>('SELECT payload FROM customer_delivery_captures WHERE delivery_id=$1 AND recipient_id=$2',[row.id,input.recipientId])).rows[0];
    requireCondition(capture,404,'message_unavailable','The captured message is not available yet.');
    const images=[];
    for(const asset of row.asset_digests) {
      const image=(await sql.query<{sha256:string;mime:string;bytes:Buffer}>('SELECT sha256,mime,bytes FROM assets WHERE id=$1 AND brand_id=$2',[asset.id,input.brandId])).rows[0];
      requireCondition(image&&image.sha256===asset.sha256&&digest(image.bytes)===asset.sha256,409,'image_unavailable','A captured original photo is unavailable.');
      images.push({sha256:image.sha256,mime:image.mime,base64:image.bytes.toString('base64')});
    }
    return {...capture.payload,images};
  }
  private async review(sql:Sql,actor:Actor,input:ReturnType<typeof customerDeliveryCommands['delivery.review']['schema']['parse']>,testSubscriberId?:string) {
    const purpose=testSubscriberId?'test':'broadcast';
    requireCondition(this.options.mode!=='off',503,'delivery_off','Choose an available delivery configuration.');
    requireCondition(deliveryPurposeAllowed(this.options.scope,purpose),403,'broadcasts_disabled','Only separately reviewed one-recipient tests are enabled. Broadcasts and schedules are disabled.');
    const draft=(await sql.query<{id:string;brand_id:string;version:number;content:CampaignContent;created_at:Date;updated_at:Date}>(
      'SELECT * FROM campaigns WHERE id=$1 AND brand_id=$2',[input.campaignId,input.brandId])).rows[0];
    requireCondition(draft,404,'campaign_unavailable','Choose a saved campaign in this brand.');
    requireCondition(draft.version===input.expectedVersion,409,'version_conflict','The campaign changed. Reload its saved version.');
    const campaign:Campaign={id:draft.id,brandId:draft.brand_id,version:draft.version,content:draft.content,
      createdAt:draft.created_at.toISOString(),updatedAt:draft.updated_at.toISOString(),status:'draft'};
    requireCondition(!contentGaps(campaign).length,422,'incomplete_content','Complete the subject, sender and message before review.');
    const now=this.options.now?.()??new Date(), due=input.dueAt?new Date(input.dueAt):now;
    requireCondition(!input.dueAt||(due>now&&due.getTime()<=now.getTime()+30*86400000),422,'invalid_schedule','Choose a future time within 30 days.');
    if(input.segmentId)requireCondition((await sql.query('SELECT id FROM audience_segments WHERE id=$1',[input.segmentId])).rowCount,404,'group_unavailable','Choose an available audience group.');
    const population=(await sql.query<{id:string;email_normalized:string;state:string;total:number}>(`
      WITH population AS MATERIALIZED (
        SELECT s.id,s.email_normalized,s.state FROM subscribers s
        WHERE ($1::uuid IS NULL OR EXISTS(SELECT FROM audience_segment_members m WHERE
          (m.workspace_id,m.brand_id,m.subscriber_id)=(s.workspace_id,s.brand_id,s.id) AND m.segment_id=$1))
          AND ($2::uuid IS NULL OR s.id=$2)
      )
      SELECT *, (SELECT count(*)::int FROM population) total FROM population
      WHERE state='confirmed' ORDER BY id LIMIT 10001`,[input.segmentId??null,testSubscriberId??null])).rows;
    requireCondition(population.length<=10000,422,'audience_limit','Choose a group with at most 10,000 confirmed contacts.');
    const selected=[];
    for(const person of population)if(person.state==='confirmed'&&
      (this.options.mode==='capture'||await this.options.liveConsent?.(sql,person.id)))selected.push(person);
    if(purpose==='test')requireCondition(selected.length===1,422,'test_recipient_ineligible','Select one existing confirmed and consent-eligible contact in this brand.');
    requireCondition(selected.length>0&&selected.length<=10000,422,'audience_empty','Choose between one and 10,000 confirmed eligible contacts.');
    const selectedProvider=await selectedDelivery(sql,this.options,actor.workspaceId,input.brandId),provider=selectedProvider.provider;
    const profile=await senderProfile(sql,input.brandId);
    if(externalDelivery(selectedProvider.mode))requireCondition(await senderEligible(sql,input.brandId,provider),503,'provider_unavailable','Complete the legal sender profile, current domain verification and provider verification for this brand.');
    const assets=(await sql.query<{id:string;name:string;sha256:string}>('SELECT id,name,sha256 FROM assets WHERE brand_id=$1 AND id=ANY($2::uuid[])',[input.brandId,draft.content.assetIds])).rows;
    requireCondition(assets.length===draft.content.assetIds.length,422,'image_unavailable','A selected original photo is unavailable.');
    const ordered=draft.content.assetIds.map(id=>assets.find(a=>a.id===id)!);
    const snapshot=purpose==='test'?{...campaign,content:{...campaign.content,subject:'[TEST] '+campaign.content.subject}}:campaign;
    const preview=renderPreview(snapshot,ordered),rendered=legalFooter(preview.html,preview.text,profile),id=randomUUID();
    await sql.query(`INSERT INTO customer_deliveries(workspace_id,brand_id,id,campaign_id,version,actor_id,creator_id,mode,state,
      content,rendered_html,rendered_text,asset_digests,provider_binding,due_at,selected,excluded,sender_profile,purpose,provider_revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reviewed',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [actor.workspaceId,input.brandId,id,draft.id,draft.version,actor.actorId,actor.userId,selectedProvider.mode,JSON.stringify(snapshot.content),
        rendered.html,rendered.text,JSON.stringify(ordered),senderFingerprint(provider,profile),due,selected.length,(population[0]?.total??0)-selected.length,profile?JSON.stringify(profile):null,purpose,selectedProvider.revision]);
    const people=selected.map(person=>{const operation=randomUUID();return {operation,subscriber:person.id,
      email:digest(person.email_normalized),reference:listmonkReference(actor.workspaceId,input.brandId,operation)};});
    await sql.query(`INSERT INTO customer_delivery_recipients(workspace_id,brand_id,delivery_id,id,subscriber_id,email_digest,engine_reference,state)
      SELECT $1,$2,$3,p.operation,p.subscriber,p.email,p.reference,'pending'
      FROM unnest($4::uuid[],$5::uuid[],$6::text[],$7::text[]) p(operation,subscriber,email,reference)`,
      [actor.workspaceId,input.brandId,id,people.map(p=>p.operation),people.map(p=>p.subscriber),people.map(p=>p.email),people.map(p=>p.reference)]);
    const result=await deliveryView(sql,await deliveryRow(sql,id,input.brandId));
    return testSubscriberId?{...result,purpose:'test' as const,testSubscriberId} satisfies TestDeliveryReview:result;
  }
  private async approve(sql:Sql,actor:Actor,row:DeliveryRow,test?:{subscriberId:string;expectedVersion:number}) {
    requireCondition(deliveryPurposeAllowed(this.options.scope,row.purpose),403,'broadcasts_disabled','Only separately reviewed one-recipient tests are enabled. Broadcasts and schedules are disabled.');
    requireCondition((row.purpose==='test')===Boolean(test),409,row.purpose==='test'?'test_approval_required':'test_review_required','Approve a test only through its exact one-recipient test review.');
    if(test) {
      requireCondition(row.version===test.expectedVersion,409,'version_conflict','This test review belongs to a different source version.');
      const person=await testRecipient(sql,row,test.subscriberId,this.options);
      requireCondition(person.matches,409,'test_recipient_mismatch','The supplied contact does not match this frozen test review.');
      if(row.state==='reviewed')requireCondition(person.eligible,422,'test_recipient_ineligible','This test contact is no longer confirmed and consent-eligible.');
    }
    requireCondition(row.actor_id===actor.actorId&&row.creator_id===actor.userId,403,'reviewer_required','Approve with the account or connection that reviewed this campaign.');
    if(row.state==='queued'){const result=await deliveryView(sql,row);return test?{...result,purpose:'test' as const,testSubscriberId:test.subscriberId}:result;}
    requireCondition(row.state==='reviewed',409,'review_required','Prepare a fresh review before approval.');
    requireCondition((await sql.query('SELECT id FROM campaigns WHERE id=$1 AND version=$2',[row.campaign_id,row.version])).rowCount,409,'version_conflict','The campaign changed after review.');
    if(test) {
      // The workspace lock makes this check and the new admission atomic across UI/API/MCP.
      const pending=await sql.query(`SELECT FROM customer_deliveries d JOIN customer_delivery_recipients p
        ON(p.workspace_id,p.brand_id,p.delivery_id)=(d.workspace_id,d.brand_id,d.id)
        WHERE d.purpose='test' AND d.brand_id=$1 AND d.campaign_id=$2 AND d.id<>$3 AND p.subscriber_id=$4
          AND (p.state IN('submitting','uncertain') OR (d.state IN('queued','paused') AND p.state IN('pending','preparing','prepared')))
        LIMIT 1`,[row.brand_id,row.campaign_id,row.id,test.subscriberId]);
      requireCondition(!pending.rowCount,409,'test_already_pending','Another test for this campaign and contact is pending or uncertain. Open and resolve that original test before approving a replacement.');
    }
    const selected=await selectedDelivery(sql,this.options,actor.workspaceId,row.brand_id),provider=selected.provider;
    requireCondition(row.mode===selected.mode&&(row.provider_revision??0)===selected.revision&&row.provider_binding===senderFingerprint(provider,await senderProfile(sql,row.brand_id)),409,'sender_changed','The sender configuration changed. Prepare a fresh review.');
    if(externalDelivery(row.mode))requireCondition(await senderEligible(sql,row.brand_id,provider),503,'sender_ineligible','The sender checks must be current before approval.');
    const reservation='customer-delivery-'+row.id;
    if(test)await admitTest(sql,row);
    await this.options.billing.reserve(sql,actor.workspaceId,{operationKey:reservation,campaignId:row.campaign_id,brandId:row.brand_id,recipients:row.selected,
      ...(test?{campaignSlot:false}:{dueAt:row.due_at})});
    await sql.query("UPDATE customer_deliveries SET state='queued',reservation_key=$2,approved_at=now() WHERE id=$1",[row.id,reservation]);
    const result=await deliveryView(sql,await deliveryRow(sql,row.id,row.brand_id));
    return test?{...result,purpose:'test' as const,testSubscriberId:test.subscriberId}:result;
  }
}
