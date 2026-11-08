// Ordinary builds and self-hosters do not download or start an engine.
/* global fetch, AbortSignal */
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

const release = {
  'linux-x64': [
    'linux_amd64',
    'ce78c89d8aac0df3ffe0e110b008e7bb5dae13e6ad0c57b43aa7094971e8698e',
    '6d7ad26bf62259338ac5a89873bf26b57fdd74dff4ba4adfb164e18c8b6848b3',
  ],
  'darwin-arm64': [
    'darwin_arm64',
    '692ebcbec722319c1d0c7705ea0d7191e1be38e8ec40b417f2f9210fbe4c601b',
    '295a08e3e5876ff559a777df47eca89c7843b1eeebbccfb5141f42efd7fa6db5',
  ],
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

if (process.env.FLOCKLETTER_PRIVATE_ENGINE === 'embedded') {
  const asset = release[process.platform + '-' + process.arch];
  if (!asset) throw Error('No verified private Listmonk release for this platform.');
  const dir = fileURLToPath(new URL('../dist/private/', import.meta.url));
  await mkdir(dir, { recursive: true });
  const work = await mkdtemp(path.join(dir, '.prepare-'));
  try {
    const source =
      'https://github.com/knadh/listmonk/releases/download/v6.2.0/listmonk_6.2.0_' + asset[0] + '.tar.gz';
    const response = await fetch(source, {
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok || !response.body) throw Error('Download of Listmonk v6.2.0 failed.');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) throw Error('Unexpected Listmonk archive size.');
      chunks.push(chunk);
    }
    const archive = Buffer.concat(chunks);
    if (digest(archive) !== asset[1]) throw Error('Listmonk release archive checksum mismatch.');
    const tarball = path.join(work, 'archive.tar.gz');
    await writeFile(tarball, archive, { mode: 0o600 });
    const extract = async (name) =>
      (
        await promisify(execFile)('tar', ['-xOzf', tarball, name], {
          encoding: 'buffer',
          maxBuffer: 48 * 1024 * 1024,
          timeout: 30_000,
          env: { PATH: '/usr/bin:/bin' },
        })
      ).stdout;
    const binary = await extract('listmonk');
    if (digest(binary) !== asset[2]) throw Error('Listmonk executable checksum mismatch.');
    await writeFile(path.join(work, 'listmonk'), binary, { mode: 0o755 });
    await writeFile(path.join(work, 'LICENSE'), await extract('LICENSE'), {
      mode: 0o644,
    });
    // Runtime and build processes may have different UIDs; these two verified release files are public.
    await chmod(path.join(work, 'listmonk'), 0o755);
    await chmod(path.join(work, 'LICENSE'), 0o644);
    await rename(path.join(work, 'LICENSE'), path.join(dir, 'LISTMONK-LICENSE'));
    await rename(path.join(work, 'listmonk'), path.join(dir, 'listmonk'));
    console.info('Prepared verified Listmonk v6.2.0 for private staging rehearsals.');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
