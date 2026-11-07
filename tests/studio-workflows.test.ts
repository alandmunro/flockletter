import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiCaller, createMcpServer } from '../src/mcp/bridge.js';
import { emptyContent, type Campaign, type CampaignContent } from '../src/shared/contracts.js';
import type { Rehearsal } from '../src/shared/rehearsal.js';
import type { StudioDocument } from '../src/shared/studio.js';
import { keyed, startStudioProof } from '../scripts/studio-proof-fixture.js';
import { sampleStudio, malformedStudio, productUrl } from './studio-examples.js';

type Preview = { version: number; html: string; text: string };
let site: Awaited<ReturnType<typeof startStudioProof>>;
let connection: string;
let mcp: Client;
let bridge: ReturnType<typeof createMcpServer>;

async function tool<T>(name: string, input: Record<string, unknown>): Promise<T> {
  const result = await mcp.callTool({ name, arguments: input });
  expect(result.isError).not.toBe(true);
  return JSON.parse((result.content as { text: string }[])[0]!.text) as T;
}
function content(document: StudioDocument = sampleStudio(site.front.asset.id)): CampaignContent {
  return {
    ...emptyContent(),
    title: 'Trailhead journal',
    subject: 'November field notes',
    fromName: 'Trail Post',
    replyTo: 'mail@example.test',
    assetIds: [site.front.asset.id],
    studio: document,
  };
}
const get = (id: string) => site.command<Campaign>('campaign.get', { id });
const make = () =>
  site.command<Campaign>('campaign.create', keyed({ brandId: site.brandId, content: content() }));
const review = (draft: Campaign) =>
  site.command<Rehearsal>(
    'rehearsal.review',
    keyed({
      brandId: site.brandId,
      campaignId: draft.id,
      expectedVersion: draft.version,
      audience: 'test',
    }),
  );
async function expectRejected(
  name: Parameters<typeof site.post>[0],
  input: unknown,
  expected: number | number[],
  token?: string,
) {
  const response = await site.post(name, input, token);
  expect(Array.isArray(expected) ? expected : [expected]).toContain(response.status);
  expect((await response.json()).error.code).toBeTruthy();
}
beforeAll(async () => {
  site = await startStudioProof();
  connection = await site.connection(['read', 'draft:write']);
  bridge = createMcpServer(apiCaller(site.origin, connection));
  mcp = new Client({ name: 'studio-acceptance', version: '1' });
  const [client, server] = InMemoryTransport.createLinkedPair();
  await bridge.connect(server);
  await mcp.connect(client);
});
afterAll(async () => {
  try {
    await mcp?.close();
    await bridge?.close();
  } finally {
    await site?.close();
  }
});

describe('Newsletter Studio through HTTP, MCP and PostgreSQL', () => {
  it('round-trips all blocks across both transports, preserves original image bytes and exports equivalent HTML and plain text', async () => {
    const input = keyed({ brandId: site.brandId, content: content() });
    const draft = await tool<Campaign>('campaign_create', input);
    expect(draft.version).toBe(1);
    expect(draft.content.studio).toEqual(input.content.studio);
    expect(await get(draft.id)).toEqual(draft);
    // Repeat the committed MCP request through HTTP with the same connection identity.
    expect(await site.command<Campaign>('campaign.create', input, connection)).toEqual(draft);
    const saved = await site.db.tenant(site.owner.workspaceId, (sql) =>
      sql.query('SELECT content,version FROM campaigns WHERE id=$1', [draft.id]),
    );
    expect(saved.rows).toEqual([{ content: draft.content, version: 1 }]);
    const args = { id: draft.id, expectedVersion: 1 };
    const preview = await site.command<Preview>('campaign.preview', args);
    expect(await tool<Preview>('campaign_preview', args)).toEqual(preview);
    expect(preview.html).toContain(site.front.bytes.toString('base64'));
    expect(preview.html).not.toMatch(/<script(?:\s|>)|\son(?:error|load|click)\s*=|\/api\/v1\/assets\//i);
    expect(preview.html).toContain('&lt;script&gt;');
    expect(preview.text).toContain('<script>');
    expect(preview.html.indexOf('Left label')).toBeGreaterThan(-1);
    expect(preview.html.indexOf('Right label')).toBeGreaterThan(preview.html.indexOf('Left label'));
    for (const marker of ['Left label', 'Right label', productUrl]) {
      expect(preview.text).toContain(marker);
    }
    const asset = await fetch(site.origin + '/api/v1/assets/' + site.front.asset.id, {
      headers: { authorization: 'Bearer ' + connection },
    });
    expect(asset.status).toBe(200);
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(site.front.bytes);
    expect(createHash('sha256').update(site.front.bytes).digest('hex')).toBe(site.front.asset.sha256);
    const check = await site.command<{ contentReady: boolean; canSend: boolean }>('campaign.preflight', {
      id: draft.id,
    });
    expect(check).toMatchObject({ contentReady: true, canSend: false });
  });

  it('rejects malformed documents, removed Studio content, invalid asset indexes and foreign image references without overwriting the saved revision', async () => {
    const draft = await make();
    const base = { id: draft.id, expectedVersion: draft.version };
    for (const example of malformedStudio(draft.content.studio!)) {
      await expectRejected(
        'campaign.update',
        keyed({ ...base, content: { ...draft.content, studio: example.document } }),
        422,
      );
    }
    const flat = { ...draft.content };
    delete flat.studio;
    await expectRejected('campaign.update', keyed({ ...base, content: flat }), [409, 422]);
    await expectRejected(
      'campaign.update',
      keyed({
        ...base,
        content: { ...draft.content, body: 'A legacy editor tried to flatten rich content.' },
      }),
      422,
    );
    await expectRejected(
      'campaign.update',
      keyed({ ...base, content: { ...draft.content, assetIds: [] } }),
      422,
    );
    for (const photo of [site.foreign, site.sibling]) {
      const foreignContent = {
        ...draft.content,
        assetIds: [photo.asset.id],
        studio: sampleStudio(photo.asset.id),
      };
      await expectRejected(
        'campaign.update',
        keyed({ ...base, content: foreignContent }),
        [404, 422],
        connection,
      );
    }
    const readOnly = await site.connection(['read']);
    await expectRejected('campaign.update', keyed({ ...base, content: draft.content }), 403, readOnly);
    const exposed = await fetch(site.origin + '/api/v1/assets/' + site.foreign.asset.id, {
      headers: { authorization: 'Bearer ' + connection },
    });
    expect(exposed.status).toBe(404);
    await expectRejected('campaign.get', { id: draft.id }, 404, site.otherSession);
    await expectRejected('campaign.preview', { id: draft.id, expectedVersion: 1 }, 404, site.otherSession);
    await expectRejected(
      'campaign.update',
      keyed({ ...base, content: draft.content }),
      404,
      site.otherSession,
    );
    expect(await site.command('campaign.list', {}, site.otherSession)).toEqual([]);
    expect(await get(draft.id)).toEqual(draft);
    const other = await site.db.tenant(site.other.workspaceId, (sql) =>
      sql.query('SELECT version FROM campaigns WHERE id=$1', [draft.id]),
    );
    expect(other.rows).toEqual([]);
  });

  it('keeps inline link and image order stable on a reopened revision and rejects a stale save after a successful full-document edit', async () => {
    const draft = await make();
    const previous = draft.content.studio!;
    const updated: StudioDocument = {
      ...previous,
      blocks: [
        { type: 'image', assetId: site.back.asset.id, alt: 'Second view first' },
        ...previous.blocks,
        { type: 'paragraph', runs: [{ text: 'A second edition.' }] },
      ],
    };
    const edit = keyed({
      id: draft.id,
      expectedVersion: 1,
      content: { ...draft.content, studio: updated, assetIds: [site.back.asset.id, site.front.asset.id] },
    });
    const saved = await tool<Campaign>('campaign_update', edit);
    expect(saved.version).toBe(2);
    expect(await site.command<Campaign>('campaign.update', edit, connection)).toEqual(saved);
    await expectRejected(
      'campaign.update',
      keyed({ id: saved.id, expectedVersion: 1, content: draft.content }),
      409,
      connection,
    );
    await expectRejected('campaign.preview', { id: saved.id, expectedVersion: 1 }, 409, connection);
    expect((await get(draft.id)).content.studio).toEqual(updated);
    const preview = await tool<Preview>('campaign_preview', { id: saved.id, expectedVersion: 2 });
    const positions = [site.back, site.front].map((photo) =>
      preview.html.indexOf(photo.bytes.toString('base64')),
    );
    expect(positions[0]).toBeGreaterThan(-1);
    expect(positions[1]).toBeGreaterThan(positions[0]!);
    expect(preview.text).toContain('A second edition.');
  });

  it('accepts a valid UTF-8 document whose full command exceeds 64 KiB and rejects an oversized replacement without changing it', async () => {
    const paragraphs = (length: number): StudioDocument => ({
      version: 1,
      blocks: [0, 1].map(() => ({
        type: 'paragraph',
        runs: [{ text: '山'.repeat(length) }],
      })),
    });
    const input = keyed({
      brandId: site.brandId,
      content: {
        ...emptyContent(),
        title: 'Multibyte document',
        studio: paragraphs(8400),
        body: '山'.repeat(12000),
      },
    });
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(65536);
    expect(Buffer.byteLength(JSON.stringify(input.content.studio))).toBeLessThan(65536);
    const draft = await site.command<Campaign>('campaign.create', input);
    const bigger = paragraphs(12000);
    expect(Buffer.byteLength(JSON.stringify(bigger))).toBeGreaterThan(65536);
    await expectRejected(
      'campaign.update',
      keyed({ id: draft.id, expectedVersion: 1, content: { ...draft.content, studio: bigger } }),
      422,
    );
    expect((await get(draft.id)).content.studio).toEqual(input.content.studio);
  });

  it('refuses old approvals, blocks an already queued edit, and captures exactly the preview of the freshly reviewed version', async () => {
    let draft = await make();
    const firstRequest = keyed({
      brandId: site.brandId,
      campaignId: draft.id,
      expectedVersion: draft.version,
      audience: 'test',
    });
    const first = await site.command<Rehearsal>('rehearsal.review', firstRequest);
    expect(await site.command('rehearsal.review', firstRequest)).toEqual(first);
    async function revise(label: string) {
      const doc = draft.content.studio!;
      draft = await site.command<Campaign>(
        'campaign.update',
        keyed({
          id: draft.id,
          expectedVersion: draft.version,
          content: {
            ...draft.content,
            studio: { ...doc, blocks: [...doc.blocks, { type: 'paragraph', runs: [{ text: label }] }] },
          },
        }),
      );
    }
    await revise('The revised note');
    await expectRejected('rehearsal.review', firstRequest, 409);
    await expectRejected('rehearsal.approve', keyed({ brandId: site.brandId, id: first.id }), 409);
    expect(await site.command('rehearsal.report', { brandId: site.brandId, id: first.id })).toMatchObject({
      state: 'blocked',
      reason: 'draft_changed',
      captured: 0,
    });
    const queued = await review(draft);
    const approvalRequest = keyed({ brandId: site.brandId, id: queued.id });
    const approval = await site.command<Rehearsal>('rehearsal.approve', approvalRequest);
    expect(await site.command('rehearsal.approve', approvalRequest)).toEqual(approval);
    await revise('The final reviewed note');
    await expectRejected('rehearsal.approve', approvalRequest, 409);
    expect(await site.command('rehearsal.report', { brandId: site.brandId, id: queued.id })).toMatchObject({
      state: 'blocked',
      reason: 'draft_changed',
      captured: 0,
    });
    await site.command('rehearsal.process', keyed({ brandId: site.brandId, id: queued.id }));
    expect(await site.command('rehearsal.report', { brandId: site.brandId, id: queued.id })).toMatchObject({
      state: 'blocked',
      reason: 'draft_changed',
      captured: 0,
    });
    const final = await review(draft);
    const preview = await site.command<Preview>('campaign.preview', {
      id: draft.id,
      expectedVersion: draft.version,
    });
    await site.command('rehearsal.approve', keyed({ brandId: site.brandId, id: final.id }));
    await site.command('rehearsal.process', keyed({ brandId: site.brandId, id: final.id }));
    const captured = await site.command<Preview & { mailbox: string }>('rehearsal.message', {
      brandId: site.brandId,
      id: final.id,
    });
    expect(captured).toMatchObject({
      mailbox: 'reader@campaign.test',
      version: 3,
      html: preview.html,
      text: preview.text,
    });
    const frozen = await site.db.brand(site.owner.workspaceId, site.brandId, (sql) =>
      sql.query('SELECT render_html,render_text FROM campaign_rehearsals WHERE id=$1', [final.id]),
    );
    expect(frozen.rows[0].render_html).toContain('cid:' + site.front.asset.sha256);
    expect(frozen.rows[0].render_text).toBe(preview.text);
  });
});
