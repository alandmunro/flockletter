import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {startDatabase} from '../scripts/database-fixture.js';
import {Database} from '../src/server/db.js';
import {OperatorStore} from '../src/server/platform/store.js';
import {productionOperatorGrantSql} from '../src/server/platform/production-provision.js';

let fixture:Awaited<ReturnType<typeof startDatabase>>,owner:pg.Client,migrator:pg.Client,root:pg.Client;
let runtimeUrl:string,operatorUrl:string;
const role='flockletter_production_operator',marker='Flockletter production foundation';
const password=()=>randomBytes(32).toString('hex');
beforeAll(async()=>{
 fixture=await startDatabase();root=new pg.Client({connectionString:fixture.adminUrl});await root.connect();
 const ownerPassword=password(),runtimePassword=password(),migratorPassword=password(),operatorPassword=password();
 await root.query(`CREATE ROLE fixture_production_owner LOGIN CREATEDB CREATEROLE PASSWORD '${ownerPassword}'`);
 await root.query('CREATE DATABASE fixture_production_control OWNER fixture_production_owner');
 const url=new URL(fixture.adminUrl);url.username='fixture_production_owner';url.password=ownerPassword;url.pathname='/fixture_production_control';
 const input={adminUrl:url.href,expectedHost:url.hostname,expectedSource:'fixture_production_control',runtimePassword,migratorPassword,confirmProduction:true};
 const result=spawnSync(process.execPath,['scripts/provision-production.mjs','apply'],{input:JSON.stringify(input)+'\n',encoding:'utf8',timeout:30000,env:{...process.env,APP_ENV:'production'}});
 expect(result.status,result.stderr).toBe(0);
 url.pathname='/flockletter_production';owner=new pg.Client({connectionString:url.href});await owner.connect();
 await owner.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${operatorPassword}'`);
 await owner.query(`COMMENT ON ROLE ${role} IS '${marker}'`);
 url.username='flockletter_production_migrator';url.password=migratorPassword;migrator=new pg.Client({connectionString:url.href});await migrator.connect();
 url.username='flockletter_production_runtime';url.password=runtimePassword;runtimeUrl=url.href;
 url.username=role;url.password=operatorPassword;operatorUrl=url.href;
});
afterAll(async()=>{await owner?.end();await migrator?.end();await root?.end();await fixture?.stop();});

async function refused(client:pg.Client,sql:string,message:string){
 try {await expect(client.query(sql)).rejects.toThrow(message);}finally{await client.query('ROLLBACK');}
}

it('refuses wrong database, role marker, actor and inherited authority before granting access',async()=>{
 await refused(root,productionOperatorGrantSql('database'),'production_database_marker_required');
 await refused(owner,productionOperatorGrantSql('objects'),'production_release_identity_required');
 await owner.query(`COMMENT ON ROLE ${role} IS 'Unreviewed fixture role'`);
 await refused(owner,productionOperatorGrantSql('database'),'inactive_restricted_operator_marker_required');
 await owner.query(`COMMENT ON ROLE ${role} IS '${marker}'`);
 await owner.query(`ALTER ROLE ${role} CREATEROLE`);
 await refused(owner,productionOperatorGrantSql('database'),'inactive_restricted_operator_marker_required');
 await owner.query(`ALTER ROLE ${role} NOCREATEROLE`);
 await root.query(`GRANT flockletter_runtime TO ${role}`);
 await refused(owner,productionOperatorGrantSql('database'),'operator_ownership_or_membership_refused');
 await root.query(`REVOKE flockletter_runtime FROM ${role}`);
});

it('provisions both owner boundaries idempotently while keeping the role inactive and foreign grants unchanged',async()=>{
 const foreignBefore=(await root.query("SELECT datacl::text FROM pg_database WHERE datname='flockletter_test'")).rows;
 for(let pass=0;pass<2;pass++){
  await owner.query(productionOperatorGrantSql('database'));
  await migrator.query(productionOperatorGrantSql('objects'));
 }
 expect((await owner.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[role])).rows[0].rolcanlogin).toBe(false);
 expect((await root.query("SELECT datacl::text FROM pg_database WHERE datname='flockletter_test'")).rows).toEqual(foreignBefore);
 await owner.query(`ALTER ROLE ${role} LOGIN`);
 const db=new Database(runtimeUrl),store=new OperatorStore(db,'live',operatorUrl);
 try{
  await expect(store.verify()).resolves.toBeUndefined();
  await migrator.query(`GRANT MAINTAIN ON flockletter_retention_control.platform_records TO ${role}`);
  await expect(store.verify()).rejects.toMatchObject({code:'operator_database_unsafe'});
  await migrator.query(`REVOKE MAINTAIN ON flockletter_retention_control.platform_records FROM ${role}`);
  await expect(store.verify()).resolves.toBeUndefined();
  await store.transaction('org_operator_fixture',r=>r.put('health','current',{ok:true}));
  expect(await store.read('health')).toEqual([{ok:true}]);
  const restricted=new pg.Client({connectionString:operatorUrl});await restricted.connect();
  try{
   await expect(restricted.query('SELECT * FROM public.workspaces')).rejects.toMatchObject({code:'42501'});
   await expect(restricted.query('DELETE FROM flockletter_retention_control.platform_records')).rejects.toMatchObject({code:'42501'});
  }finally{await restricted.end();}
 }finally{await store.close();await db.close();}
 await refused(owner,productionOperatorGrantSql('database'),'inactive_restricted_operator_marker_required');
 await owner.query(`ALTER ROLE ${role} NOLOGIN`);
});

it('rolls back object grants when effective PUBLIC drift would expand operator access',async()=>{
 await migrator.query('GRANT USAGE ON SCHEMA public TO PUBLIC');
 await migrator.query('GRANT SELECT ON public.workspaces TO PUBLIC');
 try{
  await refused(migrator,productionOperatorGrantSql('objects'),'operator_table_grants_refused');
  expect((await owner.query("SELECT has_table_privilege($1,'public.workspaces','SELECT') allowed",[role])).rows[0].allowed).toBe(true);
 }finally{
  await migrator.query('REVOKE SELECT ON public.workspaces FROM PUBLIC');
  await migrator.query('REVOKE USAGE ON SCHEMA public FROM PUBLIC');
 }
});

it('prints only fixed SQL and refuses arbitrary phase or configuration inputs',()=>{
 const valid=spawnSync(process.execPath,['--import','tsx','scripts/provision-production-operator.ts','database'],{env:{...process.env,APP_ENV:'production'},encoding:'utf8'});
 expect(valid.status,valid.stderr).toBe(0);expect(valid.stdout).toContain('production_database_marker_required');
 for(const args of [['database','unexpected-secret'],['unexpected-secret']]){
  const result=spawnSync(process.execPath,['--import','tsx','scripts/provision-production-operator.ts',...args],{env:{...process.env,APP_ENV:'production'},encoding:'utf8'});
  expect(result.status).not.toBe(0);expect(result.stdout+result.stderr).not.toContain('unexpected-secret');
 }
 expect(()=>productionOperatorGrantSql('arbitrary' as 'database')).toThrow();
});
