import pg from 'pg';
import {requireRetention,retentionDigest} from './approval.js';
import {ProtectedCheckpointStore} from './protected-store.js';
import type {RetentionScope} from './hosted-types.js';
/** Reapply current protected facts to a stale snapshot while it is OFFLINE.
 * This returns a quarantine decision, never authority to restart delivery. */
export async function reconcileRestoredWorkspace(db:pg.Client,store:ProtectedCheckpointStore,scope:RetentionScope,expectedRole:string){
 const role=(await db.query('SELECT current_database() db,current_user name,r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user')).rows[0];
 requireRetention(/^flockletter_[a-z0-9_]+$/.test(expectedRole)&&role?.name===expectedRole&&role.db===scope.databaseName&&!role.rolsuper&&!role.rolbypassrls,'restore_identity_invalid');
 const checkpoint=await store.load(scope);requireRetention(checkpoint.facts.mode==='live','restore_checkpoint_mode_invalid');
 await db.query('BEGIN');try{
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[scope.workspaceId]);await db.query("SELECT set_config('app.workspace_id',$1,true)",[scope.workspaceId]);
  // Compare latest protected version a second time after obtaining the restore lock.
  await store.load(scope,checkpoint.reference);
  for(const suppression of checkpoint.facts.suppressions){await db.query("SELECT set_config('app.intake_brand_id',$1,true)",[suppression.brandId]);await db.query(`UPDATE subscribers SET state=$4,updated_at=now() WHERE workspace_id=$1 AND brand_id=$2 AND id=$3`,[scope.workspaceId,suppression.brandId,suppression.subscriberId,suppression.state]);}
  // Reconciliation alone cannot release a host, even when the protected document says released.
  const blocked=true;
  await db.query(`INSERT INTO flockletter_retention_control.restore_quarantines(workspace_id,checkpoint_digest,checkpoint_version,protected_phase,blocked) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id) DO UPDATE SET checkpoint_digest=excluded.checkpoint_digest,checkpoint_version=excluded.checkpoint_version,protected_phase=excluded.protected_phase,blocked=excluded.blocked,updated_at=now()`,[scope.workspaceId,checkpoint.reference.digest,checkpoint.reference.versionId,checkpoint.facts.phase,blocked]);
  await db.query('COMMIT');return {quarantined:true,requiresOperatorRelease:true,protectedPhase:checkpoint.facts.phase,checkpoint:checkpoint.reference,suppressionDigest:retentionDigest(checkpoint.facts.suppressions),applicationDataErased:false};
 }catch(error){await db.query('ROLLBACK');throw error;}
}
