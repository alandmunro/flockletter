import pg from 'pg';
import {requireRetention,retentionDigest,RetentionIntegrationError} from './approval.js';
import {ProtectedCheckpointStore} from './protected-store.js';
import type {CheckpointFacts,ProtectedCheckpointRef,SignedDocument} from './hosted-types.js';
/** The caller derives facts and signs them in a separate MFA-bound authority.
 * This executor cannot mint signatures. Lost Put responses are inspected, not resent. */
export async function publishProtectedCheckpoint(db:pg.Client,store:ProtectedCheckpointStore,document:SignedDocument<CheckpointFacts>,previous:ProtectedCheckpointRef|null){
 const payload=document.payload,targetDigest=retentionDigest(document),operationKey=retentionDigest({purpose:'checkpoint',scope:payload.scope,sequence:payload.sequence});
 await db.query(`INSERT INTO flockletter_retention_control.operations(operation_key,workspace_id,job_id,approval_digest,target_digest,target,state) VALUES($1,$2,$3,$4,$4,$5,'pending') ON CONFLICT(operation_key) DO NOTHING`,[operationKey,payload.scope.workspaceId,payload.scope.jobId,targetDigest,{document,previous}]);
 await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[payload.scope.workspaceId]);
 await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[operationKey]);try{
  const row=(await db.query('SELECT * FROM flockletter_retention_control.operations WHERE operation_key=$1',[operationKey])).rows[0];requireRetention(row?.target_digest===targetDigest,'checkpoint_intent_conflict');
  if(row.state!=='pending'){
   const current=await store.load(payload.scope);requireRetention(current.reference.digest===targetDigest&&current.reference.sequence===payload.sequence,'checkpoint_reconciliation_required');await db.query("UPDATE flockletter_retention_control.operations SET state='complete',target='{}'::jsonb,result_digest=$2,updated_at=now() WHERE operation_key=$1",[operationKey,retentionDigest(current.reference)]);return current;
  }
  await db.query("UPDATE flockletter_retention_control.operations SET state='submitting',updated_at=now() WHERE operation_key=$1",[operationKey]);
  try{const current=await store.publish(document,previous);await db.query("UPDATE flockletter_retention_control.operations SET state='complete',target='{}'::jsonb,result_digest=$2,updated_at=now() WHERE operation_key=$1",[operationKey,retentionDigest(current.reference)]);return current;}
  catch{await db.query("UPDATE flockletter_retention_control.operations SET state='unknown',updated_at=now() WHERE operation_key=$1",[operationKey]);throw new RetentionIntegrationError('checkpoint_reconciliation_required');}
 }finally{await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[operationKey]);await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[payload.scope.workspaceId]);}
}
