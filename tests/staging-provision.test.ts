import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { startDatabase } from '../scripts/database-fixture.js';
import tables from '../src/shared/runtime-tables.json' with {type:'json'};
import { verifyRuntimeBoundary } from '../src/server/runtime-boundary.mjs';

let fixture: Awaited<ReturnType<typeof startDatabase>>;
let releaseInput: { adminUrl: string; expectedHost: string; expectedSource: string; runtimePassword: string; migratorPassword: string };
const secret = () => randomBytes(32).toString('hex');

beforeAll(async () => {
  fixture = await startDatabase();
  const admin = new pg.Client({ connectionString: fixture.adminUrl });
  const password = secret();
  const source = 'fixture_staging_control';
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE fixture_operator LOGIN CREATEDB CREATEROLE NOSUPERUSER PASSWORD '${password}'`);
    await admin.query(`CREATE DATABASE ${source} OWNER fixture_operator`);
  } finally { await admin.end(); }
  const url = new URL(fixture.adminUrl);
  url.username = 'fixture_operator'; url.password = password; url.pathname = `/${source}`;
  releaseInput = { adminUrl: url.href, expectedHost: url.hostname, expectedSource: source, runtimePassword: secret(), migratorPassword: secret() };
});
afterAll(async () => { await fixture?.stop(); });

function run(mode: string, input = releaseInput) {
  return spawnSync(process.execPath, ['scripts/provision-staging.mjs', mode], { input: JSON.stringify(input) + '\n', encoding: 'utf8', timeout: 25000 });
}

it('inspects, provisions and replays a dedicated database as a non-superuser, without printing secrets', async () => {
  const inspection = run('inspect');
  expect(inspection.status, inspection.stderr).toBe(0);
  expect(JSON.parse(inspection.stdout).databaseExists).toBe(false);
  const prepared = run('prepare');
  expect(prepared.status, prepared.stderr).toBe(0);
  expect(prepared.stdout).toContain('"prepared":true');
  const preparedInspection = JSON.parse(run('inspect').stdout);
  expect(preparedInspection.databaseExists).toBe(true);
  expect(preparedInspection.rolesPresent).toEqual([]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run('apply');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"verified":true');
    expect(result.stdout).toContain('"protected_tables":'+tables.length);
    for (const value of [releaseInput.adminUrl, releaseInput.migratorPassword, releaseInput.runtimePassword]) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  }
  const controlUrl=new URL(fixture.adminUrl);
  controlUrl.pathname='/flockletter_staging';
  const runtimeUrl=new URL(controlUrl);
  runtimeUrl.username='flockletter_staging_runtime'; runtimeUrl.password=releaseInput.runtimePassword;
  const control=new pg.Client({connectionString:controlUrl.href}), runtime=new pg.Client({connectionString:runtimeUrl.href});
  await control.connect(); await runtime.connect();
  try {
    const expected={database:'flockletter_staging',role:'flockletter_staging_runtime'};
    await expect(verifyRuntimeBoundary(runtime,expected)).resolves.toMatchObject({protected_tables:tables.length});
    await control.query('GRANT UPDATE (token_hash) ON subscriber_marketing_links TO flockletter_staging_runtime');
    await expect(verifyRuntimeBoundary(runtime,expected)).rejects.toThrow('Unexpected runtime privileges for subscriber_marketing_links');
    const repaired=run('apply');
    expect(repaired.status,repaired.stderr).toBe(0);
    expect((await runtime.query("SELECT has_column_privilege(current_user,'subscriber_marketing_links','token_hash','UPDATE') AS writable")).rows[0].writable).toBe(false);
    await control.query('CREATE POLICY extra_fixture_policy ON sandbox_checkouts FOR SELECT USING(true)');
    try {
      await expect(verifyRuntimeBoundary(runtime,expected)).rejects.toThrow('workspace and brand policies');
    } finally { await control.query('DROP POLICY extra_fixture_policy ON sandbox_checkouts'); }
    await expect(verifyRuntimeBoundary(runtime,expected)).resolves.toMatchObject({protected_tables:tables.length});
  } finally {await runtime.end();await control.end();}
});

it('refuses a source outside the selected staging host and redacts malformed connection input', () => {
  const wrongHost = run('apply', { ...releaseInput, expectedHost: 'unexpected.example' });
  expect(wrongHost.status).not.toBe(0);
  const malformed = run('inspect', { ...releaseInput, adminUrl: releaseInput.runtimePassword });
  expect(malformed.status).not.toBe(0);
  expect(malformed.stderr).not.toContain(releaseInput.runtimePassword);
});
