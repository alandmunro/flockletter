import pg from 'pg';
import {canonicalRetention,requireRetention,retentionDigest,retentionScope,sameRetentionScope,verifyRetentionApproval,type RetentionPublicKeys} from './approval.js';
import {planHostedRetention,privateRetentionExceptions,retentionInventoryDigest,verifiedExternalInventory,type HostedPlanOptions} from './hosted.js';
import {ProtectedCheckpointStore} from './protected-store.js';
import {disposeExternalCopies,S3ExternalCopyStore} from './external-store.js';
import {verifyEngineDisposalReceipts} from './engine-evidence.js';
import {authorizeRetention,executeAuthorizedRetention} from './executor.js';
import {verifyRetentionIdentity} from './identity.js';
import type {RetentionApprovalPayload,RetentionPlan} from './hosted-types.js';

export type HostedOperatorOptions=HostedPlanOptions&{executorRole:string;enabled:boolean;approvalKeys:RetentionPublicKeys;inventoryKeys:RetentionPublicKeys;engineKeys:RetentionPublicKeys;expectedEngineInstances:readonly string[];checkpointStore:ProtectedCheckpointStore;stores:Readonly<Record<string,S3ExternalCopyStore>>};
function planFields(value:RetentionPlan):RetentionPlan{return {...retentionScope(value),caseId:value.caseId,caseVersion:value.caseVersion,inventoryDigest:value.inventoryDigest,checkpoint:value.checkpoint,externalInventoryDigest:value.externalInventoryDigest,exceptionDigest:value.exceptionDigest};}
export async function persistHostedApproval(db:pg.Client,approval:RetentionApprovalPayload,approvalDigest:string,now:Date){
 await db.query('BEGIN');try{
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[approval.workspaceId]);
  requireRetention(!(await db.query('SELECT 1 FROM flockletter_retention_control.approval_history WHERE nonce=$1',[approval.nonce])).rowCount,'approval_nonce_superseded');
  const previous=(await db.query('SELECT * FROM flockletter_retention_control.approvals WHERE workspace_id=$1 AND job_id=$2 FOR UPDATE',[approval.workspaceId,approval.jobId])).rows[0];
  if(previous&&previous.approval_digest!==approvalDigest){
   requireRetention(previous.expires_at<=now&&canonicalRetention(planFields(previous.payload))===canonicalRetention(planFields(approval)),'approval_renewal_review_required');
   requireRetention(!(await db.query("SELECT 1 FROM flockletter_retention_control.operations WHERE workspace_id=$1 AND job_id=$2 AND state IN ('submitting','unknown','complete') LIMIT 1",[approval.workspaceId,approval.jobId])).rowCount,'approval_renewal_reconciliation_required');
   await db.query('INSERT INTO flockletter_retention_control.approval_history(nonce,workspace_id,job_id,approval_digest,payload,expires_at,superseded_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[previous.nonce,approval.workspaceId,approval.jobId,previous.approval_digest,previous.payload,previous.expires_at,approval.nonce]);
   await db.query('UPDATE flockletter_retention_control.approvals SET nonce=$3,approval_digest=$4,payload=$5,expires_at=$6 WHERE workspace_id=$1 AND job_id=$2',[approval.workspaceId,approval.jobId,approval.nonce,approvalDigest,approval,approval.expiresAt]);
   await db.query("UPDATE flockletter_retention_control.operations SET state='pending',approval_digest=$3,updated_at=now() WHERE workspace_id=$1 AND job_id=$2 AND state IN ('pending','blocked')",[approval.workspaceId,approval.jobId,approvalDigest]);
   await db.query('UPDATE flockletter_retention_control.authorizations SET authorized_by=$3,expires_at=$4 WHERE workspace_id=$1 AND job_id=$2 AND completed_at IS NULL AND expires_at<=$5',[approval.workspaceId,approval.jobId,approval.operatorId,approval.expiresAt,now]);
  }else if(!previous)await db.query('INSERT INTO flockletter_retention_control.approvals(nonce,workspace_id,job_id,approval_digest,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[approval.nonce,approval.workspaceId,approval.jobId,approvalDigest,approval,approval.expiresAt]);
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}
}
async function executeHostedRetentionLocked(db:pg.Client,options:HostedOperatorOptions,input:{approval:unknown;externalInventory:unknown;engineReceipts:unknown}){
 requireRetention(options.enabled,'hosted_erasure_disabled');
 await verifyRetentionIdentity(db,options.databaseName,options.executorRole,'executor');
 const now=()=>options.now?.()??new Date(),signed=verifyRetentionApproval(input.approval,options.approvalKeys,now(),'live'),approval=signed.payload,scope=retentionScope(approval),approvalDigest=retentionDigest(signed);
 const receipt=(await db.query('SELECT * FROM flockletter_retention_control.receipts WHERE workspace_id=$1 AND job_id=$2',[scope.workspaceId,scope.jobId])).rows[0];
 if(receipt){const recorded=(await db.query('SELECT approval_digest FROM flockletter_retention_control.approvals WHERE nonce=$1 AND workspace_id=$2 AND job_id=$3',[approval.nonce,scope.workspaceId,scope.jobId])).rows[0];requireRetention(recorded?.approval_digest===approvalDigest&&receipt.source_version===scope.sourceVersion&&receipt.manifest_digest===scope.manifestDigest&&receipt.checkpoint_digest===approval.checkpoint.digest,'receipt_scope_conflict');const protectedFact=await options.checkpointStore.load(scope);requireRetention(sameRetentionScope(protectedFact.facts.scope,scope)&&protectedFact.facts.mode==='live'&&protectedFact.facts.phase!=='released','receipt_checkpoint_changed');return {erased:true,replayed:true,at:receipt.erased_at.toISOString()};}
 const inventory=verifiedExternalInventory(input.externalInventory,options.inventoryKeys,scope,'live',now());
 requireRetention(Object.keys(options.stores).length>0&&inventory.facts.copies.every(copy=>Object.hasOwn(options.stores,copy.store)),'external_store_unconfigured');
 const checkpoint=()=>options.checkpointStore.load(scope,approval.checkpoint);
 const recheck=async()=>{verifyRetentionApproval(signed,options.approvalKeys,now(),'live');const evidence=await checkpoint();verifyEngineDisposalReceipts(input.engineReceipts,options.expectedEngineInstances,options.engineKeys,scope,approval.checkpoint,now());const current=await planHostedRetention(db,options,{workspaceId:scope.workspaceId,jobId:scope.jobId},{checkpoint:evidence,inventory});requireRetention(canonicalRetention(current)===canonicalRetention(planFields(approval)),'approved_plan_changed');};
 await recheck();
 await persistHostedApproval(db,approval,approvalDigest,now());
 for(const [name,store] of Object.entries(options.stores)){requireRetention(store.options.name===name&&sameRetentionScope(store.scope,scope),'external_store_scope_invalid');}
 for(const [name,store] of Object.entries(options.stores))await store.verifyRemaining(inventory.facts.copies.filter(copy=>copy.store===name));
 await disposeExternalCopies(db,approval,approvalDigest,inventory,options.stores,recheck);
 const verifyAbsent=async()=>{verifyEngineDisposalReceipts(input.engineReceipts,options.expectedEngineInstances,options.engineKeys,scope,approval.checkpoint,now());for(const [name,store] of Object.entries(options.stores)){requireRetention((await store.inventory()).length===0,'external_copy_remaining');for(const copy of inventory.facts.copies.filter(copy=>copy.store===name))requireRetention(await store.inspect(copy,AbortSignal.timeout(10000))==='absent','external_disposal_unverified');}return true;};
 const executor={...options,verifyCheckpoint:async()=>{const current=await checkpoint();return current.facts.phase==='quarantined'&&current.facts.mode==='live';},verifyExternalStores:verifyAbsent,verifyLockedPlan:async(sql:pg.Client,w:string,j:string)=>{
  verifyRetentionApproval(signed,options.approvalKeys,now(),'live');requireRetention(w===scope.workspaceId&&j===scope.jobId,'approval_target_changed');
  const requested=(await sql.query('SELECT j.case_id,c.version FROM customer_retention_jobs j JOIN customer_retention_cases c ON (c.workspace_id,c.id)=(j.workspace_id,j.case_id) WHERE j.workspace_id=$1 AND j.id=$2',[w,j])).rows[0];requireRetention(requested?.case_id===approval.caseId&&requested.version===approval.caseVersion,'approved_case_changed');
  requireRetention(await retentionInventoryDigest(sql,w)===approval.inventoryDigest&&retentionDigest(await privateRetentionExceptions(sql,w))===approval.exceptionDigest,'approved_inventory_changed');
 }};
 await authorizeRetention(db,executor,{...scope,checkpointDigest:approval.checkpoint.digest,authorizedBy:approval.operatorId,expiresAt:new Date(approval.expiresAt)});
 return executeAuthorizedRetention(db,executor,scope.workspaceId,scope.jobId);
}

export async function executeHostedRetention(db:pg.Client,options:HostedOperatorOptions,input:{approval:unknown;externalInventory:unknown;engineReceipts:unknown}){
 requireRetention(options.enabled,'hosted_erasure_disabled');await verifyRetentionIdentity(db,options.databaseName,options.executorRole,'executor');
 const approved=verifyRetentionApproval(input.approval,options.approvalKeys,options.now?.()??new Date(),'live');
 await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[approved.payload.workspaceId]);
 try{return await executeHostedRetentionLocked(db,options,input);}finally{await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[approved.payload.workspaceId]);}
}
