import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.resolve(process.argv[2] || fileURLToPath(new URL('./.state', import.meta.url)));
const marker = '.flockletter-selfhost-credentials-v1';
const names = [
  'bootstrap',
  'migrator',
  'runtime',
  'restore-bootstrap',
  'restore-migrator',
  'restore-runtime',
  'clerk-public',
  'clerk-secret',
];
await mkdir(directory, { recursive: true, mode: 0o700 });
if (!(await lstat(directory)).isDirectory())
  throw Error('Choose a dedicated directory for Flockletter secrets.');
const entries = await readdir(directory),
  existing = entries.includes(marker);
if (entries.length && !existing)
  throw Error('Use an empty directory or an existing Flockletter credential directory.');
await chmod(directory, 0o700);
for (const name of names) {
  const file = path.join(directory, name);
  if (existing) {
    if (!(await lstat(file).catch(() => null))?.isFile())
      throw Error('An existing credential file is missing. Restore it from its saved copy.');
    if (!name.startsWith('clerk-') && !/^[a-f0-9]{64}$/.test((await readFile(file, 'utf8')).trim()))
      throw Error('An existing database credential is invalid.');
  } else {
    // The private parent directory restricts host access. A container reads only its individual read-only mount.
    await writeFile(file, name.startsWith('clerk-') ? '' : randomBytes(32).toString('hex') + '\n', {
      flag: 'wx',
      mode: 0o444,
    });
    await chmod(file, 0o444);
  }
}
if (!existing)
  await writeFile(path.join(directory, marker), 'Flockletter self-host credentials\n', {
    flag: 'wx',
    mode: 0o400,
  });
console.log('Flockletter secret files are ready. Existing credentials were preserved.');
