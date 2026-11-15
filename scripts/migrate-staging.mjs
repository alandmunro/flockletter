import {Buffer} from 'node:buffer';
// Releases use the unlinked migration secret only in this private process.
import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import pg from 'pg';
import { applyMigrations } from './apply-migrations.mjs';
import { verifyRuntimeBoundary } from '../src/server/runtime-boundary.mjs';
import {releaseInputPreflight,refuseReleaseInput} from './release-input.mjs';
import {migrationEvidenceGaps,readProtectedReleaseFile,releaseSourceFingerprint} from './release-plan.mjs';
import {checkMigrationIdentity} from './check-migration-identity.mjs';

async function run() {
  const tag = process.argv[2];
  if (process.stdin.isTTY && !/^[a-z0-9-]{8,64}$/.test(tag ?? ''))
    throw new Error('An interactive release requires an operation tag.');
  const input = createInterface({ input: process.stdin, terminal: false });
  if (process.stdin.isTTY) console.log('PRIVATE_INPUT_READY ' + tag);
  const line = await input[Symbol.asyncIterator]().next();
  input.close();
  let data;
  try {
  if(line.done||Buffer.byteLength(line.value,'utf8')>65536)throw Error('Invalid input.');
    const single=process.argv[3]==='--uri-stdin',pair=process.argv[3]==='--pair-stdin';
    if(!single&&!pair)throw Error('Invalid input.');
    data=single?{migrationUrl:line.value,runtimeUrl:process.env.DATABASE_URL,compatibility:JSON.parse(await readProtectedReleaseFile(process.argv[4],4096))}:JSON.parse(line.value);
  } catch { refuseReleaseInput(['private_input_invalid']); }
  const compatibility=data?.compatibility;
  if(data&&typeof data==='object')delete data.compatibility;
  const gaps=releaseInputPreflight('staging.migrate',data,process.env.APP_ENV);
  if(gaps.length)refuseReleaseInput(gaps);
  const proof=migrationEvidenceGaps(compatibility,'staging',await releaseSourceFingerprint());
  if(proof.length)refuseReleaseInput(proof);
  const identityGaps=await checkMigrationIdentity('staging',compatibility.webRevision);
  if(identityGaps.length)refuseReleaseInput(identityGaps);
  const migration=new URL(data.migrationUrl),runtime=new URL(data.runtimeUrl);
  const client = new pg.Client({
    connectionString: migration.href,
    connectionTimeoutMillis: 8000,
    statement_timeout: 30000,
  });
  await client.connect();
  try {
    const identity = (await client.query('SELECT current_database() AS db,current_user AS who')).rows[0];
    if (identity.db !== 'flockletter_staging' || identity.who !== migration.username)
      throw new Error('Unexpected release identity.');
    await applyMigrations(client, runtime.username);
  } finally {
    await client.end();
  }
  const runtimeCheck = new pg.Client({connectionString:runtime.href,connectionTimeoutMillis:8000,statement_timeout:30000});
  await runtimeCheck.connect();
  try {
    await verifyRuntimeBoundary(runtimeCheck,{database:'flockletter_staging',role:'flockletter_staging_runtime'});
  } finally {
    await runtimeCheck.end();
  }
  console.log('Flockletter migrations applied to isolated staging.');
}
try {
  await run();
} catch (error) {
  console.error('Staging migration failed' + (error.code ? ' (' + error.code + ')' : '') + '.');
  process.exitCode = 1;
}
