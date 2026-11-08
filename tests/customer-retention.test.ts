import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { CustomerRetention, retentionManifestDigest } from '../src/server/customer-retention/index.js';
import { authorizeRetention, executeAuthorizedRetention } from '../src/server/customer-retention/executor.js';
import type { RetentionStatus, ServiceEnd } from '../src/shared/customer-retention.js';
import tables from '../src/shared/runtime-tables.json' with { type: 'json' };
let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database;
const now = new Date('2026-11-08T16:00:00Z'),
  start = new Date(now.getTime() - 90 * 86400000);
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});
async function owner(): Promise<Actor> {
  const workspaceId = 'org_' + randomUUID().replaceAll('-', ''),
    userId = 'user_' + randomUUID();
  const actor: Actor = {
    workspaceId,
    userId,
    actorId: 'user:' + userId,
    owner: true,
    kind: 'session',
    scopes: ['read'],
    brandIds: null,
  };
  await new CommandService(db).execute(
    'workspace.initialize',
    { operationKey: randomUUID(), name: 'Retention test', brandName: 'Trail' },
    actor,
  );
  return actor;
}
function service(fact: ServiceEnd, clock = now) {
  return new CustomerRetention(db, {
    mode: 'capture',
    isOwner: async () => true,
    serviceEnd: async () => fact,
    serviceEndSql: async () => fact,
    now: () => clock,
  });
}
const canceled = (version = 'closure-1'): ServiceEnd => ({
  source: 'exercise',
  status: 'canceled',
  effectiveEnd: start.toISOString(),
  version,
});
const command = (ret: CustomerRetention, name: string, args: unknown, actor: Actor) =>
  ret.execute(name, args, actor) as Promise<RetentionStatus>;
async function due(ret: CustomerRetention, actor: Actor) {
  const first = await command(ret, 'retention.inspect', { operationKey: randomUUID() }, actor);
  const row = first.cases[0]!;
  return command(
    ret,
    'retention.request',
    {
      operationKey: randomUUID(),
      id: row.id,
      expectedVersion: row.version,
      inventoryDigest: row.inventoryDigest,
    },
    actor,
  );
}

it('tracks the exact 90-day boundary and captures the requested executor without deleting account data', async () => {
  const actor = await owner(),
    ret = service(canceled());
  const before = await command(
    service(canceled(), new Date(now.getTime() - 1)),
    'retention.inspect',
    { operationKey: randomUUID() },
    actor,
  );
  expect(before.cases[0]?.state).toBe('retained');
  const state = await due(ret, actor),
    row = state.cases[0]!;
  expect(state.jobs[0]).toMatchObject({
    state: 'awaiting_operator',
    manifestDigest: retentionManifestDigest(),
  });
  const input = { operationKey: randomUUID(), id: row.id, expectedVersion: row.version };
  const result = await command(ret, 'retention.exercise', input, actor);
  expect(result.jobs[0]).toMatchObject({ state: 'captured', result: { captured: true, deletedRows: 0 } });
  expect((await command(ret, 'retention.exercise', input, actor)).jobs).toEqual(result.jobs);
  expect(await new CommandService(db).execute('workspace.get', {}, actor)).toHaveProperty(
    'name',
    'Retention test',
  );
});

it('holds jobs, detects reinstatement under the lock and preserves the unrelated workspace', async () => {
  const actor = await owner(),
    other = await owner(),
    fact = canceled(),
    ret = service(fact);
  let state = await due(ret, actor);
  const row = state.cases[0]!;
  state = await command(
    ret,
    'retention.hold',
    { operationKey: randomUUID(), id: row.id, expectedVersion: row.version, reason: 'Owner needs records' },
    actor,
  );
  expect(state.cases[0]?.state).toBe('held');
  expect(state.jobs[0]?.state).toBe('cancelled');
  const held = state.cases[0]!;
  fact.effectiveEnd = null;
  fact.status = 'active';
  fact.version = 'reinstated';
  state = await command(
    ret,
    'retention.release',
    { operationKey: randomUUID(), id: held.id, expectedVersion: held.version },
    actor,
  );
  expect(state.cases[0]?.state).toBe('cancelled');
  expect((await ret.status(other.workspaceId)).cases).toHaveLength(0);
  await expect(
    command(
      ret,
      'retention.hold',
      { operationKey: randomUUID(), id: held.id, expectedVersion: held.version, reason: 'Wrong workspace' },
      other,
    ),
  ).rejects.toMatchObject({ code: 'retention_case_unavailable' });
});

it('requires an exact reviewed inventory and refuses hosted erasure through owner HTTP operations', async () => {
  const actor = await owner(),
    ret = service(canceled());
  let state = await command(ret, 'retention.inspect', { operationKey: randomUUID() }, actor),
    row = state.cases[0]!;
  await expect(
    command(
      ret,
      'retention.request',
      {
        operationKey: randomUUID(),
        id: row.id,
        expectedVersion: row.version,
        inventoryDigest: 'f'.repeat(64),
      },
      actor,
    ),
  ).rejects.toMatchObject({ code: 'retention_inventory_changed' });
  state = await due(ret, actor);
  row = state.cases[0]!;
  await expect(
    command(
      new CustomerRetention(db, {
        mode: 'live',
        isOwner: async () => true,
        serviceEnd: async () => canceled(),
      }),
      'retention.exercise',
      { operationKey: randomUUID(), id: row.id, expectedVersion: row.version },
      actor,
    ),
  ).rejects.toMatchObject({ code: 'retention_executor_required' });
  await expect(command(ret, 'retention.status', {}, { ...actor, kind: 'connection' })).rejects.toMatchObject({
    code: 'owner_required',
  });
});

it('executes only with separate restricted authority and replays the durable erasure receipt', async () => {
  const actor = await owner(),
    other = await owner(),
    fact = canceled(),
    ret = service(fact);
  const state = await due(ret, actor),
    job = state.jobs[0]!,
    admin = new pg.Client({ connectionString: fixture.adminUrl });
  await admin.connect();
  const role = 'flockletter_eraser_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const options = {
    enabled: true,
    executorRole: role,
    databaseName: 'flockletter_test',
    now: () => now,
    serviceEnd: async () => fact,
    verifyCheckpoint: async () => true,
    verifyExternalStores: async () => true,
  };
  try {
    await admin.query(
      'CREATE ROLE ' +
        pg.escapeIdentifier(role) +
        ' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
    );
    await admin.query(
      'GRANT USAGE ON SCHEMA public,flockletter_retention_control TO ' + pg.escapeIdentifier(role),
    );
    await admin.query(
      'GRANT SELECT,DELETE ON ' +
        tables.map((t) => 'public.' + pg.escapeIdentifier(t.name)).join(',') +
        ' TO ' +
        pg.escapeIdentifier(role),
    );
    await admin.query(
      'GRANT UPDATE ON customer_retention_jobs,customer_retention_cases TO ' + pg.escapeIdentifier(role),
    );
    await admin.query(
      'GRANT SELECT,INSERT,UPDATE ON flockletter_retention_control.authorizations,flockletter_retention_control.receipts TO ' +
        pg.escapeIdentifier(role),
    );
    await expect(executeAuthorizedRetention(admin, options, actor.workspaceId, job.id)).rejects.toThrow(
      'Separate restricted',
    );
    await admin.query('GRANT USAGE ON SCHEMA flockletter_customer_jobs TO ' + pg.escapeIdentifier(role));
    await admin.query(
      'GRANT SELECT,DELETE ON flockletter_customer_jobs.scopes TO ' + pg.escapeIdentifier(role),
    );
    await admin.query('GRANT INSERT ON customer_retention_receipts TO ' + pg.escapeIdentifier(role));
    await admin.query(
      'INSERT INTO flockletter_customer_jobs.scopes(workspace_id,next_due_at) VALUES($1,now()),($2,now())',
      [actor.workspaceId, other.workspaceId],
    );
    await admin.query('SET ROLE ' + pg.escapeIdentifier(role));
    const approval = {
      workspaceId: actor.workspaceId,
      jobId: job.id,
      sourceVersion: fact.version,
      databaseName: 'flockletter_test',
      manifestDigest: retentionManifestDigest(),
      checkpointDigest: 'a'.repeat(64),
      authorizedBy: 'fixture-operator',
      expiresAt: new Date(now.getTime() + 60000),
    };
    await authorizeRetention(admin, options, approval);
    await expect(
      executeAuthorizedRetention(
        admin,
        { ...options, verifyExternalStores: async () => false },
        actor.workspaceId,
        job.id,
      ),
    ).rejects.toThrow('External-store');
    expect(await new CommandService(db).execute('workspace.get', {}, actor)).toHaveProperty('name');
    const result = await executeAuthorizedRetention(admin, options, actor.workspaceId, job.id);
    expect(result).toMatchObject({ erased: true, replayed: false, scope: 'application_database' });
    expect(
      (
        await admin.query(
          'SELECT workspace_id FROM flockletter_customer_jobs.scopes WHERE workspace_id=ANY($1)',
          [[actor.workspaceId, other.workspaceId]],
        )
      ).rows,
    ).toEqual([{ workspace_id: other.workspaceId }]);
    expect(await executeAuthorizedRetention(admin, options, actor.workspaceId, job.id)).toMatchObject({
      erased: true,
      replayed: true,
    });
    expect(await new CommandService(db).execute('workspace.get', {}, actor)).toBeNull();
    expect(await new CommandService(db).execute('workspace.get', {}, other)).toHaveProperty(
      'name',
      'Retention test',
    );
  } finally {
    await admin.query('RESET ROLE');
    await admin.end();
  }
});

it('schedules against verified exercise time without manufacturing a customer session or churning reviewed versions', async () => {
  const actor = await owner(),
    fact = canceled(),
    ret = new CustomerRetention(db, {
      mode: 'capture',
      isOwner: async () => true,
      currentOwner: async () => actor.userId,
      serviceEnd: async () => fact,
      serviceEndSql: async () => fact,
      now: () => new Date(start.getTime() + 86400000),
      clock: async () => now,
      clockSql: async () => now,
    });
  expect(await ret.tickWorkspace(actor.workspaceId)).toHaveProperty('reconciled', true);
  const first = await ret.status(actor.workspaceId);
  expect(first.cases[0]?.state).toBe('due');
  await ret.tickWorkspace(actor.workspaceId);
  expect((await ret.status(actor.workspaceId)).cases[0]?.version).toBe(first.cases[0]?.version);
  fact.version = 'reinstated';
  fact.effectiveEnd = null;
  fact.status = 'active';
  await ret.tickWorkspace(actor.workspaceId);
  expect((await ret.status(actor.workspaceId)).cases[0]?.state).toBe('cancelled');
  await expect(
    new CustomerRetention(db, { ...ret.options, currentOwner: async () => null }).tickWorkspace(
      actor.workspaceId,
    ),
  ).rejects.toMatchObject({ code: 'owner_required' });
});

it('holds restored retention plans after the read-only erasure checkpoint is present', async () => {
  const actor = await owner(),
    fact = canceled();
  const ret = new CustomerRetention(db, {
    mode: 'capture',
    isOwner: async () => true,
    currentOwner: async () => actor.userId,
    serviceEnd: async () => fact,
    serviceEndSql: async () => fact,
    now: () => now,
  });
  await ret.tickWorkspace(actor.workspaceId);
  const admin = new pg.Client({ connectionString: fixture.adminUrl });
  await admin.connect();
  try {
    await admin.query(
      'INSERT INTO customer_retention_receipts(workspace_id,job_id,effective_end_at,erased_at,manifest_digest,checkpoint_digest) VALUES($1,$2,$3,$4,$5,$6)',
      [actor.workspaceId, randomUUID(), start, now, retentionManifestDigest(), 'a'.repeat(64)],
    );
  } finally {
    await admin.end();
  }
  expect(await ret.tickWorkspace(actor.workspaceId)).toEqual({ reconciled: false, caseId: null });
  await expect(ret.execute('retention.inspect', { operationKey: randomUUID() }, actor)).rejects.toMatchObject(
    { code: 'workspace_erased' },
  );
});
