import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startDatabase } from '../scripts/database-fixture.js';
import { recordAccess } from '../scripts/complimentary-access.js';
import { createApp } from '../src/server/app.js';
import { Authenticator } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { apiCaller, createMcpServer } from '../src/mcp/bridge.js';
import { emptyContent, type Campaign, type CommandName, type Workspace } from '../src/shared/contracts.js';
import { type Rehearsal } from '../src/shared/rehearsal.js';
import type { Segment, SegmentDirectory, SegmentMembershipResult } from '../src/shared/segments.js';
import type { SubscriberState } from '../src/shared/audience.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>,
  db: Database,
  admin: Database,
  service: CommandService;
let owner: Actor, brand: string, sibling: string;
const id = randomUUID;
const keyed = <T extends object>(input: T) => ({ ...input, operationKey: id() });
const run = <T>(name: CommandName, input: unknown, actor = owner) =>
  service.execute(name, input, actor) as Promise<T>;
const create = (name: string, brandId = brand) => run<Segment>('segment.create', keyed({ brandId, name }));
const memberInput = (segmentId: string, action: 'add' | 'remove', emails: string[]) =>
  keyed({ brandId: brand, segmentId, action, emails });
function members(group: Segment, emails: string[], action: 'add' | 'remove' = 'add') {
  return run<SegmentMembershipResult>('segment.members', memberInput(group.id, action, emails));
}
async function seed(email: string, state: SubscriberState = 'confirmed', brandId = brand) {
  const contactId = id();
  await db.brand(owner.workspaceId, brandId, (sql) =>
    sql.query(
      'INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,$4,$5)',
      [owner.workspaceId, brandId, contactId, email, state],
    ),
  );
  return contactId;
}
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  admin = new Database(fixture.adminUrl);
  await db.verifyBoundary();
  service = new CommandService(db, undefined, async () => true);
});
afterAll(async () => {
  await db?.close();
  await admin?.close();
  await fixture?.stop();
});
beforeEach(async () => {
  owner = {
    workspaceId: 'org_' + id().replaceAll('-', ''),
    userId: 'owner',
    actorId: 'user:owner',
    owner: true,
    kind: 'session',
    scopes: ['read'],
    brandIds: null,
  };
  await run('workspace.initialize', keyed({ name: 'Group fixture', brandName: 'Bookshop' }));
  brand = (await run<Workspace>('workspace.get', {})).brands[0]!.id;
  sibling = id();
  await db.tenant(owner.workspaceId, (sql) =>
    sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
      owner.workspaceId,
      sibling,
      'Second shop',
    ]),
  );
});

describe('static audience groups', () => {
  it('uses stable scoped names and counts all states without changing subscribers or their evidence', async () => {
    const group = await create('  Regular readers  ');
    expect(group.name).toBe('Regular readers');
    await expect(create('Regular READERS')).rejects.toMatchObject({ code: 'segment_name_conflict' });
    await expect(create('   ')).rejects.toMatchObject({ status: 422 });
    await expect(create('bad\nname')).rejects.toMatchObject({ status: 422 });
    await create('Regular readers', sibling);
    const states = ['confirmed', 'pending', 'unsubscribed', 'hard_bounced', 'complained'] as const;
    const addresses = states.map((_state, i) => 'Member+' + i + '@example.test');
    for (const [i, address] of addresses.entries()) await seed(address, states[i]);
    await db.brand(owner.workspaceId, brand, (sql) =>
      sql.query(
        `INSERT INTO subscriber_consent_events(workspace_id,brand_id,id,subscriber_id,event,purpose,policy_version,text_digest,source,source_domain)
       SELECT workspace_id,brand_id,$1,id,'signup_requested','marketing','fixture-v1','fixture','signup','example.test' FROM subscribers WHERE email_normalized=$2`,
        [id(), addresses[0]],
      ),
    );
    const contactFacts = () =>
      db.brand(owner.workspaceId, brand, async (sql) => ({
        contacts: (await sql.query('SELECT id,state,updated_at FROM subscribers ORDER BY id')).rows,
        evidence: (await sql.query('SELECT * FROM subscriber_consent_events ORDER BY id')).rows,
      }));
    const before = await contactFacts();
    expect(before.evidence).toHaveLength(1);
    const input = memberInput(group.id, 'add', [
      ...addresses.map((a) => a.replace('example', 'EXAMPLE')),
      addresses[0]!,
    ]);
    const result = await run<SegmentMembershipResult>('segment.members', input);
    expect(result).toEqual({
      segmentId: group.id,
      changed: 5,
      counts: { total: 5, confirmed: 1, pending: 1, unsubscribed: 1, hard_bounced: 1, complained: 1 },
    });
    expect(await run('segment.members', input)).toEqual(result);
    await expect(run('segment.members', { ...input, action: 'remove' })).rejects.toMatchObject({
      code: 'operation_conflict',
    });
    expect((await members(group, addresses)).changed).toBe(0);
    const other = await create('Subscribers');
    await expect(
      run('segment.rename', keyed({ brandId: brand, segmentId: group.id, name: other.name.toUpperCase() })),
    ).rejects.toMatchObject({ code: 'segment_name_conflict' });
    expect(
      await run('segment.rename', keyed({ brandId: brand, segmentId: group.id, name: 'Neighbors' })),
    ).toMatchObject({ id: group.id, name: 'Neighbors', counts: result.counts });
    expect((await members(group, [addresses[1]!], 'remove')).changed).toBe(1);
    expect((await members(group, [addresses[1]!], 'remove')).changed).toBe(0);
    const directory = await run<SegmentDirectory>('segment.list', { brandId: brand });
    expect(directory.items.map((i) => i.name)).toEqual(['Neighbors', 'Subscribers']);
    await run('segment.delete', keyed({ brandId: brand, segmentId: group.id }));
    expect(await contactFacts()).toEqual(before);
    const receipts = await db.tenant(owner.workspaceId, (sql) => sql.query('SELECT result FROM operations'));
    const audit = await db.tenant(owner.workspaceId, (sql) => sql.query('SELECT * FROM audit'));
    expect(JSON.stringify([receipts.rows, audit.rows])).not.toContain('@example.test');
  });

  it('rejects unknown or foreign contacts atomically and preserves mailbox identity and brand boundaries', async () => {
    const group = await create('Alumni');
    const exact = 'Reader+club@example.test';
    await seed(exact);
    const foreign = await seed('foreign@example.test', 'confirmed', sibling);
    await expect(
      db.brand(owner.workspaceId, brand, (sql) =>
        sql.query(
          'INSERT INTO audience_segment_members(workspace_id,brand_id,segment_id,subscriber_id) VALUES($1,$2,$3,$4)',
          [owner.workspaceId, brand, group.id, foreign],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    const member: Actor = { ...owner, owner: false, brandIds: [brand], scopes: ['read', 'draft:write'] };
    await expect(
      run('segment.members', memberInput(group.id, 'remove', [exact]), member),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      members(group, [exact, 'reader+club@example.test', 'foreign@example.test']),
    ).rejects.toMatchObject({
      code: 'segment_contacts_unavailable',
      message: expect.stringMatching(/rows 2, 3\./),
    });
    expect(await run('segment.summary', { brandId: brand, segmentId: group.id })).toMatchObject({ total: 0 });
    expect((await members(group, [' Reader+club@EXAMPLE.TEST '])).changed).toBe(1);
    await expect(members(group, ['Reader@example.test'])).rejects.toMatchObject({
      code: 'segment_contacts_unavailable',
    });
    await expect(
      run('segment.rename', keyed({ brandId: sibling, segmentId: group.id, name: 'Cross-brand' })),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await db.brand('org_someone_else', brand, (sql) => sql.query('SELECT id FROM audience_segments')),
    ).toMatchObject({ rowCount: 0 });
    expect(
      await db.brand(owner.workspaceId, sibling, (sql) =>
        sql.query('SELECT subscriber_id FROM audience_segment_members'),
      ),
    ).toMatchObject({ rowCount: 0 });
    await expect(members(group, [])).rejects.toMatchObject({ status: 422 });
    await expect(members(group, Array(251).fill(exact))).rejects.toMatchObject({ status: 422 });
    expect((await members(group, Array(250).fill(exact))).changed).toBe(0);
  });

  it('enforces the 50-group cap across concurrent requests and reuses capacity after deletion', async () => {
    await db.brand(owner.workspaceId, brand, (sql) =>
      sql.query(
        `INSERT INTO audience_segments(workspace_id,brand_id,id,name,slot)
       SELECT $1,$2,gen_random_uuid(),'Group '||n,n FROM generate_series(1,49) n`,
        [owner.workspaceId, brand],
      ),
    );
    const results = await Promise.allSettled([create('One more'), create('Another')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code),
    ).toEqual(['segment_limit']);
    const directory = await run<SegmentDirectory>('segment.list', { brandId: brand });
    expect(directory.items).toHaveLength(50);
    await run('segment.delete', keyed({ brandId: brand, segmentId: directory.items[0]!.id }));
    await create('New group');
    await create('Unrelated', sibling);
  });

  it('checks current ownership even for a retry of a previously successful group edit', async () => {
    let currentOwner = true;
    const guarded = new CommandService(db, undefined, async () => currentOwner);
    const input = keyed({ brandId: brand, name: 'Proofreaders' });
    const saved = await guarded.execute('segment.create', input, owner);
    currentOwner = false;
    await expect(guarded.execute('segment.create', input, owner)).rejects.toMatchObject({
      code: 'owner_required',
    });
    currentOwner = true;
    expect(await guarded.execute('segment.create', input, owner)).toEqual(saved);
    expect((await run<SegmentDirectory>('segment.list', { brandId: brand })).items).toHaveLength(1);
  });

  it('filters before the cap, freezes original recipients and group name, then checks current suppression at capture', async () => {
    await recordAccess(admin, owner.workspaceId, {
      workspaceId: owner.workspaceId,
      plan: 'growth',
      operator: 'fixture',
      reason: 'Group capture',
      operationKey: id(),
    });
    const draft = await run<Campaign>(
      'campaign.create',
      keyed({
        brandId: brand,
        content: {
          ...emptyContent(),
          title: 'Reading night',
          subject: 'A reading',
          heading: 'Meet the author',
          body: 'Join us.',
          fromName: 'Bookshop',
          replyTo: 'desk@example.test',
        },
      }),
    );
    const group = await create('Reading club');
    const first = await seed('first@example.test');
    await seed('second@example.test');
    await seed('pending@example.test', 'pending');
    await seed('outside@shop.example');
    await db.brand(owner.workspaceId, brand, (sql) =>
      sql.query(
        `INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state)
       SELECT $1,$2,gen_random_uuid(),'other'||n||'@example.test','confirmed' FROM generate_series(1,26) n`,
        [owner.workspaceId, brand],
      ),
    );
    await members(group, [
      'first@example.test',
      'second@example.test',
      'pending@example.test',
      'outside@shop.example',
    ]);
    const review = (options: Record<string, unknown> = {}) =>
      run<Rehearsal>(
        'rehearsal.review',
        keyed({
          brandId: brand,
          campaignId: draft.id,
          expectedVersion: 1,
          audience: 'confirmed',
          ...options,
        }),
      );
    await expect(review()).rejects.toMatchObject({ code: 'practice_audience' });
    await expect(review({ audience: 'test', segmentId: group.id })).rejects.toMatchObject({
      code: 'invalid_segment_audience',
    });
    await expect(review({ segmentId: (await create('Other brand', sibling)).id })).rejects.toMatchObject({
      status: 404,
    });
    const snap = await review({ segmentId: group.id });
    expect(snap).toMatchObject({ selected: 2, excluded: 2, segment: { id: group.id, name: 'Reading club' } });
    await run('segment.rename', keyed({ brandId: brand, segmentId: group.id, name: 'Revised group' }));
    await members(group, ['second@example.test'], 'remove');
    await members(group, ['other1@example.test']);
    await run('segment.delete', keyed({ brandId: brand, segmentId: group.id }));
    await run('rehearsal.approve', keyed({ brandId: brand, id: snap.id }));
    await run('audience.unsubscribe', { brandId: brand, id: first });
    await run('rehearsal.process', keyed({ brandId: brand, id: snap.id }));
    expect(await run('rehearsal.report', { brandId: brand, id: snap.id })).toMatchObject({
      state: 'completed',
      selected: 2,
      excluded: 2,
      captured: 1,
      skipped: 1,
      segment: { id: group.id, name: 'Reading club' },
    });
    const selected = await db.brand(owner.workspaceId, brand, (sql) =>
      sql.query(
        `SELECT s.email_normalized,r.state FROM rehearsal_recipients r JOIN subscribers s
       ON (s.workspace_id,s.brand_id,s.id)=(r.workspace_id,r.brand_id,r.subscriber_id)
       WHERE r.rehearsal_id=$1 ORDER BY s.email_normalized`,
        [snap.id],
      ),
    );
    expect(selected.rows).toEqual([
      { email_normalized: 'first@example.test', state: 'excluded' },
      { email_normalized: 'second@example.test', state: 'captured' },
    ]);
  });

  it('offers only aggregate group counts to a scoped MCP connection and rechecks revocation', async () => {
    const group = await create('Private label');
    await seed('private@example.test');
    await members(group, ['private@example.test']);
    const credential = await run<{ token: string; connection: { id: string } }>(
      'connection.create',
      keyed({ name: 'Totals only', scopes: ['audience:summary'], brandIds: [brand], expiresInDays: 1 }),
    );
    const auth = new Authenticator(db, {
      session: async () => {
        throw Error('This fixture accepts only the issued connection.');
      },
      isOwner: async (user, workspace) => user === owner.userId && workspace === owner.workspaceId,
    });
    let server: Server | undefined;
    const mcp = new Client({ name: 'group-aggregate-fixture', version: '1' });
    try {
      server = createApp(
        loadConfig({ APP_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1' }),
        service,
        auth,
      ).listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('Expected a loopback fixture.');
      const call = apiCaller('http://127.0.0.1:' + address.port, credential.token),
        bridge = createMcpServer(call),
        [client, host] = InMemoryTransport.createLinkedPair();
      await bridge.connect(host);
      await mcp.connect(client);
      const tools = (await mcp.listTools()).tools.map((tool) => tool.name);
      expect(tools.filter((name) => name.startsWith('segment_'))).toEqual(['segment_summary']);
      const read = await mcp.callTool({
        name: 'segment_summary',
        arguments: { brandId: brand, segmentId: group.id },
      });
      expect(read.isError).not.toBe(true);
      const text = JSON.stringify(read.content);
      expect(text).toContain('confirmed');
      expect(text).not.toContain('private@example.test');
      expect(text).not.toContain('Private label');
      for (const name of ['segment.list', 'segment.members', 'segment.delete'])
        await expect(call(name, {})).rejects.toThrow('owner_required');
      await expect(call('segment.summary', { brandId: sibling, segmentId: group.id })).rejects.toThrow(
        'not_found',
      );
      await run('connection.revoke', keyed({ id: credential.connection.id }));
      await expect(call('segment.summary', { brandId: brand, segmentId: group.id })).rejects.toThrow();
    } finally {
      await mcp.close();
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });
});
