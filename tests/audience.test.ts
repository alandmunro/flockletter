import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { createApp } from '../src/server/app.js';
import { Authenticator } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { createMcpServer, apiCaller } from '../src/mcp/bridge.js';
import { emptyContent, type CommandName, type Preflight, type Workspace } from '../src/shared/contracts.js';
import type { AudienceSummary, ContactDetail, ContactPage, SubscriberState } from '../src/shared/audience.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database, service: CommandService, server: Server;
let alice: Actor,
  bob: Actor,
  brand: string,
  sibling: string,
  foreign: string,
  origin: string,
  revokedOwner: boolean;
const id = randomUUID;
const run = <T>(name: CommandName, input: unknown, actor = alice) =>
  service.execute(name, input, actor) as Promise<T>;
async function workspace(name: string) {
  const actor: Actor = {
    workspaceId: 'org_' + id().replaceAll('-', ''),
    userId: name,
    actorId: 'user:' + name,
    kind: 'session',
    owner: true,
    scopes: ['read'],
    brandIds: null,
  };
  await run('workspace.initialize', { name, brandName: name + ' brand', operationKey: id() }, actor);
  const w = await run<Workspace>('workspace.get', {}, actor);
  return { actor, brand: w.brands[0]!.id };
}
async function seed(
  email: string,
  state: SubscriberState,
  brandId = brand,
  owner = alice,
  contactId: string = id(),
) {
  await db.brand(owner.workspaceId, brandId, (sql) =>
    sql.query(
      `INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state,confirmed_at)
    VALUES($1,$2,$3,$4,$5,CASE WHEN $5='confirmed' THEN now() END)`,
      [owner.workspaceId, brandId, contactId, email, state],
    ),
  );
  return contactId;
}
const command = (token: string, name: CommandName, input: unknown) =>
  fetch(origin + '/api/v1/commands/' + name, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
const issue = (scopes: string[]) =>
  run<{ token: string; connection: { id: string } }>('connection.create', {
    name: 'Test connection',
    operationKey: id(),
    scopes,
    brandIds: [brand],
    expiresInDays: 1,
  });
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  await db.verifyBoundary();
  service = new CommandService(db);
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});
beforeEach(async () => {
  const a = await workspace('Alice');
  alice = a.actor;
  brand = a.brand;
  const b = await workspace('Bob');
  bob = b.actor;
  foreign = b.brand;
  sibling = id();
  revokedOwner = false;
  await db.tenant(alice.workspaceId, (sql) =>
    sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
      alice.workspaceId,
      sibling,
      'Second brand',
    ]),
  );
  const auth = new Authenticator(db, {
    async session(request) {
      const owner = request.get('authorization') === 'Bearer owner-b' ? bob : alice;
      return { userId: owner.userId, workspaceId: owner.workspaceId };
    },
    async isOwner(user, w) {
      return !revokedOwner && [alice, bob].some((o) => o.userId === user && o.workspaceId === w);
    },
  });
  server = createApp(loadConfig({ APP_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1' }), service, auth).listen(
    0,
    '127.0.0.1',
  );
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Expected private test port.');
  origin = 'http://127.0.0.1:' + address.port;
});
afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('brand audience workspace', () => {
  it('lists stable, bounded pages and exact matches under the existing email policy', async () => {
    const fixtureRows = [
      ['a@example.com', 'confirmed'],
      ['b@example.com', 'pending'],
      ['c@example.com', 'confirmed'],
      ['d@example.com', 'unsubscribed'],
      ['e@example.com', 'hard_bounced'],
      ['f@example.com', 'complained'],
    ] as const;
    for (const [email, state] of fixtureRows) await seed(email, state);
    await seed('unrelated@example.com', 'pending', sibling);
    await seed('foreign@example.com', 'confirmed', foreign, bob);
    const summary = await run<AudienceSummary>('audience.summary', { brandId: brand });
    expect(summary).toEqual({
      total: 6,
      confirmed: 2,
      pending: 1,
      unsubscribed: 1,
      hard_bounced: 1,
      complained: 1,
    });
    let cursor: string | null = null;
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const page: ContactPage = await run('audience.list', {
        brandId: brand,
        limit: 2,
        cursor: cursor ?? undefined,
      });
      seen.push(...page.items.map((x) => x.email));
      cursor = page.nextCursor;
      if (i === 0) await seed('0-before-cursor@example.com', 'pending');
    }
    expect(seen).toEqual(fixtureRows.map((x) => x[0]));
    expect(cursor).toBeNull();
    const hits = await run<ContactPage>('audience.list', {
      brandId: brand,
      state: 'confirmed',
      email: ' c@EXAMPLE.COM ',
    });
    expect(hits.items.map((x) => x.email)).toEqual(['c@example.com']);
    expect(
      (await run<ContactPage>('audience.list', { brandId: brand, email: 'C@example.com' })).items,
    ).toEqual([]);
    expect(
      (await run<ContactPage>('audience.list', { brandId: brand, state: 'complained' })).items.map(
        (x) => x.email,
      ),
    ).toEqual(['f@example.com']);
  });
  it('isolates brands and tenants, including colliding identifiers and foreign cursors', async () => {
    const shared = id();
    await seed('original@example.com', 'confirmed', brand, alice, shared);
    await seed('sibling@example.com', 'pending', sibling, alice, shared);
    const other = await seed('foreign-only@example.com', 'pending', foreign, bob);
    expect(
      (await run<ContactDetail>('audience.contact', { brandId: sibling, id: shared })).contact.email,
    ).toBe('sibling@example.com');
    await expect(run('audience.contact', { brandId: brand, id: other })).rejects.toMatchObject({
      status: 404,
    });
    await expect(run('audience.list', { brandId: brand, cursor: other })).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
    for (const [name, input] of [
      ['audience.list', {}],
      ['audience.summary', {}],
      ['audience.contact', { id: shared }],
      ['audience.unsubscribe', { id: shared }],
    ] as const) {
      expect((await command('owner-b', name, { brandId: brand, ...input })).status).toBe(404);
    }
    const res = await command('owner-a', 'audience.list', {
      brandId: brand,
      'private@example.com': 'unknown',
    });
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain('private@example.com');
    const big = await command('owner-a', 'audience.list', {
      brandId: brand,
      email: 'x'.repeat(4096) + '@example.com',
    });
    expect(big.status).toBe(413);
    expect(await big.text()).not.toContain('@example.com');
  });
  it('paginates tied consent times without skipping events or accepting a cursor for another contact', async () => {
    const person = await seed('history@example.com', 'confirmed'),
      other = await seed('other@example.com', 'pending');
    const foreignEvent = id();
    await db.brand(alice.workspaceId, brand, async (sql) => {
      for (const who of [person, other]) {
        const count = who === person ? 18 : 1;
        for (let i = 0; i < count; i++)
          await sql.query(
            `INSERT INTO subscriber_consent_events(workspace_id,brand_id,id,subscriber_id,event,purpose,policy_version,text_digest,source,source_domain,recorded_at)
          VALUES($1,$2,$3,$4,'signup_requested','ffa_product_marketing','v1','digest','storefront-footer','example.test','2026-10-10T12:45:00.123456Z')`,
            [alice.workspaceId, brand, who === person ? id() : foreignEvent, who],
          );
      }
    });
    const first = await run<ContactDetail>('audience.contact', { brandId: brand, id: person });
    const second = await run<ContactDetail>('audience.contact', {
      brandId: brand,
      id: person,
      cursor: first.nextCursor,
    });
    expect(first.events).toHaveLength(15);
    expect(second.events).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.events, ...second.events].map((e) => e.id)).size).toBe(18);
    await expect(
      run('audience.contact', { brandId: brand, id: person, cursor: foreignEvent }),
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
  });
  it('shows counts to a scoped MCP connection while withholding individual records, other brands and legacy token counts', async () => {
    await seed('private@example.com', 'confirmed');
    await seed('hidden@example.com', 'complained');
    const old = await issue(['read']),
      totals = await issue(['audience:summary']),
      mixed = await issue(['read', 'audience:summary']);
    const draft = await run<{ id: string }>('campaign.create', {
      brandId: brand,
      operationKey: id(),
      content: emptyContent(),
    });
    const before = await (await command(old.token, 'campaign.preflight', { id: draft.id })).json();
    expect(before.result).not.toHaveProperty('audience');
    const after = (await (await command(mixed.token, 'campaign.preflight', { id: draft.id })).json())
      .result as Preflight;
    expect(after.audience).toEqual({ confirmed: 1, excluded: 1 });
    expect(after.canSend).toBe(false);
    expect((await command(totals.token, 'campaign.preflight', { id: draft.id })).status).toBe(403);
    expect((await command(old.token, 'audience.summary', { brandId: brand })).status).toBe(403);
    expect((await command(totals.token, 'audience.summary', { brandId: sibling })).status).toBe(404);
    for (const name of ['audience.list', 'audience.contact', 'audience.unsubscribe'] as const)
      expect((await command(mixed.token, name, { brandId: brand, id: id() })).status).toBe(403);
    const bridge = createMcpServer(apiCaller(origin, totals.token)),
      mcp = new Client({ name: 'audience-test', version: '1' });
    const [client, host] = InMemoryTransport.createLinkedPair();
    await bridge.connect(host);
    await mcp.connect(client);
    try {
      const names = (await mcp.listTools()).tools.map((t) => t.name);
      expect(names).toContain('audience_summary');
      for (const name of ['audience_list', 'audience_contact', 'audience_unsubscribe'])
        expect(names).not.toContain(name);
      const result = await mcp.callTool({ name: 'audience_summary', arguments: { brandId: brand } });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).not.toContain('@');
      const api = await command(totals.token, 'audience.summary', { brandId: brand });
      expect(api.headers.get('cache-control')).toBe('no-store');
      const apiCounts = (await api.json()).result;
      expect(apiCounts.total).toBe(2);
      expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(apiCounts);
      revokedOwner = true;
      expect((await mcp.callTool({ name: 'audience_summary', arguments: { brandId: brand } })).isError).toBe(
        true,
      );
      expect((await command('owner-a', 'audience.list', { brandId: brand })).status).toBe(403);
      revokedOwner = false;
      await run('connection.revoke', { id: totals.connection.id, operationKey: id() });
      expect((await command(totals.token, 'audience.summary', { brandId: brand })).status).toBe(401);
      await db.tenant(alice.workspaceId, (sql) =>
        sql.query("UPDATE connections SET expires_at=now()-interval '1 minute' WHERE id=$1", [
          mixed.connection.id,
        ]),
      );
      expect((await command(mixed.token, 'audience.summary', { brandId: brand })).status).toBe(401);
    } finally {
      await mcp.close();
      await bridge.close();
    }
  });
  it('stops legacy contacts without inventing historical signup evidence, preserving stronger suppressions', async () => {
    for (const state of ['confirmed', 'pending', 'hard_bounced', 'complained'] as const) {
      const person = await seed(state + '@example.com', state);
      const input = { brandId: brand, id: person };
      await Promise.all([run('audience.unsubscribe', input), run('audience.unsubscribe', input)]);
      const result = await run<ContactDetail>('audience.contact', input);
      if (state === 'confirmed' || state === 'pending') {
        expect(result.contact.state).toBe('unsubscribed');
        expect(result.events).toHaveLength(1);
        expect(result.events[0]).toMatchObject({
          event: 'unsubscribed',
          source: 'workspace-owner',
          sourceDomain: '',
          policyVersion: 'owner-opt-out-v1',
        });
      } else {
        expect(result.contact.state).toBe(state);
        expect(result.events).toEqual([]);
      }
      const evidence = await db.tenant(
        alice.workspaceId,
        async (sql) =>
          (await sql.query('SELECT actor_id,action FROM audit WHERE resource_id=$1', [person])).rows,
      );
      expect(evidence).toEqual([{ actor_id: alice.actorId, action: 'audience.unsubscribe' }]);
    }
    const stored = await db.tenant(
      alice.workspaceId,
      async (sql) =>
        (await sql.query("SELECT result FROM operations WHERE operation_key LIKE 'unsubscribe:%'")).rows,
    );
    expect(stored).toHaveLength(4);
    expect(JSON.stringify(stored)).not.toContain('@');
  });
});
