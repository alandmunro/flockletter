import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { startDatabase } from '../scripts/database-fixture.js';
import tables from '../src/shared/runtime-tables.json' with { type: 'json' };
import { verifyRuntimeBoundary } from '../src/server/runtime-boundary.mjs';

let fixture: Awaited<ReturnType<typeof startDatabase>>;
let releaseInput: {adminUrl:string;expectedHost:string;expectedSource:string;runtimePassword:string;migratorPassword:string;confirmProduction:boolean};
const secret = () => randomBytes(32).toString('hex');

beforeAll(async () => {
  fixture = await startDatabase();
  const admin = new pg.Client({ connectionString: fixture.adminUrl });
  const password = secret();
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE fixture_operator LOGIN CREATEDB CREATEROLE NOSUPERUSER PASSWORD '${password}'`);
    await admin.query('CREATE DATABASE fixture_production_control OWNER fixture_operator');
  } finally { await admin.end(); }
  const url = new URL(fixture.adminUrl);
  url.username = 'fixture_operator'; url.password = password; url.pathname = '/fixture_production_control';
  releaseInput = {adminUrl:url.href,expectedHost:url.hostname,expectedSource:'fixture_production_control',
    runtimePassword:secret(),migratorPassword:secret(),confirmProduction:true};
});
afterAll(async () => { await fixture?.stop(); });

function run(mode: string, input = releaseInput, environment = 'production') {
  return spawnSync(process.execPath, ['scripts/provision-production.mjs', mode], {
    input: JSON.stringify(input)+'\n',encoding:'utf8',timeout:25000,
    env:{...process.env,APP_ENV:environment},
  });
}

it('refuses wrong host, staging source, missing confirmation and nonproduction execution', () => {
  for (const input of [
    {...releaseInput,expectedHost:'unexpected.example'},
    {...releaseInput,expectedSource:'fixture_staging_control'},
    {...releaseInput,confirmProduction:false},
    {...releaseInput,adminUrl:releaseInput.runtimePassword},
  ]) {
    const result=run('apply',input);
    expect(result.status).not.toBe(0);
    expect(result.stdout+result.stderr).not.toContain(releaseInput.runtimePassword);
  }
  expect(run('apply',releaseInput,'staging').status).not.toBe(0);
});

it('preserves foreign grants and data, then provisions and replays the complete restricted database', async () => {
  expect(JSON.parse(run('inspect').stdout).databaseExists).toBe(false);
  const prepared=run('prepare');
  expect(prepared.status,prepared.stderr).toBe(0);
  const inspection=JSON.parse(run('inspect').stdout);
  expect(inspection.databaseExists).toBe(true);
  expect(inspection.rolesPresent).toEqual([]);

  const foreignUrl=new URL(fixture.adminUrl);foreignUrl.pathname='/fixture_production_control';
  const foreign=new pg.Client({connectionString:foreignUrl.href});
  await foreign.connect();
  try {
    await foreign.query('CREATE TABLE unrelated_fixture (id integer)');
    await foreign.query('INSERT INTO unrelated_fixture VALUES (1)');
    await foreign.query('GRANT SELECT ON unrelated_fixture TO PUBLIC');
    const refused=run('apply');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('foreign database grants the runtime access');
    expect((await foreign.query('SELECT id FROM unrelated_fixture')).rows).toEqual([{id:1}]);
    expect((await foreign.query("SELECT has_table_privilege('flockletter_production_runtime','unrelated_fixture','SELECT') allowed")).rows[0].allowed).toBe(true);
    expect((await foreign.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='flockletter_production_runtime'")).rows[0].rolcanlogin).toBe(false);
    // Test-owned fixture cleanup only; the release helper must never repair foreign grants.
    await foreign.query('REVOKE SELECT ON unrelated_fixture FROM PUBLIC');
  } finally { await foreign.end(); }

  for(let attempt=0;attempt<2;attempt++) {
    const result=run('apply');
    expect(result.status,result.stderr).toBe(0);
    expect(result.stdout).toContain('"verified":true');
    expect(result.stdout).toContain('"protected_tables":'+tables.length);
    for(const value of [releaseInput.adminUrl,releaseInput.runtimePassword,releaseInput.migratorPassword])
      expect(result.stdout+result.stderr).not.toContain(value);
  }
  const runtimeUrl=new URL(String(releaseInput.adminUrl));
  runtimeUrl.pathname='/flockletter_production';runtimeUrl.username='flockletter_production_runtime';
  runtimeUrl.password=String(releaseInput.runtimePassword);
  const migratorUrl=new URL(runtimeUrl);
  migratorUrl.username='flockletter_production_migrator';migratorUrl.password=releaseInput.migratorPassword;
  const migrate=(migrationUrl:string,selectedRuntime=runtimeUrl.href,pair=true)=>spawnSync(process.execPath,
    ['scripts/migrate-production.mjs','fixture-release',...(pair?['--pair-stdin']:[])],
    {input:JSON.stringify({migrationUrl,runtimeUrl:selectedRuntime})+'\n',encoding:'utf8',timeout:25000,
      env:{...process.env,APP_ENV:'production'}});
  const updated=migrate(migratorUrl.href);
  expect(updated.status,updated.stderr).toBe(0);
  expect(updated.stdout).toContain('migrations applied to isolated production');
  for(const value of [migratorUrl.href,runtimeUrl.href,releaseInput.runtimePassword,releaseInput.migratorPassword])
    expect(updated.stdout+updated.stderr).not.toContain(value);
  const wrongDatabase=new URL(runtimeUrl);wrongDatabase.pathname='/flockletter_staging';
  expect(migrate(migratorUrl.href,wrongDatabase.href).status).not.toBe(0);
  expect(migrate(migratorUrl.href,runtimeUrl.href,false).status).not.toBe(0);
  const runtime=new pg.Client({connectionString:runtimeUrl.href});
  await runtime.connect();
  try {
    await expect(verifyRuntimeBoundary(runtime,{database:'flockletter_production',role:runtimeUrl.username}))
      .resolves.toMatchObject({protected_tables:tables.length});
    expect((await runtime.query("SELECT has_database_privilege(current_user,current_database(),'CREATE') AS can_create")).rows[0].can_create).toBe(false);
    expect((await runtime.query('SELECT 1 FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1))',
      [['flockletter_production_runtime','flockletter_production_migrator']])).rows).toEqual([]);
  } finally { await runtime.end(); }
});
