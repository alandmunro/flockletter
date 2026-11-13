import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {startDatabase} from '../scripts/database-fixture.js';
import {fixtureMigrationEvidence} from './helpers/migration-evidence.js';

let fixture:Awaited<ReturnType<typeof startDatabase>>,root:pg.Client;
beforeAll(async()=>{fixture=await startDatabase();root=new pg.Client({connectionString:fixture.adminUrl});await root.connect();});
afterAll(async()=>{await root?.end();await fixture?.stop();});

for(const environment of ['production','staging'] as const)it(`validates both ${environment} release URIs before any migration and accepts the isolated pair`,async()=>{
 const database='flockletter_'+environment,migration=new URL(fixture.adminUrl),runtime=new URL(fixture.adminUrl);
 const migrationRole=database+'_migrator',runtimeRole=database+'_runtime';
 const passwords=[randomBytes(32).toString('hex'),randomBytes(32).toString('hex')] as const;
 for(const [role,password] of [[migrationRole,passwords[0]],[runtimeRole,passwords[1]]] as const)
  await root.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`);
 await root.query(`CREATE DATABASE ${database} OWNER ${migrationRole}`);
 migration.pathname='/'+database;migration.username=migrationRole;migration.password=passwords[0];migration.searchParams.set('sslmode','disable');
 runtime.pathname='/'+database;runtime.username=runtimeRole;runtime.password=passwords[1];runtime.searchParams.set('sslmode','disable');
 const compatibility=await fixtureMigrationEvidence(environment);
 const command=(migrationUrl=migration.href,runtimeUrl=runtime.href,single=false,proof:unknown=compatibility)=>spawnSync(process.execPath,
  ['--import','./tests/helpers/migration-readiness.mjs',`scripts/migrate-${environment}.mjs`,'fixture-release',single?'--uri-stdin':'--pair-stdin'],{
   input:single?migrationUrl+'\n':JSON.stringify({migrationUrl,runtimeUrl,compatibility:proof})+'\n',encoding:'utf8',timeout:15000,
   env:{...process.env,APP_ENV:environment,DATABASE_URL:runtimeUrl},
  });
 const initial=command();expect(initial.status,initial.stderr).toBe(0);
 const owner=new pg.Client({connectionString:migration.href});await owner.connect();
 try{
  // This disposable column ACL is a sentinel: real migrations revoke it. Invalid
  // runtime URLs must be refused before even the valid migration connection runs.
  await owner.query('GRANT SELECT(workspace_id) ON public.workspaces TO PUBLIC');
  for(const [proof,code] of [
    [null,'compatibility_evidence_required'],
    [{...compatibility,sourceFingerprint:'0'.repeat(64)},'compatibility_source_mismatch'],
    [{...compatibility,webRevision:'e'.repeat(40),workerRevision:'e'.repeat(40),checked:['e'.repeat(40)]},'serving_revision_or_readiness_changed'],
  ] as const){
   const refused=command(migration.href,runtime.href,false,proof);
   expect(refused.status).not.toBe(0);
   expect(refused.stderr).toContain(code);
   expect((await owner.query("SELECT EXISTS(SELECT FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid='public.workspaces'::regclass AND acl.grantee=0) AS unchanged")).rows[0].unchanged).toBe(true);
  }
  for(const target of ['migration','runtime'] as const){
   for(const option of ['host=invalid.example','user=invalid_role','password=private-query-marker','credential-percent','credential-control',
    'database=unrelated','port=1','sslmode=disable&sslmode=disable','sslmode=unsupported',
    'sslmode=disable&application_name=unexpected','#unexpected','#']){
    const changed=new URL(target==='migration'?migration:runtime);changed.search='';
    if(option==='credential-percent')changed.password='invalid%';
    else if(option==='credential-control')changed.password='invalid%00';
    else if(option.startsWith('#'))changed.hash=option;else changed.search='?'+option;
    const result=command(target==='migration'?changed.href:migration.href,target==='runtime'?changed.href:runtime.href);
    expect(result.status).not.toBe(0);
    expect(result.stdout+result.stderr).not.toContain('private-query-marker');
    expect((await owner.query("SELECT EXISTS(SELECT FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid='public.workspaces'::regclass AND a.attname='workspace_id' AND acl.grantee=0) AS unchanged")).rows[0].unchanged).toBe(true);
   }
  }
  if(environment==='staging'){
   const changed=new URL(runtime);changed.search='?user=invalid_role';
   expect(command(migration.href,changed.href,true).status).not.toBe(0);
   expect((await owner.query("SELECT EXISTS(SELECT FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid='public.workspaces'::regclass AND acl.grantee=0) AS unchanged")).rows[0].unchanged).toBe(true);
  }
  const replay=command();expect(replay.status,replay.stderr).toBe(0);
  expect((await owner.query("SELECT EXISTS(SELECT FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid='public.workspaces'::regclass AND acl.grantee=0) AS remains")).rows[0].remains).toBe(false);
 }finally{await owner.end();}
});
