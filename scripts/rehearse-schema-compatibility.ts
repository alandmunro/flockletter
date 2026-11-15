import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { startDatabase } from './database-fixture.js';
import { releaseBoundaryFiles, releaseRoot, releaseSourceFingerprint } from './release-plan.mjs';
import type { applyMigrations } from './apply-migrations.mjs';
import type { verifyRuntimeBoundary } from '../src/server/runtime-boundary.mjs';

const git = promisify(execFile);
const sha = /^[a-f0-9]{40}$/;
const environments=['staging','production','self-host'];
const recovery = 'Hold the migration. Prepare a bridge release verified on both schemas, or arrange an approved maintenance window and a tested database recovery point. Verify the serving web and worker revisions again before retrying.';
async function readRevision(repository:string, root: string, revision: string) {
  const read = (args: string[]) => git('git', ['-C', repository, ...args], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
  if (!sha.test(revision) || (await read(['rev-parse', '--verify', revision+'^{commit}'])).stdout.toString().trim() !== revision)
    throw Error('revision_unavailable');
  const entries = (await read(['ls-tree','-rz', revision,'--', ...releaseBoundaryFiles,'scripts','migrations'])).stdout.toString().split('\0').filter(Boolean);
  const selected = new Set<string>();
  for (const entry of entries) {
    const [header, name] = entry.split('\t');
    if (!name || !(releaseBoundaryFiles.includes(name) || /^scripts\/[\w.-]+\.mjs$/.test(name) || /^migrations\/[\w.-]+\.sql$/.test(name))) continue;
    if (!/^100(?:644|755) blob [0-9a-f]{40}$/.test(header!)) throw Error('release_artifact_invalid');
    selected.add(name);
  }
  for (const required of [...releaseBoundaryFiles, 'scripts/apply-migrations.mjs']) if (!selected.has(required)) throw Error('release_artifact_missing');
  for (const name of selected) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, (await read(['show', revision+':'+name])).stdout, { flag: 'wx', mode: 0o600 });
  }
  const module = (name:string) => import(pathToFileURL(path.join(root, name)).href);
  const { applyMigrations: migrate } = await module('scripts/apply-migrations.mjs') as { applyMigrations: typeof applyMigrations };
  const { verifyRuntimeBoundary: verify } = await module('src/server/runtime-boundary.mjs') as { verifyRuntimeBoundary: typeof verifyRuntimeBoundary };
  return { root, migrate, verify };
}

export async function rehearseSchema(environment: string, webRevision: string, workerRevision: string, candidateRevision: string, repository=releaseRoot) {
  if (!environments.includes(environment) || ![webRevision,workerRevision,candidateRevision].every(value=>sha.test(value)))
    return { ok:false, code:'expected_environment_and_three_full_commit_ids', recovery };
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'flockletter-compatibility-'));
  let stage = 'revision_artifacts';
  try {
    const artifacts = new Map<string,Awaited<ReturnType<typeof readRevision>>>();
    for (const revision of new Set([webRevision,workerRevision,candidateRevision]))
      artifacts.set(revision, await readRevision(repository,path.join(directory,revision),revision));
    const candidate = artifacts.get(candidateRevision)!;
    // Verify each deployed revision's baseline independently, including an older worker.
    const checked: string[] = [];
    const incompatible:string[]=[];
    for (const revision of new Set([webRevision,workerRevision])) {
      const running = artifacts.get(revision)!;
      stage = 'existing_schema_install';
      const fixture = await startDatabase(running.migrate);
      try {
        const verify = async (verifyBoundary:typeof verifyRuntimeBoundary) => {
          const client = new pg.Client({connectionString:fixture.url,statement_timeout:10000});
          await client.connect();
          try { await verifyBoundary(client, {database:'flockletter_test',role:'flockletter_runtime'}); }
          finally { await client.end(); }
        };
        stage = 'existing_runtime_on_existing_schema';
        await verify(running.verify);
        stage = 'candidate_migration';
        const owner = new pg.Client({connectionString:fixture.adminUrl,statement_timeout:30000});
        await owner.connect();
        try { await candidate.migrate(owner,'flockletter_runtime'); } finally { await owner.end(); }
        stage = 'candidate_runtime_on_new_schema';
        await verify(candidate.verify);
        stage = revision === webRevision ? 'serving_web_on_new_schema' : 'serving_worker_on_new_schema';
        try { await verify(running.verify); checked.push(revision); }
        catch {
          if(revision===webRevision)incompatible.push('web');
          if(revision===workerRevision)incompatible.push('worker');
        }
      } finally { await fixture.stop(); }
    }
    if(incompatible.length)return {ok:false,code:incompatible.includes('web')?'serving_web_on_new_schema':'serving_worker_on_new_schema',
      incompatible,webRevision,workerRevision,candidateRevision,recovery};
    stage='candidate_fingerprint';
    const sourceFingerprint=await releaseSourceFingerprint(candidate.root);
    return { ok:true, version:1, environment, webRevision, workerRevision, candidateRevision, sourceFingerprint,
      checked, checkedAt:new Date().toISOString() };
  } catch {
    return { ok:false, code:stage, webRevision, workerRevision, candidateRevision, recovery };
  } finally { await rm(directory, { recursive:true, force:true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [environment,web,worker,candidate] = process.argv.slice(2);
  const result = process.argv.length === 6 ? await rehearseSchema(environment!,web!,worker!,candidate!) : {ok:false,code:'expected_environment_and_three_full_commit_ids',recovery};
  process.stdout.write(JSON.stringify(result)+'\n');
  process.exitCode = result.ok ? 0 : 1;
}
