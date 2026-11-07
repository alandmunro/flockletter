import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { recordAccess } from '../scripts/complimentary-access.js';
import { Database } from '../src/server/db.js';
import { Authenticator, type IdentityProvider } from '../src/server/auth.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import type { ClerkTeam } from '../src/server/team.js';
import { emptyContent, type Campaign, type CommandName, type Workspace } from '../src/shared/contracts.js';
import type { TeamPage } from '../src/shared/team.js';
let fix: Awaited<ReturnType<typeof startDatabase>>,
  db: Database,
  admin: Database,
  s: CommandService,
  server: Server,
  origin: string;
let owner: Actor,
  org: string,
  brand: string,
  other: string,
  roster: Map<string, 'owner' | 'member'>,
  unavailable = false;
const id = randomUUID,
  target = 'user_reader',
  boss = 'user_manager';
async function plan(p: 'growth' | 'starter' | null) {
  await recordAccess(admin, org, {
    workspaceId: org,
    operator: 'tester',
    reason: 'seat fixture',
    plan: p,
    operationKey: id(),
  });
}
const input = (details: Record<string, unknown>) => ({ ...details, operationKey: id() });
const http = (who: string, name: CommandName, data: unknown) =>
  fetch(origin + '/api/v1/commands/' + name, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + who, 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
async function grant(role: 'viewer' | 'editor', brands = [brand]) {
  return s.execute('team.grant', input({ userId: target, permission: role, brandIds: brands }), owner);
}
beforeAll(async () => {
  fix = await startDatabase();
  db = new Database(fix.url);
  admin = new Database(fix.adminUrl);
  await db.verifyBoundary();
});
afterAll(async () => {
  await admin?.close();
  await db?.close();
  await fix?.stop();
});
beforeEach(async () => {
  org = 'org_' + id();
  roster = new Map([
    [boss, 'owner'],
    [target, 'member'],
  ]);
  unavailable = false;
  const clerk: ClerkTeam = {
    async membership(user, w) {
      if (unavailable) throw Error('unavailable');
      return w === org ? (roster.get(user) ?? null) : null;
    },
    async members(w, offset, limit) {
      if (unavailable) throw Error('unavailable');
      const list = w === org ? [...roster.entries()] : [];
      return {
        total: list.length,
        members: list
          .slice(offset, offset + limit)
          .map(([userId, membership]) => ({ userId, name: userId, membership })),
      };
    },
  };
  const identity: IdentityProvider = {
    team: clerk,
    async session(req) {
      return { userId: (req.get('authorization') ?? '').slice(7), workspaceId: org };
    },
    async isOwner(user, w) {
      return (await clerk.membership(user, w)) === 'owner';
    },
  };
  owner = {
    kind: 'session',
    workspaceId: org,
    userId: boss,
    actorId: 'user:' + boss,
    owner: true,
    scopes: ['read'],
    brandIds: null,
  };
  s = new CommandService(db, undefined, identity.isOwner, undefined, undefined, clerk);
  await s.execute('workspace.initialize', input({ name: 'Workspace', brandName: 'First' }), owner);
  brand = ((await s.execute('workspace.get', {}, owner)) as Workspace).brands[0]!.id;
  other = id();
  await db.tenant(org, (sql) =>
    sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [org, other, 'Second']),
  );
  server = createApp(
    loadConfig({ APP_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1' }),
    s,
    new Authenticator(db, identity),
  ).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw Error('fixture port');
  origin = 'http://127.0.0.1:' + addr.port;
});
afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});
describe('Clerk-owned teams with explicit brand grants', () => {
  it('lists verified membership and cap but never gives a pending, absent, or unassigned member implicit access', async () => {
    const page = (await (await http(boss, 'team.list', {})).json()) as { result: TeamPage };
    expect(page.result).toMatchObject({ total: 2, seats: 1, overLimit: true });
    expect(page.result.members.every((m) => m.permission === null)).toBe(true);
    expect((await http(target, 'workspace.get', {})).status).toBe(403);
    await expect(grant('viewer')).rejects.toMatchObject({ code: 'seat_limit' });
    await plan('growth');
    await expect(
      s.execute(
        'team.grant',
        input({ userId: 'user_missing', permission: 'editor', brandIds: [brand] }),
        owner,
      ),
    ).rejects.toMatchObject({ code: 'member_required' });
    await expect(grant('editor', [id()])).rejects.toMatchObject({ status: 404 });
    await grant('viewer');
    const access = (await (await http(target, 'workspace.get', {})).json()).result as Workspace;
    expect(access.brands.map((b) => b.id)).toEqual([brand]);
    expect(access.canEdit).toBe(false);
    expect(access.canManageConnections).toBe(false);
    for (const name of [
      'audience.list',
      'audience.summary',
      'rehearsal.review',
      'billing.status',
      'team.list',
      'sender.status',
      'connection.create',
      'workspace.operations',
      'campaign.create',
    ] as const) {
      expect((await http(target, name, {})).status).toBe(403);
    }
    expect((await http(target, 'asset.list', { brandId: other })).status).toBe(404);
    const funds = (await (await http(target, 'workspace.access', {})).json()).result;
    expect(funds.usage).toBeNull();
  });
  it('checks the current brand, scope and signer before returning any saved mutation receipt', async () => {
    await plan('growth');
    await grant('editor');
    const original = input({
      brandId: brand,
      content: { ...emptyContent(), title: 'Restricted field notes' },
    });
    const result = await http(target, 'campaign.create', original);
    expect(result.status).toBe(200);
    const draft = (await result.json()).result as Campaign;
    const preview = (await (await http(target, 'campaign.preflight', { id: draft.id })).json()).result;
    expect(preview).not.toHaveProperty('audience');
    expect(preview.canSend).toBe(false);
    await grant('editor', [other]);
    expect((await http(target, 'campaign.create', original)).status).toBe(404);
    expect((await http(target, 'campaign.get', { id: draft.id })).status).toBe(404);
    await grant('viewer', [brand]);
    expect((await http(target, 'campaign.create', original)).status).toBe(403);
    expect((await http(target, 'campaign.preview', { id: draft.id, expectedVersion: 1 })).status).toBe(200);
    const revoke = input({ userId: target });
    await s.execute('team.revoke', revoke, owner);
    await expect(s.execute('team.revoke', revoke, owner)).resolves.toMatchObject({ revoked: true });
    await expect(s.execute('team.revoke', input({ userId: target }), owner)).rejects.toMatchObject({
      code: 'grant_unavailable',
    });
    expect((await http(target, 'workspace.get', {})).status).toBe(403);
  });
  it('denies revoked members, downsized plans, or unknown membership while retaining staff records for remediation', async () => {
    await plan('growth');
    await grant('editor');
    await plan('starter');
    expect((await http(target, 'workspace.get', {})).status).toBe(403);
    expect((await http(boss, 'team.list', {})).status).toBe(200);
    await plan('growth');
    expect((await http(target, 'workspace.get', {})).status).toBe(200);
    roster.delete(target);
    expect((await http(target, 'workspace.get', {})).status).toBe(403);
    expect((await db.tenant(org, (sql) => sql.query('SELECT user_id FROM team_grants'))).rows).toEqual([
      { user_id: target },
    ]);
    expect(
      (await db.tenant('org_foreign', (sql) => sql.query('SELECT user_id FROM team_grants'))).rows,
    ).toEqual([]);
    unavailable = true;
    expect((await http(target, 'workspace.get', {})).status).toBe(503);
  });
});
