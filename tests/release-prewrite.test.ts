import {tmpdir} from 'node:os';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {startDatabase} from '../scripts/database-fixture.js';

let fixture:Awaited<ReturnType<typeof startDatabase>>,root:pg.Client,directory:string,administrator:string;
beforeAll(async()=>{
 fixture=await startDatabase();root=new pg.Client({connectionString:fixture.adminUrl});await root.connect();
 const password=randomBytes(32).toString('hex');await root.query(`CREATE ROLE fixture_operator LOGIN CREATEDB CREATEROLE NOSUPERUSER PASSWORD '${password}'`);
 for(const environment of ['production','staging'])await root.query(`CREATE DATABASE fixture_${environment}_control OWNER fixture_operator`);
 const url=new URL(fixture.adminUrl);url.username='fixture_operator';url.password=password;administrator=url.href;
 directory=await mkdtemp(path.join(await realpath(tmpdir()),'flockletter-release-prewrite-'));
});
afterAll(async()=>{await root?.end();await fixture?.stop();await rm(directory,{recursive:true,force:true});});
async function store(name:string,value:unknown){const file=path.join(directory,name);await writeFile(file,JSON.stringify(value),{mode:0o600});return file;}

for(const environment of ['production','staging'] as const)it(`refuses ${environment} apply gaps before database, roles or ACL mutations; runs a private inspect without inherited provider env`,async()=>{
 const database='flockletter_'+environment,source='fixture_'+environment+'_control';
 const url=new URL(administrator);url.pathname='/'+source;
 const input={adminUrl:url.href,expectedHost:url.hostname,expectedSource:source,[environment==='production'?'confirmProduction':'confirmStaging']:true};
 const before=(await root.query('SELECT datacl::text FROM pg_database WHERE datname=$1',[source])).rows;
 const result=spawnSync(process.execPath,[`scripts/provision-${environment}.mjs`,'apply'],{
  input:JSON.stringify({...input,runtimePassword:'invalid-password-marker',migratorPassword:'invalid-password-marker'})+'\n',encoding:'utf8',env:{...process.env,APP_ENV:environment},
 });
 expect(result.status).not.toBe(0);expect(JSON.parse(result.stderr)).toEqual({ok:false,stage:'preflight',codes:['runtime_password_invalid','migrator_password_invalid','distinct_role_passwords_required']});
 expect(result.stdout+result.stderr).not.toContain('invalid-password-marker');
 expect((await root.query('SELECT FROM pg_database WHERE datname=$1',[database])).rowCount).toBe(0);
 expect((await root.query('SELECT FROM pg_roles WHERE rolname=ANY($1)',[[database+'_runtime',database+'_migrator']])).rowCount).toBe(0);
 expect((await root.query('SELECT datacl::text FROM pg_database WHERE datname=$1',[source])).rows).toEqual(before);
 const spec={version:1,operation:environment+'.inspect',host:url.hostname,port:Number(url.port||5432),database,migrationRole:database+'_migrator',runtimeRole:database+'_runtime',sourceDatabase:source,administratorRole:'fixture_operator'};
 const targetFile=await store(environment+'-target.json',spec);
 const planned=spawnSync(process.execPath,['scripts/release-runner.mjs','plan',targetFile],{encoding:'utf8'});
 expect(planned.status,planned.stderr).toBe(0);const bundle=JSON.parse(planned.stdout);
 const planFile=await store(environment+'-plan.json',bundle);
 const privateFile=await store(environment+'-input.json',{version:1,operation:spec.operation,planDigest:bundle.planDigest,input});
 // The local database has no TLS: inheriting PGSSLMODE=require would fail. The
 // runner's fixed child environment must not copy this service/provider setting.
 const executed=spawnSync(process.execPath,['scripts/release-runner.mjs','execute',planFile,privateFile],{
  encoding:'utf8',env:{...process.env,PGSSLMODE:'require',PGPASSWORD:'private-environment-marker'},timeout:15000,
 });
 expect(executed.status,executed.stdout+executed.stderr).toBe(0);
 expect(JSON.parse(executed.stdout)).toMatchObject({ok:true,stage:'completed',operation:spec.operation});
 for(const value of [url.href,url.password,'private-environment-marker','maxConnections','rolesPresent'])expect(executed.stdout+executed.stderr).not.toContain(value);
 const mismatch=await store(environment+'-mismatch.json',{version:1,operation:spec.operation,planDigest:bundle.planDigest,input:{...input,expectedHost:'localhost',adminUrl:url.href.replace('127.0.0.1','localhost')}});
 const refused=spawnSync(process.execPath,['scripts/release-runner.mjs','execute',planFile,mismatch],{encoding:'utf8'});
 expect(refused.status).not.toBe(0);expect(JSON.parse(refused.stdout)).toMatchObject({ok:false,stage:'preflight',codes:expect.arrayContaining(['private_target_mismatch','private_source_mismatch'])});
 const missingSource='fixture_'+environment+'_missing';
 const badSpec={...spec,sourceDatabase:missingSource};const badTarget=await store(environment+'-bad-target.json',badSpec);
 const badPlanned=spawnSync(process.execPath,['scripts/release-runner.mjs','plan',badTarget],{encoding:'utf8'});expect(badPlanned.status).toBe(0);const badBundle=JSON.parse(badPlanned.stdout);
 const badPlan=await store(environment+'-bad-plan.json',badBundle),missingUrl=new URL(url);missingUrl.pathname='/'+missingSource;
 const badInput=await store(environment+'-bad-input.json',{version:1,operation:spec.operation,planDigest:badBundle.planDigest,input:{...input,adminUrl:missingUrl.href,expectedSource:missingSource}});
 const childFailure=spawnSync(process.execPath,['scripts/release-runner.mjs','execute',badPlan,badInput],{encoding:'utf8',timeout:15000});
 expect(childFailure.status).not.toBe(0);expect(JSON.parse(childFailure.stdout)).toEqual({ok:false,stage:'child',codes:['release_child_failed','reconciliation_required']});
 expect(childFailure.stderr).toBe('');expect(childFailure.stdout).not.toContain(url.password);
 expect((await root.query('SELECT FROM pg_database WHERE datname=$1',[database])).rowCount).toBe(0);
 expect((await root.query('SELECT datacl::text FROM pg_database WHERE datname=$1',[source])).rows).toEqual(before);
});
