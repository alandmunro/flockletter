import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import {
  CustomerTeamLifecycle,
  type TeamDirectory,
  type TeamIntent,
  type TeamLifecyclePort,
} from '../src/server/customer-team/service.js';
import type { TeamLifecycleView } from '../src/shared/customer-team.js';
import { recordRestoredErasure } from './helpers/restored-erasure.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database;
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});
async function setup(limit: number | null = 3) {
  const workspace = 'org_' + randomUUID().replaceAll('-', ''),
    actor: Actor = {
      workspaceId: workspace,
      userId: 'user_owner',
      actorId: 'user:owner',
      owner: true,
      kind: 'session',
      scopes: ['read'],
      brandIds: null,
    };
  await new CommandService(db).execute(
    'workspace.initialize',
    { operationKey: randomUUID(), name: 'Team shop', brandName: 'Trail' },
    actor,
  );
  const team = new CustomerTeamLifecycle(db, {
    mode: 'exercise',
    checkOwner: async () => true,
    seatLimit: async () => limit,
  });
  await team.execute('teamLifecycle.initializeExercise', { operationKey: randomUUID() }, actor);
  return {
    workspace,
    actor,
    team,
    status: () => team.execute('teamLifecycle.status', {}, actor) as Promise<TeamLifecycleView>,
  };
}
it('exercises invitations, acceptance, owner transfer and removal without changing Clerk identity', async () => {
  const a = await setup();
  const invite = { operationKey: randomUUID(), email: 'teammate@realshop.com' };
  const first = await a.team.execute('teamLifecycle.invite', invite, a.actor);
  expect(await a.team.execute('teamLifecycle.invite', invite, a.actor)).toEqual(first);
  const pending = (await a.status()).invitations[0]!;
  const accepted = (await a.team.execute(
    'teamLifecycle.exerciseAccept',
    { operationKey: randomUUID(), id: pending.id },
    a.actor,
  )) as { userId: string };
  expect(accepted.userId).toMatch(/^exercise_/);
  await expect(
    a.team.execute('teamLifecycle.remove', { operationKey: randomUUID(), userId: a.actor.userId }, a.actor),
  ).rejects.toMatchObject({ code: 'transfer_required' });
  await a.team.execute(
    'teamLifecycle.transfer',
    { operationKey: randomUUID(), userId: accepted.userId },
    a.actor,
  );
  expect((await a.status()).members.find((m) => m.userId === accepted.userId)?.role).toBe('owner');
  expect((await a.status()).members.find((m) => m.userId === a.actor.userId)?.role).toBe('member');
  await expect(
    a.team.execute('teamLifecycle.remove', { operationKey: randomUUID(), userId: accepted.userId }, a.actor),
  ).rejects.toMatchObject({ code: 'last_owner' });
  // The actual verified Clerk owner still controls this isolated scenario.
  expect(await a.team.execute('teamLifecycle.status', {}, a.actor)).toMatchObject({ mode: 'exercise' });
});
it('reserves the final finite seat once under simultaneous invitation requests', async () => {
  const a = await setup(2);
  const attempts = await Promise.allSettled(
    ['one@shop.com', 'two@shop.com'].map((email) =>
      a.team.execute('teamLifecycle.invite', { operationKey: randomUUID(), email }, a.actor),
    ),
  );
  expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect((await a.status()).invitations.filter((i) => i.state === 'pending')).toHaveLength(1);
  const row = (await a.status()).invitations[0]!;
  await a.team.execute('teamLifecycle.revokeInvite', { operationKey: randomUUID(), id: row.id }, a.actor);
  expect((await a.status()).invitations[0]?.state).toBe('revoked');
});
it('keeps scenario records isolated and requires a current owner on reads and retries', async () => {
  const a = await setup(),
    b = await setup();
  await a.team.execute(
    'teamLifecycle.invite',
    { operationKey: randomUUID(), email: 'private@shop.com' },
    a.actor,
  );
  expect((await b.status()).invitations).toHaveLength(0);
  await expect(
    a.team.execute('teamLifecycle.status', {}, { ...a.actor, owner: false }),
  ).rejects.toMatchObject({ code: 'owner_required' });
  const revoked = new CustomerTeamLifecycle(db, { mode: 'exercise', checkOwner: async () => false });
  await expect(revoked.execute('teamLifecycle.status', {}, a.actor)).rejects.toMatchObject({
    code: 'owner_required',
  });
});
it('reconciles a lost Clerk invitation response without a second provider mutation', async () => {
  const a = await setup();
  const directory: TeamDirectory = {
    members: [{ userId: a.actor.userId, email: 'owner@shop.com', role: 'owner' }],
    invitations: [],
    maximum: 3,
  };
  let posts = 0;
  const port: TeamLifecyclePort = {
    inspect: async () => structuredClone(directory),
    apply: async (_w, intent) => {
      posts++;
      directory.invitations.push({
        id: 'orginv_fixture',
        email: intent.payload.email!,
        state: 'pending',
        reference: intent.reference,
      });
      throw Error('lost response');
    },
  };
  const team = new CustomerTeamLifecycle(db, {
    mode: 'clerk',
    checkOwner: async () => true,
    seatLimit: async () => 3,
    port,
  });
  const request = { operationKey: randomUUID(), email: 'new@shop.com' };
  const result = await team.execute('teamLifecycle.invite', request, a.actor);
  expect(result).toMatchObject({ state: 'completed', mode: 'clerk' });
  expect(await team.execute('teamLifecycle.invite', request, a.actor)).toEqual(result);
  expect(posts).toBe(1);
});
it('commits uncertainty before a failed mutation and never guesses that the operation was rejected', async () => {
  const a = await setup();
  let posts = 0;
  const port: TeamLifecyclePort = {
    inspect: async () => ({
      members: [{ userId: a.actor.userId, email: 'owner@shop.com', role: 'owner' }],
      invitations: [],
      maximum: 3,
    }),
    apply: async () => {
      posts++;
      throw Error('provider unreachable');
    },
  };
  const team = new CustomerTeamLifecycle(db, {
    mode: 'clerk',
    checkOwner: async () => true,
    seatLimit: async () => 3,
    port,
  });
  const request = { operationKey: randomUUID(), email: 'new@shop.com' };
  const result = await team.execute('teamLifecycle.invite', request, a.actor);
  expect(result).toMatchObject({ state: 'uncertain' });
  await team.execute('teamLifecycle.invite', request, a.actor);
  expect(posts).toBe(1);
});
it('transfers ownership in verified phases and only demotes after observing the successor owner', async () => {
  const a = await setup();
  const directory: TeamDirectory = {
    members: [
      { userId: a.actor.userId, email: 'owner@shop.com', role: 'owner' },
      { userId: 'user_successor', email: 'next@shop.com', role: 'member' },
    ],
    invitations: [],
    maximum: 3,
  };
  const phases: string[] = [];
  const port: TeamLifecyclePort = {
    inspect: async () => structuredClone(directory),
    apply: async (_w, intent: TeamIntent) => {
      phases.push(intent.phase);
      if (intent.phase === 'initial') {
        directory.members[1]!.role = 'owner';
        throw Error('lost promotion response');
      }
      expect(directory.members[1]?.role).toBe('owner');
      directory.members[0]!.role = 'member';
    },
  };
  const team = new CustomerTeamLifecycle(db, {
    mode: 'clerk',
    checkOwner: async () => true,
    seatLimit: async () => 3,
    port,
  });
  const result = await team.execute(
    'teamLifecycle.transfer',
    { operationKey: randomUUID(), userId: 'user_successor' },
    a.actor,
  );
  expect(result).toMatchObject({ state: 'completed' });
  expect(phases).toEqual(['initial', 'demoting']);
});

it('never replays an exercise intent against real Clerk after changing lifecycle mode', async () => {
  const a = await setup();
  const request = { operationKey: randomUUID(), email: 'exercise@shop.com' };
  const receipt = (await a.team.execute('teamLifecycle.invite', request, a.actor)) as { id: string };
  let mutations = 0;
  const real = new CustomerTeamLifecycle(db, {
    mode: 'clerk',
    checkOwner: async () => true,
    seatLimit: async () => 3,
    port: {
      inspect: async () => ({
        members: [{ userId: a.actor.userId, email: 'owner@shop.com', role: 'owner' }],
        invitations: [],
        maximum: 3,
      }),
      apply: async () => {
        mutations++;
      },
    },
  });
  await expect(real.execute('teamLifecycle.invite', request, a.actor)).rejects.toMatchObject({
    code: 'operation_conflict',
  });
  await expect(
    real.execute('teamLifecycle.reconcile', { id: receipt.id, operationKey: randomUUID() }, a.actor),
  ).rejects.toMatchObject({ code: 'operation_mode_changed' });
  expect(await real.tickWorkspace(a.workspace)).toEqual({ processed: 0 });
  expect(mutations).toBe(0);
});

it('blocks restored external team mutations and transfer demotion after an erasure receipt, but reconciles facts', async () => {
  const a = await setup();
  const directory: TeamDirectory = {
    members: [
      { userId: a.actor.userId, email: 'owner@shop.test', role: 'owner' },
      { userId: 'user_next', email: 'next@shop.test', role: 'member' },
    ],
    invitations: [],
    maximum: 3,
  };
  const phases: string[] = [];
  let inspections = 0;
  const port: TeamLifecyclePort = {
    inspect: async () => {
      inspections++;
      return structuredClone(directory);
    },
    apply: async (_workspace, intent) => {
      phases.push(intent.phase);
      if (intent.phase === 'initial') {
        directory.members[1]!.role = 'owner';
        // Model a restored database receipt without running an erasure executor or any real Clerk action.
        await recordRestoredErasure(fixture.adminUrl, a.workspace);
        throw Error('lost promotion response');
      }
      directory.members[0]!.role = 'member';
    },
  };
  const team = new CustomerTeamLifecycle(db, {
    mode: 'clerk',
    checkOwner: async () => true,
    seatLimit: async () => 3,
    port,
  });
  const result = (await team.execute(
    'teamLifecycle.transfer',
    { operationKey: randomUUID(), userId: 'user_next' },
    a.actor,
  )) as { id: string; state: string };
  expect(result.state).toBe('uncertain');
  expect(phases).toEqual(['initial']);
  expect(directory.members[0]?.role).toBe('owner');
  await team.tickWorkspace(a.workspace);
  expect(phases).toEqual(['initial']);
  expect(inspections).toBeGreaterThan(1);
  await expect(
    team.execute('teamLifecycle.invite', { operationKey: randomUUID(), email: 'blocked@shop.test' }, a.actor),
  ).rejects.toMatchObject({ code: 'workspace_erased' });
  expect(phases).toEqual(['initial']);
  // A read-only observation can resolve an already-completed outcome after erasure, without granting authority.
  directory.members[0]!.role = 'member';
  const worker = new CustomerTeamLifecycle(db, { mode: 'clerk', checkOwner: async () => false, port });
  await worker.tickWorkspace(a.workspace);
  expect(
    await db.tenant(
      a.workspace,
      async (sql) =>
        (await sql.query('SELECT state,phase FROM customer_team_intents WHERE id=$1', [result.id])).rows[0],
    ),
  ).toMatchObject({ state: 'completed', phase: 'initial' });
  expect(phases).toEqual(['initial']);
});
