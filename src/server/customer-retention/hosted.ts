import pg from 'pg';
import tables from '../../shared/runtime-tables.json' with {type:'json'};
import type {ServiceEnd} from '../../shared/customer-retention.js';
import {reviewDate} from '../retention.js';
import {retentionManifestDigest} from './index.js';
import {requireRetention,retentionDigest,sameRetentionScope,verifyExternalInventory,type RetentionPublicKeys} from './approval.js';
import {isProtectedCheckpoint} from './protected-store.js';
import type {RetentionScope,RetentionPlan,VerifiedCheckpoint,VerifiedExternalInventory,RetentionException} from './hosted-types.js';

const inventories=new WeakSet<object>();
export function verifiedExternalInventory(raw:unknown,keys:RetentionPublicKeys,scope:RetentionScope,mode:'live'|'capture',now=new Date()):VerifiedExternalInventory {
 const document=verifyExternalInventory(raw,keys),facts=document.payload;
 requireRetention(sameRetentionScope(facts.scope,scope)&&facts.mode===mode,'external_scope_mismatch');
 requireRetention(Date.parse(facts.createdAt)<=now.getTime()+30000&&Date.parse(facts.createdAt)>=now.getTime()-300000,'external_inventory_stale');
 requireRetention(new Set(facts.copies.map(c=>c.id)).size===facts.copies.length&&new Set(facts.copies.map(c=>c.store+'\0'+c.key+'\0'+c.versionId)).size===facts.copies.length,'external_inventory_duplicate');
 for(const exception of facts.exceptions)requireRetention(exception.policyMode==='lifetime'?exception.retainUntil===null:exception.retainUntil!==null&&Date.parse(exception.retainUntil)>now.getTime(),'exception_policy_invalid');
 const result={facts,digest:retentionDigest(document),verifiedAt:now.toISOString()};inventories.add(result);return result;
}
export function isVerifiedExternalInventory(value:VerifiedExternalInventory){return inventories.has(value);}
export async function retentionInventoryDigest(db:pg.Client,workspace:string) {
 const brands=(await db.query<{id:string}>('SELECT id FROM brands WHERE workspace_id=$1 ORDER BY id',[workspace])).rows;
 const counts:Record<string,number>={};
 for(const table of [...tables].sort((a,b)=>a.name.localeCompare(b.name))){
  const name=pg.escapeIdentifier(table.name);let count=0;
  if(table.scope==='brand')for(const brand of brands){await db.query("SELECT set_config('app.intake_brand_id',$1,true)",[brand.id]);count+=Number((await db.query('SELECT count(*) n FROM public.'+name+' WHERE workspace_id=$1 AND brand_id=$2',[workspace,brand.id])).rows[0].n);}
  else count=Number((await db.query('SELECT count(*) n FROM public.'+name+' WHERE workspace_id=$1',[workspace])).rows[0].n);
  requireRetention(Number.isSafeInteger(count),'inventory_count_invalid');counts[table.name]=count;
 }
 for(const name of ['scopes','support_reply_routes','confirmation_routes'])if((await db.query('SELECT to_regclass($1) present',['flockletter_customer_jobs.'+name])).rows[0]?.present)counts['private.'+name]=Number((await db.query('SELECT count(*) n FROM flockletter_customer_jobs.'+pg.escapeIdentifier(name)+' WHERE workspace_id=$1',[workspace])).rows[0].n);
 if((await db.query("SELECT to_regclass('flockletter_retention_control.platform_records') present")).rows[0]?.present)counts['private.platform_records']=Number((await db.query("SELECT count(*) n FROM flockletter_retention_control.platform_records WHERE workspace_id=$1 AND kind<>'approval'",[workspace])).rows[0].n);
 return retentionDigest(counts);
}
export async function privateRetentionExceptions(db:pg.Client,workspace:string):Promise<RetentionException[]> {
 const mappings=(await db.query<{registry_namespace:string|null;registry_workspace_digest:string|null}>('SELECT DISTINCT registry_namespace,registry_workspace_digest FROM customer_trial_setups WHERE workspace_id=$1',[workspace])).rows;
 const exceptions:RetentionException[]=[];
 for(const mapping of mappings){if(!mapping.registry_namespace&&!mapping.registry_workspace_digest)continue;requireRetention(mapping.registry_namespace&&mapping.registry_workspace_digest,'private_inventory_mapping_incomplete');
  const raw=(await db.query('SELECT flockletter_customer_jobs.trial_retention_inventory($1,$2) inventory',[mapping.registry_namespace,mapping.registry_workspace_digest])).rows[0]?.inventory;
  requireRetention(raw&&Number.isSafeInteger(raw.recordCount)&&raw.recordCount>=0,'private_inventory_invalid');
  if(raw.recordCount)exceptions.push({store:'trial_registry',policyId:raw.policyId,policyVersion:raw.policyVersion,policyMode:raw.policyMode,retainUntil:raw.retainUntil,recordCount:raw.recordCount,digest:raw.digest});
 }
 return exceptions.sort((a,b)=>a.digest.localeCompare(b.digest));
}
export type HostedPlanOptions={databaseName:string;serviceEnd:(sql:pg.Client,workspace:string)=>Promise<ServiceEnd>;now?:()=>Date};
export async function planHostedRetention(db:pg.Client,options:HostedPlanOptions,target:{workspaceId:string;jobId:string},evidence:{checkpoint:VerifiedCheckpoint;inventory:VerifiedExternalInventory}):Promise<RetentionPlan> {
 const now=options.now?.()??new Date();requireRetention(isProtectedCheckpoint(evidence.checkpoint)&&isVerifiedExternalInventory(evidence.inventory),'unverified_operator_evidence');
 await db.query('BEGIN');try {
  requireRetention((await db.query('SELECT current_database() name')).rows[0]?.name===options.databaseName,'database_mismatch');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[target.workspaceId]);await db.query("SELECT set_config('app.workspace_id',$1,true)",[target.workspaceId]);
  const fact=await options.serviceEnd(db,target.workspaceId);
  requireRetention((evidence.inventory.facts.mode==='live'?fact.source==='stripe':fact.source!=='complimentary')&&fact.effectiveEnd&&['canceled','cancelled','closed'].includes(fact.status)&&reviewDate(new Date(fact.effectiveEnd))<=now,'service_end_ineligible');
  const request=(await db.query(`SELECT j.case_id,j.manifest_digest,j.state,c.version,c.state case_state,c.source_version,c.hold_reason FROM customer_retention_jobs j JOIN customer_retention_cases c ON (c.workspace_id,c.id)=(j.workspace_id,j.case_id) WHERE j.workspace_id=$1 AND j.id=$2`,[target.workspaceId,target.jobId])).rows[0];
  requireRetention(request&&request.state==='awaiting_operator'&&request.case_state==='awaiting_operator'&&!request.hold_reason&&request.source_version===fact.version&&request.manifest_digest===retentionManifestDigest(),'request_changed');
  const scope={databaseName:options.databaseName,workspaceId:target.workspaceId,jobId:target.jobId,sourceVersion:fact.version,manifestDigest:retentionManifestDigest()};
  const checkpoint=evidence.checkpoint,inventory=evidence.inventory;
  requireRetention(sameRetentionScope(checkpoint.facts.scope,scope)&&sameRetentionScope(inventory.facts.scope,scope)&&checkpoint.facts.mode===inventory.facts.mode&&checkpoint.facts.phase==='quarantined','checkpoint_scope_mismatch');
  requireRetention(now.getTime()-Date.parse(checkpoint.verifiedAt)<30000&&now.getTime()-Date.parse(inventory.verifiedAt)<30000,'operator_evidence_stale');
  const exceptions=await privateRetentionExceptions(db,target.workspaceId);
  requireRetention(retentionDigest(exceptions)===retentionDigest([...inventory.facts.exceptions].sort((a,b)=>a.digest.localeCompare(b.digest))),'private_exception_review_required');
  const plan={...scope,caseId:request.case_id,caseVersion:request.version,inventoryDigest:await retentionInventoryDigest(db,target.workspaceId),checkpoint:checkpoint.reference,externalInventoryDigest:inventory.digest,exceptionDigest:retentionDigest(exceptions)};
  await db.query('COMMIT');return plan;
 }catch(error){await db.query('ROLLBACK');throw error;}
}
