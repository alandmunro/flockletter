import { createClerkClient } from '@clerk/backend';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { recordAccess } from '../scripts/complimentary-access.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { clerkInvitationPilot, loadInvitationBinding } from '../src/server/team-invitation-provider.js';
import { pendingClerkInvitations } from '../src/server/auth.js';
import type { ClerkTeam } from '../src/server/team.js';
import type { InvitationOutcome, TeamInvitationPage } from '../src/shared/team.js';

const first = 'first@example.test',
  second = 'second@example.test',
  ownerEmail = 'owner@example.test';
const secondOwner = 'user_second_owner',
  secondOwnerEmail = 'second-owner@example.test';
type Invitation = {
  id: string;
  organization_id: string;
  email_address: string;
  role: string;
  status: string;
  private_metadata: { flockletter_invitation_reference?: string };
};
let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database, admin: Database, server: Server;
let service: CommandService,
  actor: Actor,
  clerk: ClerkTeam,
  ownerCurrent: boolean,
  maximum: number,
  memberEmails: string[],
  invitations: Invitation[];
let mode: 'ok' | 'lose-before' | 'lose-after' | 'unavailable' | 'redirect', posts: Invitation[], missingCount: boolean, redirected: number;
const send = (email: string, key: string, who = actor) =>
  service.execute('team.invite', { email, operationKey: key }, who) as Promise<InvitationOutcome>;
const directory = () => service.execute('team.invitations', {}, actor) as Promise<TeamInvitationPage>;
async function setPlan(plan: 'starter' | 'growth' | 'pro') {
  await recordAccess(admin, actor.workspaceId, {
    workspaceId: actor.workspaceId,
    plan,
    operator: 'fixture',
    reason: 'Local staging invitation test',
    operationKey: randomUUID(),
  });
}
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  admin = new Database(fixture.adminUrl);
});
afterAll(async () => {
  await admin?.close();
  await db?.close();
  await fixture?.stop();
});
beforeEach(async () => {
  const workspace = 'org_' + randomUUID(),
    owner = 'user_invitation_owner';
  actor = {
    userId: owner,
    owner: true,
    workspaceId: workspace,
    kind: 'session',
    actorId: 'user:' + owner,
    brandIds: null,
    scopes: ['read'],
  };
  mode = 'ok';
  maximum = 3;
  memberEmails = [ownerEmail];
  ownerCurrent = true;
  invitations = [];
  posts = [];
  redirected = 0;
  missingCount = false;
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    const base = '/v1/organizations/' + workspace;
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && mode === 'unavailable') {
      res.statusCode = 503;
      res.end('{"errors":[]}');
      return;
    }
    if (req.method === 'GET' && url.pathname === base) {
      res.end(
        JSON.stringify({
          object: 'organization',
          id: workspace,
          name: 'Fixture',
          slug: 'fixture',
          members_count: missingCount ? undefined : memberEmails.length,
          max_allowed_memberships: maximum,
        }),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === base + '/memberships') {
      const entries = memberEmails.map((email, i) => ({
        object: 'organization_membership',
        id: 'member' + i,
        organization: { object: 'organization', id: workspace },
        role: i === 0 || email === secondOwnerEmail ? 'org:admin' : 'org:member',
        public_user_data: { user_id: 'user_' + i, identifier: email },
      }));
      res.end(JSON.stringify({ data: entries, total_count: entries.length }));
      return;
    }
    if (req.method === 'GET' && url.pathname === base + '/invitations') {
      const statuses = url.searchParams.getAll('status'),
        offset = Number(url.searchParams.get('offset') ?? 0),
        limit = Number(url.searchParams.get('limit') ?? 10);
      const entries = invitations.filter((row) => statuses.includes(row.status));
      res.end(
        JSON.stringify({
          data: entries.slice(offset, offset + limit).map((row) => ({
            ...row,
            object: 'organization_invitation',
            expires_at: 1900000000000,
            url: 'https://example.test/secret-capability',
            public_metadata: {},
          })),
          total_count: entries.length,
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === base + '/invitations') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      expect([owner, secondOwner]).toContain(payload.inviter_user_id);
      expect(payload.role).toBe('org:member');
      const row = {
        id: 'orginv_' + randomUUID(),
        email_address: payload.email_address,
        role: payload.role,
        private_metadata: payload.private_metadata,
        organization_id: workspace,
        status: 'pending',
      };
      posts.push(row);
      if(mode==='redirect') {
        res.writeHead(307,{location:'/redirected-invitation'});
        res.end();return;
      }
      if (mode !== 'lose-before') invitations.push(row);
      if (mode === 'lose-before' || mode === 'lose-after') {
        res.destroy();
        return;
      }
      res.end(
        JSON.stringify({
          ...row,
          object: 'organization_invitation',
          expires_at: 1900000000000,
          url: 'https://example.test/secret-capability',
        }),
      );
      return;
    }
    if (url.pathname==='/redirected-invitation') redirected++;
    res.statusCode = 404;
    res.end('{"errors":[]}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Expected a local test port.');
  const orgs = createClerkClient({
    secretKey: 'sk_test_fixture',
    apiUrl: 'http://127.0.0.1:' + address.port,
  }).organizations;
  clerk = {
    membership: async (user, w) =>
      w === workspace &&
      ownerCurrent &&
      (user === owner || (user === secondOwner && memberEmails.includes(secondOwnerEmail)))
        ? 'owner'
        : null,
    members: async () => ({ total: memberEmails.length, members: [] }),
    invitations: (w, o, l) => pendingClerkInvitations(orgs, w, o, l),
    invitePilot: clerkInvitationPilot(orgs, { workspace, recipients: [first, second, ownerEmail] },'sk_test_fixture',
      async (url,init)=>{
        const target=new URL(String(url));
        expect(target.origin).toBe('https://api.clerk.com');
        expect(init?.headers).toMatchObject({authorization:'Bearer sk_test_fixture'});
        return fetch('http://127.0.0.1:'+address.port+target.pathname,init);
      }),
  };
  service = new CommandService(db, undefined, undefined, undefined, undefined, clerk);
  await service.execute(
    'workspace.initialize',
    { operationKey: randomUUID(), name: 'Fixture', brandName: 'Fixture' },
    actor,
  );
  await setPlan('growth');
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('allowlisted staging Clerk member invitations', () => {
  it('requires explicitly configured development Clerk, authenticated owner, allowed workspace/email and provider-enforced seat limits', async () => {
    expect(loadInvitationBinding({})).toBeUndefined();
    const env = {
      APP_ENV: 'staging',
      CLERK_SECRET_KEY: 'sk_test_fixture',
      CLERK_PUBLISHABLE_KEY: 'pk_test_fixture',
      FLOCKLETTER_TEAM_INVITES: 'allowlist',
      FLOCKLETTER_TEAM_INVITE_WORKSPACE: actor.workspaceId,
      FLOCKLETTER_TEAM_INVITE_RECIPIENTS: first,
    };
    expect(loadInvitationBinding(env)?.recipients).toEqual([first]);
    for (const change of [
      { APP_ENV: 'local' },
      { CLERK_SECRET_KEY: 'sk_live_fixture' },
      { FLOCKLETTER_TEAM_INVITE_RECIPIENTS: '*@example.test' },
    ])
      expect(() => loadInvitationBinding({ ...env, ...change })).toThrow();
    await expect(send('unknown@example.test', randomUUID())).rejects.toMatchObject({
      code: 'invitation_pilot_disabled',
    });
    await expect(send(first, randomUUID(), { ...actor, kind: 'connection' })).rejects.toMatchObject({
      code: 'owner_required',
    });
    await expect(send(first, randomUUID(), { ...actor, workspaceId: 'org_foreign' })).rejects.toMatchObject({
      code: 'invitation_pilot_disabled',
    });
    ownerCurrent = false;
    await expect(send(first, randomUUID())).rejects.toMatchObject({ code: 'owner_required' });
    ownerCurrent = true;
    for (maximum of [0, 4])
      await expect(send(first, randomUUID())).rejects.toMatchObject({ code: 'clerk_seat_limit_required' });
    maximum = 3;
    missingCount = true;
    await expect(send(first, randomUUID())).rejects.toMatchObject({
      code: 'invitation_capacity_unavailable',
    });
    missingCount = false;
    await expect(send(ownerEmail, randomUUID())).rejects.toMatchObject({ code: 'invitation_exists' });
    expect(posts).toHaveLength(0);
    delete clerk.invitePilot;
    await expect(send(first, randomUUID())).rejects.toMatchObject({ code: 'invitation_pilot_disabled' });
    expect((await directory()).pilot).toBeUndefined();
  });
  it('reserves the final seat once across concurrent operations, replays without another email, and stores no provider link', async () => {
    memberEmails.push(secondOwnerEmail);
    const keys = [randomUUID(), randomUUID()];
    const attempts = await Promise.allSettled([
      send(first, keys[0]!),
      send(second, keys[1]!, { ...actor, userId: secondOwner, actorId: 'user:' + secondOwner }),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find((r) => r.status === 'rejected')?.reason).toMatchObject({ code: 'seat_limit' });
    expect(posts).toHaveLength(1);
    const email = posts[0]!.email_address,
      key = keys[email === first ? 0 : 1]!;
    expect(await send(email, key)).toEqual({ operationKey: key, state: 'pending' });
    expect(await send(email, randomUUID())).toEqual({ operationKey: key, state: 'pending' });
    await expect(send(email === first ? second : first, key)).rejects.toMatchObject({
      code: 'operation_conflict',
    });
    expect(posts).toHaveLength(1);
    const ownerPage = await directory();
    expect(ownerPage.available).toBe(0);
    expect(ownerPage.pilot?.choices.find((row) => row.email === email)?.prior).toEqual({
      operationKey: key,
      state: 'pending',
    });
    const facts = await db.tenant(
      actor.workspaceId,
      async (sql) =>
        (await sql.query("SELECT result FROM operations WHERE actor_id LIKE 'system:team-invite:%'")).rows,
    );
    expect(facts).toHaveLength(2);
    expect(JSON.stringify(facts)).not.toContain('secret-capability');
    expect(JSON.stringify(facts)).not.toContain(email);
  });
  it('looks up a lost acknowledgment and holds an unconfirmed operation even across changed retry keys or misleading provider rows', async () => {
    await setPlan('pro');
    maximum = 0;
    mode = 'lose-after';
    const ack = randomUUID();
    expect(await send(first, ack)).toEqual({ operationKey: ack, state: 'pending' });
    const key = randomUUID();
    mode = 'lose-before';
    expect(await send(second, key)).toEqual({ operationKey: key, state: 'awaiting_reconciliation' });
    expect((await directory()).pilot?.reserved).toBe(1);
    const posted = posts[1]!;
    invitations.push({ ...posted, role: 'org:admin' });
    expect((await send(second, randomUUID())).state).toBe('awaiting_reconciliation');
    invitations[1] = { ...posted, email_address: 'foreign@example.test' };
    expect((await send(second, key)).state).toBe('awaiting_reconciliation');
    mode = 'unavailable';
    expect((await send(second, key)).state).toBe('awaiting_reconciliation');
    mode = 'ok';
    invitations[1] = { ...posted, status: 'accepted' };
    expect(await send(second, key)).toEqual({ operationKey: key, state: 'accepted' });
    expect(posts).toHaveLength(2);
  });
  it('counts an uncertain request against a finite allowance and checks owner authority again immediately before the POST', async () => {
    memberEmails.push(secondOwnerEmail);
    mode = 'lose-before';
    expect((await send(first, randomUUID())).state).toBe('awaiting_reconciliation');
    expect(invitations).toHaveLength(0);
    expect((await directory()).available).toBe(0);
    await expect(send(second, randomUUID())).rejects.toMatchObject({ code: 'seat_limit' });
    expect(posts).toHaveLength(1);
    await setPlan('pro');
    maximum = 0;
    const pilot = clerk.invitePilot!,
      inspect = pilot.inspect;
    let inspections = 0;
    pilot.inspect = async (workspace) => {
      const result = await inspect(workspace);
      if (++inspections === 2) ownerCurrent = false;
      return result;
    };
    const key = randomUUID();
    await expect(send(second, key)).rejects.toMatchObject({ code: 'owner_required' });
    ownerCurrent = true;
    expect((await send(second, key)).state).toBe('awaiting_reconciliation');
    expect(posts).toHaveLength(1);
  });
  it('does not forward a redirected POST or repeat it on retry',async()=>{
    mode='redirect';
    const key=randomUUID();
    expect(await send(first,key)).toEqual({operationKey:key,state:'awaiting_reconciliation'});
    expect(await send(first,randomUUID())).toEqual({operationKey:key,state:'awaiting_reconciliation'});
    expect(redirected).toBe(0);
    expect(posts).toHaveLength(1);
  });
});
