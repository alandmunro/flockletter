// Opt-in native test: FLOCKLETTER_PRIVATE_ENGINE=embedded node scripts/prepare-listmonk.mjs
// then FLOCKLETTER_TEST_PRIVATE_ENGINE=1 npm test -- tests/embedded-listmonk.test.ts
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import type { DeliveryEnvelope } from '../src/server/campaign/delivery-provider.js';
import { EmbeddedListmonk } from '../src/server/campaign/embedded-listmonk.js';
import { listmonkReference, reviewedListmonkMessage } from '../src/server/campaign/listmonk-callback.js';

const secret = randomBytes(32).toString('hex');
const sample = (key: string): DeliveryEnvelope => ({
  workspaceId: 'test-workspace',
  brandId: 'test-brand',
  operationKey: key,
  to: 'private@render.test',
  subject: 'Reviewed subject',
  html: '<p>Reviewed &amp; ready</p>',
  text: 'Reviewed & ready',
  images: [],
});

it('requires an exact loopback callback and rejects real addresses or an unrelated reference before startup', async () => {
  for (const url of [
    'https://127.0.0.1:88/message',
    'http://localhost:88/message',
    'http://127.0.0.1:65536/message',
    'http://127.0.0.1:3000/message?x=1',
    'http://127.0.0.1@other.invalid:3000/message',
  ]) {
    expect(() => new EmbeddedListmonk(url, secret)).toThrow();
  }
  const engine = new EmbeddedListmonk('http://127.0.0.1:1234/message', secret);
  const msg = sample('one');
  const reference = listmonkReference(msg.workspaceId, msg.brandId, msg.operationKey);
  await expect(engine.render({ ...msg, to: 'outside@flockletter.org' }, reference)).rejects.toThrow();
  await expect(
    engine.render(msg, listmonkReference('different', msg.brandId, msg.operationKey)),
  ).rejects.toThrow();
  await engine.close();
  await expect(engine.render(msg, reference)).rejects.toThrow();
});

it('skips native downloads on ordinary builds and preserves an existing binary when an archive fails its checksum', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'flockletter-install-test-'));
  try {
    await mkdir(path.join(root, 'scripts'));
    const script = path.join(root, 'scripts', 'prepare-listmonk.mjs');
    await copyFile(new URL('../scripts/prepare-listmonk.mjs', import.meta.url), script);
    const shim = path.join(root, 'response.mjs');
    await writeFile(shim, "globalThis.fetch=async()=>{throw Error('Unexpected download.')}");
    const exec = promisify(execFile);
    await exec(process.execPath, ['--import', shim, script], { env: {} });
    expect(await readdir(root)).not.toContain('dist');
    const dist = path.join(root, 'dist', 'private');
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, 'listmonk'), 'known-good');
    await writeFile(shim, "globalThis.fetch=async()=>new Response('wrong archive')");
    await expect(
      exec(process.execPath, ['--import', shim, script], { env: { FLOCKLETTER_PRIVATE_ENGINE: 'embedded' } }),
    ).rejects.toThrow(/checksum mismatch|No verified private Listmonk release/);
    expect(await readdir(dist)).toEqual(['listmonk']);
    expect(await readFile(path.join(dist, 'listmonk'), 'utf8')).toBe('known-good');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.env.FLOCKLETTER_TEST_PRIVATE_ENGINE !== '1')(
  'renders with real Listmonk, releases idle resources and starts a fresh disposable engine',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'flockletter-engine-test-'));
    const expected = new Map<string, DeliveryEnvelope>();
    const accepted = new Set<string>();
    const server = createServer(async (req, res) => {
      try {
        expect(req.url).toBe('/message');
        expect(req.headers.authorization).toBe(
          'Basic ' + Buffer.from('flockletter:' + secret).toString('base64'),
        );
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const reviewed = expected.get(body.from_email);
        if (!reviewed) throw Error('Unknown synthetic callback.');
        reviewedListmonkMessage(body, reviewed);
        accepted.add(body.from_email);
        res.end('{}');
      } catch {
        res.writeHead(400).end();
      }
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing test listener.');
    const engine = new EmbeddedListmonk('http://127.0.0.1:' + address.port + '/message', secret);
    const original = globalThis.setTimeout;
    // Only compress the three-minute idle grace period; startup, Postgres, Listmonk and HTTP are real.
    const clock = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
        original(fn, ms === 180_000 ? 1_500 : ms, ...args)) as typeof setTimeout);
    vi.stubEnv('TMPDIR', root);
    const until = async (condition: () => Promise<boolean>) => {
      for (let i = 0; i < 200; i++) {
        if (await condition()) return;
        await sleep(50);
      }
      throw Error('Timed out waiting for a private rehearsal condition.');
    };
    const render = async (key: string) => {
      const msg = sample(key),
        ref = listmonkReference(msg.workspaceId, msg.brandId, msg.operationKey);
      expected.set(ref, msg);
      await engine.render(msg, ref);
      return ref;
    };
    try {
      const first = await Promise.all([render('first'), render('concurrent')]);
      await until(async () => first.every((ref) => accepted.has(ref)));
      const firstDirs = await readdir(root);
      expect(firstDirs.filter((name) => name.startsWith('flockletter-private-engine-'))).toHaveLength(1);
      await until(
        async () => !(await readdir(root)).some((name) => name.startsWith('flockletter-private-engine-')),
      );
      const next = await render('after-idle');
      await until(async () => accepted.has(next));
      expect(
        (await readdir(root)).filter((name) => name.startsWith('flockletter-private-engine-')),
      ).not.toEqual(firstDirs);
      expect(accepted.size).toBe(3);
    } finally {
      await engine.close();
      clock.mockRestore();
      vi.unstubAllEnvs();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      expect(await readdir(root)).toEqual([]);
      await rm(root, { recursive: true, force: true });
    }
  },
  150_000,
);
