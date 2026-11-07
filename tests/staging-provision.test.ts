import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { startDatabase } from '../scripts/database-fixture.js';

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

it('inspects, provisions and replays a dedicated database as a non-superuser, without printing secrets', () => {
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
    expect(result.stdout).toContain('"protected_tables":15');
    for (const value of [releaseInput.adminUrl, releaseInput.migratorPassword, releaseInput.runtimePassword]) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  }
});

it('refuses a source outside the selected staging host and redacts malformed connection input', () => {
  const wrongHost = run('apply', { ...releaseInput, expectedHost: 'unexpected.example' });
  expect(wrongHost.status).not.toBe(0);
  const malformed = run('inspect', { ...releaseInput, adminUrl: releaseInput.runtimePassword });
  expect(malformed.status).not.toBe(0);
  expect(malformed.stderr).not.toContain(releaseInput.runtimePassword);
});
