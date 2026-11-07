import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { previewImport } from '../src/server/subscribers/import-preview.js';
import { CommandService, type Actor } from '../src/server/service.js';
import {
  importLimits,
  importPreviewInput,
  readImportCsv,
  type ImportPreviewResult,
} from '../src/shared/import-preview.js';

function read(text: string) {
  return readImportCsv(Buffer.from(text));
}
const brandId = randomUUID(),
  sibling = randomUUID(),
  ownerId = 'org_csv_owner',
  foreignId = 'org_csv_foreign';
const encode = (text: string, emailColumn = 1, brand = brandId) => ({
  brandId: brand,
  csvBase64: Buffer.from(text).toString('base64'),
  emailColumn,
});

describe('CSV preview parsing', () => {
  it('keeps duplicate Email headers and parses CRLF plus a quoted comma', () => {
    const csv = 'Email,Email\r\n"Doe, Jane",jane.doe@example.test';
    const { headers, rows } = read(csv);
    expect(headers).toEqual(['Email', 'Email']);
    expect(rows[0]).toEqual(['Doe, Jane', 'jane.doe@example.test']);
  });
  it('parses UTF-8 BOM, embedded line breaks, escaped quotes, empty cells, and all record terminators', () => {
    expect(
      read(
        '\uFEFFName,Notes,Email\r\n"Jo, Jr.","one\r\ntwo","A@example.test"\rN,"left""right",\n,"",a@b.test\n',
      ),
    ).toEqual({
      headers: ['Name', 'Notes', 'Email'],
      rows: [
        ['Jo, Jr.', 'one\r\ntwo', 'A@example.test'],
        ['N', 'left"right', ''],
        ['', '', 'a@b.test'],
      ],
    });
    expect(read('email\n\n\n').rows).toEqual([[''], ['']]);
    expect(read('email\n').rows).toEqual([]);
  });

  it.each([
    'name,email\nfoo,"unclosed e@x.test',
    'name,email\nfoo,un"expected',
    'name,email\nfoo,"value"x',
    'name,email\nfoo,\0',
    '\nwho@example.test',
  ])('rejects malformed files without echoing cells', (csv) => {
    expect(() => read(csv)).toThrow();
    try {
      read(csv);
    } catch (e) {
      const message = (e as Error).message;
      expect(message).not.toMatch(/e@x\.test|who@example\.test|un"expected/i);
    }
  });

  it('enforces byte, row and column bounds and rejects invalid UTF-8', () => {
    expect(read('email\n' + 'x\n'.repeat(importLimits.rows)).rows).toHaveLength(importLimits.rows);
    expect(() => read('email\n' + 'x\n'.repeat(importLimits.rows + 1))).toThrow();
    expect(read('x,'.repeat(importLimits.columns - 1) + 'x').headers).toHaveLength(importLimits.columns);
    expect(() => read('x,'.repeat(importLimits.columns) + 'x')).toThrow();
    expect(() => read('é'.repeat(importLimits.bytes / 2 + 1))).toThrow();
    expect(() => readImportCsv(Buffer.from([0xc3, 0x28]))).toThrow(/UTF-8/);
  });

  it('validates an exact mapping and rejects delegated authority or CSV bytes in unknown fields', () => {
    expect(importPreviewInput.safeParse(encode('email,a\n', 0)).success).toBe(true);
    for (const input of [
      encode('email,a\n', -1),
      encode('email,a\n', 64),
      { ...encode('email,a\n', 1), workspaceId: ownerId },
      { ...encode('email,a\n', 0), csvBase64: 'x'.repeat(4 * Math.ceil(importLimits.bytes / 3) + 1) },
    ])
      expect(importPreviewInput.safeParse(input).success).toBe(false);
  });
});

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database;
const owner: Actor = {
  workspaceId: ownerId,
  userId: 'csv-owner',
  actorId: 'user:csv-owner',
  kind: 'session',
  owner: true,
  scopes: ['read'],
  brandIds: null,
};
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  for (const workspace of [ownerId, foreignId]) {
    await db.tenant(workspace, async (sql) => {
      await sql.query('INSERT INTO workspaces(workspace_id,name) VALUES ($1,$2)', [workspace, 'CSV fixture']);
      for (const brand of workspace === ownerId ? [brandId, sibling] : [brandId]) {
        await sql.query('INSERT INTO brands(workspace_id,id,name) VALUES ($1,$2,$3)', [
          workspace,
          brand,
          brand === sibling ? 'Companion sample' : 'Primary sample',
        ]);
      }
    });
  }
  for (const [workspace, brand, address, state] of [
    [ownerId, brandId, 'Reader+news@example.test', 'confirmed'],
    [ownerId, brandId, 'pending@example.test', 'pending'],
    [ownerId, brandId, 'unsub@example.test', 'unsubscribed'],
    [ownerId, brandId, 'bounce@example.test', 'hard_bounced'],
    [ownerId, brandId, 'complaint@example.test', 'complained'],
    [ownerId, sibling, 'sibling@example.test', 'confirmed'],
    [foreignId, brandId, 'foreign@example.test', 'confirmed'],
  ] as const) {
    await db.brand(workspace, brand, (sql) =>
      sql.query(
        'INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,$4,$5)',
        [workspace, brand, randomUUID(), address, state],
      ),
    );
  }
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});

describe('read-only brand CSV comparison', () => {
  const csv =
    'Name,Email address\n"Line one\nand two", Reader+news@EXAMPLE.TEST \nJ,Reader+news@example.test\n' +
    'J,reader+news@example.test\nJ,pending@example.test\nJ,unsub@example.test\nJ,bounce@example.test\nJ,complaint@example.test\n' +
    'J,sibling@example.test\nJ,foreign@example.test\nJ,invalid\nJ,\nextra,columns,here\n';
  it('counts unique rows, suppression, duplicates, invalid fields, and sibling/foreign matches without writes', async () => {
    const service = new CommandService(db);
    const expected: ImportPreviewResult = {
      rows: 12,
      invalid: 3,
      duplicates: 1,
      newContacts: 3,
      confirmed: 1,
      pending: 1,
      suppressed: 3,
      examples: [
        { row: 3, issue: 'duplicate' },
        { row: 11, issue: 'invalid_email' },
        { row: 12, issue: 'invalid_email' },
        { row: 13, issue: 'column_count' },
      ],
    };
    const counts = () =>
      db.brand(
        ownerId,
        brandId,
        async (sql) =>
          (
            await sql.query(
              'SELECT (SELECT count(*) FROM subscribers) AS contacts,(SELECT count(*) FROM subscriber_consent_events) AS events,(SELECT count(*) FROM subscriber_outbox) AS jobs,(SELECT count(*) FROM operations) AS operations',
            )
          ).rows[0],
      );
    const before = await counts();
    for (let i = 0; i < 2; i++) {
      const result = await service.execute('audience.previewImport', encode(csv), owner);
      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain('@');
    }
    expect(await counts()).toEqual(before);
    const other = (await service.execute(
      'audience.previewImport',
      encode('Email\nReader+news@example.test\n', 0, sibling),
      owner,
    )) as ImportPreviewResult;
    expect(other.newContacts).toBe(1);
  });
  it('denies delegated calls and a foreign brand without using their file', async () => {
    const service = new CommandService(db);
    await expect(
      service.execute('audience.previewImport', encode(csv), {
        ...owner,
        kind: 'connection',
        scopes: ['read', 'audience:summary'],
        brandIds: [brandId],
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.execute('audience.previewImport', encode(csv, 1, sibling), {
        ...owner,
        workspaceId: foreignId,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('caps issues, rejects invalid UTF-8 or base64, and requires an existing named mapping', async () => {
    const check = (input: ReturnType<typeof encode>) =>
      db.brand(ownerId, brandId, (sql) => previewImport(sql, input));
    const report = await check(encode('Email\n' + 'bad\n'.repeat(17), 0));
    expect(report.invalid).toBe(17);
    expect(report.examples).toHaveLength(importLimits.issueExamples);
    for (const input of [
      { ...encode('', 0), csvBase64: 'bm90PQ====' },
      { ...encode('', 0), csvBase64: Buffer.from([0xff]).toString('base64') },
      encode('first,second\nfoo,bar', 2),
      encode('first,\nfoo,bar', 1),
      encode('reader@example.test\nnext@example.test', 0),
    ])
      await expect(check(input)).rejects.toMatchObject({ status: 422 });
  });
});
