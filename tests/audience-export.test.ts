import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { collectContactCsv } from '../src/client/contact-export.js';
import { exportLimits, type ExportContact, type ExportPage } from '../src/shared/audience-export.js';

const revision = 'a'.repeat(64);
const sample = (email: string): ExportContact => ({
  email,
  state: 'pending',
  createdAt: '2026-01-01T00:00:00Z',
  confirmedAt: null,
});
const freshSignal = () => new AbortController().signal;

describe('complete private CSV generation', () => {
  it('quotes every field and neutralizes formula prefixes, including controls and fullwidth markers', async () => {
    const inputs = [
      '+tag@example.test',
      '  =SUM(1,2)',
      '@formula',
      '-1',
      '＠formula',
      '\ttrick',
      'line"break\nordinary',
      'reader@example.test',
    ];
    const { file, contacts } = await collectContactCsv(
      async () => ({ rows: inputs.map(sample), total: inputs.length, nextCursor: null, revision }),
      freshSignal(),
    );
    expect(contacts).toBe(inputs.length);
    expect([...new Uint8Array(await file.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = await file.text();
    for (const value of inputs.slice(0, 6)) expect(text).toContain('"\'' + value + '"');
    expect(text).toContain('"line""break\nordinary"');
    expect(text).toContain('"reader@example.test"');
    expect(text.split('\r\n')[0]).toBe('"Email","Status","Added at (UTC)","Confirmed at (UTC)"');
  });
  it('rejects partial files, page failures, over-limit requests and user cancellations', async () => {
    const first: ExportPage = {
      rows: Array.from({ length: 500 }, (_, i) => sample(i + '@example.test')),
      total: 501,
      nextCursor: randomUUID(),
      revision,
    };
    await expect(
      collectContactCsv(async (cursor) => {
        if (!cursor) return first;
        throw new Error('Permission revoked.');
      }, freshSignal()),
    ).rejects.toThrow('Permission revoked.');
    await expect(collectContactCsv(async () => ({ ...first, nextCursor: null }), freshSignal())).rejects.toThrow(
      'incomplete',
    );
    await expect(collectContactCsv(async () => ({ ...first, total: 10_001 }), freshSignal())).rejects.toThrow(
      '10,000',
    );
    const abort = new AbortController();
    await expect(
      collectContactCsv(async () => {
        abort.abort();
        return first;
      }, abort.signal),
    ).rejects.toThrow();
    const empty = await collectContactCsv(
      async () => ({ rows: [], total: 0, nextCursor: null, revision }),
      freshSignal(),
    );
    expect(empty.contacts).toBe(0);
  });
});

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database, service: CommandService;
const workspace = 'org_export_fixture',
  otherWorkspace = 'org_export_foreign',
  owner: Actor = {
    workspaceId: workspace,
    userId: 'export-owner',
    actorId: 'user:export-owner',
    owner: true,
    kind: 'session',
    brandIds: null,
    scopes: ['read'],
  };
const small = randomUUID(),
  over = randomUUID(),
  foreign = randomUUID();
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  service = new CommandService(db);
  for (const [workspaceId, brands] of [
    [workspace, [small, over]],
    [otherWorkspace, [foreign]],
  ] as const) {
    await db.tenant(workspaceId, async (sql) => {
      await sql.query('INSERT INTO workspaces(workspace_id,name) VALUES($1,$2)', [
        workspaceId,
        'Export fixture',
      ]);
      for (const brand of brands)
        await sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
          workspaceId,
          brand,
          brand === over ? 'Large export example' : 'Primary export example',
        ]);
    });
  }
  for (const [workspaceId, brand, total] of [
    [workspace, small, 501],
    [workspace, over, 10_001],
    [otherWorkspace, foreign, 1],
  ] as const) {
    await db.brand(workspaceId, brand, (sql) =>
      sql.query(
        "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) SELECT $1,$2,gen_random_uuid(),'reader-'||lpad(n::text,5,'0')||'@example.test','confirmed' FROM generate_series(1,$3::int) n",
        [workspaceId, brand, total],
      ),
    );
  }
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});
const page = (brandId: string, opts: { cursor?: string; revision?: string } = {}) =>
  service.execute('audience.exportPage', { brandId, ...opts }, owner) as Promise<ExportPage>;
describe('owner brand export pages', () => {
  it('serves a complete alphabetic export, 500 rows at a time, with opaque cursors', async () => {
    const first = await page(small);
    expect(first.total).toBe(501);
    expect(first.rows).toHaveLength(exportLimits.page);
    expect(first.nextCursor).toMatch(/^[a-f0-9-]{36}$/);
    const tail = await page(small, { cursor: first.nextCursor!, revision: first.revision });
    expect(tail.rows).toHaveLength(1);
    expect(tail.nextCursor).toBeNull();
    expect(tail.rows[0]!.email).toBe('reader-00501@example.test');
    expect(first.rows[0]).not.toHaveProperty('id');
    expect(new Set([...first.rows, ...tail.rows].map((row) => row.email)).size).toBe(501);
  });
  it('rejects stale pages, invalid cursors, oversized brands, foreign brands and delegated credentials', async () => {
    const first = await page(small);
    await db.brand(workspace, small, (sql) =>
      sql.query(
        "UPDATE subscribers SET state='unsubscribed' WHERE email_normalized='reader-00501@example.test'",
      ),
    );
    await expect(page(small, { cursor: first.nextCursor!, revision: first.revision })).rejects.toMatchObject({
      status: 409,
      code: 'export_changed',
    });
    await expect(page(small, { cursor: randomUUID() })).rejects.toMatchObject({ status: 422 });
    const again = await page(small);
    await expect(page(small, { cursor: randomUUID(), revision: again.revision })).rejects.toMatchObject({
      status: 422,
      code: 'invalid_cursor',
    });
    await expect(page(over)).rejects.toMatchObject({ status: 422, code: 'export_limit' });
    await expect(page(foreign)).rejects.toMatchObject({ status: 404 });
    await expect(
      service.execute(
        'audience.exportPage',
        { brandId: small },
        { ...owner, kind: 'connection', scopes: ['read', 'audience:summary'], brandIds: [small] },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
