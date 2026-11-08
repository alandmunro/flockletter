import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { startDatabase } from '../scripts/database-fixture.js';
import tables from '../src/shared/runtime-tables.json' with { type: 'json' };
import { verifyRuntimeBoundary } from '../src/server/runtime-boundary.mjs';

let fixture: Awaited<ReturnType<typeof startDatabase>>;
let releaseInput: {
  adminUrl: string;
  expectedHost: string;
  expectedSource: string;
  runtimePassword: string;
  migratorPassword: string;
};
const secret = () => randomBytes(32).toString('hex');

beforeAll(async () => {
  fixture = await startDatabase();
  const admin = new pg.Client({ connectionString: fixture.adminUrl });
  const password = secret();
  const source = 'fixture_staging_control';
  await admin.connect();
  try {
    await admin.query(
      `CREATE ROLE fixture_operator LOGIN CREATEDB CREATEROLE NOSUPERUSER PASSWORD '${password}'`,
    );
    await admin.query(`CREATE DATABASE ${source} OWNER fixture_operator`);
  } finally {
    await admin.end();
  }
  const url = new URL(fixture.adminUrl);
  url.username = 'fixture_operator';
  url.password = password;
  url.pathname = `/${source}`;
  releaseInput = {
    adminUrl: url.href,
    expectedHost: url.hostname,
    expectedSource: source,
    runtimePassword: secret(),
    migratorPassword: secret(),
  };
});
afterAll(async () => {
  await fixture?.stop();
});

function run(mode: string, input = releaseInput) {
  return spawnSync(process.execPath, ['scripts/provision-staging.mjs', mode], {
    input: JSON.stringify(input) + '\n',
    encoding: 'utf8',
    timeout: 25000,
  });
}
function prepareSchemas(adminUrl: string, expectedDatabase = 'flockletter_staging') {
  return spawnSync(process.execPath, ['scripts/prepare-customer-schemas.mjs'], {
    input: JSON.stringify({ adminUrl, expectedDatabase }) + '\n',
    encoding: 'utf8',
    timeout: 25000,
  });
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
    expect(result.stdout).toContain('"protected_tables":' + tables.length);
    for (const value of [
      releaseInput.adminUrl,
      releaseInput.migratorPassword,
      releaseInput.runtimePassword,
    ]) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  }
  const controlUrl = new URL(fixture.adminUrl);
  controlUrl.pathname = '/flockletter_staging';
  const runtimeUrl = new URL(controlUrl);
  runtimeUrl.username = 'flockletter_staging_runtime';
  runtimeUrl.password = releaseInput.runtimePassword;
  const control = new pg.Client({ connectionString: controlUrl.href }),
    runtime = new pg.Client({ connectionString: runtimeUrl.href });
  await control.connect();
  await runtime.connect();
  try {
    const schemaOwner = (
      await control.query(`SELECT nspname,pg_get_userbyid(nspowner) AS owner FROM pg_namespace
      WHERE nspname IN ('flockletter_customer_jobs','flockletter_retention_control') ORDER BY nspname`)
    ).rows;
    expect(schemaOwner).toEqual([
      { nspname: 'flockletter_customer_jobs', owner: 'fixture_operator' },
      { nspname: 'flockletter_retention_control', owner: 'fixture_operator' },
    ]);
    expect(
      (
        await control.query(`SELECT has_database_privilege('flockletter_staging_runtime',current_database(),'CREATE') AS runtime,
      has_database_privilege('flockletter_staging_migrator',current_database(),'CREATE') AS migrator`)
      ).rows[0],
    ).toEqual({ runtime: false, migrator: false });
    const ownerUrl = new URL(releaseInput.adminUrl);
    ownerUrl.pathname = '/flockletter_staging';
    const memberships = await control.query(
      'SELECT roleid,member,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member',
    );
    const preparedSchemas = prepareSchemas(ownerUrl.href);
    expect(preparedSchemas.status, preparedSchemas.stderr).toBe(0);
    expect(JSON.parse(preparedSchemas.stdout)).toEqual({
      prepared: true,
      customerJobsSchema: true,
      retentionControlSchema: true,
    });
    for (const value of [ownerUrl.href, releaseInput.runtimePassword, releaseInput.migratorPassword])
      expect(preparedSchemas.stdout + preparedSchemas.stderr).not.toContain(value);
    expect(
      (
        await control.query(
          'SELECT roleid,member,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member',
        )
      ).rows,
    ).toEqual(memberships.rows);
    const privateObjects = (
      await control.query(`SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('flockletter_customer_jobs','flockletter_retention_control') AND c.relkind='r'`)
    ).rows;
    expect(privateObjects.length).toBe(4);
    expect(privateObjects.every((row) => row.owner === 'flockletter_staging_migrator')).toBe(true);
    const schedulerFunctions = (
      await control.query(
        "SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE pronamespace='flockletter_customer_jobs'::regnamespace",
      )
    ).rows;
    expect(schedulerFunctions).toHaveLength(6);
    expect(schedulerFunctions.every((row) => row.owner === 'flockletter_staging_migrator')).toBe(true);
    await control.query('ALTER SCHEMA flockletter_customer_jobs OWNER TO flockletter_staging_migrator');
    const alreadyMigratorOwned = prepareSchemas(ownerUrl.href);
    expect(alreadyMigratorOwned.status, alreadyMigratorOwned.stderr).toBe(0);
    await control.query('GRANT USAGE ON SCHEMA flockletter_customer_jobs TO PUBLIC');
    try {
      expect(JSON.parse(prepareSchemas(ownerUrl.href).stderr)).toEqual({
        prepared: false,
        code: 'schema_grants_invalid',
      });
    } finally {
      await control.query('REVOKE ALL ON SCHEMA flockletter_customer_jobs FROM PUBLIC');
    }
    await control.query('ALTER SCHEMA flockletter_customer_jobs OWNER TO flockletter_runtime');
    try {
      const refused = prepareSchemas(ownerUrl.href);
      expect(refused.status).not.toBe(0);
      expect(JSON.parse(refused.stderr)).toEqual({ prepared: false, code: 'schema_ownership_invalid' });
      expect(
        (
          await control.query(
            "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='flockletter_customer_jobs'",
          )
        ).rows[0].owner,
      ).toBe('flockletter_runtime');
    } finally {
      await control.query('ALTER SCHEMA flockletter_customer_jobs OWNER TO flockletter_staging_migrator');
    }
    await control.query("COMMENT ON DATABASE flockletter_staging IS 'Unverified fixture database'");
    try {
      expect(JSON.parse(prepareSchemas(ownerUrl.href).stderr)).toEqual({
        prepared: false,
        code: 'database_marker_invalid',
      });
    } finally {
      await control.query("COMMENT ON DATABASE flockletter_staging IS 'Flockletter staging foundation'");
    }
    await control.query("COMMENT ON ROLE flockletter_staging_migrator IS 'Unverified fixture role'");
    try {
      expect(JSON.parse(prepareSchemas(ownerUrl.href).stderr)).toEqual({
        prepared: false,
        code: 'migrator_marker_invalid',
      });
    } finally {
      await control.query("COMMENT ON ROLE flockletter_staging_migrator IS 'Flockletter staging foundation'");
    }
    const wrongScope = prepareSchemas(releaseInput.adminUrl);
    expect(wrongScope.status).not.toBe(0);
    expect(JSON.parse(wrongScope.stderr)).toEqual({ prepared: false, code: 'database_scope_invalid' });
    expect(JSON.parse(prepareSchemas(runtimeUrl.href).stderr)).toEqual({
      prepared: false,
      code: 'database_owner_required',
    });
    const expected = { database: 'flockletter_staging', role: 'flockletter_staging_runtime' };
    await expect(verifyRuntimeBoundary(runtime, expected)).resolves.toMatchObject({
      protected_tables: tables.length,
    });
    await control.query(
      'GRANT UPDATE (token_hash) ON subscriber_marketing_links TO flockletter_staging_runtime',
    );
    await expect(verifyRuntimeBoundary(runtime, expected)).rejects.toThrow(
      'Unexpected runtime privileges for subscriber_marketing_links',
    );
    // Simulate a previously applied 009 schema alongside an unintended column privilege.
    await control.query('ALTER TABLE audience_segment_members DROP CONSTRAINT segment_contact_membership');
    await control.query(
      'ALTER TABLE audience_segment_members ADD CONSTRAINT earlier_segment_fk FOREIGN KEY (workspace_id,brand_id,subscriber_id) REFERENCES subscribers(workspace_id,brand_id,id)',
    );
    const repaired = run('apply');
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(
      (
        await runtime.query(
          "SELECT has_column_privilege(current_user,'subscriber_marketing_links','token_hash','UPDATE') AS writable",
        )
      ).rows[0].writable,
    ).toBe(false);
    expect(
      (
        await control.query(
          "SELECT confdeltype FROM pg_constraint WHERE conrelid='audience_segment_members'::regclass AND confrelid='subscribers'::regclass",
        )
      ).rows,
    ).toEqual([{ confdeltype: 'c' }]);
    await control.query('CREATE POLICY extra_fixture_policy ON sandbox_checkouts FOR SELECT USING(true)');
    try {
      await expect(verifyRuntimeBoundary(runtime, expected)).rejects.toThrow('workspace and brand policies');
    } finally {
      await control.query('DROP POLICY extra_fixture_policy ON sandbox_checkouts');
    }
    await expect(verifyRuntimeBoundary(runtime, expected)).resolves.toMatchObject({
      protected_tables: tables.length,
    });
  } finally {
    await runtime.end();
    await control.end();
  }
});

it('refuses a source outside the selected staging host and redacts malformed connection input', () => {
  const wrongHost = run('apply', { ...releaseInput, expectedHost: 'unexpected.example' });
  expect(wrongHost.status).not.toBe(0);
  const malformed = run('inspect', { ...releaseInput, adminUrl: releaseInput.runtimePassword });
  expect(malformed.status).not.toBe(0);
  expect(malformed.stderr).not.toContain(releaseInput.runtimePassword);
});
