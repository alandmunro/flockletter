import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {startDatabase} from '../scripts/database-fixture.js';
import {productionRetentionGrantSql,type ProductionRetentionKind} from '../src/server/customer-retention/production-provision.js';
import {productionOperatorGrantSql} from '../src/server/platform/production-provision.js';
import {productionRestrictedRoles} from '../src/server/production-role-provision.js';
import {verifyRetentionIdentity} from '../src/server/customer-retention/identity.js';

let fixture:Awaited<ReturnType<typeof startDatabase>>,root:pg.Client,owner:pg.Client,migrator:pg.Client;
let roleUrl:URL;
const secret=()=>randomBytes(32).toString('hex');
beforeAll(async()=>{
 fixture=await startDatabase();root=new pg.Client({connectionString:fixture.adminUrl});await root.connect();
 const ownerPassword=secret(),migratorPassword=secret();
 await root.query(`CREATE ROLE fixture_production_owner LOGIN CREATEDB CREATEROLE PASSWORD '${ownerPassword}'`);
 await root.query('CREATE DATABASE fixture_production_control OWNER fixture_production_owner');
 const url=new URL(fixture.adminUrl);url.username='fixture_production_owner';url.password=ownerPassword;url.pathname='/fixture_production_control';
 const result=spawnSync(process.execPath,['scripts/provision-production.mjs','apply'],{
  input:JSON.stringify({adminUrl:url.href,expectedHost:url.hostname,expectedSource:'fixture_production_control',runtimePassword:secret(),migratorPassword,confirmProduction:true})+'\n',
  encoding:'utf8',timeout:30000,env:{...process.env,APP_ENV:'production'},
 });
 expect(result.status,result.stderr).toBe(0);
 url.pathname='/flockletter_production';roleUrl=new URL(url);owner=new pg.Client({connectionString:url.href});await owner.connect();
 url.username='flockletter_production_migrator';url.password=migratorPassword;
 migrator=new pg.Client({connectionString:url.href});await migrator.connect();
});
afterAll(async()=>{await owner?.end();await migrator?.end();await root?.end();await fixture?.stop();});
async function refused(client:pg.Client,sql:string,category:string){
 try{await expect(client.query(sql)).rejects.toThrow(category);}finally{await client.query('ROLLBACK');}
}

it('creates only exact marked inactive roles without credentials and safely replays the owner/migrator phases',async()=>{
 const before=(await root.query("SELECT datacl::text FROM pg_database WHERE datname='flockletter_test'")).rows;
 await refused(root,productionRetentionGrantSql('planner','role'),'production_database_marker_required');
 await refused(migrator,productionRetentionGrantSql('planner','role'),'production_release_identity_required');
 for(let pass=0;pass<2;pass++){
  await owner.query(productionOperatorGrantSql('role'));
  for(const kind of ['planner','executor'] as const){
   await owner.query(productionRetentionGrantSql(kind,'role'));
   await owner.query(productionRetentionGrantSql(kind,'database'));
   await refused(owner,productionRetentionGrantSql(kind,'objects'),'production_release_identity_required');
   await migrator.query(productionRetentionGrantSql(kind,'objects'));
  }
 }
 expect((await root.query("SELECT datacl::text FROM pg_database WHERE datname='flockletter_test'")).rows).toEqual(before);
 const roles=(await root.query(`SELECT rolname,rolcanlogin,rolinherit,rolconnlimit,rolpassword IS NULL AS password_missing,
  shobj_description(oid,'pg_authid') AS marker FROM pg_authid WHERE rolname=ANY($1) ORDER BY rolname`,[Object.values(productionRestrictedRoles)])).rows;
 expect(roles).toHaveLength(3);
 for(const role of roles)expect(role).toMatchObject({rolcanlogin:false,rolinherit:false,rolconnlimit:2,password_missing:true,marker:'Flockletter production foundation'});
 // A credential installed separately on an inactive marked role is never rotated by bootstrap replay.
 await owner.query(`ALTER ROLE ${productionRestrictedRoles.operator} PASSWORD '${secret()}'`);
 const prior=(await root.query('SELECT rolpassword FROM pg_authid WHERE rolname=$1',[productionRestrictedRoles.operator])).rows[0].rolpassword;
 await owner.query(productionOperatorGrantSql('role'));
 expect((await root.query('SELECT rolpassword=$1 AS preserved FROM pg_authid WHERE rolname=$2',[prior,productionRestrictedRoles.operator])).rows[0].preserved).toBe(true);
});

it('refuses unexpected role markers, elevated flags, memberships and ownership without repairing them',async()=>{
 const role=productionRestrictedRoles.planner;
 await owner.query(`COMMENT ON ROLE ${role} IS 'Unreviewed role'`);
 await refused(owner,productionRetentionGrantSql('planner','role'),'inactive_restricted_operator_marker_required');
 expect((await owner.query("SELECT shobj_description(oid,'pg_authid') marker FROM pg_roles WHERE rolname=$1",[role])).rows[0].marker).toBe('Unreviewed role');
 await owner.query(`COMMENT ON ROLE ${role} IS 'Flockletter production foundation'`);
 await owner.query(`ALTER ROLE ${role} CREATEROLE`);
 await refused(owner,productionRetentionGrantSql('planner','database'),'inactive_restricted_operator_marker_required');
 await owner.query(`ALTER ROLE ${role} NOCREATEROLE`);
 await root.query(`GRANT flockletter_runtime TO ${role}`);
 await refused(migrator,productionRetentionGrantSql('planner','objects'),'operator_ownership_or_membership_refused');
 await root.query(`REVOKE flockletter_runtime FROM ${role}`);
 const targetRoot=new pg.Client({connectionString:new URL('/flockletter_production',fixture.adminUrl).href});await targetRoot.connect();
 try{
  await targetRoot.query(`CREATE TABLE public.role_ownership_fixture(id integer)`);
  await targetRoot.query(`ALTER TABLE public.role_ownership_fixture OWNER TO ${role}`);
  await refused(owner,productionRetentionGrantSql('planner','role'),'operator_ownership_or_membership_refused');
  await targetRoot.query('DROP TABLE public.role_ownership_fixture');
 }finally{await targetRoot.end();}
});

it('passes actual-role verification including029 while keeping030 worker metadata and destructive privileges isolated',async()=>{
 for(const kind of ['planner','executor'] as const){
  const role=productionRestrictedRoles[kind],password=secret();
  // Test fixture activation only. The SQL generators never issue credentials or LOGIN.
  await owner.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
  const url=new URL(roleUrl);url.username=role;url.password=password;
  const actual=new pg.Client({connectionString:url.href});await actual.connect();
  try{
   await expect(verifyRetentionIdentity(actual,'flockletter_production',role,kind)).resolves.toBeUndefined();
   expect((await actual.query('SELECT count(*)::int amount FROM flockletter_customer_jobs.confirmation_routes')).rows[0].amount).toBe(0);
   await expect(actual.query('SELECT * FROM flockletter_customer_jobs.worker_instances')).rejects.toMatchObject({code:'42501'});
   await expect(actual.query("SELECT flockletter_customer_jobs.worker_liveness('dedicated')")).rejects.toMatchObject({code:'42501'});
   await expect(actual.query('SELECT * FROM flockletter_customer_jobs.trial_claims')).rejects.toMatchObject({code:'42501'});
   if(kind==='planner')await expect(actual.query('DELETE FROM flockletter_customer_jobs.confirmation_routes WHERE false')).rejects.toMatchObject({code:'42501'});
   else expect((await actual.query('DELETE FROM flockletter_customer_jobs.confirmation_routes WHERE false')).rowCount).toBe(0);
   await refused(owner,productionRetentionGrantSql(kind,'role'),'inactive_restricted_operator_marker_required');
  }finally{await actual.end();await owner.query(`ALTER ROLE ${role} NOLOGIN`);}
 }
});

it('rolls back on PUBLIC table, sequence, function and030 drift without revoking foreign/public grants',async()=>{
 const role=productionRestrictedRoles.planner;
 await migrator.query('CREATE SEQUENCE public.production_retention_sequence');
 for(const [grant,revoke,category] of [
  ['GRANT INSERT ON public.workspaces TO PUBLIC','REVOKE INSERT ON public.workspaces FROM PUBLIC','retention_table_grants_refused'],
  ['GRANT SELECT ON flockletter_customer_jobs.worker_instances TO PUBLIC','REVOKE SELECT ON flockletter_customer_jobs.worker_instances FROM PUBLIC','retention_table_grants_refused'],
  ['GRANT SELECT ON SEQUENCE public.production_retention_sequence TO PUBLIC','REVOKE SELECT ON SEQUENCE public.production_retention_sequence FROM PUBLIC','retention_extra_grants_refused'],
  ['GRANT EXECUTE ON FUNCTION flockletter_customer_jobs.worker_liveness(text) TO PUBLIC','REVOKE EXECUTE ON FUNCTION flockletter_customer_jobs.worker_liveness(text) FROM PUBLIC','retention_function_grants_refused'],
 ] as const){
  await migrator.query(grant);
  try{await refused(migrator,productionRetentionGrantSql('planner','objects'),category);}
  finally{await migrator.query(revoke);}
 }
 await migrator.query('DROP SEQUENCE public.production_retention_sequence');
 await migrator.query(productionRetentionGrantSql('planner','objects'));
 expect((await owner.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[role])).rows[0].rolcanlogin).toBe(false);
});

it('prints fixed SQL only and rejects arbitrary identifiers, extra arguments and generic production use',()=>{
 const run=(args:string[],environment='production')=>spawnSync(process.execPath,['--import','tsx','scripts/provision-production-retention.ts',...args],{encoding:'utf8',env:{...process.env,APP_ENV:environment}});
 const valid=run(['executor','role']);expect(valid.status,valid.stderr).toBe(0);expect(valid.stdout).toContain('NOLOGIN');expect(valid.stdout).not.toContain('PASSWORD');
 for(const args of [['unexpected-secret','role'],['planner','unexpected-secret'],['planner','role','unexpected-secret']]){
  const result=run(args);expect(result.status).not.toBe(0);expect(result.stdout+result.stderr).not.toContain('unexpected-secret');
 }
 expect(run(['planner','role'],'staging').status).not.toBe(0);
 expect(()=>productionRetentionGrantSql('operator' as ProductionRetentionKind,'role')).toThrow();
 const generic=spawnSync(process.execPath,['--import','tsx','scripts/retention-operator-grants.ts'],{encoding:'utf8',env:{...process.env,APP_ENV:'production'}});
 expect(generic.status).not.toBe(0);expect(generic.stdout).toBe('');
});
