import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startDatabase } from '../scripts/database-fixture.js';
import { createMcpServer } from '../src/mcp/bridge.js';
import { renderPreview } from '../src/server/content.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import {
  commands,
  contentSchema,
  isCommand,
  type Campaign,
  type Workspace,
} from '../src/shared/contracts.js';
import { fromProductContent, fromTemplateContent, templateIds, templates } from '../src/shared/authoring.js';

const id = randomUUID;
const product = {
  productName: 'Field tee',
  excerpt: 'A sky-blue tee with a stitched hem.',
  productUrl: 'https://retailer.example.com/products/field-tee',
  assetIds: [] as string[],
};

describe('newsletter authoring', () => {
  it('offers three original templates; each produces an editable draft with space for the owner’s message', () => {
    expect(templates.map((t) => t.id)).toEqual([...templateIds]);
    for (const t of templates) {
      const content = fromTemplateContent(t.id);
      expect(contentSchema.parse(content)).toEqual(content);
      expect(content).toMatchObject({ layout: t.id, body: '', replyTo: '', assetIds: [] });
      expect(t.sections).toHaveLength(3);
    }
  });
  it('preserves selected image order, uses the supplied text verbatim and escapes it in a preview', () => {
    const photos = [id(), id()];
    const content = fromProductContent({ ...product, excerpt: '<script>never()</script>', assetIds: photos });
    expect(content).toMatchObject({
      title: product.productName,
      subject: product.productName,
      heading: product.productName,
      body: '<script>never()</script>',
      ctaUrl: product.productUrl,
      ctaLabel: 'View product',
      assetIds: photos,
    });
    expect(content.assetIds).not.toBe(photos);
    const campaign: Campaign = {
      id: id(),
      brandId: id(),
      version: 1,
      content,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'draft',
    };
    const preview = renderPreview(campaign, []);
    expect(preview.html).toContain('&lt;script&gt;never()&lt;/script&gt;');
    expect(preview.html).not.toContain('<script>never()');
  });
  it('gives the collection a story before its gallery and preserves the legacy preview order', () => {
    const image = { name: 'Image marker', mime: 'image/png', bytes: Buffer.from('sample') };
    for (const layout of [undefined, 'announcement', 'collection', 'appreciation'] as const) {
      const content = {
        ...fromTemplateContent('announcement'),
        layout,
        body: 'Story marker',
        ctaLabel: 'Link marker',
        ctaUrl: product.productUrl,
      };
      const campaign: Campaign = {
        id: id(),
        brandId: id(),
        version: 1,
        content,
        createdAt: '',
        updatedAt: '',
        status: 'draft',
      };
      const html = renderPreview(campaign, [image]).html;
      const photo = html.indexOf('Image marker'),
        story = html.indexOf('Story marker'),
        link = html.indexOf('Link marker');
      expect([photo, story, link].every((i) => i > 0)).toBe(true);
      if (layout === 'collection') expect(story < photo && photo < link).toBe(true);
      else if (layout === 'appreciation') expect(story < link && link < photo).toBe(true);
      else expect(photo < story && story < link).toBe(true);
    }
  });
  it('accepts only explicit public HTTPS product URLs, known image IDs, and reviewed product fields', () => {
    const input = { ...product, brandId: id(), operationKey: id() };
    const schema = commands['campaign.fromProduct'].schema;
    expect(schema.safeParse(input).success).toBe(true);
    for (const link of [
      'http://retailer.example.com',
      'https:example.com',
      'https://owner:secret@example.com',
      'https://localhost.',
      'https://worker.internal./item',
      'https://0x7f000001/x',
      'https://[::1]/',
      'https://example.com:81/',
      'https://example.com/path\nnext',
      'javascript:alert(1)',
    ]) {
      expect(schema.safeParse({ ...input, productUrl: link }).success).toBe(false);
    }
    for (const extra of [
      { imageUrl: 'https://example.com/product.jpg' },
      { assetIds: [id(), 'bad'] },
      { productName: 'Subject\nAnother header' },
      { excerpt: '  ' },
      { assetIds: Array(7).fill(id()) },
    ]) {
      expect(schema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
  });
});

describe('authoring commands in a restricted workspace', () => {
  let db: Database, service: CommandService, fixture: Awaited<ReturnType<typeof startDatabase>>;
  const owner: Actor = {
    workspaceId: 'org_authoring_sample',
    userId: 'sample_owner',
    actorId: 'user:sample_owner',
    kind: 'session',
    owner: true,
    scopes: ['read'],
    brandIds: null,
  };
  let brand: string, other: string, photo: string, otherPhoto: string, data: Buffer;
  let editor: Actor;
  beforeAll(async () => {
    fixture = await startDatabase();
    db = new Database(fixture.url);
    await db.verifyBoundary();
    service = new CommandService(db);
    await service.execute(
      'workspace.initialize',
      { name: 'Sample store', brandName: 'Field Notes', operationKey: id() },
      owner,
    );
    brand = ((await service.execute('workspace.get', {}, owner)) as Workspace).brands[0]!.id;
    other = id();
    await db.tenant(owner.workspaceId, (sql) =>
      sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
        owner.workspaceId,
        other,
        'Other brand',
      ]),
    );
    editor = {
      ...owner,
      kind: 'connection',
      actorId: 'connection:' + id(),
      scopes: ['read', 'draft:write'],
      brandIds: [brand],
    };
    data = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'navy' } })
      .png()
      .toBuffer();
    async function upload(brandId: string) {
      const result = (await service.execute(
        'asset.uploadBatch',
        {
          brandId,
          operationKey: id(),
          files: [{ itemKey: id(), name: 'original.png', base64: data.toString('base64') }],
        },
        owner,
      )) as { results: { asset: { id: string } }[] };
      return result.results[0]!.asset.id;
    }
    photo = await upload(brand);
    otherPhoto = await upload(other);
  });
  afterAll(async () => {
    await db?.close();
    await fixture?.stop();
  });
  it('uses the canonical draft checks, one durable replay and the unchanged original photo', async () => {
    const input = { ...product, brandId: brand, operationKey: id(), assetIds: [photo] };
    const make = () => service.execute('campaign.fromProduct', input, editor) as Promise<Campaign>;
    const [a, b] = await Promise.all([make(), make()]);
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({
      status: 'draft',
      version: 1,
      brandId: brand,
      content: { assetIds: [photo], layout: 'announcement' },
    });
    await expect(
      service.execute('campaign.fromProduct', { ...input, excerpt: 'Another excerpt' }, editor),
    ).rejects.toMatchObject({ code: 'operation_conflict' });
    const retained = await service.readAsset(editor, photo);
    expect(retained.bytes).toEqual(data);
    await expect(
      service.execute(
        'campaign.fromProduct',
        { ...input, operationKey: id(), assetIds: [otherPhoto] },
        editor,
      ),
    ).rejects.toMatchObject({ code: 'image_unavailable' });
    await expect(
      service.execute(
        'campaign.fromProduct',
        { ...input, operationKey: id(), brandId: other, assetIds: [] },
        editor,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.execute(
        'campaign.fromTemplate',
        { brandId: brand, operationKey: id(), templateId: 'collection' },
        { ...editor, scopes: ['read'] },
      ),
    ).rejects.toMatchObject({ status: 403 });
    const events = await db.tenant(
      owner.workspaceId,
      async (sql) => (await sql.query("SELECT action FROM audit WHERE action='campaign.fromProduct'")).rows,
    );
    expect(events).toEqual([{ action: 'campaign.fromProduct' }]);
  });
  it('lists templates and creates the exact selected layout over MCP', async () => {
    const server = createMcpServer((name, input) => {
      if (!isCommand(name)) throw Error('Unknown test command.');
      return service.execute(name, input, editor);
    });
    const client = new Client({ name: 'authoring-acceptance', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b);
      await client.connect(a);
      const toolNames = (await client.listTools()).tools.map((t) => t.name);
      expect(toolNames).toEqual(
        expect.arrayContaining(['template_list', 'campaign_fromTemplate', 'campaign_fromProduct']),
      );
      const catalogue = await client.callTool({ name: 'template_list', arguments: {} });
      expect(catalogue.isError).not.toBe(true);
      expect(JSON.parse((catalogue.content as { text: string }[])[0]!.text)).toEqual(templates);
      const result = await client.callTool({
        name: 'campaign_fromTemplate',
        arguments: { brandId: brand, operationKey: id(), templateId: 'appreciation' },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({
        brandId: brand,
        version: 1,
        status: 'draft',
        content: { layout: 'appreciation' },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
