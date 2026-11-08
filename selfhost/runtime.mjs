import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { applyMigrations } from '../scripts/apply-migrations.mjs';
import { Database } from '../dist/server/server/db.js';

async function secret(name, required = true) {
  const value = (await readFile('/run/secrets/' + name, 'utf8')).trim();
  if (required && !/^[a-f0-9]{64}$/.test(value)) throw Error('Missing or invalid self-host role credential.');
  return value;
}
async function connection(mode, target = false) {
  const role = mode === 'migrate' ? 'flockletter_migrator' : 'flockletter_runtime';
  const host = target ? 'restore-db' : 'db';
  const database = target ? 'flockletter_restore' : 'flockletter_demo';
  const password = await secret(target ? 'restore-runtime' : mode === 'migrate' ? 'migrator' : 'runtime');
  const url = new URL('postgresql://' + host + '/' + database);
  url.username = role;
  url.password = password;
  return url.href;
}
async function run() {
  const action = process.argv[2];
  if (action === 'migrate') {
    const client = new pg.Client({
      connectionString: await connection('migrate'),
      connectionTimeoutMillis: 8000,
      statement_timeout: 30000,
    });
    await client.connect();
    try {
      const identity = (
        await client.query(
          'SELECT current_database() AS db,current_user AS role,rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls AS unsafe FROM pg_roles WHERE rolname=current_user',
        )
      ).rows[0];
      if (identity.db !== 'flockletter_demo' || identity.role !== 'flockletter_migrator' || identity.unsafe)
        throw Error('Invalid self-host release identity.');
      await applyMigrations(client, 'flockletter_runtime');
    } finally {
      await client.end();
    }
    console.log('Flockletter self-host schema applied to the demo database.');
    return;
  }
  if (action === 'web') {
    const originPort = Number(process.env.FLOCKLETTER_WEB_PORT ?? 4310);
    if (!Number.isInteger(originPort) || originPort < 1 || originPort > 65535)
      throw Error('Choose a valid loopback web port.');
    const database = await connection('runtime');
    const db = new Database(database);
    try {
      await db.verifyBoundary();
    } finally {
      await db.close();
    }
    const publishable = await secret('clerk-public', false),
      backend = await secret('clerk-secret', false);
    if (Boolean(publishable) !== Boolean(backend)) throw Error('Supply both Clerk keys or leave both blank.');
    const clean = {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      APP_ENV: 'local',
      HOST: '0.0.0.0',
      PORT: '4310',
      APP_ORIGIN: 'http://127.0.0.1:' + originPort,
      DATABASE_URL: database,
      LOCAL_TEST_IDENTITY: 'false',
      ...(publishable ? { CLERK_PUBLISHABLE_KEY: publishable, CLERK_SECRET_KEY: backend } : {}),
    };
    const child = spawn(process.execPath, ['dist/server/server/main.js'], { stdio: 'inherit', env: clean });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
    child.once('error', () => {
      console.error('The self-host web process could not start.');
      process.exitCode = 1;
    });
    child.once('exit', (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  if (['seed', 'advance', 'verify'].includes(action)) {
    const { drill } = await import('./drill-data.mjs');
    await drill(action, await connection('runtime'), await connection('runtime', true));
    return;
  }
  throw Error('Unknown self-host mode.');
}
try {
  await run();
} catch (error) {
  // Database and provider errors may contain private parameters. Report a category only.
  if (error?.code === 'RESTORE_STALE') {
    console.error('Restored consent differs from the current source. Keep delivery disabled.');
    process.exitCode = 78;
  } else {
    console.error(
      'Self-host operation failed' +
        (typeof error?.code === 'string' && /^[A-Z0-9_]{1,30}$/.test(error.code)
          ? ' (' + error.code + ')'
          : '') +
        '. Check role credentials, migrations and the local configuration.',
    );
    process.exitCode = 1;
  }
}
