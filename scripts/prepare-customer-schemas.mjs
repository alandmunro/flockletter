// Existing staging release administrators run this before migrations. No role or password changes.
import pg from 'pg';
import { createInterface } from 'node:readline/promises';
import { URL, pathToFileURL } from 'node:url';
import process from 'node:process';

const database = 'flockletter_staging';
const migrator = 'flockletter_staging_migrator';
const marker = 'Flockletter staging foundation';
const schemas = ['flockletter_customer_jobs', 'flockletter_retention_control'];

function reject(code) {
  const error = new Error('Customer schema preparation was refused.');
  error.code = code;
  throw error;
}

/** Prepare only the reviewed namespaces; objects created by migrations remain migrator-owned. */
export async function prepareCustomerSchemas(client) {
  let phase = 'schema_validation';
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('flockletter:customer-schemas'))");
    const identity = (
      await client.query(`SELECT d.datname AS database,d.datdba AS database_owner,
      r.oid AS actor,shobj_description(d.oid,'pg_database') AS marker
      FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)
    ).rows[0];
    if (identity?.database !== database || identity.marker !== marker) reject('database_marker_invalid');
    if (identity.actor !== identity.database_owner) reject('database_owner_required');
    const role = (
      await client.query(
        `SELECT oid,rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication AS unsafe,
      shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1`,
        [migrator],
      )
    ).rows[0];
    if (!role || role.unsafe || role.marker !== marker) reject('migrator_marker_invalid');
    const existing = (
      await client.query('SELECT nspname,nspowner FROM pg_namespace WHERE nspname=ANY($1)', [schemas])
    ).rows;
    if (existing.some((schema) => ![identity.database_owner, role.oid].includes(schema.nspowner)))
      reject('schema_ownership_invalid');
    // Every identifier below is a fixed source constant. Namespace ownership is never changed.
    for (const schema of schemas) {
      const found = existing.find((row) => row.nspname === schema);
      if (found?.nspowner === role.oid) {
        // The database owner may lack SET authority for this role. Never alter role membership.
        const grants = (
          await client.query(
            `SELECT
          has_schema_privilege($1,$2,'USAGE WITH GRANT OPTION') AS can_use,
          has_schema_privilege($1,$2,'CREATE WITH GRANT OPTION') AS can_create,
          EXISTS(SELECT FROM pg_namespace n,
            LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
            WHERE n.nspname=$2 AND a.grantee=0) AS public_access`,
            [migrator, schema],
          )
        ).rows[0];
        if (!grants.can_use || !grants.can_create || grants.public_access) reject('schema_grants_invalid');
        continue;
      }
      phase = 'schema_creation';
      if (!found) await client.query(`CREATE SCHEMA ${schema}`);
      phase = 'schema_public_grants';
      await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`GRANT USAGE,CREATE ON SCHEMA ${schema} TO ${migrator} WITH GRANT OPTION`);
    }
    await client.query('COMMIT');
    return { prepared: true, customerJobsSchema: true, retentionControlSchema: true };
  } catch (error) {
    await client.query('ROLLBACK');
    error.schemaPreparationPhase = phase;
    throw error;
  }
}

async function main() {
  const input = createInterface({ input: process.stdin, terminal: false });
  const line = await input[Symbol.asyncIterator]().next();
  input.close();
  let settings, url;
  try {
    if (line.done) reject('private_input_invalid');
    settings = JSON.parse(line.value);
    url = new URL(settings.adminUrl);
  } catch {
    reject('private_input_invalid');
  }
  if (
    settings.expectedDatabase !== database ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.pathname !== `/${database}` ||
    !url.username ||
    !url.password
  )
    reject('database_scope_invalid');
  const client = new pg.Client({
    connectionString: url.href,
    connectionTimeoutMillis: 8000,
    statement_timeout: 30000,
  });
  await client.connect();
  try {
    process.stdout.write(JSON.stringify(await prepareCustomerSchemas(client)) + '\n');
  } finally {
    await client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    // Never emit SQL, provider messages, connection strings, stdin, role passwords or key material.
    const code =
      typeof error?.code === 'string' && /^[a-zA-Z0-9_]{1,60}$/.test(error.code)
        ? error.code
        : 'preparation_failed';
    process.stderr.write(JSON.stringify({ prepared: false, code }) + '\n');
    process.exitCode = 1;
  }
}
