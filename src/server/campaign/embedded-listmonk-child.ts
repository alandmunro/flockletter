// Private supervisor. Its entire inherited environment is constructed by EmbeddedListmonk;
// even initdb (which inherits its caller's environment) cannot receive application credentials.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const work = process.env.FLOCKLETTER_ENGINE_WORKDIR!;
const binary = path.resolve('dist/private/listmonk');
const engineStore = 'private_engine';
let postgres: EmbeddedPostgres | undefined;
let native: ChildProcess | undefined;
let stopping = false;
let start: Promise<void> | undefined;
let shutdown: Promise<void> | undefined;
let phase = 'configuration';

async function availableDatabasePort() {
  return new Promise<number>((resolve, reject) => {
    const listener = createServer();
    listener.once('error', reject).listen(0, '127.0.0.1', () => {
      const address = listener.address();
      listener.close((error) => {
        if (error || !address || typeof address === 'string') reject(new Error('No private database port.'));
        else resolve(address.port);
      });
    });
  });
}

function requireRunning() {
  if (stopping) throw Error('Private engine stopped.');
}

// Configure every output before Listmonk's server or workers may start. The upstream installer
// includes sample subscribers, lists, a campaign, and SMTP settings. None are retained.
async function prepareEngine(db: pg.Client, callback: string, secret: string, token: string) {
  await db.query('BEGIN');
  const disabled = [
    'app.check_updates',
    'app.send_optin_confirmation',
    'app.enable_public_subscription_page',
    'app.enable_public_archive',
    'app.show_optin_page',
    'privacy.individual_tracking',
    'bounce.enabled',
    'bounce.webhooks_enabled',
    'bounce.ses_enabled',
  ];
  const settings = new Map<string, unknown>([
    ...disabled.map((key) => [key, false] as const),
    ['privacy.disable_tracking', true],
    ['app.concurrency', 1],
    ['app.notify_emails', []],
    ['smtp', []],
    [
      'messengers',
      [
        {
          enabled: true,
          name: 'flockletter',
          root_url: callback,
          username: 'flockletter',
          password: secret,
          max_conns: 1,
          max_msg_retries: 0,
          timeout: '10s',
        },
      ],
    ],
  ]);
  for (const [key, value] of settings) {
    const change = await db.query('UPDATE settings SET value=$2::jsonb WHERE key=$1', [
      key,
      JSON.stringify(value),
    ]);
    if (change.rowCount !== 1) throw Error('A required private engine setting is unavailable.');
  }
  await db.query(
    "DELETE FROM campaigns; DELETE FROM subscribers; DELETE FROM lists; DELETE FROM templates WHERE type='tx'",
  );
  const template = await db.query<{
    id: number;
  }>(`INSERT INTO templates(name,type,subject,body) VALUES
    ('Flockletter reviewed message','tx','{{ .Tx.Data.subject }}','{{ Safe .Tx.Data.html }}') RETURNING id`);
  // Listmonk reserves role #1 for superadmin and requires a human user to disable first-time setup.
  // The placeholder cannot sign in. Only the second role's send-only API token is returned to Flockletter.
  await db.query(`WITH role AS (INSERT INTO roles(name) VALUES ('Disabled setup owner') RETURNING id)
    INSERT INTO users(username,name,type,user_role_id,email,status,password_login)
    SELECT 'disabled-owner','Disabled setup owner','user',id,'disabled@receipt.test','disabled',false FROM role`);
  await db
    .query(
      `WITH role AS (INSERT INTO roles(name,permissions) VALUES ('Reviewed transaction',ARRAY['tx:send']) RETURNING id)
    INSERT INTO users(username,name,type,user_role_id,email,status,password) SELECT 'renderer','Private renderer','api',
    id,'renderer@receipt.test','enabled',$1 FROM role WHERE id <> 1`,
      [createHash('sha256').update(token).digest('hex')],
    )
    .then((r) => {
      if (r.rowCount !== 1) throw Error('Could not restrict private renderer.');
    });
  await db.query('COMMIT');
  return template.rows[0]!.id;
}

function launch(args: string[], env: NodeJS.ProcessEnv, watchPort = false): Promise<number> {
  requireRunning();
  const child = spawn(binary, args, {
    cwd: work,
    env,
    stdio: ['ignore', watchPort ? 'pipe' : 'ignore', 'ignore'],
  });
  native = child;
  return new Promise<number>((resolve, reject) => {
    let tail = '';
    if (watchPort)
      child.stdout!.on('data', (chunk: Buffer) => {
        // Echo prints the bound port after listen(2). Asking the kernel for :0 avoids a port-claim race.
        tail = (tail + chunk.toString()).slice(-1024);
        const port = /http server started on 127\.0\.0\.1:([0-9]+)\s/i.exec(tail)?.[1];
        if (port && Number(port) > 0 && Number(port) <= 65535) resolve(Number(port));
      });
    child.once('error', () => reject(Error('Private executable could not start.')));
    child.once('exit', (code) => {
      native = undefined;
      if (!watchPort && code === 0) resolve(0);
      else reject(Error('Private executable stopped.'));
      if (watchPort && !stopping) void stop();
    });
  });
}

async function boot(callback: string, secret: string) {
  if (
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/message$/.test(callback) ||
    Number(new URL(callback).port) > 65535 ||
    typeof secret !== 'string' ||
    secret.length < 16
  )
    throw Error('Invalid private messenger configuration.');
  const pgPort = await availableDatabasePort();
  const pgAdmin = randomBytes(32).toString('hex');
  const pgPassword = randomBytes(32).toString('hex');
  const token = randomBytes(32).toString('hex');
  phase = 'database initialization';
  postgres = new EmbeddedPostgres({
    databaseDir: path.join(work, 'pg'),
    user: 'postgres',
    password: pgAdmin,
    port: pgPort,
    persistent: false,
    authMethod: 'scram-sha-256',
    autoRehydrateSymlinks: true,
    postgresFlags: [
      '-h',
      '127.0.0.1',
      '-c',
      'unix_socket_directories=',
      '-c',
      'max_connections=12',
      '-c',
      'shared_buffers=8MB',
    ],
    onLog: () => {},
    onError: () => {},
  });
  await postgres.initialise();
  requireRunning();
  await postgres.start();
  requireRunning();
  phase = 'database setup';
  const client = (user: string, password: string, database: string) =>
    new pg.Client({
      user,
      password,
      database,
      host: '127.0.0.1',
      port: pgPort,
      connectionTimeoutMillis: 3000,
    });
  const admin = client('postgres', pgAdmin, 'postgres');
  await admin.connect();
  try {
    // Only generated hex is interpolated into PostgreSQL's CREATE ROLE utility statement.
    await admin.query(
      "CREATE ROLE renderer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '" + pgPassword + "'",
    );
    await admin.query('CREATE DATABASE private_engine OWNER renderer');
    await admin.query('REVOKE ALL ON DATABASE postgres, template1, private_engine FROM PUBLIC');
  } finally {
    await admin.end();
  }
  phase = 'Listmonk install';
  const env = {
    PATH: '/usr/bin:/bin',
    TMPDIR: work,
    LANG: 'C',
    GOMAXPROCS: '1',
    LISTMONK_app__address: '127.0.0.1:0',
    LISTMONK_db__host: '127.0.0.1',
    LISTMONK_db__port: String(pgPort),
    LISTMONK_db__user: 'renderer',
    LISTMONK_db__password: pgPassword,
    LISTMONK_db__database: engineStore,
    LISTMONK_db__ssl_mode: 'disable',
    LISTMONK_db__max_open: '4',
    LISTMONK_db__max_idle: '1',
  };
  await launch(['--install', '--yes', '--config', ''], env);
  requireRunning();
  phase = 'engine configuration';
  const db = client('renderer', pgPassword, engineStore);
  await db.connect();
  let templateId: number;
  try {
    templateId = await prepareEngine(db, callback, secret, token);
  } finally {
    await db.end();
  }
  phase = 'engine listener';
  const port = await launch(['--config', ''], env, true);
  requireRunning();
  process.send!({ type: 'ready', port, token, templateId });
}

function stop() {
  stopping = true;
  if (shutdown) return shutdown;
  shutdown = (async () => {
    // The supervisor's caller also has a process-group deadline, including failed initdb children.
    const child = native;
    if (child && child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
    await start?.catch(() => undefined);
    await postgres?.stop().catch(() => undefined);
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    if (process.connected) process.disconnect?.();
  })();
  return shutdown;
}

// Only the parent which constructed the dedicated working directory and IPC channel may run this supervisor.
if (!process.send || !work || !path.basename(work).startsWith('flockletter-private-engine-')) {
  throw Error('Private engine supervisor requires a dedicated working directory and IPC channel.');
}
process.umask(0o077);
process.once('disconnect', () => {
  void stop();
});
process.once('message', (msg: { callback?: string; secret?: string }) => {
  if (stopping) return;
  start = boot(msg.callback ?? '', msg.secret ?? '');
  void start.catch(() => {
    if (process.connected) process.send!({ type: 'failed', phase });
    void stop();
  });
});
