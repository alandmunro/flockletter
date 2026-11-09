// Releases use the unlinked migration secret only in this private process.
import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import pg from 'pg';
import { applyMigrations } from './apply-migrations.mjs';
import { verifyRuntimeBoundary } from '../src/server/runtime-boundary.mjs';

async function run() {
  const tag = process.argv[2];
  if (process.stdin.isTTY && !/^[a-z0-9-]{8,64}$/.test(tag ?? ''))
    throw new Error('An interactive release requires an operation tag.');
  const input = createInterface({ input: process.stdin, terminal: false });
  if (process.stdin.isTTY) console.log('PRIVATE_INPUT_READY ' + tag);
  const line = await input[Symbol.asyncIterator]().next();
  input.close();
  let migration, runtime;
  try {
    // In a protected, echo-disabled terminal the operator can paste the existing
    // migration URI directly. Never accept a credential on the command line.
    const pair = process.argv[3] === '--pair-stdin';
    if (!pair) throw new Error('Invalid private production release input.');
    const data = JSON.parse(line.value);
    migration = new URL(data.migrationUrl);
    runtime = new URL(data.runtimeUrl);
  } catch {
    throw new Error('Invalid private production release input.');
  }
  if (
    process.env.APP_ENV !== 'production' ||
    !['postgres:', 'postgresql:'].includes(migration.protocol) ||
    !['postgres:', 'postgresql:'].includes(runtime.protocol) ||
    migration.host !== runtime.host ||
    migration.pathname !== '/flockletter_production' ||
    runtime.pathname !== migration.pathname ||
    migration.username !== 'flockletter_production_migrator' ||
    runtime.username !== 'flockletter_production_runtime' ||
    !migration.password ||
    !runtime.password
  )
    throw new Error('Refusing a release outside the isolated production database.');
  const client = new pg.Client({
    connectionString: migration.href,
    connectionTimeoutMillis: 8000,
    statement_timeout: 30000,
  });
  await client.connect();
  try {
    const identity = (await client.query('SELECT current_database() AS db,current_user AS who')).rows[0];
    if (identity.db !== 'flockletter_production' || identity.who !== migration.username)
      throw new Error('Unexpected release identity.');
    await applyMigrations(client, runtime.username);
  } finally {
    await client.end();
  }
  const runtimeCheck = new pg.Client({connectionString:runtime.href,connectionTimeoutMillis:8000,statement_timeout:30000});
  await runtimeCheck.connect();
  try {
    await verifyRuntimeBoundary(runtimeCheck,{database:'flockletter_production',role:'flockletter_production_runtime'});
  } finally {
    await runtimeCheck.end();
  }
  console.log('Flockletter migrations applied to isolated production.');
}
try {
  await run();
} catch (error) {
  console.error('Production migration failed' + (error.code ? ' (' + error.code + ')' : '') + '.');
  process.exitCode = 1;
}
