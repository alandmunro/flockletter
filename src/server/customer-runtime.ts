import { trialRegistryFromEnvironment } from './customer-abuse/registry.js';
import { setTimeout as pause } from 'node:timers/promises';
import type { Config } from './config.js';
import type { Database } from './db.js';
import type { Actor } from './service.js';
import type { IdentityProvider } from './auth.js';
import { requireCondition } from './errors.js';
import { commands,type CommandName } from '../shared/contracts.js';
import type { CustomerOperationsStatus } from '../shared/customer-operations.js';
import { customerSettings } from './customer-settings.js';
import { CustomerBilling,customerEligibility,customerContactLimit,customerSeatLimit,retentionServiceEndSql,retentionClockSql } from './customer-billing/service.js';
import { customerBillingConfiguration,stripeCustomerProvider } from './customer-billing/provider.js';
import { CustomerAudience,createCustomerOptOut,productionConsentEligible } from './customer-audience/service.js';
import { CustomerConfirmationProvider } from './customer-audience/resend.js';
import { CustomerTeamLifecycle } from './customer-team/service.js';
import { customerTeamClerkPort } from './customer-team/clerk.js';
import { configuredSupportWriter } from './customer-support/writer.js';
import { CustomerSupport } from './customer-support/index.js';
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
import type { SesRoute } from './campaign/ses-runtime.js';

const prefixes=['customerBilling.','audienceOnboarding.','teamLifecycle.','support.','retention.','delivery.','operations.','infrastructure.'];
export class CustomerWorkflows {
  readonly settings;
  readonly billing:CustomerBilling;
  readonly audience:CustomerAudience;
  readonly team:CustomerTeamLifecycle;
  readonly support:CustomerSupport;
  readonly retention:CustomerRetention;
  readonly delivery:CustomerDelivery;
  readonly infrastructure:CustomerInfrastructure;
  readonly engine?:CustomerEnginePool;
  readonly ses?:ReturnType<typeof customerSesRuntime>;
  readonly feedback?:SesFeedbackRouter;
  observe?: (value:{workspaceId:string;status:CustomerOperationsStatus})=>Promise<void>;
  private running=false;
  private closing=false;
  private active=new Map<string,Promise<void>>();
  constructor(readonly db:Database,readonly config:Config,readonly identity:IdentityProvider,readonly env:NodeJS.ProcessEnv=process.env) {
    const settings=this.settings=customerSettings(config,env);
    const gateway=stripeCustomerProvider(config.origin,env);
    this.billing=new CustomerBilling(db,{environment:config.environment,exerciseEnabled:settings.billing==='exercise',
      gateway,trialRegistry:trialRegistryFromEnvironment(env,settings.billing==='exercise'?'exercise':gateway?.live?'stripe_live':'stripe_test',settings.billing==='exercise'?'captured':gateway?.account??'unconfigured'),checkOwner:identity.isOwner});
    this.audience=new CustomerAudience(db,{mode:settings.audience,origin:config.origin,checkOwner:identity.isOwner,
      contactLimit:(sql,w)=>customerContactLimit(sql,w,this.billing.options),
      ...(settings.audience==='live'?{confirmationKey:this.confirmationKey(),provider:new CustomerConfirmationProvider(
        env.FLOCKLETTER_CUSTOMER_CONFIRMATION_KEY??'',env.FLOCKLETTER_CUSTOMER_CONFIRMATION_FROM??'',config.origin)}:{})});
    this.team=new CustomerTeamLifecycle(db,{mode:settings.team,checkOwner:identity.isOwner,seatLimit:(sql,w)=>customerSeatLimit(sql,w,this.billing.options),
      ...(settings.team==='clerk'?{port:customerTeamClerkPort({secretKey:config.clerkSecretKey!,publishableKey:config.clerkPublishableKey!})}:{})});
    const inbound=env.FLOCKLETTER_SUPPORT_INBOUND_WORKSPACE&&env.FLOCKLETTER_SUPPORT_INBOUND_ADDRESS&&env.FLOCKLETTER_SUPPORT_INBOUND_SECRET?
      {workspaceId:env.FLOCKLETTER_SUPPORT_INBOUND_WORKSPACE,address:env.FLOCKLETTER_SUPPORT_INBOUND_ADDRESS,webhookSecret:env.FLOCKLETTER_SUPPORT_INBOUND_SECRET}:undefined;
    if(settings.support==='live'&&(!env.FLOCKLETTER_SUPPORT_RESEND_KEY||!env.FLOCKLETTER_SUPPORT_SENDER))
      throw Error('External support needs dedicated transport, sender and operator bindings.');
    this.support=new CustomerSupport(db,{mode:settings.support,isOwner:identity.isOwner,
      isOperator:async()=>false,writer:configuredSupportWriter({enabled:env.FLOCKLETTER_SUPPORT_WRITER_ENABLED==='true',origin:env.FLOCKLETTER_SUPPORT_WRITER_ORIGIN??'',allowedOrigins:(env.FLOCKLETTER_SUPPORT_WRITER_ALLOWED_ORIGINS??'').split(',').filter(Boolean),model:env.FLOCKLETTER_SUPPORT_WRITER_MODEL??'',apiKey:env.FLOCKLETTER_SUPPORT_WRITER_KEY}),automationLiveApproved:env.FLOCKLETTER_SUPPORT_AUTOMATION_APPROVED==='true',sender:env.FLOCKLETTER_SUPPORT_SENDER,
      ...(env.FLOCKLETTER_SUPPORT_NATIVE_WEBHOOK_SECRET&&env.FLOCKLETTER_SUPPORT_RESEND_KEY?{nativeInbound:{webhookSecret:env.FLOCKLETTER_SUPPORT_NATIVE_WEBHOOK_SECRET,apiKey:env.FLOCKLETTER_SUPPORT_RESEND_KEY,bindings:JSON.parse(env.FLOCKLETTER_SUPPORT_NATIVE_BINDINGS??'[]'),platformAddress:env.FLOCKLETTER_SUPPORT_NATIVE_ADDRESS,replyDomain:env.FLOCKLETTER_SUPPORT_REPLY_DOMAIN,threadSecret:env.FLOCKLETTER_SUPPORT_THREAD_KEY}}:{}),
      ...(settings.support==='live'?{provider:new ResendSupportProvider(env.FLOCKLETTER_SUPPORT_RESEND_KEY!),inbound}:{})});
    this.retention=new CustomerRetention(db,{mode:settings.retention,isOwner:identity.isOwner,
      serviceEnd:w=>this.billing.retentionServiceEnd(w),serviceEndSql:(sql,w)=>retentionServiceEndSql(sql,w,this.billing.options),
      clock:w=>this.billing.retentionClock(w),clockSql:(sql,w)=>retentionClockSql(sql,w,this.billing.options),
      currentOwner:w=>this.currentOwner(w)});
    this.engine=settings.renderer&&settings.delivery!=='off'?new CustomerEnginePool(settings.engineCount):undefined;
    this.ses=customerSesRuntime(config.origin,env);
    this.delivery=new CustomerDelivery(db,{mode:settings.delivery,environment:config.environment,origin:config.origin,
      billing:this.billing,eligibilitySql:(sql,w)=>customerEligibility(sql,w,this.billing.options),isOwner:identity.isOwner,
      render:this.engine?message=>this.engine!.render(message):undefined,optOut:createCustomerOptOut,liveConsent:productionConsentEligible,
      provider:this.ses?.provider});
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
    if(this.ses||settings.infrastructure==='aws')this.feedback=new SesFeedbackRouter([]);
    for(const entry of this.ses?.entries??[])this.registerFeedback(entry.route);
  }
  private registerFeedback(route:SesRoute) {
    route=Object.freeze({...route});
    this.feedback?.register(new SesNotifications(route,undefined,undefined,{
      customer:true,canConfirm:async()=>{
        const exists=await this.db.tenant(route.workspaceId,async sql=>
          !!(await sql.query('SELECT FROM workspaces')).rowCount&&!(await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount);
        if(!exists)return false;
        if(this.ses?.entries.some(entry=>entry.configuration&&entry.route.fingerprint===route.fingerprint))return true;
        return this.infrastructure.canConfirmRoute(route);
      },apply:async(_db,event,eventId)=>{
        await locked(this.db,route.workspaceId,async sql=>{
          await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[route.brandId]);
          const row=(await sql.query<DeliveryRow>(`SELECT d.* FROM customer_deliveries d JOIN customer_delivery_recipients p
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
    if(this.settings.infrastructure!=='aws')return;
    this.ses?.deactivate(workspace);
    for(const route of await this.infrastructure.routeCandidates(workspace)) {
      this.registerFeedback(route);
      const verified=await this.infrastructure.verifiedRoute(workspace,route.brandId).catch(()=>null);
      this.ses?.register(route,verified?.fingerprint===route.fingerprint);
    }
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
  async preflight(actor:Actor) {
    const service=await this.billing.eligibility(actor.workspaceId);
    return this.db.tenant(actor.workspaceId,async sql=>{
      const initialized=!!(await sql.query('SELECT FROM workspaces')).rowCount;
      const gaps:{code:string;title:string;detail:string;brandId?:string}[]=[];
      if(!initialized)gaps.push({code:'workspace_not_initialized',title:'Create your workspace',detail:'Name the workspace and first brand.'});
      if(!service.eligible)for(const reason of service.reasons)gaps.push({code:'service_activation_required',title:'Review subscription access',detail:reason});
      if(this.settings.delivery==='off')gaps.push({code:'delivery_off',title:'Delivery is not configured',detail:'A platform operator must configure the delivery mode.'});
      if(!this.engine)gaps.push({code:'renderer_required',title:'Private renderer needed',detail:'Configure the private mailing renderer before campaign approval.'});
      const brands=[];
      for(const brand of (await sql.query<{id:string;name:string}>('SELECT id,name FROM brands ORDER BY name')).rows) {
        if(actor.brandIds!==null&&!actor.brandIds.includes(brand.id))continue;
        await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[brand.id]);
        const confirmed=(await sql.query<{count:number}>("SELECT count(*)::int count FROM subscribers WHERE state='confirmed'")).rows[0]!.count;
        const profile=await senderProfile(sql,brand.id);
        const liveSender=this.settings.delivery==='ses'&&await senderEligible(sql,brand.id,this.ses?.provider(actor.workspaceId,brand.id));
        if(!confirmed)gaps.push({code:'confirmed_audience_required',title:'Confirm subscribers',detail:'Add contacts with permission and complete email confirmation.',brandId:brand.id});
        if(this.settings.delivery==='ses'&&!liveSender)gaps.push({code:'sender_verification_required',title:'Verify this sender',detail:'Complete the legal sender profile, current DNS proof and provider setup.',brandId:brand.id});
        brands.push({id:brand.id,name:brand.name,confirmed,senderProfileConfigured:!!profile,senderVerified:liveSender});
      }
      return {initialized,canPrepare:initialized,canSend:false,reviewRequired:true,
        mode:this.settings.delivery,capturedExercise:this.settings.delivery==='capture',scopes:actor.scopes,brandIds:actor.brandIds,
        limits,allowance:service.limits,brands,gaps};
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
    if(name.startsWith('infrastructure.')||name.startsWith('delivery.'))await this.hydrateInfrastructure(actor.workspaceId);
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
    for(const brand of brands)if(this.settings.infrastructure==='aws'||(this.settings.delivery==='ses'&&this.ses?.provider(workspace,brand.id)))
      await run(()=>refreshCustomerSender(this.db,workspace,brand.id));
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
    this.running=true;
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
    }finally{this.running=false;}
  }
  async status(workspace:string):Promise<CustomerOperationsStatus> {
    const recorded=await this.db.tenant(workspace,async sql=>(await sql.query<{last_pass_at:Date|null;last_failure_code:string|null}>(
      'SELECT * FROM flockletter_customer_jobs.scope_status($1)',[workspace])).rows[0]);
    const queue=await this.db.tenant(workspace,async sql=>{
      const count=async(text:string)=>(await sql.query<{count:number}>(text)).rows[0]!.count;
      let confirmations=0,confirmationUnknown=0;
      for(const brand of (await sql.query<{id:string}>('SELECT id FROM brands')).rows) {
        await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[brand.id]);
        confirmationUnknown+=await count("SELECT count(*)::int count FROM customer_audience_confirmations WHERE state='uncertain'");
        confirmations+=await count("SELECT count(*)::int count FROM customer_audience_confirmations WHERE state IN ('queued','submitting','uncertain')");
      }
      return {
        delivery:await count("SELECT count(*)::int count FROM customer_delivery_recipients WHERE state IN ('pending','preparing','prepared','submitting')"),
        confirmations,
        team:await count("SELECT count(*)::int count FROM customer_team_intents WHERE state IN ('submitting','uncertain')"),
        support:await count("SELECT count(*)::int count FROM customer_support_dispatches WHERE state IN ('queued','submitting')"),
        retention:await count("SELECT count(*)::int count FROM customer_retention_jobs WHERE state IN ('awaiting_operator','authorized')"),
        infrastructure:await count("SELECT count(*)::int count FROM customer_infrastructure_intents WHERE state IN ('queued','provisioning','awaiting_dns','uncertain')"),
        unknown:confirmationUnknown+await count("SELECT ((SELECT count(*) FROM customer_delivery_recipients WHERE state='uncertain')+(SELECT count(*) FROM customer_support_dispatches WHERE state='uncertain')+(SELECT count(*) FROM customer_team_intents WHERE state='uncertain')+(SELECT count(*) FROM customer_infrastructure_intents WHERE state='uncertain')+(SELECT count(*) FROM customer_trial_setups WHERE state='activation_pending'))::int count"),
      };
    });
    const modes=this.settings,gaps:CustomerOperationsStatus['gaps']=[];
    for(const area of ['billing','delivery','audience','team','support','retention','infrastructure'] as const)if(modes[area]==='off')
      gaps.push({area,code:'not_configured',detail:'Configure this workflow before activation.'});
    if(modes.delivery!=='off'&&!this.engine)gaps.push({area:'delivery',code:'private_renderer_required',detail:'Enable the private Listmonk renderer.'});
    if(!modes.dedicated)gaps.push({area:'operations',code:'sleeping_web_worker',detail:'Queues run while this web service is awake. A dedicated worker is required for continuous service.'});
    if(modes.infrastructure==='aws'&&!this.infrastructure.options.provider)gaps.push({area:'infrastructure',code:'provider_configuration_required',detail:'Configure the dedicated provisioning account, US region and credentials.'});
    if(modes.infrastructure==='aws'&&!modes.provisioningMonthlyLimit)gaps.push({area:'infrastructure',code:'platform_budget_required',detail:'An operator must approve a bounded platform provisioning allowance.'});
    const billing=customerBillingConfiguration(this.env);
    for(const key of billing.missing)gaps.push({area:'billing',code:'configuration_required',detail:'Configure '+key+'.'});
    return {environment:this.config.environment,exercise:Object.values(modes).some(value=>value==='capture'||value==='exercise'),
      worker:{running:this.running,dedicated:modes.dedicated,lastPass:recorded?.last_pass_at?.toISOString()??null,lastFailure:recorded?.last_failure_code??null},
      modes:{billing:modes.billing,delivery:modes.delivery,audience:modes.audience,team:modes.team,support:modes.support,retention:modes.retention,infrastructure:modes.infrastructure},
      gaps,queue,safeguards:{externalDelivery:modes.delivery==='ses',realCharges:modes.billing==='stripe_live',hostedErasure:false,openTracking:false,clickTracking:false}};
  }
  async close(){this.closing=true;const providerClose=Promise.resolve(this.infrastructure.options.provider?.close?.());this.ses?.close();await Promise.all([providerClose,this.engine?.close()]);await Promise.allSettled(this.active.values());}
}
