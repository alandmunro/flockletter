import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {startDatabase} from '../scripts/database-fixture.js';
import {persistHostedApproval} from '../src/server/customer-retention/operator.js';
import type {RetentionApprovalPayload} from '../src/server/customer-retention/hosted-types.js';
import {verifyRetentionIdentity} from '../src/server/customer-retention/identity.js';
let fixture:Awaited<ReturnType<typeof startDatabase>>,db:pg.Client,planner:string,executor:string;
beforeAll(async()=>{fixture=await startDatabase();db=new pg.Client({connectionString:fixture.adminUrl});await db.connect();planner='flockletter_plan_'+randomUUID().replaceAll('-','').slice(0,8);executor='flockletter_erase_'+randomUUID().replaceAll('-','').slice(0,8);for(const role of [planner,executor])await db.query('CREATE ROLE '+pg.escapeIdentifier(role)+' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS');const result=spawnSync(process.execPath,['--import','tsx','scripts/retention-operator-grants.ts'],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,FLOCKLETTER_RETENTION_RUNTIME_ROLE:'flockletter_runtime',FLOCKLETTER_RETENTION_PLANNER_ROLE:planner,FLOCKLETTER_RETENTION_EXECUTOR_ROLE:executor,FLOCKLETTER_RETENTION_DATABASE_NAME:'flockletter_test'}});expect(result.status).toBe(0);await db.query(result.stdout);});
afterAll(async()=>{await db?.end();await fixture?.stop();});
it('accepts only exact restricted planner/executor grants and rejects grant drift, CREATE and role membership',async()=>{
 for(const [role,kind] of [[planner,'planner'],[executor,'executor']] as const){await db.query('SET ROLE '+pg.escapeIdentifier(role));try{await verifyRetentionIdentity(db,'flockletter_test',role,kind);}finally{await db.query('RESET ROLE');}}
 await db.query('GRANT INSERT ON public.workspaces TO '+pg.escapeIdentifier(planner));await db.query('SET ROLE '+pg.escapeIdentifier(planner));try{await expect(verifyRetentionIdentity(db,'flockletter_test',planner,'planner')).rejects.toMatchObject({code:'operator_table_grants_drift'});}finally{await db.query('RESET ROLE');}await db.query('REVOKE INSERT ON public.workspaces FROM '+pg.escapeIdentifier(planner));
 await db.query('GRANT CREATE ON SCHEMA public TO '+pg.escapeIdentifier(planner));await db.query('SET ROLE '+pg.escapeIdentifier(planner));try{await expect(verifyRetentionIdentity(db,'flockletter_test',planner,'planner')).rejects.toMatchObject({code:'operator_identity_excess_authority'});}finally{await db.query('RESET ROLE');}await db.query('REVOKE CREATE ON SCHEMA public FROM '+pg.escapeIdentifier(planner));
 await db.query('GRANT '+pg.escapeIdentifier(executor)+' TO '+pg.escapeIdentifier(planner));await db.query('SET ROLE '+pg.escapeIdentifier(planner));try{await expect(verifyRetentionIdentity(db,'flockletter_test',planner,'planner')).rejects.toMatchObject({code:'operator_identity_excess_authority'});}finally{await db.query('RESET ROLE');}
});

it('renews only expired identical fresh plans without uncertain or completed external work and preserves authority history',async()=>{
 const at=new Date(),jobId=randomUUID(),workspaceId='org_renewal_'+randomUUID().replaceAll('-','');
 const approval:RetentionApprovalPayload={version:1,mode:'live',databaseName:'flockletter_test',workspaceId,jobId,sourceVersion:'closed1',manifestDigest:'a'.repeat(64),caseId:randomUUID(),caseVersion:1,inventoryDigest:'b'.repeat(64),checkpoint:{versionId:'v1',digest:'c'.repeat(64),sequence:1},externalInventoryDigest:'d'.repeat(64),exceptionDigest:'e'.repeat(64),nonce:randomUUID(),operatorId:'user_operator',issuedAt:new Date(at.getTime()-1200000).toISOString(),expiresAt:new Date(at.getTime()-600000).toISOString()};
 await persistHostedApproval(db,approval,'1'.repeat(64),new Date(at.getTime()-1200000));
 const renewed={...approval,nonce:randomUUID(),issuedAt:at.toISOString(),expiresAt:new Date(at.getTime()+600000).toISOString()};await persistHostedApproval(db,renewed,'2'.repeat(64),at);
 expect((await db.query('SELECT superseded_by FROM flockletter_retention_control.approval_history WHERE nonce=$1',[approval.nonce])).rows[0].superseded_by).toBe(renewed.nonce);
 await expect(persistHostedApproval(db,approval,'1'.repeat(64),at)).rejects.toMatchObject({code:'approval_nonce_superseded'});
 await db.query("INSERT INTO flockletter_retention_control.operations(operation_key,workspace_id,job_id,approval_digest,target_digest,target,state) VALUES($1,$2,$3,$4,$5,'{}','unknown')",['f'.repeat(64),workspaceId,jobId,'2'.repeat(64),'a'.repeat(64)]);
 const later=new Date(at.getTime()+1200000),next={...renewed,nonce:randomUUID(),issuedAt:later.toISOString(),expiresAt:new Date(later.getTime()+600000).toISOString()};await expect(persistHostedApproval(db,next,'3'.repeat(64),later)).rejects.toMatchObject({code:'approval_renewal_reconciliation_required'});
});
it('rejects SELECT-only sequence grants and PostgreSQL17 maintenance authority',async()=>{
 await db.query('CREATE SEQUENCE public.retention_identity_sequence');
 await db.query('GRANT SELECT ON SEQUENCE public.retention_identity_sequence TO '+pg.escapeIdentifier(executor));
 await db.query('SET ROLE '+pg.escapeIdentifier(executor));
 try{await expect(verifyRetentionIdentity(db,'flockletter_test',executor,'executor')).rejects.toMatchObject({code:'operator_sequence_grants_drift'});}finally{await db.query('RESET ROLE');await db.query('REVOKE SELECT ON SEQUENCE public.retention_identity_sequence FROM '+pg.escapeIdentifier(executor));}
 const version=Number((await db.query("SELECT current_setting('server_version_num') version")).rows[0].version);
 if(version>=170000){
  await db.query('GRANT MAINTAIN ON public.workspaces TO '+pg.escapeIdentifier(executor));await db.query('SET ROLE '+pg.escapeIdentifier(executor));
  try{await expect(verifyRetentionIdentity(db,'flockletter_test',executor,'executor')).rejects.toMatchObject({code:'operator_table_grants_drift'});}finally{await db.query('RESET ROLE');await db.query('REVOKE MAINTAIN ON public.workspaces FROM '+pg.escapeIdentifier(executor));}
 }
});
