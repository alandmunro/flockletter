import {ResendSenderSetup,resendSenderSetupPort,capturedSenderSetupPort} from './customer-delivery/sender-setup.js';
import {storedResendRoute} from './customer-delivery/resend-route.js';
import {SendingSafeguards} from './customer-delivery/safeguards.js';
import {externalDelivery,type SendingProvider} from '../shared/customer-delivery.js';
import {selectedDelivery} from './customer-delivery/selection.js';
import {customerResendRuntime} from './customer-delivery/resend.js';
import {CustomerResendFeedback} from './customer-delivery/resend-feedback.js';
import type {WorkspacePreflight,WorkspaceSetupGap} from '../shared/workspace-preflight.js';
import {customerPreparation} from './customer-preparation.js';
import { trialRegistryFromEnvironment } from './customer-abuse/registry.js';
import {readWorkerHeartbeat,runWorkerHeartbeat} from './customer-worker-heartbeat.js';
import { setTimeout as pause } from 'node:timers/promises';
import type { Config } from './config.js';
import type { Database } from './db.js';
import type { Actor } from './service.js';
import type { IdentityProvider } from './auth.js';
import { requireCondition } from './errors.js';
import { commands,type CommandName,type Capability } from '../shared/contracts.js';
import type { CustomerOperationsStatus } from '../shared/customer-operations.js';
import { customerSettings } from './customer-settings.js';
import { CustomerBilling,customerEligibility,customerContactLimit,customerSeatLimit,retentionServiceEndSql,retentionClockSql } from './customer-billing/service.js';
import { customerBillingConfiguration,stripeCustomerProvider } from './customer-billing/provider.js';
import { CustomerAudience,createCustomerOptOut,productionConsentEligible,productionConsentEligibleBatch } from './customer-audience/service.js';
import { CustomerConfirmationFeedback } from './customer-audience/feedback.js';
import { CustomerConfirmationProvider } from './customer-audience/resend.js';
import { CustomerTeamLifecycle } from './customer-team/service.js';
import { customerTeamClerkPort } from './customer-team/clerk.js';
import { configuredSupportWriter } from './customer-support/writer.js';
import { CustomerSupport } from './customer-support/index.js';
import { supportResendKeys } from './customer-support/configuration.js';
import { ResendSupportProvider } from './customer-support/provider.js';
import { CustomerRetention } from './customer-retention/index.js';
import { CustomerDelivery } from './customer-delivery/service.js';
import { CustomerEnginePool } from './customer-delivery/engine.js';
import { customerSesRuntime } from './customer-delivery/ses.js';
import { SesFeedbackRouter,SesNotifications } from './campaign/ses-notifications.js';
import { locked,audit } from './customer-delivery/storage.js';
import { digest } from './content.js';
import type { DeliveryRow } from './customer-delivery/types.js';
import { senderProfile,senderEligible,refreshCustomerSender } from './customer-delivery/sender.js';
import { limits } from '../shared/contracts.js';
import { CustomerInfrastructure } from './customer-infrastructure/index.js';
import { createAwsInfrastructurePort } from './customer-infrastructure/aws.js';
import { parseSesRoute, type SesRoute } from './campaign/ses-runtime.js';

const prefixes=['senderSetup.','customerBilling.','audienceOnboarding.','teamLifecycle.','support.','retention.','delivery.','operations.','infrastructure.'];
export class CustomerWorkflows {
  readonly settings;
  readonly billing:CustomerBilling;
  readonly audience:CustomerAudience;
  readonly team:CustomerTeamLifecycle;
  readonly support:CustomerSupport;
  readonly retention:CustomerRetention;
  readonly delivery:CustomerDelivery;
  readonly infrastructure:CustomerInfrastructure;
  readonly senderSetup:ResendSenderSetup;
  readonly engine?:CustomerEnginePool;
  readonly ses?:ReturnType<typeof customerSesRuntime>;
  readonly feedback?:SesFeedbackRouter;
  readonly resend?:ReturnType<typeof customerResendRuntime>;
  readonly resendFeedback?:CustomerResendFeedback;
  observe?: (value:{workspaceId:string;status:CustomerOperationsStatus})=>Promise<void>;
  private running=false;
  private closing=false;
  private active=new Map<string,Promise<void>>();
  constructor(readonly db:Database,readonly config:Config,readonly identity:IdentityProvider,readonly env:NodeJS.ProcessEnv=process.env) {
    const settings=this.settings=customerSettings(config,env);
    const gateway=stripeCustomerProvider(config.origin,env);
    this.billing=new CustomerBilling(db,{environment:config.environment,exerciseEnabled:settings.billing==='exercise',
      gateway,trialRegistry:trialRegistryFromEnvironment(env,settings.billing==='exercise'?'exercise':gateway?.live?'stripe_live':'stripe_test',settings.billing==='exercise'?'captured':gateway?.account??'unconfigured'),checkOwner:identity.isOwner});
    const confirmationFeedback=settings.audience==='live'?new CustomerConfirmationFeedback(db,{
      sendingKey:env.FLOCKLETTER_CUSTOMER_CONFIRMATION_KEY??'',retrieveKey:env.FLOCKLETTER_CUSTOMER_CONFIRMATION_RETRIEVE_KEY??'',
      sender:env.FLOCKLETTER_CUSTOMER_CONFIRMATION_FROM??'',webhookSecret:env.FLOCKLETTER_CUSTOMER_CONFIRMATION_WEBHOOK_SECRET??'',
      routeKey:this.confirmationRoutingKey(),
    }):undefined;
    this.audience=new CustomerAudience(db,{mode:settings.audience,origin:config.origin,checkOwner:identity.isOwner,
      contactLimit:(sql,w)=>customerContactLimit(sql,w,this.billing.options),
      ...(settings.audience==='live'?{feedback:confirmationFeedback,confirmationKey:this.confirmationKey(),provider:new CustomerConfirmationProvider(
        env.FLOCKLETTER_CUSTOMER_CONFIRMATION_KEY??'',env.FLOCKLETTER_CUSTOMER_CONFIRMATION_FROM??'',config.origin)}:{})});
    this.team=new CustomerTeamLifecycle(db,{mode:settings.team,checkOwner:identity.isOwner,seatLimit:(sql,w)=>customerSeatLimit(sql,w,this.billing.options),
      ...(settings.team==='clerk'?{port:customerTeamClerkPort({secretKey:config.clerkSecretKey!,publishableKey:config.clerkPublishableKey!})}:{})});
    const inbound=env.FLOCKLETTER_SUPPORT_INBOUND_WORKSPACE&&env.FLOCKLETTER_SUPPORT_INBOUND_ADDRESS&&env.FLOCKLETTER_SUPPORT_INBOUND_SECRET?
      {workspaceId:env.FLOCKLETTER_SUPPORT_INBOUND_WORKSPACE,address:env.FLOCKLETTER_SUPPORT_INBOUND_ADDRESS,webhookSecret:env.FLOCKLETTER_SUPPORT_INBOUND_SECRET}:undefined;
    const supportKeys=supportResendKeys(env,settings.support==='live');
    if(settings.support==='live'&&!env.FLOCKLETTER_SUPPORT_SENDER)
      throw Error('External support needs dedicated transport, sender and operator bindings.');
    this.support=new CustomerSupport(db,{mode:settings.support,isOwner:identity.isOwner,
      isOperator:async()=>false,writer:configuredSupportWriter({enabled:env.FLOCKLETTER_SUPPORT_WRITER_ENABLED==='true',origin:env.FLOCKLETTER_SUPPORT_WRITER_ORIGIN??'',allowedOrigins:(env.FLOCKLETTER_SUPPORT_WRITER_ALLOWED_ORIGINS??'').split(',').filter(Boolean),model:env.FLOCKLETTER_SUPPORT_WRITER_MODEL??'',apiKey:env.FLOCKLETTER_SUPPORT_WRITER_KEY}),automationLiveApproved:env.FLOCKLETTER_SUPPORT_AUTOMATION_APPROVED==='true',sender:env.FLOCKLETTER_SUPPORT_SENDER,
      ...(env.FLOCKLETTER_SUPPORT_NATIVE_WEBHOOK_SECRET?{nativeInbound:{webhookSecret:env.FLOCKLETTER_SUPPORT_NATIVE_WEBHOOK_SECRET,apiKey:supportKeys.retrieval!,bindings:JSON.parse(env.FLOCKLETTER_SUPPORT_NATIVE_BINDINGS??'[]'),platformAddress:env.FLOCKLETTER_SUPPORT_NATIVE_ADDRESS,replyDomain:env.FLOCKLETTER_SUPPORT_REPLY_DOMAIN,threadSecret:env.FLOCKLETTER_SUPPORT_THREAD_KEY}}:{}),
      ...(settings.support==='live'?{provider:new ResendSupportProvider(supportKeys.sending!,undefined,supportKeys.retrieval),inbound}:{})});
    this.retention=new CustomerRetention(db,{mode:settings.retention,isOwner:identity.isOwner,
      serviceEnd:w=>this.billing.retentionServiceEnd(w),serviceEndSql:(sql,w)=>retentionServiceEndSql(sql,w,this.billing.options),
      clock:w=>this.billing.retentionClock(w),clockSql:(sql,w)=>retentionClockSql(sql,w,this.billing.options),
      currentOwner:w=>this.currentOwner(w)});
    this.engine=settings.renderer&&settings.delivery!=='off'?new CustomerEnginePool(settings.engineCount):undefined;
    this.ses=customerSesRuntime(config.origin,env);
    this.resend=customerResendRuntime(config.origin,env);
    const provider=(w:string,b:string,mode:SendingProvider=settings.delivery==='resend'?'resend':'ses')=>mode==='ses'?this.ses?.provider(w,b):this.resend?.provider(w,b);
    const safeguards=env.FLOCKLETTER_SENDING_POLICY==='permission-v1'?new SendingSafeguards(db,env.FLOCKLETTER_CUSTOMER_RESEND_RETRIEVE_KEY,fetch,Number(env.FLOCKLETTER_RESEND_APPROVED_MONTHLY_LIMIT??'50000')):undefined;
    this.delivery=new CustomerDelivery(db,{safeguards,mode:settings.delivery,scope:settings.deliveryScope,environment:config.environment,origin:config.origin,
      billing:this.billing,eligibilitySql:(sql,w)=>customerEligibility(sql,w,this.billing.options),isOwner:identity.isOwner,
      render:this.engine?message=>this.engine!.render(message):undefined,optOut:createCustomerOptOut,liveConsent:productionConsentEligible,liveConsentBatch:productionConsentEligibleBatch,
      provider});
    if(this.resend)this.resendFeedback=new CustomerResendFeedback(db,this.resend,this.delivery.worker,async fingerprint=>{const value=(await db.pool.query('SELECT flockletter_customer_jobs.resolve_resend_route($1) route',[fingerprint])).rows[0]?.route;return value?storedResendRoute(value):null;});
    const selfService=env.FLOCKLETTER_RESEND_SELF_SERVICE==='approved';
    const capturedSetup=env.FLOCKLETTER_RESEND_SELF_SERVICE==='capture';
    if(env.FLOCKLETTER_RESEND_SELF_SERVICE!==undefined&&!['off','approved','capture'].includes(env.FLOCKLETTER_RESEND_SELF_SERVICE))throw Error('Unknown sender setup mode.');
    if(capturedSetup&&config.environment==='production'||selfService&&config.environment!=='production')throw Error('Use captured sender setup only outside production.');
    const provisioningKey=env.FLOCKLETTER_RESEND_PROVISION_KEY;
    if(selfService&&(!this.resend||!provisioningKey||[env.FLOCKLETTER_CUSTOMER_RESEND_KEY,env.FLOCKLETTER_CUSTOMER_RESEND_RETRIEVE_KEY].includes(provisioningKey)))throw Error('Self-service sending needs a separate Resend provisioning credential and configured newsletter service.');
    this.senderSetup=new ResendSenderSetup(db,{enabled:selfService||capturedSetup,captured:capturedSetup,port:capturedSetup?capturedSenderSetupPort():provisioningKey?resendSenderSetupPort(provisioningKey):undefined,webhookId:env.FLOCKLETTER_RESEND_CUSTOMER_WEBHOOK_ID??this.resend?.entries[0]?.route.webhookId??(capturedSetup?'00000000-0000-4000-8000-000000000001':undefined),isOwner:identity.isOwner,eligible:w=>this.billing.eligibility(w),configured:(w,b,from)=>!!from&&this.resend?.provider(w,b)?.from===from,register:route=>this.resend?.register(route)});
    this.infrastructure=new CustomerInfrastructure(db,{mode:settings.infrastructure,environment:config.environment,isOwner:identity.isOwner,
      eligibility:w=>this.billing.eligibility(w),eligibilitySql:(sql,w)=>customerEligibility(sql,w,this.billing.options),
      provider:settings.infrastructure==='aws'?createAwsInfrastructurePort(env,async request=>db.brand(request.workspaceId,request.brandId,async sql=>{
        if((await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount)return false;
        const profile=await senderProfile(sql,request.brandId);
        return !!profile&&profile.revision===request.senderRevision&&profile.fromEmail===request.fromEmail&&
          Boolean((await sql.query("SELECT FROM sender_domains WHERE domain=$1 AND verified_at>clock_timestamp()-interval '24 hours'",[request.domain])).rowCount);
      })):undefined,
      ...(settings.provisioningMonthlyLimit>0?{budgetPermit:async(sql,request)=>Boolean((await sql.query<{allowed:boolean}>(
        'SELECT flockletter_customer_jobs.claim_provisioning_budget($1,$2,$3,$4) AS allowed',
        [request.workspaceId,request.brandId,request.operationKey,settings.provisioningMonthlyLimit])).rows[0]?.allowed)}:{})});
    const inboundBinding=env.FLOCKLETTER_CUSTOMER_SES_FEEDBACK_BINDING;
    const inboundRoute=inboundBinding?parseSesRoute(JSON.parse(inboundBinding)):undefined;
    if(inboundRoute&&settings.delivery==='ses'&&!this.ses?.entries.some(entry=>entry.route.fingerprint===inboundRoute.fingerprint))
      throw Error('The prepared feedback route must match the configured sending route before activation.');
    if(this.ses||inboundRoute||settings.infrastructure==='aws')this.feedback=new SesFeedbackRouter([]);
    if(inboundRoute)this.registerFeedback(inboundRoute,true);
    for(const entry of this.ses?.entries??[])this.registerFeedback(entry.route);
  }
  private registerFeedback(route:SesRoute,explicitFeedbackBinding=false) {
    route=Object.freeze({...route});
    this.feedback?.register(new SesNotifications(route,undefined,undefined,{
      customer:true,canConfirm:async()=>{
        const exists=await this.db.tenant(route.workspaceId,async sql=>
          !!(await sql.query('SELECT FROM brands WHERE workspace_id=$1 AND id=$2',[route.workspaceId,route.brandId])).rowCount&&!(await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount);
        if(!exists)return false;
        if(explicitFeedbackBinding||this.ses?.entries.some(entry=>entry.configuration&&entry.route.fingerprint===route.fingerprint))return true;
        return this.infrastructure.canConfirmRoute(route);
      },apply:async(_db,event,eventId)=>{
        await locked(this.db,route.workspaceId,async sql=>{
          await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[route.brandId]);
          const row=(await sql.query<DeliveryRow>(`SELECT d.*,d.test_day::text AS test_day FROM customer_deliveries d JOIN customer_delivery_recipients p
            ON(p.workspace_id,p.brand_id,p.delivery_id)=(d.workspace_id,d.brand_id,d.id)
            WHERE p.id=$1 AND d.brand_id=$2 AND d.mode='ses' AND split_part(d.provider_binding,':',1)=$3`,
            [event.operation,route.brandId,route.fingerprint])).rows[0];
          const person=(await sql.query<{email_digest:string;message_id:string|null}>('SELECT email_digest,message_id FROM customer_delivery_recipients WHERE id=$1 FOR UPDATE',[event.operation])).rows[0];
          requireCondition(row&&person&&person.email_digest===digest(event.destination)&&(!person.message_id||person.message_id===event.messageId),
            409,'feedback_unmapped','This notification does not match a submitted recipient.');
          await this.delivery.worker.feedback(sql,row,event.operation,event.kind==='permanent_bounce'?'hard_bounce':event.kind,eventId);
          await sql.query('UPDATE customer_delivery_recipients SET message_id=coalesce(message_id,$2) WHERE id=$1',[event.operation,event.messageId]);
          await this.delivery.worker.settle(sql,row);
        });
      },
    }));
  }
  private async hydrateInfrastructure(workspace:string) {
    await this.delivery.options.safeguards?.refreshUsage();
    if(this.resend){const routes=(await this.db.read(workspace,sql=>sql.query<{route:unknown}>('SELECT flockletter_customer_jobs.resend_routes($1) route',[workspace]))).rows;requireCondition(routes.length<=100,503,'sender_route_capacity','Sender route history needs operator review.');for(const {route} of routes)this.resend.register(storedResendRoute(route),false);
      const brands=(await this.db.read(workspace,sql=>sql.query<{id:string}>('SELECT id FROM brands ORDER BY id LIMIT 5'))).rows;
      for(const brand of brands){const current=await this.db.brand(workspace,brand.id,async sql=>{const row=(await sql.query<{from_email:string;sender_revision:number}>("SELECT from_email,sender_revision FROM customer_resend_senders WHERE brand_id=$1 AND state='verified'",[brand.id])).rows[0];const profile=await senderProfile(sql,brand.id);return row&&profile?.fromEmail===row.from_email&&profile.revision===row.sender_revision?row:null;});if(current){const found=routes.map(r=>storedResendRoute(r.route)).filter(r=>r.brandId===brand.id&&r.from===current.from_email).at(-1);if(found)this.resend.register(found);}}}
    if(this.settings.infrastructure!=='aws')return;
    this.ses?.deactivate(workspace);
    for(const route of await this.infrastructure.routeCandidates(workspace)) {
      this.registerFeedback(route);
      const verified=await this.infrastructure.verifiedRoute(workspace,route.brandId).catch(()=>null);
      this.ses?.register(route,verified?.fingerprint===route.fingerprint);
    }
  }
  private confirmationRoutingKey() {
    const key=this.env.FLOCKLETTER_CUSTOMER_CONFIRMATION_ROUTING_KEY;
    if(!key||!/^[a-f0-9]{64}$/i.test(key)||key.toLowerCase()===this.env.FLOCKLETTER_CUSTOMER_CONFIRMATION_SIGNING_KEY?.toLowerCase())throw Error('Live confirmation needs a distinct dedicated routing key.');
    return Buffer.from(key,'hex');
  }
  private confirmationKey() {
    const key=this.env.FLOCKLETTER_CUSTOMER_CONFIRMATION_SIGNING_KEY;
    if(!key||!/^[a-f0-9]{64}$/i.test(key))throw Error('Live confirmation needs a dedicated signing key.');
    return Buffer.from(key,'hex');
  }
  private async currentOwner(workspace:string) {
    if(!this.identity.team)return null;
    let total:number|undefined;
    for(let offset=0;offset<10000;offset+=100) {
      const page=await this.identity.team.members(workspace,offset,100);
      if(!Number.isSafeInteger(page.total)||page.total<1||(total!==undefined&&total!==page.total))return null;
      total=page.total;
      for(const member of page.members)if(member.membership==='owner'&&await this.identity.isOwner(member.userId,workspace))return member.userId;
      if(offset+page.members.length>=total)return null;
      if(page.members.length!==100)return null;
    }
    return null;
  }
  owns(name:string){return prefixes.some(prefix=>name.startsWith(prefix));}
  async preflight(actor:Actor):Promise<WorkspacePreflight> {
    const owner=actor.kind==='session'&&actor.owner&&await this.identity.isOwner(actor.userId,actor.workspaceId);
    if(actor.kind==='connection')requireCondition(await this.identity.isOwner(actor.userId,actor.workspaceId),403,'owner_required','Current issuing-owner authority is required.');
    const service=await this.billing.eligibility(actor.workspaceId);
    return this.db.tenant(actor.workspaceId,async sql=>{
      let audienceAllowed=owner,brandIds=actor.brandIds,scopes=actor.scopes;
      if(actor.kind==='connection') {
        const grant=(await sql.query<{scopes:Capability[];brand_ids:string[]}>(`SELECT scopes,brand_ids FROM connections
          WHERE id::text=$1 AND issuer_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()
          AND 'read'=ANY(scopes) FOR SHARE`,[actor.actorId.slice('connection:'.length),actor.userId])).rows[0];
        requireCondition(grant,403,'connection_revoked','This connection no longer has current workspace read access.');
        audienceAllowed=grant.scopes.includes('audience:summary');scopes=grant.scopes;
        brandIds=grant.brand_ids.filter(id=>actor.brandIds===null||actor.brandIds.includes(id));
      }
      const observedAt=(await sql.query<{at:Date}>('SELECT clock_timestamp() at')).rows[0]!.at.toISOString();
      const initialized=!!(await sql.query('SELECT FROM workspaces')).rowCount;
      const gaps:WorkspaceSetupGap[]=[];
      if(!initialized)gaps.push({code:'workspace_not_initialized',title:'Create your workspace',detail:'Name the workspace and first brand.',action:'settings'});
      if(owner&&!service.eligible)for(const reason of service.reasons)gaps.push({code:'service_activation_required',title:'Review subscription access',detail:reason,action:'subscription'});
      if(!owner)gaps.push({code:'owner_service_review_required',title:'Owner service review',detail:'A current workspace owner reviews subscription access.',action:'subscription'});
      if(this.settings.delivery==='off')gaps.push({code:'delivery_off',title:'Delivery is not configured',detail:'A platform operator must configure the delivery mode.',action:'operations'});
      if(!this.engine)gaps.push({code:'renderer_required',title:'Private renderer needed',detail:'Configure the private mailing renderer before campaign approval.',action:'operations'});
      const brands:WorkspacePreflight['brands']=[];
      for(const brand of (await sql.query<{id:string;name:string}>('SELECT id,name FROM brands ORDER BY name')).rows) {
        if(brandIds!==null&&!brandIds.includes(brand.id))continue;
        await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[brand.id]);
        const confirmed=audienceAllowed?(await sql.query<{count:number}>("SELECT count(*)::int count FROM subscribers WHERE state='confirmed'")).rows[0]!.count:null;
        const profile=await senderProfile(sql,brand.id);
        let liveSender=false,unavailable=false;
        if(externalDelivery(this.settings.delivery))try{const selected=await selectedDelivery(sql,this.delivery.options,actor.workspaceId,brand.id);liveSender=await senderEligible(sql,brand.id,selected.provider);}catch{unavailable=true;}
        if(confirmed===0)gaps.push({code:'confirmed_audience_required',title:'Confirm subscribers',detail:'Add contacts with permission and complete email confirmation.',brandId:brand.id,action:'audience'});
        if(confirmed===null)gaps.push({code:'audience_review_required',title:'Audience review',detail:'An owner or an explicitly granted audience-summary connection must inspect audience totals.',brandId:brand.id,action:'audience'});
        if(!profile)gaps.push({code:'sender_profile_required',title:'Complete sender identity',detail:'Save this brand’s recognizable sender and required postal footer.',brandId:brand.id,action:'delivery'});
        if(externalDelivery(this.settings.delivery)&&!liveSender)gaps.push({code:unavailable?'sender_verification_unavailable':'sender_verification_required',title:unavailable?'Refresh sender verification':'Verify this sender',detail:unavailable?'The latest sender/provider check could not complete. Retry before reviewing delivery.':'Complete the legal sender profile, current DNS proof and provider setup.',brandId:brand.id,action:'delivery'});
        brands.push({id:brand.id,name:brand.name,confirmed,senderProfileConfigured:!!profile,senderVerified:liveSender});
      }
      return {initialized,canPrepare:initialized,canSend:false,reviewRequired:true,observedAt,
        mode:this.settings.delivery,deliveryScope:this.settings.deliveryScope,capturedExercise:this.settings.delivery==='capture',rendererConfigured:!!this.engine,scopes,brandIds,
        service:owner?{source:service.source,state:service.state,eligible:service.eligible,reasons:service.reasons}:null,
        limits,allowance:owner?service.limits:null,brands,gaps};
    });
  }
  async wake(workspace:string) {
    await this.db.tenant(workspace,async sql=>{
      if(!(await sql.query('SELECT FROM workspaces')).rowCount)return;
      await sql.query('SELECT flockletter_customer_jobs.wake($1,now())',[workspace]);
    });
  }
  async execute(name:CommandName,raw:unknown,actor:Actor):Promise<unknown> {
    if(!this.owns(name))return undefined;
    requireCondition(!this.closing,503,'worker_draining','The service is restarting. Retry with the same operation key.');
    const mutation=commands[name].mutation;
    if(name.startsWith('infrastructure.')||name.startsWith('delivery.')&&!['delivery.preflight','delivery.outcomes','delivery.testDetails'].includes(name))await this.hydrateInfrastructure(actor.workspaceId);
    if(mutation)await this.wake(actor.workspaceId);
    let result:unknown;
    if(name==='operations.status')return this.status(actor.workspaceId);
    if(name==='operations.process') {
      requireCondition(actor.kind==='session'&&actor.owner&&await this.identity.isOwner(actor.userId,actor.workspaceId),403,'owner_required','Use a current owner session.');
      const input=commands['operations.process'].schema.parse(raw),hash=digest(JSON.stringify([name,input]));
      const intent=await locked(this.db,actor.workspaceId,async sql=>{
        requireCondition(await this.identity.isOwner(actor.userId,actor.workspaceId),403,'owner_required','Current workspace ownership is required.');
        const previous=(await sql.query<{request_hash:string;result:unknown}>('SELECT request_hash,result FROM operations WHERE actor_id=$1 AND operation_key=$2',[actor.actorId,input.operationKey])).rows[0];
        if(previous){requireCondition(previous.request_hash===hash,409,'operation_conflict','Retry the original operation with this key.');return {fresh:false,result:previous.result};}
        const result={requested:true,requestId:input.operationKey};
        await sql.query('INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4,$5)',[actor.workspaceId,actor.actorId,input.operationKey,hash,JSON.stringify(result)]);
        await audit(sql,actor,name,null);return {fresh:true,result};
      });
      if(intent.fresh)await this.processWorkspace(actor.workspaceId);result=intent.result;
    } else if(name.startsWith('customerBilling.'))result=await this.billing.execute(name,raw,actor);
    else if(name.startsWith('audienceOnboarding.'))result=await this.audience.execute(name,raw,actor);
    else if(name.startsWith('teamLifecycle.'))result=await this.team.execute(name,raw,actor);
    else if(name.startsWith('support.'))result=await this.support.execute(name,raw,actor);
    else if(name.startsWith('retention.'))result=await this.retention.execute(name,raw,actor);
    else if(name.startsWith('senderSetup.'))result=await this.senderSetup.execute(name,raw,actor);
    else if(name.startsWith('infrastructure.')){result=await this.infrastructure.execute(name,raw,actor);await this.hydrateInfrastructure(actor.workspaceId);}
    else result=await this.delivery.execute(name,raw,actor);
    if(mutation)await this.wake(actor.workspaceId);
    return result;
  }
  async processWorkspace(workspace:string):Promise<void> {
    const current=this.active.get(workspace);if(current)return current;
    const job=this.process(workspace).finally(()=>this.active.delete(workspace));
    this.active.set(workspace,job);return job;
  }
  private async process(workspace:string) {
    if(this.closing)return;
    const erased=await this.db.tenant(workspace,async sql=>Boolean((await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount));
    if(erased)return;
    let failure:string|null=null;
    const run=async(action:()=>Promise<unknown>)=>{if(this.closing)return;try{await action();}catch{failure='workspace_job_requires_review';}};
    const brands=await this.db.tenant(workspace,async sql=>(await sql.query<{id:string}>('SELECT id FROM brands ORDER BY id LIMIT 5')).rows);
    for(const brand of brands)if(this.settings.infrastructure==='aws'||externalDelivery(this.settings.delivery))
      await run(()=>refreshCustomerSender(this.db,workspace,brand.id));
    await run(()=>this.senderSetup.tick(workspace));
    await run(()=>this.hydrateInfrastructure(workspace));
    await run(()=>this.infrastructure.tickWorkspace(workspace));
    await run(()=>this.hydrateInfrastructure(workspace));
    for(const brand of brands) {
      await run(()=>this.audience.tick(workspace,brand.id));
    }
    await run(()=>this.team.tickWorkspace(workspace));
    await run(()=>this.support.tickWorkspace(workspace));
    await run(()=>this.retention.tickWorkspace(workspace));
    for(let i=0;i<8&&!this.closing;i++) {
      try{if(!(await this.delivery.worker.tick(workspace)).processed)break;}
      catch{failure='delivery_job_requires_review';break;}
    }
    await this.db.tenant(workspace,sql=>sql.query('SELECT flockletter_customer_jobs.record_pass($1,$2)',[workspace,failure]));
    if(this.observe)await this.observe({workspaceId:workspace,status:await this.status(workspace)});
  }
  async run(signal:AbortSignal) {
    if(this.running)throw Error('The customer worker is already running.');
    this.running=true;
    const heartbeatStop=new AbortController();
    const heartbeat=runWorkerHeartbeat(this.db,this.settings.dedicated?'dedicated':'embedded',
      AbortSignal.any([signal,heartbeatStop.signal])).catch(()=>console.error('The customer worker heartbeat stopped unexpectedly.'));
    try {
      while(!signal.aborted) {
        try {
          const scopes=(await this.db.pool.query<{workspace_id:string}>('SELECT * FROM flockletter_customer_jobs.due_scopes()')).rows;
          for(const scope of scopes.slice(0,10)) {
            if(signal.aborted)break;
            await this.processWorkspace(scope.workspace_id);
            await this.db.tenant(scope.workspace_id,sql=>sql.query("SELECT flockletter_customer_jobs.snooze($1,now()+interval '15 seconds')",[scope.workspace_id]));
          }
        }catch{console.error('The customer scheduler needs review.');}
        try{await pause(3000,undefined,{signal});}catch{if(!signal.aborted)throw Error('Worker timer failed.');}
      }
    }finally{this.running=false;heartbeatStop.abort();await heartbeat;}
  }
  async status(workspace:string):Promise<CustomerOperationsStatus> {
    const heartbeat=await readWorkerHeartbeat(this.db,this.settings.dedicated?'dedicated':'embedded');
    const recorded=await this.db.tenant(workspace,async sql=>(await sql.query<{last_pass_at:Date|null;last_failure_code:string|null}>(
      'SELECT * FROM flockletter_customer_jobs.scope_status($1)',[workspace])).rows[0]);
    const queue=await this.db.tenant(workspace,async sql=>{
      const count=async(text:string)=>(await sql.query<{count:number}>(text)).rows[0]!.count;
      let confirmations=0,confirmationUnknown=0,senderQueued=0,senderUnknown=0;
      for(const brand of (await sql.query<{id:string}>('SELECT id FROM brands')).rows) {
        await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[brand.id]);
        senderQueued+=await count("SELECT count(*)::int count FROM customer_resend_senders WHERE state IN ('queued','creating','configuring','awaiting_dns')");senderUnknown+=await count("SELECT count(*)::int count FROM customer_resend_senders WHERE state='uncertain'");
        confirmationUnknown+=await count("SELECT count(*)::int count FROM customer_audience_confirmations WHERE state='uncertain'");
        confirmations+=await count("SELECT count(*)::int count FROM customer_audience_confirmations WHERE state IN ('queued','submitting','uncertain')");
      }
      return {
        delivery:await count("SELECT count(*)::int count FROM customer_delivery_recipients WHERE state IN ('pending','preparing','prepared','submitting')"),
        confirmations,
        team:await count("SELECT count(*)::int count FROM customer_team_intents WHERE state IN ('submitting','uncertain')"),
        support:await count("SELECT count(*)::int count FROM customer_support_dispatches WHERE state IN ('queued','submitting')"),
        retention:await count("SELECT count(*)::int count FROM customer_retention_jobs WHERE state IN ('awaiting_operator','authorized')"),
        infrastructure:senderQueued+await count("SELECT count(*)::int count FROM customer_infrastructure_intents WHERE state IN ('queued','provisioning','awaiting_dns','uncertain')"),
        unknown:confirmationUnknown+senderUnknown+await count("SELECT ((SELECT count(*) FROM customer_delivery_recipients WHERE state='uncertain')+(SELECT count(*) FROM customer_support_dispatches WHERE state='uncertain')+(SELECT count(*) FROM customer_team_intents WHERE state='uncertain')+(SELECT count(*) FROM customer_infrastructure_intents WHERE state='uncertain')+(SELECT count(*) FROM customer_trial_setups WHERE state='activation_pending'))::int count"),
      };
    });
    const modes=this.settings,gaps:CustomerOperationsStatus['gaps']=[];
    if(heartbeat.state!=='fresh')gaps.push({area:'operations',code:'worker_heartbeat_'+heartbeat.state,
      detail:'Worker liveness is '+heartbeat.state+'. Check the worker process and the separate queue-pass history.'});
    for(const area of ['billing','delivery','audience','team','support','retention','infrastructure'] as const)if(modes[area]==='off')
      gaps.push({area,code:'disabled',detail:'This workflow is switched off. Recorded settings and external verification are separate from activation.'});
    if(modes.delivery!=='off'&&!this.engine)gaps.push({area:'delivery',code:'private_renderer_required',detail:'Enable the private Listmonk renderer.'});
    if(modes.deliveryScope==='tests')gaps.push({area:'delivery',code:'broadcasts_disabled',detail:'Only separately reviewed one-recipient tests are permitted. Broadcasts and schedules are disabled.'});
    if(!modes.dedicated)gaps.push({area:'operations',code:'embedded_worker',detail:'Queues share this web service. Continuous operation depends on its hosting plan and process health; verify capacity or provision a dedicated worker before launch.'});
    if(modes.infrastructure==='aws'&&!this.infrastructure.options.provider)gaps.push({area:'infrastructure',code:'provider_configuration_required',detail:'Configure the dedicated provisioning account, US region and credentials.'});
    if(modes.infrastructure==='aws'&&!modes.provisioningMonthlyLimit)gaps.push({area:'infrastructure',code:'platform_budget_required',detail:'An operator must approve a bounded platform provisioning allowance.'});
    const billing=customerBillingConfiguration(this.env);
    for(const key of billing.missing)gaps.push({area:'billing',code:'configuration_required',detail:'Configure '+key+'.'});
    return {environment:this.config.environment,exercise:Object.values(modes).some(value=>value==='capture'||value==='exercise'),
      worker:{running:heartbeat.state==='fresh',dedicated:modes.dedicated,localProcessRunning:this.running,heartbeat,
        lastPass:recorded?.last_pass_at?.toISOString()??null,lastFailure:recorded?.last_failure_code??null},
      modes:{billing:modes.billing,delivery:modes.delivery,deliveryScope:modes.deliveryScope,audience:modes.audience,team:modes.team,support:modes.support,retention:modes.retention,infrastructure:modes.infrastructure},
      preparation:customerPreparation(this.env),gaps,queue,safeguards:{externalDelivery:externalDelivery(modes.delivery)&&modes.deliveryScope==='all',testDelivery:externalDelivery(modes.delivery),realCharges:modes.billing==='stripe_live',hostedErasure:false,openTracking:false,clickTracking:false}};
  }
  async close(){this.closing=true;const providerClose=Promise.resolve(this.infrastructure.options.provider?.close?.());this.ses?.close();await Promise.all([providerClose,this.engine?.close()]);await Promise.allSettled(this.active.values());}
}
