import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as nodeRequest, type Server } from 'node:http';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { Authenticator, type IdentityProvider } from '../src/server/auth.js';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { digest, inspectImage, safeLink } from '../src/server/content.js';
import { createMcpServer, apiCaller } from '../src/mcp/bridge.js';
import { emptyContent, type AssetSummary, type Campaign, type Connection, type Workspace } from '../src/shared/contracts.js';

const owner = (workspaceId: string): Actor => ({ workspaceId, userId: `user_${workspaceId}`, actorId: `user:user_${workspaceId}`, owner: true, kind: 'session', scopes: ['read', 'draft:write', 'assets:write'], brandIds: null });
const a = owner('org_alpha'); const b = owner('org_beta');
let stop: () => Promise<void>; let db: Database; let service: CommandService; let server: Server; let origin: string;
let brandA: string; let brandB: string; let draftA: Campaign; let png: string;
const removed = new Set<string>();
const identity: IdentityProvider = {
  async session(request) { const actor = request.get('authorization') === 'Bearer test-alpha' ? a : request.get('authorization') === 'Bearer test-beta' ? b : null; if (!actor) throw new Error('Invalid test session'); return { userId: actor.userId, workspaceId: actor.workspaceId }; },
  async isOwner(user, workspace) { return user === `user_${workspace}` && !removed.has(user); },
};
const run = <T>(name: Parameters<CommandService['execute']>[0], input: unknown, actor = a) => service.execute(name, input, actor) as Promise<T>;
const keyed = <T extends object>(fields: T) => ({ operationKey: randomUUID(), ...fields });
const create = (title: string, brandId = brandA, actor = a) => run<Campaign>('campaign.create', keyed({ brandId, content: { ...emptyContent(), title } }), actor);
async function issue(scopes = ['read', 'draft:write', 'assets:write'], issuer = a, brand = brandA) { return run<{ connection: Connection; token: string }>('connection.create', keyed({ name: 'Contract test', scopes, brandIds: [brand], expiresInDays: 30 }), issuer); }
async function http(name: string, input: unknown, token = 'test-alpha', requestOrigin?: string) {
  return fetch(`${origin}/api/v1/commands/${name}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(requestOrigin ? { origin: requestOrigin } : {}) }, body: JSON.stringify(input) });
}
beforeAll(async () => {
  const fixture = await startDatabase(); stop = fixture.stop; db = new Database(fixture.url); await db.verifyBoundary(); service = new CommandService(db);
  for (const actor of [a, b]) await run('workspace.initialize', keyed({ name: actor.workspaceId, brandName: 'Sample retail' }), actor);
  brandA = (await run<Workspace>('workspace.get', {})).brands[0]!.id;
  brandB = (await run<Workspace>('workspace.get', {}, b)).brands[0]!.id;
  draftA = await create('First draft');
  png = (await sharp({ create: { width: 16, height: 12, channels: 3, background: '#a41f2d' } }).png().toBuffer()).toString('base64');
  const config = loadConfig({ APP_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:4310', LOCAL_TEST_IDENTITY: 'true', DATABASE_URL: fixture.url });
  const app = createApp(config, service, new Authenticator(db, identity));
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server'); origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await db?.close(); await stop?.(); });

describe('real PostgreSQL isolation and concurrency', () => {
  it('uses an unprivileged runtime with forced policies and no schema creation', async () => { await expect(db.verifyBoundary()).resolves.toBeUndefined(); await expect(db.pool.query('CREATE TABLE should_fail(id int)')).rejects.toThrow(); });
  it('reads no tenant records without a transaction context', async () => { expect((await db.pool.query('SELECT * FROM campaigns')).rowCount).toBe(0); });
  it('filters another workspace and prevents cross-tenant inserts under A context', async () => {
    await db.tenant(a.workspaceId, async sql => { expect((await sql.query('SELECT * FROM brands WHERE id=$1', [brandB])).rowCount).toBe(0); });
    await expect(db.tenant(a.workspaceId, sql => sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [b.workspaceId, randomUUID(), 'Forbidden']))).rejects.toThrow(/row-level security/);
  });
  it('rejects cross-workspace references even with a valid foreign UUID', async () => {
    await expect(db.tenant(a.workspaceId, sql => sql.query('INSERT INTO campaigns(workspace_id,id,brand_id,content) VALUES($1,$2,$3,$4)', [a.workspaceId, randomUUID(), brandB, '{}']))).rejects.toThrow(/foreign key/);
    await expect(run('campaign.get', { id: draftA.id }, b)).rejects.toMatchObject({ code: 'not_found' });
    await expect(run('campaign.create', keyed({ brandId: brandB, content: emptyContent() }))).rejects.toMatchObject({ code: 'not_found' });
  });
  it('does not provision workspace data from a read', async () => { const actor = owner('org_empty'); expect(await run('workspace.get', {}, actor)).toBeNull(); expect(await db.tenant(actor.workspaceId, async sql => (await sql.query('SELECT * FROM workspaces')).rowCount)).toBe(0); });
  it('initializes one workspace and brand across retries', async () => { await run('workspace.initialize', keyed({ name: 'Do not replace', brandName: 'Do not duplicate' })); const result = await run<Workspace>('workspace.get', {}); expect(result.name).toBe(a.workspaceId); expect(result.brands).toHaveLength(1); });
  it('deduplicates concurrent requests with the same operation key', async () => { const input = keyed({ brandId: brandA, content: { ...emptyContent(), title: 'One concurrent draft' } }); const [one, two] = await Promise.all([run<Campaign>('campaign.create', input), run<Campaign>('campaign.create', input)]); expect(one.id).toBe(two.id); expect(one.version).toBe(1); });
  it('rejects reuse of an operation key with different content', async () => { const input = keyed({ brandId: brandA, content: emptyContent() }); await run('campaign.create', input); await expect(run('campaign.create', { ...input, content: { ...input.content, title: 'Changed' } })).rejects.toMatchObject({ code: 'operation_conflict' }); });
  it('allows exactly one writer for the same expected version', async () => { const draft = await create('Two editors'); const results = await Promise.allSettled(['One', 'Two'].map(title => run<Campaign>('campaign.update', keyed({ id: draft.id, expectedVersion: 1, content: { ...draft.content, title } })))); expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); const failure = results.find(r => r.status === 'rejected'); expect(failure?.status === 'rejected' && failure.reason.code).toBe('version_conflict'); expect((await run<Campaign>('campaign.get', { id: draft.id })).version).toBe(2); });
  it('does not consume another tenant operation key or list their campaigns', async () => { const campaigns = await run<Campaign[]>('campaign.list', {}, b); expect(campaigns).toEqual([]); });
});

describe('original image batches and preview safety', () => {
  it('preserves original photo bytes and handles partial batches safely', async () => {
    const goodKey = randomUUID(); const badKey = randomUUID();
    const input = keyed({ brandId: brandA, files: [{ itemKey: goodKey, name: 'lifestyle.png', base64: png }, { itemKey: badKey, name: 'fake.png', base64: Buffer.from('<svg onload="alert(1)"></svg>').toString('base64') }] });
    type Batch = { results: { itemKey: string; ok: boolean; reused?: boolean; asset?: AssetSummary; error?: { code: string } }[] };
    const result = await run<Batch>('asset.uploadBatch', input); expect(result.results.map(r => r.ok)).toEqual([true, false]); expect(result.results[1]?.error?.code).toBe('invalid_image');
    const stored = await service.readAsset(a, result.results[0]!.asset!.id); expect(stored.bytes.toString('base64')).toBe(png);
    expect(result.results[0]?.asset?.sha256).toBe(digest(Buffer.from(png, 'base64')));
    expect(await run('asset.uploadBatch', input)).toEqual(result);
    const retry = await run<Batch>('asset.uploadBatch', { ...input, operationKey: randomUUID(), files: [input.files[0]] }); expect(retry.results[0]?.reused).toBe(true);
    const changed = await run<Batch>('asset.uploadBatch', { ...input, operationKey: randomUUID(), files: [{ ...input.files[0], name: 'different.png' }] }); expect(changed.results[0]?.error?.code).toBe('item_conflict');
    await expect(service.readAsset(b, stored.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(run('campaign.create', keyed({ brandId: brandB, content: { ...emptyContent(), assetIds: [stored.id] } }), b)).rejects.toMatchObject({ code: 'image_unavailable' });
  });
  it('rejects broken, oversized and animated/unsupported media before storing', async () => {
    await expect(inspectImage('%%%')).rejects.toMatchObject({ code: 'image_size' });
    await expect(inspectImage(Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'))).rejects.toMatchObject({ code: 'image_size' });
    await expect(inspectImage(Buffer.from('GIF89a').toString('base64'))).rejects.toMatchObject({ code: 'invalid_image' });
    const huge = await sharp({ create: { width: 5001, height: 5000, channels: 3, background: '#fff' } }).png().toBuffer();
    await expect(inspectImage(huge.toString('base64'))).rejects.toMatchObject({ code: 'invalid_image' });
  });
  it('escapes script markup and omits unsafe links from both preview versions', async () => {
    const draft = await run<Campaign>('campaign.create', keyed({ brandId: brandA, content: { ...emptyContent(), subject: '</title><script>alert(1)</script>', heading: '<img onerror=alert(1)>', body: '<script>steal()</script>\nKeep line breaks', ctaLabel: 'Click', ctaUrl: 'javascript:alert(1)' } }));
    const preview = await run<{ html: string; text: string }>('campaign.preview', { id: draft.id, expectedVersion: 1 });
    expect(preview.html).not.toContain('<script>'); expect(preview.html).toContain('&lt;script&gt;'); expect(preview.html).not.toContain('href="javascript:'); expect(preview.text).not.toContain('javascript:'); expect(preview.text).toContain('\nKeep line breaks');
    await expect(run('campaign.preview', { id: draft.id, expectedVersion: 2 })).rejects.toMatchObject({ code: 'version_conflict' });
  });
  it.each(['http://example.com', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://127.0.0.1', 'https://localhost', 'https://host.internal', 'https://example.com:8080', 'https://[::1]'])('rejects unsafe CTA %s', link => expect(safeLink(link)).toBe(false));
  it('accepts a public HTTPS CTA', () => expect(safeLink('https://example.com/shop?item=1&color=red')).toBe(true));
  it('returns all setup gaps and never claims send readiness', async () => { const checks = await run<{ canSend: boolean; gaps: { code: string }[] }>('campaign.preflight', { id: draftA.id }); expect(checks.canSend).toBe(false); expect(checks.gaps.map(g => g.code)).toEqual(expect.arrayContaining(['subject_missing', 'from_name_missing', 'reply_to_invalid', 'message_incomplete', 'sender_not_verified', 'audience_not_ready', 'entitlement_not_active', 'delivery_not_configured'])); });
  it('reports setup gaps before any campaign or upload exists', async () => { const result = await run<{ initialized: boolean; canSend: boolean; gaps: { code: string }[] }>('workspace.preflight', {}, owner('org_not_started')); expect(result.initialized).toBe(false); expect(result.canSend).toBe(false); expect(result.gaps.map(g => g.code)).toEqual(expect.arrayContaining(['workspace_not_initialized', 'sender_not_verified', 'audience_not_ready', 'entitlement_not_active', 'delivery_not_configured'])); });
  it('returns an oversized-file failure without losing a valid item', async () => {
    const result = await run<{ results: { ok: boolean; error?: { code: string } }[] }>('asset.uploadBatch', keyed({ brandId: brandA, files: [{ itemKey: randomUUID(), name: 'oversize.png', base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }, { itemKey: randomUUID(), name: 'valid.png', base64: png }] }));
    expect(result.results[0]?.error?.code).toBe('image_size'); expect(result.results[1]?.ok).toBe(true);
  });
});

describe('HTTP authority, credentials and transport parity', () => {
  it('rejects missing authorization and foreign browser origins', async () => {
    expect((await fetch(`${origin}/api/v1/commands/workspace.get`, { method: 'POST' })).status).toBe(401);
    expect((await http('workspace.get', {}, 'test-alpha', 'https://foreign.example')).status).toBe(403);
    expect((await http('workspace.get', {}, 'test-alpha', 'http://127.0.0.1:4310')).status).toBe(200);
    const rejectedHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = nodeRequest(`${origin}/api/config`, { headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    expect(rejectedHost).toBe(403);
  });
  it('returns field-level input errors without secrets', async () => { const response = await http('campaign.update', { id: draftA.id, expectedVersion: -1 }); expect(response.status).toBe(422); const body = await response.json(); expect(body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'expectedVersion' })])); });
  it('does not expose a send route', async () => { expect((await http('campaign.send', { id: draftA.id })).status).toBe(404); });
  it('stores only token hashes and never replays a secret', async () => {
    const input = keyed({ name: 'One-time secret', scopes: ['read'], brandIds: [brandA], expiresInDays: 30 });
    const issued = await run<{ token: string; connection: Connection }>('connection.create', input); expect(issued.token).toMatch(/^flk_/);
    const replay = await run<{ token?: string; secretAlreadyIssued: boolean }>('connection.create', input); expect(replay.token).toBeUndefined(); expect(replay.secretAlreadyIssued).toBe(true);
    const rows = await db.tenant(a.workspaceId, async sql => ({ operations: (await sql.query('SELECT * FROM operations')).rows, audit: (await sql.query('SELECT * FROM audit')).rows, connection: (await sql.query('SELECT * FROM connections WHERE id=$1', [issued.connection.id])).rows[0] }));
    expect(JSON.stringify(rows)).not.toContain(issued.token); expect(rows.connection.token_hash).toBe(digest(issued.token));
  });
  it('separates read/write scopes and prevents token privilege management', async () => { const read = await issue(['read']); expect((await http('workspace.get', {}, read.token)).status).toBe(200); expect((await http('campaign.create', keyed({ brandId: brandA, content: emptyContent() }), read.token)).status).toBe(403); expect((await http('connection.list', {}, read.token)).status).toBe(403); });
  it('rejects expired, revoked and forged credentials', async () => {
    const expired = await issue(); await db.tenant(a.workspaceId, sql => sql.query("UPDATE connections SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.connection.id])); expect((await http('workspace.get', {}, expired.token)).status).toBe(401);
    const revoked = await issue(); await run('connection.revoke', keyed({ id: revoked.connection.id })); expect((await http('workspace.get', {}, revoked.token)).status).toBe(401);
    expect((await http('workspace.get', {}, revoked.token + 'x')).status).toBe(401);
    const swapped = revoked.token.replace(Buffer.from(a.workspaceId).toString('base64url'), Buffer.from(b.workspaceId).toString('base64url')); expect((await http('workspace.get', {}, swapped)).status).toBe(401);
  });
  it('checks current issuing-owner membership for every connection request', async () => { const issued = await issue(); removed.add(a.userId); try { expect((await http('workspace.get', {}, issued.token)).status).toBe(403); expect((await http('workspace.get', {})).status).toBe(403); } finally { removed.delete(a.userId); } });
  it('protects assets and provides JSON schema matching canonical commands', async () => { expect((await fetch(`${origin}/api/v1/assets/${randomUUID()}`)).status).toBe(401); const response = await fetch(`${origin}/api/v1/schema`, { headers: { authorization: 'Bearer test-alpha' } }); const schema = await response.json(); expect(schema.commands['campaign.update'].inputSchema.required).toContain('expectedVersion'); expect(schema.commands['campaign.send']).toBeUndefined(); });
  it('narrows a connection to its granted brand even inside the same workspace', async () => {
    const otherBrand = randomUUID(); await db.tenant(a.workspaceId, sql => sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [a.workspaceId, otherBrand, 'Another brand']));
    const hidden = await create('Brand-private draft', otherBrand); const issued = await issue();
    expect((await http('campaign.get', { id: hidden.id }, issued.token)).status).toBe(404);
    const workspace = await (await http('workspace.get', {}, issued.token)).json(); expect(workspace.result.brands.map((item: { id: string }) => item.id)).toEqual([brandA]);
    expect((await http('asset.list', { brandId: otherBrand }, issued.token)).status).toBe(404);
    await run('connection.revoke', keyed({ id: issued.connection.id }));
  });
  it('performs a real MCP initialize/list/call over the same HTTP API', async () => {
    const issued = await issue(); const bridge = createMcpServer(apiCaller(origin, issued.token)); const mcp = new Client({ name: 'foundation-contract', version: '1' }); const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await bridge.connect(serverTransport); await mcp.connect(clientTransport);
    try {
      const tools = await mcp.listTools(); expect(tools.tools.map(t => t.name)).toContain('campaign_preflight'); expect(tools.tools.map(t => t.name)).not.toContain('connection_create');
      const response = await mcp.callTool({ name: 'campaign_get', arguments: { id: draftA.id } });
      const content = response.content as { type: string; text: string }[];
      expect(JSON.parse(content[0]!.text)).toEqual(await run('campaign.get', { id: draftA.id }));
      const mutation = keyed({ brandId: brandA, content: { ...emptyContent(), title: 'MCP-created' } });
      const first = await mcp.callTool({ name: 'campaign_create', arguments: mutation });
      const second = await mcp.callTool({ name: 'campaign_create', arguments: mutation }); expect(JSON.parse((second.content as { text: string }[])[0]!.text)).toEqual(JSON.parse((first.content as { text: string }[])[0]!.text));
      await run('connection.revoke', keyed({ id: issued.connection.id })); const denied = await mcp.callTool({ name: 'workspace_get', arguments: {} }); expect(denied.isError).toBe(true);
    } finally { await mcp.close(); await bridge.close(); }
  });
  it('blocks local photo paths outside the configured MCP folder', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'flockletter-assets-')); const outside = await mkdtemp(path.join(tmpdir(), 'flockletter-outside-'));
    await writeFile(path.join(directory, 'photo.png'), Buffer.from(png, 'base64')); await writeFile(path.join(outside, 'secret.png'), Buffer.from(png, 'base64')); await symlink(path.join(outside, 'secret.png'), path.join(directory, 'escape.png'));
    let calls = 0; const bridge = createMcpServer(async () => { calls++; return { ok: true }; }, directory); const mcp = new Client({ name: 'photo-contract', version: '1' }); const [ct, st] = InMemoryTransport.createLinkedPair(); await bridge.connect(st); await mcp.connect(ct);
    try {
      const args = (file: string) => ({ operationKey: randomUUID(), brandId: brandA, files: [{ itemKey: randomUUID(), path: file }] });
      expect((await mcp.callTool({ name: 'asset_upload_files', arguments: args('escape.png') })).isError).toBe(true); expect(calls).toBe(0);
      expect((await mcp.callTool({ name: 'asset_upload_files', arguments: args('photo.png') })).isError).not.toBe(true); expect(calls).toBe(1);
    } finally { await mcp.close(); await bridge.close(); await rm(directory, { recursive: true }); await rm(outside, { recursive: true }); }
  });
});

describe('configuration gates', () => {
  it.each([{ APP_ENV: 'staging', APP_ORIGIN: 'https://example.com' }, { APP_ENV: 'local', HOST: '0.0.0.0' }, { APP_ENV: 'local', APP_ORIGIN: 'https://example.com' }, { APP_ENV: 'local', RENDER: 'true' }, { APP_ENV: 'local', NODE_ENV: 'production' }])('rejects deployed synthetic identity %j', env => expect(() => loadConfig({ ...env, LOCAL_TEST_IDENTITY: 'true' })).toThrow());
  it('cannot start as production', () => expect(() => loadConfig({ APP_ENV: 'production' })).toThrow());
  it('preserves the exact owner-provided logo', async () => { const logo = await readFile(new URL('../public/brand/frosty-flamingo-software.png', import.meta.url)); expect(digest(logo)).toBe('256e619a2ac589b4e2e248115bd395379819725888da16f661a6e1a6aa1304b2'); });
});
