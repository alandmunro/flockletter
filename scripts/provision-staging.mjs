// Run only in a protected release shell. Inputs are read from stdin, never argv or service env.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { applyMigrations } from './apply-migrations.mjs';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import pg from 'pg';

const target = 'flockletter_staging';
const runtime = 'flockletter_staging_runtime';
const migrator = 'flockletter_staging_migrator';
const marker = 'Flockletter staging foundation';
const mode = process.argv[2];
if (!['inspect', 'prepare', 'apply'].includes(mode)) throw new Error('Choose inspect, prepare or apply.');

// PostgreSQL's SCRAM-SHA-256 stored-password format (RFC 5802). Only verifiers appear in DDL.
function verifier(password) {
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('Supply a fresh 32-byte random hex secret for each role.');
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const keyed = text => createHmac('sha256', salted).update(text).digest();
  const stored = createHash('sha256').update(keyed('Client Key')).digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${keyed('Server Key').toString('base64')}`;
}

const input = createInterface({ input: process.stdin, terminal: false });
if (process.stdin.isTTY) {
  const tag = process.argv[3];
  if (!/^[a-z0-9-]{8,64}$/.test(tag ?? '')) throw new Error('An interactive release requires a fresh public operation tag.');
  console.log(`PRIVATE_INPUT_READY ${tag}`);
}
const line = await input[Symbol.asyncIterator]().next();
input.close();
if (line.done) throw new Error('Missing private release input.');
let settings;
let url;
try {
  settings = JSON.parse(line.value);
  url = new URL(settings.adminUrl);
} catch { throw new Error('Invalid private release input.'); }
if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== settings.expectedHost ||
    url.pathname !== `/${settings.expectedSource}` || !settings.expectedSource?.includes('staging') ||
    settings.expectedSource === target || !url.password) throw new Error('The administration connection must match the explicitly selected staging host and source database.');

function connect(database, role, password) {
  const connection = new URL(url);
  connection.pathname = `/${database}`;
  if (role) { connection.username = role; connection.password = password; }
  return new pg.Client({ connectionString: connection.href, connectionTimeoutMillis: 8000, statement_timeout: 30000 });
}

async function using(client, action) {
  await client.connect();
  try { return await action(client); } finally { await client.end(); }
}

async function provision(admin) {
  await admin.query("SELECT pg_advisory_lock(hashtext('flockletter:staging:provision'))");
  const info = (await admin.query(`SELECT current_database() AS source, rolcreatedb, rolcreaterole,
    current_setting('max_connections')::int AS max_connections,
    current_setting('superuser_reserved_connections')::int + coalesce(current_setting('reserved_connections',true),'0')::int AS reserved_connections,
    (SELECT coalesce(sum(numbackends),0)::int FROM pg_stat_database WHERE datid<>0) AS active_backends
    FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if (info.source !== settings.expectedSource || !info.rolcreatedb || !info.rolcreaterole) throw new Error('The selected staging administrator cannot provision the database and roles.');
  const database = (await admin.query("SELECT datname, shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [target])).rows[0];
  const roles = (await admin.query(`SELECT rolname, rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication AS unsafe,
    shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=ANY($1)`, [[migrator, runtime]])).rows;
  if ((database && database.marker !== marker) || roles.some(r => r.unsafe || r.marker !== marker)) throw new Error('An existing database or role lacks the Flockletter ownership marker. Review before making changes.');
  console.log(JSON.stringify({ mode, target, databaseExists: Boolean(database), rolesPresent: roles.map(r => r.rolname), maxConnections: info.max_connections, currentBackends: info.active_backends }));
  if (mode === 'inspect') return;
  if (info.max_connections - info.reserved_connections - info.active_backends < 12) throw new Error('Insufficient connection headroom for deployment overlap.');
  if (!database) {
    await admin.query(`CREATE DATABASE ${target} ALLOW_CONNECTIONS false`);
    await admin.query(`COMMENT ON DATABASE ${target} IS '${marker}'`);
  }
  await admin.query(`REVOKE ALL ON DATABASE ${target} FROM PUBLIC`);
  if (mode === 'prepare') {
    console.log(JSON.stringify({ prepared: true, database: target }));
    return;
  }
  if (settings.runtimePassword === settings.migratorPassword) throw new Error('Use distinct role secrets.');
  const passwords = { [runtime]: settings.runtimePassword, [migrator]: settings.migratorPassword };
  await admin.query('BEGIN');
  try {
    for (const role of [migrator, runtime]) {
      if (!roles.some(r => r.rolname === role)) {
        await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT ${role === runtime ? 10 : 2} PASSWORD '${verifier(passwords[role])}'`);
        await admin.query(`COMMENT ON ROLE ${role} IS '${marker}'`);
      }
    }
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
  const memberships = await admin.query('SELECT 1 FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1))', [[runtime, migrator]]);
  if (memberships.rowCount) throw new Error('The Flockletter roles have additional role memberships. Review before activation.');
  const other = await admin.query('SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate AND datname<>$1 AND has_database_privilege($2,datname,\'CONNECT\')', [target, runtime]);
  for (const { datname } of other.rows) {
    await using(connect(datname), async audit => {
      const result = await audit.query(`SELECT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege($1,n.oid,'USAGE')
        AND CASE WHEN c.relkind='S' THEN has_sequence_privilege($1,c.oid,'SELECT,USAGE,UPDATE')
          WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ELSE false END
      ) OR EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND p.prosecdef
        AND has_schema_privilege($1,n.oid,'USAGE') AND has_function_privilege($1,p.oid,'EXECUTE')
      ) OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege($1,n.oid,'CREATE')) AS unsafe`, [runtime]);
      if (result.rows[0].unsafe) throw new Error('A foreign database grants the runtime access to application objects or a privileged function. Review its grants before activation.');
    });
  }
  await admin.query(`GRANT CONNECT ON DATABASE ${target} TO ${migrator},${runtime}`);
  await admin.query(`ALTER DATABASE ${target} ALLOW_CONNECTIONS true`);
  await using(connect(target), async owner => {
    await owner.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await owner.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${migrator} WITH GRANT OPTION`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${runtime}`);
  });
  await admin.query(`ALTER ROLE ${migrator} LOGIN`);
  await admin.query(`ALTER ROLE ${runtime} LOGIN`);
  await using(connect(target, migrator, passwords[migrator]), async release => {
    await applyMigrations(release, runtime);
  });
  await using(connect(target, runtime, passwords[runtime]), async app => {
    const check = (await app.query(`SELECT current_database() AS database, current_user AS role,
      (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relrowsecurity AND relforcerowsecurity) AS protected_tables,
      has_schema_privilege(current_user,'public','CREATE') AS schema_create,
      has_database_privilege(current_user,current_database(),'CREATE') AS database_create`)).rows[0];
    if (check.database !== target || check.role !== runtime || check.protected_tables !== 15 || check.schema_create || check.database_create) throw new Error('Runtime isolation check failed.');
    console.log(JSON.stringify({ verified: true, foreignCatalogsChecked: other.rowCount, ...check }));
  });
}

try { await using(connect(settings.expectedSource), provision); }
catch (error) {
  // PostgreSQL errors can include SQL or request parameters. Emit only an error category.
  console.error(error.code ? `Staging database operation failed (${error.code}).` : error.message?.replace(/postgres(?:ql)?:\/\/\S+/gi, '[connection]'));
  process.exitCode = 1;
}
