import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { startDatabase } from '../scripts/database-fixture.js';
import tables from '../src/shared/runtime-tables.json' with { type: 'json' };
import { verifyRuntimeBoundary } from '../src/server/runtime-boundary.mjs';
import { hasSupportedProductionConnectionOptions } from '../scripts/production-connection.mjs';

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

function prepare(adminUrl: string) {
  return spawnSync(process.execPath, ['scripts/prepare-production-schemas.mjs'], {
    input: JSON.stringify({adminUrl,expectedDatabase:'flockletter_production',confirmProduction:true})+'\n',
    encoding:'utf8',timeout:25000,env:{...process.env,APP_ENV:'production'},
  });
}

it('rejects connection query overrides and duplicates before connecting, allowing only one supported sslmode', () => {
  // This is the real driver parser, without a network connection: query fields override URL fields.
  const overridden=new pg.Client({connectionString:'postgresql://url_user:url_password@url.example/url_db?host=query.example&user=query_user&database=query_db'});
  expect(overridden).toMatchObject({host:'query.example',user:'query_user',database:'url_db'});
  const targetUrl=new URL(releaseInput.adminUrl);targetUrl.pathname='/flockletter_production';
  for(const search of ['?host=query.example','?user=query_user','?database=query_db','?password=private-query-marker',
    '?port=12345','?sslmode=disable&sslmode=disable','?sslmode=disable&application_name=unexpected',
    '?sslmode=unsupported','?sslmode=','?options=-csearch_path%3Dpublic','#unexpected']) {
    for(const url of [new URL(releaseInput.adminUrl),new URL(targetUrl)]) {
      if(search.startsWith('#')) url.hash=search;else url.search=search;
      const result=url.pathname==='/flockletter_production'?prepare(url.href):run('apply',{...releaseInput,adminUrl:url.href});
      expect(result.status).not.toBe(0);
      expect(result.stdout+result.stderr).not.toContain('private-query-marker');
      expect(result.stderr).toMatch(/database_scope_invalid|explicitly selected production host/);
    }
  }
  for(const mode of ['disable','no-verify','prefer','require','verify-ca','verify-full']) {
    const url=new URL(releaseInput.adminUrl);url.searchParams.set('sslmode',mode);
    expect(hasSupportedProductionConnectionOptions(url)).toBe(true);
  }
  const valid=new URL(releaseInput.adminUrl);valid.searchParams.set('sslmode','disable');
  const inspected=run('inspect',{...releaseInput,adminUrl:valid.href});
  expect(inspected.status,inspected.stderr).toBe(0);
  expect(JSON.parse(inspected.stdout).databaseExists).toBe(false);
});

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
    expect(refused.stderr).toContain('foreign database grants a Flockletter role access');
    expect((await foreign.query('SELECT id FROM unrelated_fixture')).rows).toEqual([{id:1}]);
    expect((await foreign.query("SELECT has_table_privilege('flockletter_production_runtime','unrelated_fixture','SELECT') allowed")).rows[0].allowed).toBe(true);
    expect((await foreign.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='flockletter_production_runtime'")).rows[0].rolcanlogin).toBe(false);
    // Test-owned fixture cleanup only; the release helper must never repair foreign grants.
    await foreign.query('REVOKE SELECT ON unrelated_fixture FROM PUBLIC');
    for(const role of ['flockletter_production_migrator','flockletter_production_runtime']) {
      for(const privilege of ['SELECT','MAINTAIN']) {
        await foreign.query(`GRANT ${privilege} ON unrelated_fixture TO ${role}`);
        const refused=run('apply');
        expect(refused.status).not.toBe(0);
        expect(refused.stderr).toContain('foreign database grants a Flockletter role access');
        expect((await foreign.query(`SELECT has_table_privilege($1,'unrelated_fixture',$2) allowed`,[role,privilege])).rows[0].allowed).toBe(true);
        expect((await foreign.query('SELECT id FROM unrelated_fixture')).rows).toEqual([{id:1}]);
        expect((await foreign.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=ANY($1)',
          [['flockletter_production_runtime','flockletter_production_migrator']])).rows).toEqual([{rolcanlogin:false},{rolcanlogin:false}]);
        await foreign.query(`REVOKE ${privilege} ON unrelated_fixture FROM ${role}`);
      }
      for(const [grant,revoke] of [
        [`GRANT SELECT(id) ON unrelated_fixture TO ${role}`,`REVOKE SELECT(id) ON unrelated_fixture FROM ${role}`],
        [`GRANT CREATE ON DATABASE fixture_production_control TO ${role}`,`REVOKE CREATE ON DATABASE fixture_production_control FROM ${role}`],
      ] as const) {
        await foreign.query(grant);
        const refused=run('apply');
        expect(refused.status).not.toBe(0);
        expect(refused.stderr).toContain('foreign database grants a Flockletter role access');
        expect((await foreign.query('SELECT id FROM unrelated_fixture')).rows).toEqual([{id:1}]);
        await foreign.query(revoke);
      }
    }
  } finally { await foreign.end(); }

  for(let attempt=0;attempt<2;attempt++) {
    const result=run('apply');
    expect(result.status,result.stderr).toBe(0);
    expect(result.stdout).toContain('"verified":true');
    expect(result.stdout).toContain('"protected_tables":'+tables.length);
    for(const value of [releaseInput.adminUrl,releaseInput.runtimePassword,releaseInput.migratorPassword])
      expect(result.stdout+result.stderr).not.toContain(value);
  }
  const ownerUrl=new URL(releaseInput.adminUrl);ownerUrl.pathname='/flockletter_production';
  const root=new pg.Client({connectionString:fixture.adminUrl});await root.connect();
  try {
    await root.query('GRANT flockletter_runtime TO flockletter_production_migrator');
    const refused=prepare(ownerUrl.href);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('migrator_marker_invalid');
    expect((await root.query("SELECT 1 FROM pg_auth_members WHERE member='flockletter_production_migrator'::regrole")).rowCount).toBe(1);
    await root.query('REVOKE flockletter_runtime FROM flockletter_production_migrator');
  } finally { await root.end(); }
  const preparedAgain=prepare(ownerUrl.href);
  expect(preparedAgain.status,preparedAgain.stderr).toBe(0);
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
