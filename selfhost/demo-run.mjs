import { spawn } from 'node:child_process';
import { readFile, mkdtemp, mkdir, symlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
function port(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw Error('Invalid loopback port.');
  return value;
}
const webPort = port('FLOCKLETTER_DEMO_WEB_PORT', 4311),
  dbPort = port('FLOCKLETTER_DEMO_DB_PORT', 55473);
const state = process.env.FLOCKLETTER_STATE_DIR || path.join(root, 'selfhost', '.state');
const password = (await readFile(path.join(state, 'runtime'), 'utf8')).trim();
if (!/^[a-f0-9]{64}$/.test(password)) throw Error('Initialize the local self-host secrets first.');
const main = path.join(root, 'dist/server/server/main.js'),
  assets = path.join(root, 'dist/client');
await access(main);
await access(assets);
const url = new URL('postgresql://127.0.0.1:' + dbPort + '/flockletter_demo');
url.username = 'flockletter_runtime';
url.password = password;
const cwd = await mkdtemp(path.join(tmpdir(), 'flockletter-loopback-'));
try {
  // Keep the user's repository .env out of the demo. Only the built public assets are linked.
  await mkdir(path.join(cwd, 'dist'));
  await symlink(assets, path.join(cwd, 'dist/client'), 'dir');
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'development',
    APP_ENV: 'local',
    HOST: '127.0.0.1',
    PORT: String(webPort),
    APP_ORIGIN: 'http://127.0.0.1:' + webPort,
    LOCAL_TEST_IDENTITY: 'true',
    DATABASE_URL: url.href,
  };
  const child = spawn(process.execPath, [main], { cwd, stdio: 'inherit', env });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = status;
} finally {
  await rm(cwd, { recursive: true, force: true });
}
