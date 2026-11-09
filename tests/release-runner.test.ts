import {afterAll,beforeAll,expect,it} from 'vitest';
import {chmod,link,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {releaseInputPreflight} from '../scripts/release-input.mjs';
import {createReleasePlan,privateEnvelopeGaps,readProtectedReleaseFile,releasePlanDigest,releasePlanGaps,releaseSourceFingerprint,targetSpecGaps,verifyReleaseSourceFile,type ReleasePlan,type ReleaseTarget} from '../scripts/release-plan.mjs';
import {executeReleaseFiles} from '../scripts/release-runner.mjs';

let directory:string,plan:ReleasePlan;
const target:ReleaseTarget={version:1,operation:'production.inspect',host:'database.example',port:5432,database:'flockletter_production',migrationRole:'flockletter_production_migrator',runtimeRole:'flockletter_production_runtime',sourceDatabase:'fixture_production_control',administratorRole:'fixture_operator'};
const input={adminUrl:'postgresql://fixture_operator:private-input-marker@database.example/fixture_production_control',expectedHost:target.host,expectedSource:target.sourceDatabase,confirmProduction:true};
beforeAll(async()=>{directory=await mkdtemp('/private/tmp/flockletter-release-files-');const result=await createReleasePlan(target);expect(result.codes).toBeUndefined();plan=result.plan!;});
afterAll(async()=>{await rm(directory,{recursive:true,force:true});});
async function store(name:string,value:unknown){const file=path.join(directory,name);await writeFile(file,JSON.stringify(value),{mode:0o600});return file;}
const bundle=(p:ReleasePlan)=>({ok:true,plan:p,planDigest:releasePlanDigest(p)});
const envelope=(p:ReleasePlan)=>({version:1,operation:p.operation,planDigest:releasePlanDigest(p),input});

it('returns all static field gaps together, without supplied values or cross-environment fallback',()=>{
 expect(releaseInputPreflight('production.apply',{},'staging')).toEqual(['environment_mismatch','admin_url_invalid','expected_host_invalid','expected_source_invalid','environment_confirmation_required','runtime_password_invalid','migrator_password_invalid']);
 expect(releaseInputPreflight('production.migrate',{},'production')).toEqual(['migration_url_invalid','runtime_url_invalid']);
 expect(releaseInputPreflight('production.migrate',{migrationUrl:'postgresql://flockletter_production_migrator:bad%@database.example/flockletter_production',runtimeUrl:'postgresql://flockletter_production_runtime:bad%00@database.example/flockletter_production'},'production')).toEqual(['migration_url_invalid','runtime_url_invalid']);
 expect(releaseInputPreflight('constructor',input,'production')).toEqual(['operation_invalid']);
 expect(targetSpecGaps({...target,operation:{toString:null}})).toEqual(['operation_invalid']);
 expect(releaseInputPreflight('production.inspect',input,'production')).toEqual([]);
 expect(releaseInputPreflight('staging.inspect',{...input,expectedSource:'fixture_production_control'},'staging')).toEqual(expect.arrayContaining(['expected_source_invalid','environment_confirmation_required','unexpected_input_fields']));
 const codes=releaseInputPreflight('production.apply',{...input,unexpected:'private-input-marker',runtimePassword:'invalid',migratorPassword:'invalid'},'production');
 expect(codes).toEqual(['unexpected_input_fields','runtime_password_invalid','migrator_password_invalid','distinct_role_passwords_required']);
 expect(JSON.stringify(codes)).not.toContain('private-input-marker');
});

it('binds separately supplied target host/source/roles and rejects stale or altered source plans',async()=>{
 expect(targetSpecGaps({...target,database:'flockletter_staging',migrationRole:'other_role'})).toEqual(['target_database_mismatch','target_roles_mismatch']);
 expect(releasePlanGaps(plan,await releaseSourceFingerprint())).toEqual([]);
 expect(releasePlanGaps({...plan,createdAt:new Date(Date.now()-1801000).toISOString()},plan.sourceFingerprint)).toContain('plan_time_invalid');
 expect(releasePlanGaps({...plan,createdAt:new Date(Date.now()+61000).toISOString()},plan.sourceFingerprint)).toContain('plan_time_invalid');
 expect(releasePlanGaps({...plan,target:{...target,host:'other.example'}},plan.sourceFingerprint)).toContain('target_fingerprint_mismatch');
 expect(privateEnvelopeGaps({...envelope(plan),input:{...input,adminUrl:input.adminUrl.replace('database.example','other.example'),expectedHost:'other.example'}},plan)).toEqual(['private_target_mismatch','private_source_mismatch']);
 expect(privateEnvelopeGaps({...envelope(plan),operation:'staging.inspect',planDigest:'a'.repeat(64)},plan)).toEqual(['private_operation_mismatch','private_plan_mismatch']);
});

it('checks exact source and public target before opening any private input file',async()=>{
 const missing=path.join(directory,'private-input-does-not-exist');
 const changed={...plan,sourceFingerprint:'0'.repeat(64)};
 expect(await executeReleaseFiles(await store('wrong-source-plan.json',bundle(changed)),missing)).toEqual({ok:false,stage:'plan',codes:['source_fingerprint_mismatch']});
 const altered={...plan,targetFingerprint:'0'.repeat(64)};
 expect(await executeReleaseFiles(await store('wrong-target-plan.json',bundle(altered)),missing)).toEqual({ok:false,stage:'plan',codes:['target_fingerprint_mismatch']});
 const planFile=await store('valid-plan.json',bundle(plan));
 expect(await executeReleaseFiles(planFile,await store('wrong-operation-input.json',{...envelope(plan),operation:'staging.inspect'}))).toEqual({ok:false,stage:'preflight',codes:['private_operation_mismatch']});
 const invalid={...envelope(plan),input:{...input,adminUrl:'private-input-marker',expectedHost:'',expectedSource:''}};
 const result=await executeReleaseFiles(planFile,await store('invalid-input.json',invalid));
 expect(result).toMatchObject({ok:false,stage:'preflight',codes:expect.arrayContaining(['admin_url_invalid','expected_host_invalid','expected_source_invalid'])});
 expect(JSON.stringify(result)).not.toContain('private-input-marker');
});

it('refuses symlinks, hardlinks, unsafe files/directories/ancestors and oversized private input',async()=>{
 const file=await store('permissions.json',{secret:'private-input-marker'});
 await expect(verifyReleaseSourceFile(file)).resolves.toBeUndefined();
 await chmod(file,0o620);await expect(verifyReleaseSourceFile(file)).rejects.toThrow('release_source_invalid');await chmod(file,0o600);
 expect(await readProtectedReleaseFile(file)).toContain('private-input-marker');
 await chmod(file,0o640);await expect(readProtectedReleaseFile(file)).rejects.toThrow('protected_file_permissions');await chmod(file,0o600);
 const linked=path.join(directory,'linked.json');await symlink(file,linked);await expect(readProtectedReleaseFile(linked)).rejects.toThrow('protected_file_symlink');
 const hard=path.join(directory,'hard.json');await link(file,hard);await expect(readProtectedReleaseFile(hard)).rejects.toThrow('protected_file_permissions');await rm(hard);
 const child=path.join(directory,'shared');await mkdir(child,{mode:0o750});const childFile=path.join(child,'input.json');await writeFile(childFile,'{}',{mode:0o600});
 await expect(readProtectedReleaseFile(childFile)).rejects.toThrow('protected_directory_permissions');
 await chmod(child,0o777);const nested=path.join(child,'private');await mkdir(nested,{mode:0o700});const nestedFile=path.join(nested,'input.json');await writeFile(nestedFile,'{}',{mode:0o600});
 await expect(readProtectedReleaseFile(nestedFile)).rejects.toThrow('protected_ancestor_permissions');await chmod(child,0o700);
 const huge=path.join(directory,'huge.json');await writeFile(huge,'x'.repeat(65537),{mode:0o600});await expect(readProtectedReleaseFile(huge)).rejects.toThrow('protected_file_size');
 await expect(readProtectedReleaseFile(child)).rejects.toThrow('protected_file_permissions');
});

it('provides strict fixed CLI dispatch and a useful public plan without reading credentials',async()=>{
 const spec=await store('target.json',target);
 const result=spawnSync(process.execPath,['scripts/release-runner.mjs','plan',spec],{encoding:'utf8'});
 expect(result.status,result.stderr).toBe(0);const published=JSON.parse(result.stdout);
 expect(published).toMatchObject({ok:true,plan:{operation:'production.inspect',target,sourceFingerprint:expect.any(String),targetFingerprint:expect.any(String)},planDigest:expect.any(String)});
 expect(await readFile(spec,'utf8')).not.toContain('private-input-marker');
 for(const args of [['unexpected-private-marker'],['execute',spec],['plan',spec,'unexpected-private-marker']]){
  const invalid=spawnSync(process.execPath,['scripts/release-runner.mjs',...args],{encoding:'utf8'});
  expect(invalid.status).not.toBe(0);expect(invalid.stdout+invalid.stderr).not.toContain('unexpected-private-marker');
 }
});
