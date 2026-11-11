import {createHash} from 'node:crypto';
import {z} from 'zod';
import {Database} from '../src/server/db.js';
import {accessChange,accessGuard,inspectAccess,recordAccess} from './complimentary-access.js';
import {parseReleaseConnection,validReleaseHost} from './release-input.mjs';

/** An owner-private, independently reviewed target. It contains no credential. */
export const complimentaryReleaseInput=z.object({
  version:z.literal(1),environment:z.enum(['staging','production']),
  expectedHost:z.string().refine(validReleaseHost),expectedPort:z.number().int().min(1).max(65535),
  expectedCommit:z.string().regex(/^[a-f0-9]{40}$/),
  confirmApply:z.boolean(),change:accessChange,
  guard:accessGuard.extend({requireNoBillingHistory:z.literal(true)}).strict(),
}).strict();

export function complimentaryReleaseConfiguration(raw:unknown,env:NodeJS.ProcessEnv,mode:string){
  const input=complimentaryReleaseInput.parse(raw);
  if(!['inspect','apply'].includes(mode)||env.APP_ENV!==input.environment||
    env.RENDER_GIT_COMMIT!==input.expectedCommit||(mode==='apply'&&!input.confirmApply))
    throw Error('complimentary_release_scope_invalid');
  const url=parseReleaseConnection(env.MIGRATION_DATABASE_URL);
  const database='flockletter_'+input.environment,role=database+'_migrator';
  if(!url||url.hostname!==input.expectedHost||Number(url.port||5432)!==input.expectedPort||
    url.pathname!=='/'+database||url.username!==role)
    throw Error('complimentary_release_connection_invalid');
  return {input,url,database,role,marker:'Flockletter '+input.environment+' foundation'};
}

/** Read only before an exact apply. This process alone receives the migration credential. */
export async function runComplimentaryRelease(raw:unknown,env:NodeJS.ProcessEnv,mode:string){
  const target=complimentaryReleaseConfiguration(raw,env,mode);
  const {input,database,role,marker}=target;
  const db=new Database(target.url.href,1);
  try{
    const identity=(await db.pool.query<{database:string;role:string;database_marker:string;role_marker:string;unsafe:boolean}>(`
      SELECT current_database() AS database,current_user AS role,
        shobj_description(d.oid,'pg_database') AS database_marker,
        shobj_description(r.oid,'pg_authid') AS role_marker,
        r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit OR
          EXISTS(SELECT FROM pg_auth_members m WHERE m.member=r.oid) AS unsafe
      FROM pg_database d,pg_roles r WHERE d.datname=current_database() AND r.rolname=current_user`)).rows[0];
    if(!identity||identity.database!==database||identity.role!==role||identity.database_marker!==marker||
      identity.role_marker!==marker||identity.unsafe)throw Error('complimentary_release_identity_invalid');
    const workspace=input.change.workspaceId;
    const before=await inspectAccess(db,workspace,input.change,input.guard);
    const receipt=mode==='apply'?await recordAccess(db,workspace,input.change,input.guard):null;
    // A separate read describes current access even when an old operation is replayed.
    const current=await inspectAccess(db,workspace,input.change,input.guard);
    const effective=receipt?(await db.read(workspace,async sql=>(await sql.query<{recorded_at:Date}>(
      'SELECT recorded_at FROM workspace_access_events WHERE workspace_id=$1 AND operation_key=$2',[workspace,input.change.operationKey])).rows[0]?.recorded_at.toISOString()??null)):null;
    return {ok:true,mode,workspaceFingerprint:createHash('sha256').update(workspace).digest('hex'),
      replayed:before.replayed,receipt:receipt?{...receipt,effectiveAt:effective}:null,
      currentRevision:current.currentRevision,currentPlan:current.currentPlan,
      requestedPlan:input.change.plan};
  }finally{await db.close();}
}
