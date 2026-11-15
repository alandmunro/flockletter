import { afterAll,beforeAll,expect,it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rehearseSchema } from '../scripts/rehearse-schema-compatibility.js';
import { migrationEvidenceGaps, releasePlanDigest, releasePlanGaps, releaseSourceFingerprint, createReleasePlan, releaseRoot, type MigrationEvidence } from '../scripts/release-plan.mjs';
import { fixtureMigrationEvidence } from './helpers/migration-evidence.js';

let directory:string;
const revision=execFileSync('git',['-C',releaseRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
beforeAll(async()=>{directory=await mkdtemp(path.join(await realpath(tmpdir()),'flockletter-revision-test-'));});
afterAll(async()=>{await rm(directory,{recursive:true,force:true});});

it('migrates isolated PostgreSQL and checks the restricted role with both committed builds',async()=>{
  const result=await rehearseSchema('staging',revision,revision,revision);
  expect(result).toMatchObject({ok:true,environment:'staging',webRevision:revision,workerRevision:revision,candidateRevision:revision,checked:[revision]});
  expect(result.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
});

it('rejects an incompatible serving worker even when the new web build accepts the new schema',async()=>{
  // An isolated clone makes the regression independent of git depth and private deployment history.
  execFileSync('git',['clone','--quiet','--local','--no-checkout',releaseRoot,directory]);
  const git=(...args:string[])=>execFileSync('git',['-C',directory,...args],{encoding:'utf8'}).trim();
  git('checkout','--quiet','--detach',revision);
  const file=path.join(directory,'src/server/runtime-boundary.mjs');
  const original=await readFile(file,'utf8');
  // The old, restricted worker explicitly prohibits the fixture's proposed future permission.
  const anchor='const names = tables.map';
  expect(original).toContain(anchor);
  await writeFile(file,original.replace(anchor,`if ((await client.query("SELECT has_function_privilege(current_user, 'public.flockletter_default_company_id(text)', 'EXECUTE') AND to_regclass('public.future_schema_marker') IS NOT NULL AS incompatible")).rows[0].incompatible) throw Error('unexpected_runtime_schema');\n  ${anchor}`));
  const commit=()=>{git('add','--all');git('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','--quiet','-m','Synthetic compatibility case');return git('rev-parse','HEAD');};
  const worker=commit();
  await writeFile(file,original);
  const migration=path.join(directory,'migrations/037_trial_status_read_only.sql');
  const prior=await readFile(migration,'utf8');
  await writeFile(migration,prior+"\nCREATE TABLE IF NOT EXISTS public.future_schema_marker (id integer PRIMARY KEY);\n");
  const candidate=commit();
  const result=await rehearseSchema('staging',revision,worker,candidate,directory);
  expect(result).toMatchObject({ok:false,code:'serving_worker_on_new_schema',workerRevision:worker,candidateRevision:candidate});
  expect(result.recovery).toContain('Hold the migration');
  expect(await rehearseSchema('staging',worker,worker,candidate,directory)).toMatchObject({ok:false,code:'serving_web_on_new_schema'});
});

it('refuses missing or changed revisions, late proof and earlier proof presented to another target',async()=>{
  const source=await releaseSourceFingerprint(),evidence=await fixtureMigrationEvidence('staging');
  const target={version:1,operation:'staging.migrate',host:'database.example',port:5432,database:'flockletter_staging',
    migrationRole:'flockletter_staging_migrator',runtimeRole:'flockletter_staging_runtime'};
  for(const [patch,code] of [
    [{sourceFingerprint:'0'.repeat(64)},'compatibility_source_mismatch'],[{checked:[]},'compatibility_checks_incomplete'],
    [{environment:'production'},'compatibility_environment_mismatch'],[{checkedAt:new Date(Date.now()-1801000).toISOString()},'compatibility_evidence_expired'],
  ] as const)expect(migrationEvidenceGaps({...evidence,...patch},'staging',source)).toContain(code);
  expect(await createReleasePlan(target)).toEqual({codes:['compatibility_evidence_required']});
  const result=await createReleasePlan(target,new Date(),evidence);
  expect(releasePlanGaps(result.plan,source)).toEqual([]);
  const altered:MigrationEvidence={...evidence,candidateRevision:'c'.repeat(40)};
  expect(releasePlanDigest({...result.plan!,compatibility:altered})).not.toEqual(releasePlanDigest(result.plan!));
  expect(await rehearseSchema('test',revision,revision,revision)).toMatchObject({ok:false});
  expect(await rehearseSchema('staging','main',revision,revision)).toMatchObject({ok:false});
});
