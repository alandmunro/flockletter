import { randomUUID } from 'node:crypto';
import { platformCommands,type PlatformCommand,type PlatformCase,type PlatformOverview,type PlatformHealth,type PlatformAlert } from '../../shared/platform.js';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import { digest } from '../content.js';
import { requireCondition } from '../errors.js';
import type { CustomerSupport,UnassignedSupportEmail } from '../customer-support/index.js';
import type { RetentionPlan } from '../customer-retention/hosted-types.js';
import { retentionDigest,signRetentionApproval } from '../customer-retention/approval.js';
import type { PlatformStore } from './store.js';
import type { OperatorIdentity,OperatorSession } from './auth.js';
import type { SupportProvider } from '../customer-support/provider.js';
import type { CustomerOperationsStatus,CustomerWorkerHeartbeat } from '../../shared/customer-operations.js';

const stagingCriticalAlerts = new Set(['security_incident','migration_failed','deployment_failure_persistent','worker_failure_persistent']);

type Options={sendingSafeguards?:import('../customer-delivery/safeguards.js').SendingSafeguards;environment:Config['environment'];mode:'capture'|'live';identity:OperatorIdentity;support:CustomerSupport;databaseName:string;workerHeartbeat?:()=>Promise<CustomerWorkerHeartbeat>;plan?:(workspace:string,jobId:string)=>Promise<RetentionPlan>;signing?:{keyId:string;privateKey:string};gaps?:string[];alerts?:{provider:SupportProvider;from:string;to:string};now?:()=>Date};
export class PlatformService {
 constructor(readonly db:Database,readonly store:PlatformStore,readonly options:Options){}
 private now(){return this.options.now?.()??new Date();}
 private async current(actor:OperatorSession){requireCondition(actor.exercise===(this.options.mode==='capture')&&await this.options.identity.current(actor),403,'operator_authority_expired','Verify current operator authority again.');}
 private workspace(actor:OperatorSession,target:string){requireCondition(!actor.exercise||actor.workspaceId===target,403,'exercise_workspace_only','The operator exercise is limited to your current workspace.');}
 async case(actor:OperatorSession,id:string){await this.current(actor);const value=(await this.store.read<PlatformCase>('case',actor.exercise?actor.workspaceId:undefined,id))[0];requireCondition(value&&value.actorId===actor.userId&&value.sessionId===actor.sessionId&&(value.authentication??'required')===(actor.authentication??'required')&&Date.parse(value.expiresAt)>this.now().getTime(),403,'operator_case_required','Open a current case for this exact target.');this.workspace(actor,value.workspaceId);return value;}
 async supportAuthorized(user:string,workspace:string,reference:string){
  try{const action=(await this.store.read<{caseId:string;userId:string}>('ack',this.options.mode==='capture'?workspace:undefined,reference))[0];if(!action||action.userId!==user)return false;
   const row=(await this.store.read<PlatformCase>('case',this.options.mode==='capture'?workspace:undefined,action.caseId))[0];
   if(!row||row.kind!=='support'||row.workspaceId!==workspace||row.actorId!==user||Date.parse(row.expiresAt)<=this.now().getTime())return false;
   return this.options.identity.current({userId:user,sessionId:row.sessionId,verifiedAt:row.verifiedAt,authentication:row.authentication,exercise:this.options.mode==='capture',workspaceId:this.options.mode==='capture'?workspace:undefined});
  }catch{return false;}
 }
 private async heartbeat():Promise<CustomerWorkerHeartbeat|null>{
  // Only the trusted database reader can establish current daemon activity. A failed
  // read must not reuse a formerly fresh snapshot or a configured dedicated flag.
  try{return await this.options.workerHeartbeat?.()??null;}catch{return null;}
 }
 async overview(actor:OperatorSession):Promise<PlatformOverview>{await this.current(actor);const workspace=actor.exercise?actor.workspaceId:undefined;
  const heartbeat=await this.heartbeat(),health=(await this.store.read<PlatformHealth>('health',workspace)).map(h=>({...h,heartbeat}));
  return {mode:this.options.mode,authority:actor.exercise?'owner-exercise':'platform-operator',authentication:actor.exercise?'workspace-exercise':this.options.identity.mfaPolicy??'required',workspaceId:actor.exercise?actor.workspaceId??null:null,gaps:this.options.gaps??[],supportMode:this.options.support.options.mode,writerConfigured:!!this.options.support.options.writer,health,alerts:await this.store.read('alert',workspace),cases:await this.store.read('case',workspace),sendingEnabled:false,erasureEnabled:false};}
 async observe(workspace:string,status:CustomerOperationsStatus){
  const health:PlatformHealth={workspaceId:workspace,observedAt:this.now().toISOString(),lastPass:status.worker.lastPass,failure:status.worker.lastFailure,pending:Object.entries(status.queue).filter(([key])=>key!=='unknown').reduce((n,[,v])=>n+(v??0),0),unknown:status.queue.unknown};
  await this.store.transaction(workspace,async records=>{
   const previous=this.options.environment==='staging' && health.failure
    ? await records.get<PlatformHealth & {failureSince?:string}>('health','current') : null;
   const failureSince=health.failure ? previous?.failureSince??health.observedAt : null;
   const persistentFailure=this.options.environment==='staging' && failureSince!==null &&
    Date.parse(health.observedAt)-Date.parse(failureSince)>=15*60000;
   await records.put('health','current',{...health,failureSince});
   for(const [code,active] of [['worker_failure_persistent',persistentFailure],['provider_outcome_unknown',health.unknown>0],['worker_failed',!!health.failure],['queue_without_continuous_worker',health.pending>0&&!status.worker.dedicated]] as const){
    const old=await records.get<PlatformAlert>('alert',code);
    if(!active&&!old)continue;
    const next:PlatformAlert={id:old?.id??randomUUID(),workspaceId:workspace,code,active,acknowledgedAt:old?.active===active?old.acknowledgedAt:null,createdAt:old?.createdAt??this.now().toISOString(),updatedAt:this.now().toISOString()};
    await records.put('alert',code,next);
    if(active&&(!old||!old.active)){const id=randomUUID();await records.put('notification',id,{id,code,workspaceId:workspace,state:'queued',providerId:null,createdAt:this.now().toISOString()},true);}
   }
  });
  await this.notifications(workspace);
 }
 async notifications(workspace:string){
  type Notice={id:string;code:string;workspaceId:string;state:string;providerId:string|null;createdAt:string};
  const items=await this.store.pendingNotifications<Notice>(workspace);
  for(const item of items){
   if(!['queued','submitting','unknown'].includes(item.state))continue;
   const transport=this.options.alerts;
   const claim=await this.store.transaction(workspace,async r=>{
    const current=await r.get<Notice>('notification',item.id);
    if(!current||!['queued','submitting','unknown'].includes(current.state))return null;
    const submit=current.state==='queued';
    if(submit){
     const suppressed=this.options.environment==='staging'&&!stagingCriticalAlerts.has(current.code);
     if(!transport||suppressed||this.options.mode==='capture'){
      await r.put('notification',item.id,{...current,state:'captured'});
      return null;
     }
     await r.put('notification',item.id,{...current,state:'submitting'});
    }
    return {notice:current,submit};
   });
   if(!claim||!transport||this.options.mode==='capture')continue;
   // An already-submitting request is reconciled read-only; its transport is never retried blindly.
   const outcome=claim.submit?await transport.provider.submit({operationKey:item.id,workspaceId:workspace,to:transport.to,from:transport.from,subject:'Flockletter platform review required',text:'A platform condition requires review: '+item.code+'. Open the authenticated control room. No customer content is included.'}):await transport.provider.lookup(item.id,claim.notice.providerId);
   await this.store.transaction(workspace,async r=>{const current=await r.get<Notice>('notification',item.id);if(current&&['submitting','unknown'].includes(current.state))await r.put('notification',item.id,{...current,state:outcome.state,lastChecked:this.now().toISOString(),providerId:outcome.state==='accepted'?outcome.id:current.providerId});});
  }
 }
 async monitor(){
  if(this.options.mode!=='live')return;
  await this.store.cleanup();
  const heartbeat=await this.heartbeat();
  const health=await this.store.read<PlatformHealth>('health');
  for(const h of health){
   const stale=h.pending>0&&(!h.lastPass||this.now().getTime()-Date.parse(h.lastPass)>5*60000);
   await this.store.transaction(h.workspaceId,async r=>{
    for(const [code,active] of [['worker_stale',stale],['worker_liveness_unverified',heartbeat?.state!=='fresh']] as const){
     const old=await r.get<PlatformAlert>('alert',code);if(!old&&!active)continue;
     const next:PlatformAlert={id:old?.id??randomUUID(),workspaceId:h.workspaceId,code,active,acknowledgedAt:old?.active===active?old.acknowledgedAt:null,createdAt:old?.createdAt??this.now().toISOString(),updatedAt:this.now().toISOString()};
     await r.put('alert',code,next);
     if(active&&!old?.active){const id=randomUUID();await r.put('notification',id,{id,code,workspaceId:h.workspaceId,state:'queued',providerId:null,createdAt:this.now().toISOString()},true);}
    }
   });
   await this.notifications(h.workspaceId);
  }
 }
 async unassigned(email:UnassignedSupportEmail){
  requireCondition(this.options.mode==='live',503,'platform_inbox_not_enabled','Unassigned email intake requires the private platform store.');
  // This quarantine never maps From to a customer account and never triggers a reply.
  return this.store.transaction('_platform_inbox',async records=>{const old=await records.get<{id:string;digest:string}>('inbound',email.providerEmailId);if(old){requireCondition(old.digest===email.digest,409,'inbound_conflict','This email identifier has different verified content.');return {id:old.id};}requireCondition(await records.count('inbound')<1000,503,'platform_inbox_capacity','The unassigned inbox needs operator review before accepting more mail.');const id=randomUUID();await records.put('inbound',email.providerEmailId,{...email,id,state:'quarantined',receivedAt:this.now().toISOString()},true);return {id};});
 }
 async execute(name:PlatformCommand,raw:unknown,actor:OperatorSession):Promise<unknown>{
  await this.current(actor);
  const input=platformCommands[name].schema.parse(raw);
  if(name==='platform.overview')return this.overview(actor);
  if(name==='platform.openCase'){
   const p=platformCommands[name].schema.parse(input);this.workspace(actor,p.workspaceId);
   await this.db.tenant(p.workspaceId,async sql=>{
    requireCondition(!!(await sql.query('SELECT FROM workspaces')).rowCount,404,'workspace_unavailable','The case target is unavailable.');
    if(p.kind==='support'&&p.resourceId)requireCondition(!!(await sql.query('SELECT FROM customer_support_tickets WHERE id=$1',[p.resourceId])).rowCount,404,'resource_unavailable','The support target is unavailable.');
    if(p.kind==='retention')requireCondition(p.resourceId&&!!(await sql.query('SELECT FROM customer_retention_jobs WHERE id=$1',[p.resourceId])).rowCount,404,'resource_unavailable','Select the exact retention job.');
    if(p.kind==='delivery')requireCondition(p.resourceId&&!!(await sql.query('SELECT FROM customer_deliveries WHERE id=$1',[p.resourceId])).rowCount,404,'resource_unavailable','Select the exact delivery.');
   });
   const requestHash=digest(JSON.stringify([p,actor.userId,actor.sessionId,actor.authentication??'required']));
   return this.store.transaction(p.workspaceId,async records=>{await this.current(actor);const old=await records.get<PlatformCase>('case',p.operationKey);if(old){requireCondition(old.requestHash===requestHash,409,'operation_conflict','Retry the original case with this key.');return old;}const createdAt=this.now().toISOString(),value:PlatformCase={id:p.operationKey,workspaceId:p.workspaceId,kind:p.kind,resourceId:p.resourceId,reason:p.reason,actorId:actor.userId,sessionId:actor.sessionId,verifiedAt:actor.verifiedAt,authentication:actor.authentication,createdAt,expiresAt:new Date(Math.min(this.now().getTime()+5*60000,actor.exercise?Infinity:Date.parse(actor.verifiedAt)+5*60000)).toISOString(),requestHash};await records.put('case',value.id,value,true);return value;});
  }
  if(name==='platform.inbox'){requireCondition(!actor.exercise,403,'operator_required','Unassigned customer email is never exposed to a workspace exercise.');return this.store.read('inbound','_platform_inbox');}
  if(name==='platform.alertAck'){
   const p=platformCommands[name].schema.parse(input),alerts=await this.store.read<PlatformAlert>('alert',actor.exercise?actor.workspaceId:undefined);const alert=alerts.find(a=>a.id===p.alertId);requireCondition(alert,404,'alert_unavailable','This alert is unavailable.');this.workspace(actor,alert.workspaceId);
   return this.store.transaction(alert.workspaceId,async records=>{await this.current(actor);const requestHash=digest(JSON.stringify([p,actor.userId]));const prior=await records.get<{requestHash:string;result:unknown}>('ack',p.operationKey);if(prior){requireCondition(prior.requestHash===requestHash,409,'operation_conflict','Retry the original acknowledgement.');return prior.result;}const current=await records.get<PlatformAlert>('alert',alert.code);requireCondition(current?.id===alert.id,409,'alert_changed','Reload the alert.');const result={...current,acknowledgedAt:this.now().toISOString()};await records.put('alert',alert.code,result);await records.put('ack',p.operationKey,{requestHash,result,operatorId:actor.userId,reason:p.reason},true);return result;});
  }
  const p=input as {caseId:string};const review=await this.case(actor,p.caseId);
  if(name==='platform.case')return review;
  if(name==='platform.sendingTrust'||name==='platform.reviewSendingTrust'){
   requireCondition(['abuse','delivery'].includes(review.kind),403,'case_scope_mismatch','Open a delivery or abuse review case.');
   requireCondition(this.options.sendingSafeguards,503,'sending_policy_unconfigured','Configure the sending safeguards.');
   const status=await this.db.read(review.workspaceId,sql=>this.options.sendingSafeguards!.status(sql,review.workspaceId));
   if(name==='platform.sendingTrust')return status;
   const p=platformCommands['platform.reviewSendingTrust'].schema.parse(input);
   requireCondition(status.revision===p.expectedRevision,409,'sending_review_changed','Refresh the exact current incident before review.');
   requireCondition(!status.held||p.phase==='limited',409,'limited_restart_required','An incident can restart only at the limited daily allowance.');
   requireCondition(p.phase==='limited'||p.phase==='established'&&status.ageDays>=7&&status.delivered>=100||p.phase==='full'&&status.ageDays>=14&&status.delivered>=500,409,'sending_trust_not_earned','This workspace has not yet met the age and verified-delivery requirements.');
   return this.store.transaction(review.workspaceId,async records=>{
    await this.current(actor);requireCondition((await records.get<PlatformCase>('case',review.id))?.requestHash===review.requestHash&&Date.parse(review.expiresAt)>this.now().getTime(),403,'operator_case_required','Reopen the exact case.');
    const hash=digest(JSON.stringify([p,actor.userId]));const old=await records.get<{hash:string;result:unknown}>('ack',p.operationKey);
    if(old){requireCondition(old.hash===hash,409,'operation_conflict','Retry the original sending-trust review.');return old.result;}
    const result={phase:p.phase,resume:true,incidentRevision:status.revision,operatorId:actor.userId,caseId:review.id,reason:p.reason,reviewedAt:this.now().toISOString()};
    await records.put('approval','sending-trust',result);await records.put('ack',p.operationKey,{hash,result},true);return result;
   });
  }
  if(name==='platform.abuseHold'){
   const p=platformCommands[name].schema.parse(input);requireCondition(review.kind==='abuse',403,'case_scope_mismatch','Open a workspace abuse review case.');
   return this.store.transaction(review.workspaceId,async records=>{await this.current(actor);requireCondition((await records.get<PlatformCase>('case',review.id))?.requestHash===review.requestHash&&Date.parse(review.expiresAt)>this.now().getTime(),403,'operator_case_required','Reopen the current exact case.');const hash=digest(JSON.stringify([p,actor.userId]));const old=await records.get<{hash:string;result:unknown}>('ack',p.operationKey);if(old){requireCondition(old.hash===hash,409,'operation_conflict','Retry the original review hold.');return old.result;}const result={held:p.held,reason:p.reason,operatorId:actor.userId,caseId:review.id,changedAt:this.now().toISOString()};await records.put('hold','current',result);await records.put('ack',p.operationKey,{hash,result},true);return result;});
  }
  if(name==='platform.support'){
   const p=platformCommands[name].schema.parse(input);requireCondition(review.kind==='support',403,'case_scope_mismatch','Open a support case.');
   const policy=p.command.startsWith('support.policy')||p.command==='support.publishPolicy';
   requireCondition(policy?!review.resourceId:!!review.resourceId,403,'case_scope_mismatch','Open a case for this exact support resource.');
   requireCondition(!('workspaceId' in p.input)&&!('actorId' in p.input)&&(!('id' in p.input)||p.input.id===review.resourceId),403,'case_scope_mismatch','The case locks the workspace and conversation.');
   const operationKey=typeof p.input.operationKey==='string'?p.input.operationKey:randomUUID();
   requireCondition(/^[a-f0-9-]{36}$/i.test(operationKey),422,'operation_key_required','Use a stable UUID for support mutations.');
   const reference='support:'+operationKey,requestHash=digest(JSON.stringify([p.command,p.input,review.id,actor.userId]));
   const authorization=await this.store.transaction(review.workspaceId,async records=>{
    await this.current(actor);requireCondition((await records.get<PlatformCase>('case',review.id))?.requestHash===review.requestHash&&Date.parse(review.expiresAt)>this.now().getTime(),403,'operator_case_required','Reopen the current exact case.');const old=await records.get<{requestHash:string;result?:unknown}>('ack',reference);
    if(old){requireCondition(old.requestHash===requestHash,409,'operation_conflict','Retry the original exact support action.');return old;}
    if(p.command==='support.publishPolicy'){
     const previews=await records.find<{caseId:string;command:string;result?:{id?:string;reviewCode?:string}}>('ack');
     requireCondition(previews.some(a=>a.caseId===review.id&&a.command==='support.policyPreview'&&a.result?.id===p.input.previewId&&a.result?.reviewCode===p.input.reviewCode),403,'policy_review_case_mismatch','Review this exact policy preview in the same case before publishing.');
    }
    const value={caseId:review.id,userId:actor.userId,command:p.command,requestHash};await records.put('ack',reference,value,true);return value as {requestHash:string;result?:unknown};
   });
   if(authorization.result!==undefined)return authorization.result;
   const result=await this.options.support.executeForOperator(p.command,{...p.input,...(!policy?{id:review.resourceId}:{})},{workspaceId:review.workspaceId,userId:actor.userId,actorId:'platform:'+review.id,reason:review.reason,reference,check:async()=>{await this.case(actor,review.id);return this.supportAuthorized(actor.userId,review.workspaceId,reference);}});
   await this.store.transaction(review.workspaceId,async records=>{const action=await records.get<Record<string,unknown>>('ack',reference);requireCondition(action,409,'support_authorization_changed','The support authorization changed.');await records.put('ack',reference,{...action,result});});
   return result;
  }
  requireCondition(review.kind==='retention'&&review.resourceId,403,'case_scope_mismatch','Open an exact retention job case.');
  if(name==='platform.retentionApprove')requireCondition(this.options.identity.mfaPolicy!=='pre-revenue',403,'operator_mfa_required','Restore administrator MFA before signing hosted erasure approvals.');
  requireCondition(this.options.plan,503,'retention_evidence_required','Configure protected checkpoints, external inventory and private operator review before signing hosted erasure.');
  const plan=await this.options.plan(review.workspaceId,review.resourceId),planDigest=retentionDigest(plan);
  if(name==='platform.retentionPlan')return {plan,digest:planDigest,executable:false};
  const approve=platformCommands['platform.retentionApprove'].schema.parse(input);
  requireCondition(!actor.exercise&&this.options.signing&&planDigest===approve.expectedDigest,409,'retention_plan_changed','Review the exact current plan with a configured live signing authority.');
  await this.current(actor);
  return this.store.transaction(review.workspaceId,async records=>{
   await this.current(actor);requireCondition((await records.get<PlatformCase>('case',review.id))?.requestHash===review.requestHash&&Date.parse(review.expiresAt)>this.now().getTime(),403,'operator_case_required','Reopen the current exact case.');
   const previous=await records.get<{digest:string;artifact:unknown}>('approval',approve.operationKey);
   if(previous){requireCondition(previous.digest===digest(JSON.stringify([approve,actor.userId])),409,'operation_conflict','Retry the original approval.');return previous.artifact;}
   const artifact=signRetentionApproval({...plan,version:1,mode:'live',nonce:randomUUID(),operatorId:actor.userId,issuedAt:this.now().toISOString(),expiresAt:new Date(Math.min(Date.parse(review.expiresAt),this.now().getTime()+5*60000)).toISOString()},this.options.signing!.privateKey,this.options.signing!.keyId);
   await records.put('approval',approve.operationKey,{digest:digest(JSON.stringify([approve,actor.userId])),artifact,operatorCase:review.id},true);return artifact;
  });
 }
 async close(){await this.store.close();}
}
