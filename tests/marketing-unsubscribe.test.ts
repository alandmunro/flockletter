import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request, type Server } from 'node:http';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { Database } from '../src/server/db.js';
import { CommandService } from '../src/server/service.js';
import {
  buildMarketingMessageLinks,
  loadMarketingLinks,
  redeemMarketingLink,
} from '../src/server/subscribers/marketing-links.js';

const origin = 'https://mail.example.test',
  host = new URL(origin).host;
const a = { workspaceId: 'org_oneclick_a', brandId: randomUUID() },
  b = { workspaceId: 'org_oneclick_b', brandId: randomUUID() };
const key = 'ab'.repeat(32);
const environment = (signer = key) => ({
  FLOCKLETTER_UNSUBSCRIBE_BINDINGS: JSON.stringify([a, b]),
  FLOCKLETTER_UNSUBSCRIBE_SIGNING_KEY: signer,
});
const settings = loadMarketingLinks(origin, environment())!;
let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database, server: Server, port: number;
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  await db.verifyBoundary();
  for (const scope of [a, b])
    await db.tenant(scope.workspaceId, async (sql) => {
      await sql.query('INSERT INTO workspaces(workspace_id,name) VALUES($1,$2)', [
        scope.workspaceId,
        'Test workspace',
      ]);
      await sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
        scope.workspaceId,
        scope.brandId,
        'Test brand',
      ]);
    });
  for (const [name, value] of Object.entries(environment())) vi.stubEnv(name, value);
  const app = createApp(loadConfig({ APP_ENV: 'test', APP_ORIGIN: origin }), new CommandService(db));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No private HTTP port');
  port = address.port;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.close();
  await fixture?.stop();
});
async function seed(scope = a, id: string = randomUUID(), state = 'confirmed', withEvidence = false) {
  await db.brand(scope.workspaceId, scope.brandId, async (sql) => {
    await sql.query(
      'INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,$4,$5)',
      [scope.workspaceId, scope.brandId, id, id + '@example.test', state],
    );
    if (withEvidence)
      await sql.query(
        `INSERT INTO subscriber_consent_events(workspace_id,brand_id,id,subscriber_id,event,purpose,policy_version,text_digest,source,source_domain)
      VALUES($1,$2,$3,$4,'signup_requested','brand_marketing','fixture-v1','digest','storefront-footer','example.test')`,
        [scope.workspaceId, scope.brandId, randomUUID(), id],
      );
  });
  return id;
}
const build = (id: string, scope = a, config = settings) =>
  db.brand(scope.workspaceId, scope.brandId, (sql) =>
    buildMarketingMessageLinks(sql, config, { ...scope, subscriberId: id }),
  );
async function inspect(id: string, scope = a) {
  return db.brand(scope.workspaceId, scope.brandId, async (sql) => ({
    state: (await sql.query('SELECT state FROM subscribers WHERE id=$1', [id])).rows[0]?.state,
    optOuts: (
      await sql.query(
        "SELECT source,policy_version FROM subscriber_consent_events WHERE subscriber_id=$1 AND event='unsubscribed'",
        [id],
      )
    ).rows,
  }));
}
function http(url: string, method = 'GET', body?: string | Buffer, headers: Record<string, string> = {}) {
  const u = new URL(url);
  return new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, method, path: u.pathname + u.search, headers: { host, ...headers } },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (c) => chunks.push(c));
          response.on('error', reject);
          response.on('end', () =>
            resolve({
              status: response.statusCode!,
              headers: response.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    },
  );
}
const argument = 'List-Unsubscribe=One-Click';
const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };
const post = (url: string, headers: Record<string, string> = {}) =>
  http(url, 'POST', argument, { ...formHeaders, ...headers });

describe('signed brand marketing unsubscribe', () => {
  it('limits configuration, enforces a dedicated key and emits stable opaque HTTPS headers for eligible contacts only', async () => {
    expect(loadMarketingLinks(origin, {})).toBeUndefined();
    expect(() => loadMarketingLinks('http://mail.example.test', environment())).toThrow();
    expect(() =>
      loadMarketingLinks(origin, { ...environment(), FLOCKLETTER_CONFIRMATION_SIGNING_KEY: key }),
    ).toThrow();
    expect(() =>
      loadMarketingLinks(origin, {
        ...environment(),
        FLOCKLETTER_UNSUBSCRIBE_BINDINGS: JSON.stringify([a, a]),
      }),
    ).toThrow();
    const id = await seed();
    const [first, again] = await Promise.all([build(id), build(id)]);
    expect(first).toEqual(again);
    expect(first.headers).toEqual({
      'List-Unsubscribe': '<' + first.bodyUrl + '>',
      'List-Unsubscribe-Post': argument,
    });
    expect(first.requiredDkimHeaders).toEqual(['list-unsubscribe', 'list-unsubscribe-post']);
    const url = new URL(first.bodyUrl);
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe('/mail/unsubscribe');
    expect(url.hash).toBe('');
    const token = url.searchParams.get('t')!;
    for (const secret of [a.workspaceId, a.brandId, id, '@example.test']) expect(token).not.toContain(secret);
    const persisted = await db.brand(
      a.workspaceId,
      a.brandId,
      async (sql) =>
        (await sql.query('SELECT id,token_hash FROM subscriber_marketing_links WHERE subscriber_id=$1', [id]))
          .rows,
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain(token);
    await expect(build(await seed(a, randomUUID(), 'pending'))).rejects.toMatchObject({
      code: 'recipient_ineligible',
    });
    await expect(
      db.brand(b.workspaceId, b.brandId, (sql) =>
        buildMarketingMessageLinks(sql, settings, { ...a, subscriberId: id }),
      ),
    ).rejects.toMatchObject({ code: 'recipient_ineligible' });
    await expect(build(id, a, loadMarketingLinks(origin, environment(''))!)).rejects.toMatchObject({
      code: 'unsubscribe_unavailable',
    });
  });
  it('serves GET and HEAD without writes; exact one-click POST works anonymously, concurrently and after pause', async () => {
    const id = await seed(a, randomUUID(), 'confirmed', true),
      url = (await build(id)).bodyUrl;
    const token = new URL(url).searchParams.get('t')!;
    const get = await http(url);
    expect(get.status).toBe(200);
    expect(get.body).toContain('name="List-Unsubscribe"');
    expect(get.body).not.toContain(token);
    expect(get.body).not.toContain('<script');
    expect(get.headers['cache-control']).toBe('no-store');
    expect(get.headers['referrer-policy']).toBe('strict-origin');
    expect(get.headers['set-cookie']).toBeUndefined();
    expect((await http(url, 'HEAD')).body).toBe('');
    expect(await inspect(id)).toEqual({ state: 'confirmed', optOuts: [] });
    await db.brand(a.workspaceId, a.brandId, (sql) =>
      sql.query(
        'INSERT INTO subscriber_intake_settings(workspace_id,brand_id,enabled) VALUES($1,$2,false) ON CONFLICT (workspace_id,brand_id) DO UPDATE SET enabled=false',
        [a.workspaceId, a.brandId],
      ),
    );
    const replies = await Promise.all([post(url), post(url)]);
    expect(replies.map((r) => [r.status, r.body, r.headers.location])).toEqual([
      [204, '', undefined],
      [204, '', undefined],
    ]);
    expect(await inspect(id)).toEqual({
      state: 'unsubscribed',
      optOuts: [{ source: 'marketing-unsubscribe-link', policy_version: 'fixture-v1' }],
    });
    // Ordinary account cookies are never needed. Browser UI uses one intentional same-origin submission.
    const browser = await post(url, { origin, 'sec-fetch-site': 'same-origin', cookie: 'ignored=fake' });
    expect(browser.status).toBe(200);
    expect(browser.headers['referrer-policy']).toBe('no-referrer');
    expect(browser.body).not.toContain(token);
    expect(browser.body).not.toContain(id);
  });
  it('accepts bounded multipart; rejects duplicate fields, files, foreign browsers, compressed or oversized forms without reflecting input', async () => {
    const id = await seed(),
      url = (await build(id)).bodyUrl;
    const token = new URL(url).searchParams.get('t')!;
    const form = new FormData();
    form.set('List-Unsubscribe', 'One-Click');
    const multipart = new Request(origin, { method: 'POST', body: form });
    for (const [body, headers, status] of [
      [argument, { ...formHeaders, origin: 'https://foreign.example' }, 403],
      [argument, { ...formHeaders, 'sec-fetch-site': 'cross-site' }, 403],
      [argument, { ...formHeaders, origin: 'null' }, 403],
      [argument, { ...formHeaders, 'sec-fetch-mode': 'navigate' }, 403],
      [argument, { ...formHeaders, authorization: 'Bearer ignored-fixture' }, 403],
      [argument, { ...formHeaders, cookie: 'session=ignored' }, 403],
      [argument, { ...formHeaders, host: 'foreign.example' }, 403],
      [argument, { ...formHeaders, 'content-encoding': 'gzip' }, 415],
      [argument + '&' + argument, formHeaders, 400],
      [argument + '&email=private%40example.test', formHeaders, 400],
      ['List-Unsubscribe=Wrong', formHeaders, 400],
      ['x'.repeat(5000), formHeaders, 413],
      [argument, { 'content-type': 'text/plain' }, 415],
    ] as [string, Record<string, string>, number][]) {
      const res = await http(url, 'POST', body, headers);
      expect(res.status).toBe(status);
      expect(res.body).not.toContain(token);
      expect(res.body).not.toContain('@example.test');
    }
    const file = new FormData();
    file.set('List-Unsubscribe', new Blob(['One-Click']), 'field.txt');
    const fileBody = new Request(origin, { method: 'POST', body: file });
    expect(
      (
        await http(url, 'POST', Buffer.from(await fileBody.arrayBuffer()), {
          'content-type': fileBody.headers.get('content-type')!,
        })
      ).status,
    ).toBe(400);
    expect(await inspect(id)).toEqual({ state: 'confirmed', optOuts: [] });
    expect(
      (
        await http(url, 'POST', Buffer.from(await multipart.arrayBuffer()), {
          'content-type': multipart.headers.get('content-type')!,
        })
      ).status,
    ).toBe(204);
    expect(await inspect(id)).toEqual({
      state: 'unsubscribed',
      optOuts: [{ source: 'marketing-unsubscribe-link', policy_version: 'marketing-opt-out-v1' }],
    });
  });
  it('isolates colliding subscriber IDs, rejects a tampered capability uniformly, and preserves hard bounces and complaints', async () => {
    const id = await seed(),
      other = await seed(b, id);
    const first = new URL((await build(id)).bodyUrl),
      second = new URL((await build(other, b)).bodyUrl);
    const original = first.searchParams.get('t')!,
      foreign = second.searchParams.get('t')!;
    const parts = original.split('.');
    first.searchParams.set('t', [parts[0], foreign.split('.')[1], parts[2], parts[3]].join('.'));
    expect((await post(first.href)).status).toBe(204);
    first.searchParams.set('t', original.slice(0, -1) + (original.endsWith('A') ? 'B' : 'A'));
    expect((await post(first.href)).status).toBe(204);
    expect((await inspect(id)).state).toBe('confirmed');
    expect((await inspect(id, b)).state).toBe('confirmed');
    for (const state of ['hard_bounced', 'complained']) {
      await db.brand(a.workspaceId, a.brandId, (sql) =>
        sql.query('UPDATE subscribers SET state=$1 WHERE id=$2', [state, id]),
      );
      first.searchParams.set('t', original);
      expect((await post(first.href)).status).toBe(204);
      expect(await inspect(id)).toEqual({ state, optOuts: [] });
    }
    expect((await post(second.href)).status).toBe(204);
    expect((await inspect(id, b)).state).toBe('unsubscribed');
    expect(
      await db.tenant(
        a.workspaceId,
        async (sql) => (await sql.query('SELECT id FROM subscriber_marketing_links')).rows,
      ),
    ).toEqual([]);
    await expect(
      db.brand(a.workspaceId, a.brandId, (sql) => sql.query('DELETE FROM subscriber_marketing_links')),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('keeps previously issued links usable with a rotated or retired signing key and never logs their query', async () => {
    const id = await seed(),
      before = await build(id),
      rotated = loadMarketingLinks(origin, environment('cd'.repeat(32)))!;
    const after = await build(id, a, rotated);
    expect(after.bodyUrl).not.toBe(before.bodyUrl);
    const retired = loadMarketingLinks(origin, environment(''))!,
      token = new URL(before.bodyUrl).searchParams.get('t')!;
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    try {
      await redeemMarketingLink(db, retired, token);
      expect((await inspect(id)).state).toBe('unsubscribed');
      expect((await post(after.bodyUrl)).status).toBe(204);
      expect(JSON.stringify(spies.map((s) => s.mock.calls))).not.toContain(token);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
