import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('.', import.meta.url));
const repo = path.dirname(folder.replace(/\/$/, ''));
const project = 'flockletter-proof-' + randomUUID().slice(0, 8);
function command(program, args, options = {}) {
  const { expect = 0, ...spawnOptions } = options;
  const child = spawnSync(program, args, { cwd: repo, stdio: 'inherit', ...spawnOptions });
  if (child.error) throw child.error;
  if (child.status !== expect)
    throw Error(program + ' ' + args[0] + ' failed with status ' + child.status + '.');
  return child;
}
const read = (program, args) =>
  command(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).stdout.trim();
const context = process.env.DOCKER_CONTEXT || read('docker', ['context', 'show']);
const endpoint = read('docker', ['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']);
if (!endpoint.startsWith('unix://'))
  throw Error('Choose a local Unix-socket Docker context for this disposable drill.');
const freePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => server.on('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};
const port = await freePort();
const state = await mkdtemp(path.join(folder, '.proof-'));
const environment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DOCKER_CONTEXT: context,
  FLOCKLETTER_STATE_DIR: state,
  FLOCKLETTER_WEB_PORT: String(port),
  FLOCKLETTER_DISPOSABLE_FIXTURE: '1',
  COMPOSE_PROJECT_NAME: project,
};
if (process.env.DOCKER_CONFIG) environment.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
const composeProgram = process.env.FLOCKLETTER_COMPOSE_BIN || 'docker';
const composeArgs = [
  ...(process.env.FLOCKLETTER_COMPOSE_BIN ? [] : ['compose']),
  '--env-file',
  '/dev/null',
  '-p',
  project,
  '-f',
  path.join(folder, 'compose.yaml'),
  '--profile',
  'restore',
];
const compose = (args, options = {}) =>
  command(composeProgram, [...composeArgs, ...args], { env: environment, ...options });
let built = false;
const guard =
  'export PGPASSWORD="$(cat /run/secrets/bootstrap)"; marker="$(psql -XAt -U flockletter_bootstrap -d "$FLOCKLETTER_DATABASE" -c "SELECT shobj_description(oid,\'pg_database\') FROM pg_database WHERE datname=current_database()")"; test "$marker" = "Flockletter disposable restore fixture"; ';
const dump = path.join(state, 'logical.pg_dump');
async function backup() {
  const file = await open(dump, 'w', 0o600);
  try {
    compose(
      [
        'exec',
        '-T',
        'db',
        'sh',
        '-ec',
        guard +
          'test "$FLOCKLETTER_DATABASE" = flockletter_demo; exec pg_dump -Fc -U flockletter_bootstrap -d flockletter_demo',
      ],
      { stdio: ['ignore', file.fd, 'inherit'] },
    );
  } finally {
    await file.close();
  }
}
async function restore() {
  const file = await open(dump, 'r');
  try {
    compose(
      [
        'exec',
        '-T',
        'restore-db',
        'sh',
        '-ec',
        guard +
          'test "$FLOCKLETTER_DATABASE" = flockletter_restore; exec pg_restore --clean --if-exists --exit-on-error --single-transaction -U flockletter_bootstrap -d flockletter_restore',
      ],
      { stdio: [file.fd, 'inherit', 'inherit'] },
    );
  } finally {
    await file.close();
  }
}
const rehearse = (action, expected = 0) =>
  compose(['run', '--rm', '--no-deps', 'drill', action], { expect: expected });
try {
  command(process.execPath, [path.join(folder, 'secrets.mjs'), state]);
  compose(['config', '--quiet']);
  compose(['up', '--wait', '-d', 'db', 'restore-db']);
  compose(['build', 'migrate']);
  built = true;
  compose(['up', '--wait', '-d', 'web']);
  const origin = 'http://127.0.0.1:' + port;
  assert.equal((await fetch(origin + '/healthz', { signal: AbortSignal.timeout(10000) })).status, 200);
  const config = await (await fetch(origin + '/api/config')).json();
  assert.equal(config.environment, 'local');
  assert.equal(config.localIdentity, false);
  assert.equal(config.sendingEnabled, false);
  assert.ok(config.setupGaps.includes('clerk_not_configured'));
  const protectedResponse = await fetch(origin + '/api/v1/commands/workspace.get', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(protectedResponse.status, 503);
  rehearse('seed');
  await backup();
  await restore();
  rehearse('verify');
  rehearse('advance');
  rehearse('verify', 78);
  await backup();
  await restore();
  rehearse('verify');
  console.log(
    'Self-host preparation and scoped logical restore passed. The stale backup was refused; the up-to-date backup preserved the later opt-out.',
  );
} finally {
  // A unique project, fresh local volumes and a generated private directory belong only to this invocation.
  try {
    compose(['down', '--volumes']);
    if (built) command('docker', ['--context', context, 'image', 'rm', project + '-app:local']);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}
