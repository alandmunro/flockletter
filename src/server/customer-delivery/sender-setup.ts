import {senderDomain} from '../../shared/sender.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {senderSetupCommands,type SenderSetupView,type SenderSetupState} from '../../shared/sender-setup.js';
import type {Actor} from '../service.js';
import {authorize} from '../service.js';
import type {Database,Sql} from '../db.js';
import {requireCondition,AppError} from '../errors.js';
import {digest} from '../content.js';
import {senderProfile} from './sender.js';
import {locked,brandScope,audit} from './storage.js';
import {boundedJson} from '../customer-support/writer.js';
import {parseResendRoute,type ResendRoute} from './resend-route.js';

const domainSchema=z.object({id:z.uuid(),name:z.string(),region:z.string(),status:z.string(),open_tracking:z.boolean(),click_tracking:z.boolean(),capabilities:z.object({sending:z.string()}),records:z.array(z.object({name:z.string().min(1).max(512),type:z.enum(['TXT','MX','CNAME']),value:z.string().min(1).max(4096),priority:z.number().int().nonnegative().optional()})).max(30)});
export type ResendDomainFacts=z.infer<typeof domainSchema>;
export type SenderSetupPort={usage:()=>Promise<{available:boolean}>;create:(domain:string)=>Promise<ResendDomainFacts>;inspect:(id:string,domain:string)=>Promise<ResendDomainFacts>;configure:(id:string)=>Promise<void>;verify:(id:string)=>Promise<void>};
export function resendSenderSetupPort(key:string,send:typeof fetch=fetch):SenderSetupPort {
 const call=async(path:string,method='GET',body?:unknown)=>{
  const response=await send('https://api.resend.com/'+path,{method,redirect:'error',signal:AbortSignal.timeout(8000),headers:{authorization:'Bearer '+key,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok){await response.body?.cancel();throw new AppError(response.status>=500?503:422,response.status>=500?'provider_outcome_unknown':'provider_request_rejected','The sending service could not complete this setup step.');}
  return boundedJson(response,65536);
 };
 return {
  usage:async()=>{const raw=z.object({domains:z.object({used:z.number().int().nonnegative(),limit:z.number().int().nonnegative()})}).parse(await call('usage'));return {available:raw.domains.used<raw.domains.limit};},
  create:async domain=>domainSchema.parse(await call('domains','POST',{name:domain,region:'us-east-1',capabilities:{sending:'enabled',receiving:'disabled'}})),
  inspect:async id=>domainSchema.parse(await call('domains/'+z.uuid().parse(id))),
  configure:async id=>{await call('domains/'+z.uuid().parse(id),'PATCH',{open_tracking:false,click_tracking:false});},
  verify:async id=>{await call('domains/'+z.uuid().parse(id)+'/verify','POST');},
 };
}
type Row={captured:boolean;workspace_id:string;brand_id:string;operation_id:string;actor_id:string;creator_id:string;domain:string;from_email:string;sender_revision:number;state:SenderSetupState;domain_id:string|null;dns:{name:string;type:string;value:string;priority?:number}[];reason:string|null};
type Options={enabled:boolean;captured?:boolean;port?:SenderSetupPort;webhookId?:string;isOwner:(user:string,workspace:string)=>Promise<boolean>;eligible:(workspace:string)=>Promise<{eligible:boolean}>;configured?:(workspace:string,brand:string,from:string|undefined)=>boolean;register?:(route:ResendRoute)=>void};
export class ResendSenderSetup {
 constructor(private db:Database,readonly options:Options){}
 private async owner(actor:Actor){requireCondition(actor.owner&&await this.options.isOwner(actor.userId,actor.workspaceId),403,'owner_required','Current workspace ownership is required.');}
 private async current(sql:Sql,row:Row){
  requireCondition(await this.options.isOwner(row.creator_id,row.workspace_id),403,'owner_required','The approving owner no longer has access.');
  if(row.actor_id.startsWith('connection:'))requireCondition((await sql.query("SELECT FROM connections WHERE id=$1 AND issuer_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() AND 'sender:configure'=ANY(scopes) AND 'read'=ANY(scopes) AND $3::uuid=ANY(brand_ids)",[row.actor_id.slice(11),row.creator_id,row.brand_id])).rowCount,403,'connection_revoked','Sender setup access has expired or been revoked.');
  const profile=await senderProfile(sql,row.brand_id);
  requireCondition(profile&&profile.revision===row.sender_revision&&profile.fromEmail===row.from_email,409,'sender_setup_changed','The saved sender changed. Review a fresh setup before creating infrastructure.');
  requireCondition(this.options.captured||(await sql.query("SELECT FROM sender_domains WHERE domain=$1 AND verified_at>clock_timestamp()-interval '24 hours'",[row.domain])).rowCount,409,'sender_ownership_required','Verify the Flockletter ownership TXT record before creating or verifying provider resources.');
 }
 async status(actor:Actor,brand:string):Promise<SenderSetupView>{return this.db.read(actor.workspaceId,async sql=>{
  await brandScope(sql,actor,brand);const profile=await senderProfile(sql,brand),row=(await sql.query<Row>('SELECT * FROM customer_resend_senders WHERE brand_id=$1',[brand])).rows[0];
  const ownership=profile&&(this.options.captured||Boolean((await sql.query("SELECT FROM sender_domains WHERE domain=$1 AND verified_at>clock_timestamp()-interval '24 hours'",[profile.fromEmail.split('@')[1]])).rowCount));
  const gaps:string[]=[];if(!this.options.enabled||!this.options.port)gaps.push('Self-service sender setup is not configured. Contact support; no provider resource or mailing was created.');
  if(!profile)gaps.push('Save the legal sender profile on Delivery first.');else if(!ownership)gaps.push('Add and verify the Flockletter domain ownership TXT record in Workspace first.');
  if(row?.state==='uncertain')gaps.push('The domain-creation outcome is unknown. Support must reconcile the original request; do not create a replacement.');
  if(row?.reason)gaps.push(({provider_domain_capacity:'The current provider domain allowance is full. Contact support; this setup will not buy an add-on or upgrade.',provider_request_rejected:'The provider rejected this setup. Check the saved domain and ask support to inspect the existing request before retrying.',provider_outcome_unknown:'The provider response was uncertain. Support must reconcile the existing setup before any replacement.',provider_facts_invalid:'Provider domain facts do not match the approved sender, region or disabled-tracking policy. Contact support.',sender_or_service_changed:'The approving owner, sender, ownership proof or subscription changed. Refresh those checks and review the sender again.',provider_setup_unavailable:'Sender setup could not complete. Refresh this saved setup; contact support if it stays held.',domain_creation_unknown:'Support must reconcile the original domain creation. Do not create another domain.'} as Record<string,string>)[row.reason]??'Sender setup needs support review of the existing request.');
  return {enabled:this.options.enabled&&!!this.options.port,captured:this.options.captured??false,alreadyConfigured:this.options.configured?.(actor.workspaceId,brand,profile?.fromEmail)??false,brandId:brand,ownershipVerified:!!ownership,senderRevision:profile?.revision??null,
   setup:row?{id:row.operation_id,domain:row.domain,fromEmail:row.from_email,senderRevision:row.sender_revision,state:row.state,reason:row.reason,dns:row.dns}:null,gaps};
 });}
 async execute(name:string,raw:unknown,actor:Actor){
  if(!(name in senderSetupCommands))return undefined;const command=senderSetupCommands[name as keyof typeof senderSetupCommands];authorize(actor,name as keyof typeof senderSetupCommands);
  const input=command.schema.parse(raw) as {brandId:string;operationKey?:string;senderRevision?:number;setupId?:string};
  await this.owner(actor);if(name==='senderSetup.status')return this.status(actor,input.brandId);
  requireCondition(this.options.enabled&&this.options.port&&this.options.webhookId,503,'sender_setup_unconfigured','The operator must configure self-service sender setup.');
  await locked(this.db,actor.workspaceId,async sql=>{
   await brandScope(sql,actor,input.brandId);await this.owner(actor);
   if(actor.kind==='connection')requireCondition((await sql.query("SELECT FROM connections WHERE id=$1 AND issuer_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() AND 'sender:configure'=ANY(scopes) AND 'read'=ANY(scopes) AND $3::uuid=ANY(brand_ids)",[actor.actorId.slice(11),actor.userId,input.brandId])).rowCount,403,'connection_revoked','Sender setup access is no longer current.');
   const hash=digest(JSON.stringify([name,command.schema.parse(raw)])),old=(await sql.query<{request_hash:string}>('SELECT request_hash FROM operations WHERE actor_id=$1 AND operation_key=$2',[actor.actorId,input.operationKey])).rows[0];
   if(old){requireCondition(old.request_hash===hash,409,'operation_conflict','Retry the original sender-setup request.');return;}
   const row=(await sql.query<Row>('SELECT * FROM customer_resend_senders WHERE brand_id=$1',[input.brandId])).rows[0];
   if(name==='senderSetup.review'){
    const profile=await senderProfile(sql,input.brandId);requireCondition(profile&&profile.revision===input.senderRevision,409,'sender_setup_changed','Save and review the current sender revision.');
    requireCondition(!row||!['creating','uncertain'].includes(row.state),409,'sender_setup_uncertain','Reconcile the original domain creation before changing this setup.');
    const domain=senderDomain.parse(profile.fromEmail.split('@')[1]),owned=(await sql.query<{id:string|null}>('SELECT flockletter_customer_jobs.owned_resend_domain($1,$2) id',[actor.workspaceId,domain])).rows[0]?.id;
    await sql.query(`INSERT INTO customer_resend_senders(workspace_id,brand_id,operation_id,actor_id,creator_id,domain,from_email,sender_revision,state,domain_id,captured) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reviewed',$9,$10)
     ON CONFLICT(workspace_id,brand_id) DO UPDATE SET operation_id=excluded.operation_id,actor_id=excluded.actor_id,creator_id=excluded.creator_id,domain=excluded.domain,from_email=excluded.from_email,sender_revision=excluded.sender_revision,state='reviewed',domain_id=excluded.domain_id,dns='[]',reason=NULL,captured=excluded.captured,updated_at=now()`,[actor.workspaceId,input.brandId,randomUUID(),actor.actorId,actor.userId,domain,profile.fromEmail,profile.revision,owned??null,this.options.captured??false]);
   }else{
    requireCondition(row&&row.operation_id===input.setupId,409,'sender_setup_changed','Use this brand’s current exact setup.');await this.current(sql,row);
    if(name==='senderSetup.approve'){
     requireCondition(row.state==='reviewed'&&row.sender_revision===input.senderRevision,409,'sender_setup_changed','Review the exact current sender setup.');
     requireCondition((await this.options.eligible(actor.workspaceId)).eligible,403,'service_activation_required','Activate eligible service before provider provisioning.');
     requireCondition((await sql.query<{allowed:boolean}>('SELECT flockletter_customer_jobs.claim_resend_domain($1,$2,$3,$4) allowed',[actor.workspaceId,input.brandId,row.operation_id,row.domain])).rows[0]?.allowed,409,'sender_domain_claimed','This domain has another setup in progress or belongs to another workspace.');
     await sql.query("UPDATE customer_resend_senders SET state='queued',updated_at=now() WHERE brand_id=$1",[input.brandId]);
    }
   }
   await sql.query('INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4,$5)',[actor.workspaceId,actor.actorId,input.operationKey,hash,JSON.stringify({brandId:input.brandId})]);
   await audit(sql,actor,name,input.setupId??null);
  });
  if(name!=='senderSetup.review')await this.tick(actor.workspaceId,input.brandId);
  return this.status(actor,input.brandId);
 }
 async tick(workspace:string,brand?:string){
  if(!this.options.enabled||!this.options.port)return;
  if(!brand){const brands=(await this.db.read(workspace,sql=>sql.query<{id:string}>('SELECT id FROM brands ORDER BY id LIMIT 5'))).rows;for(const item of brands)await this.tick(workspace,item.id);return;}
  const work=await locked(this.db,workspace,async sql=>{
   await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[brand]);
   const row=(await sql.query<Row>("SELECT * FROM customer_resend_senders WHERE ($1::uuid IS NULL OR brand_id=$1) AND state IN('queued','creating','configuring','awaiting_dns','verified') AND (state='queued' OR updated_at<clock_timestamp()-interval '60 seconds') ORDER BY updated_at LIMIT 1 FOR UPDATE",[brand??null])).rows[0];if(!row)return null;
   await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[row.brand_id]);
   try{requireCondition(row.captured===(this.options.captured??false),409,'sender_setup_mode_changed','Review this setup in the correct environment.');await this.current(sql,row);requireCondition((await this.options.eligible(workspace)).eligible,403,'service_activation_required','Service is not eligible.');}catch{await sql.query("UPDATE customer_resend_senders SET state='held',reason='sender_or_service_changed',updated_at=now() WHERE brand_id=$1",[row.brand_id]);return null;}
   if(row.state==='creating'&&!row.domain_id){await sql.query("UPDATE customer_resend_senders SET state='uncertain',reason='domain_creation_unknown',updated_at=now() WHERE brand_id=$1",[row.brand_id]);return null;}
   await sql.query("UPDATE customer_resend_senders SET state=CASE WHEN domain_id IS NULL THEN 'creating' ELSE 'configuring' END,updated_at=now() WHERE brand_id=$1",[row.brand_id]);
   return row;
  });
  if(!work)return;
  let facts:ResendDomainFacts;let creating=false;
  try{
   if(!work.domain_id){
    if(!(await this.options.port.usage()).available){await this.save(workspace,work,'held','provider_domain_capacity');return;}
    creating=true;facts=await this.options.port.create(work.domain);
    requireCondition(facts.name===work.domain&&facts.region==='us-east-1',503,'provider_facts_invalid','The provider returned mismatched domain facts.');
    await locked(this.db,workspace,async sql=>{await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[work.brand_id]);await sql.query("UPDATE customer_resend_senders SET domain_id=$2,state='configuring',updated_at=now() WHERE brand_id=$1 AND operation_id=$3",[work.brand_id,facts.id,work.operation_id]);await sql.query('SELECT flockletter_customer_jobs.bind_resend_domain($1,$2,$3,$4)',[workspace,work.brand_id,work.operation_id,facts.id]);});work.domain_id=facts.id;
   }else facts=await this.options.port.inspect(work.domain_id,work.domain);
   requireCondition(facts.id===work.domain_id&&facts.name===work.domain&&facts.region==='us-east-1',503,'provider_facts_invalid','The provider returned mismatched domain facts.');
   if(facts.open_tracking||facts.click_tracking){await this.options.port.configure(facts.id);facts=await this.options.port.inspect(facts.id,work.domain);}
   requireCondition(facts.open_tracking===false&&facts.click_tracking===false&&facts.capabilities.sending==='enabled',503,'provider_facts_invalid','Disable tracking and enable this sender at the provider.');
   const verified=facts.status==='verified';
   if(!verified)await this.options.port.verify(facts.id);
   await locked(this.db,workspace,async sql=>{
    await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[work.brand_id]);
    const current=(await sql.query<Row>('SELECT * FROM customer_resend_senders WHERE brand_id=$1',[work.brand_id])).rows[0];
    requireCondition(current?.operation_id===work.operation_id,409,'sender_setup_changed','The sender setup changed.');await this.current(sql,current);
    const dns=facts.records.map(r=>({name:r.name,type:r.type,value:r.value,...(r.priority!==undefined?{priority:r.priority}:{})}));
    await sql.query('UPDATE customer_resend_senders SET state=$2,dns=$3,reason=NULL,updated_at=now() WHERE brand_id=$1',[work.brand_id,verified?'verified':'awaiting_dns',JSON.stringify(dns)]);
    if(verified){const route=parseResendRoute({workspaceId:workspace,brandId:work.brand_id,from:work.from_email,domainId:facts.id,webhookId:this.options.webhookId!,region:'us-east-1'});await sql.query('SELECT flockletter_customer_jobs.register_resend_route($1,$2,$3,$4)',[workspace,work.brand_id,route.fingerprint,JSON.stringify(route)]);this.options.register?.(route);}
   });
  }catch(error){await this.save(workspace,work,!work.domain_id&&creating&&!(error instanceof AppError&&error.code==='provider_request_rejected')?'uncertain':'held',error instanceof AppError?error.code:'provider_setup_unavailable');}
 }
 private async save(workspace:string,row:Row,state:SenderSetupState,reason:string){await locked(this.db,workspace,async sql=>{await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[row.brand_id]);await sql.query('UPDATE customer_resend_senders SET state=$2,reason=$3,updated_at=now() WHERE brand_id=$1 AND operation_id=$4',[row.brand_id,state,reason,row.operation_id]);});}
}

/** Synthetic transport for the isolated staging database; never installed in production. */
export function capturedSenderSetupPort():SenderSetupPort {
 const facts=(id:string,domain:string,status:string):ResendDomainFacts=>({id,name:domain,region:'us-east-1',status,open_tracking:false,click_tracking:false,capabilities:{sending:'enabled'},records:[{name:'_dkim.'+domain+'.invalid',type:'TXT',value:'captured-example-only'}]});
 return {usage:async()=>({available:true}),create:async domain=>facts(randomUUID(),domain,'not_started'),inspect:async(id,domain)=>facts(id,domain,'verified'),configure:async()=>{},verify:async()=>{}};
}
