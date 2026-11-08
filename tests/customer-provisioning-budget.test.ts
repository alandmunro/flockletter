import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>;
let db: Database;
let operator: Database;

interface Scope {
  workspaceId: string;
  brandId: string;
}

const scopes: Scope[] = [];

beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  operator = new Database(fixture.adminUrl);

  for (let i = 0; i < 2; i++) {
    const workspaceId = 'org_' + randomUUID().replace(/-/g, '');
    const userId = 'user_' + randomUUID();

    const service = new CommandService(db);

    const actor: Actor = {
      workspaceId,
      userId,
      actorId: 'user:' + userId,
      owner: true,
      kind: 'session',
      scopes: ['read'],
      brandIds: null,
    };

    await service.execute(
      'workspace.initialize',
      { name: 'Shop' + i, brandName: 'Brand' + i, operationKey: randomUUID() },
      actor,
    );

    const workspace = (await service.execute('workspace.get', {}, actor)) as {
      brands: { id: string }[];
    };

    const brandId = workspace.brands[0]!.id;
    scopes.push({ workspaceId, brandId });
  }
});

beforeEach(async () => {
  await operator.pool.query('DELETE FROM flockletter_customer_jobs.provisioning_budget');
});

afterAll(async () => {
  await db?.close();
  await operator?.close();
  await fixture?.stop();
});

async function claim(scope: Scope, operationId: string, limit: number): Promise<boolean> {
  return db.tenant(scope.workspaceId, (sql) =>
    sql
      .query<{ allowed: boolean }>(
        `SELECT flockletter_customer_jobs.claim_provisioning_budget($1, $2, $3, $4) AS allowed`,
        [scope.workspaceId, scope.brandId, operationId, limit],
      )
      .then((res) => res.rows[0]!.allowed),
  );
}

it('limit1 first succeeds exact replay succeeds second scope reusing same op fails and fresh op fails', async () => {
  const scopeA = scopes[0]!,
    scopeB = scopes[1]!;
  const op1 = randomUUID();

  expect(await claim(scopeA, op1, 1)).toBe(true);

  expect(await claim(scopeA, op1, 1)).toBe(true);

  expect(await claim(scopeB, op1, 1)).toBe(false);

  const op2 = randomUUID();
  expect(await claim(scopeA, op2, 1)).toBe(false);
});

it('six parallel unique claims alternating two scopes with limit2 yields exactly 2 true and each successful replay remains true', async () => {
  const scopeA = scopes[0]!,
    scopeB = scopes[1]!;

  const opsA: string[] = [randomUUID(), randomUUID(), randomUUID()];
  const opsB: string[] = [randomUUID(), randomUUID(), randomUUID()];

  const promises = [
    claim(scopeA, opsA[0]!, 2),
    claim(scopeB, opsB[0]!, 2),
    claim(scopeA, opsA[1]!, 2),
    claim(scopeB, opsB[1]!, 2),
    claim(scopeA, opsA[2]!, 2),
    claim(scopeB, opsB[2]!, 2),
  ];

  const results = await Promise.all(promises);

  const trues = results.filter((r) => r).length;
  expect(trues).toBe(2);

  const successfulOps: string[] = [];
  if (results[0]) successfulOps.push(opsA[0]!);
  if (results[1]) successfulOps.push(opsB[0]!);
  if (results[2]) successfulOps.push(opsA[1]!);
  if (results[3]) successfulOps.push(opsB[1]!);
  if (results[4]) successfulOps.push(opsA[2]!);
  if (results[5]) successfulOps.push(opsB[2]!);

  const replays = await Promise.all(
    successfulOps.map((op) => {
      const getScopeForOp = (op: string): Scope => {
        if ([opsA[0], opsA[1], opsA[2]].includes(op)) return scopeA;
        if ([opsB[0], opsB[1], opsB[2]].includes(op)) return scopeB;
        throw new Error('Unknown op');
      };

      const s = getScopeForOp(op);
      return claim(s, op, 2);
    }),
  );

  expect(replays.every((r) => r)).toBe(true);
});

it('malformed cross-workspace brand and limit 0/21 returns false and runtime direct table SELECT/INSERT/DELETE permission denied 42501', async () => {
  const scopeA = scopes[0]!,
    scopeB = scopes[1]!;

  const op1 = randomUUID();

  const crossWorkspaceResult = await db.tenant(scopeA.workspaceId, (sql) =>
    sql
      .query<{ allowed: boolean }>(
        `SELECT flockletter_customer_jobs.claim_provisioning_budget($1, $2, $3, $4) AS allowed`,
        [scopeA.workspaceId, scopeB.brandId, op1, 5], // Using Scope B's brand for Scope A
      )
      .then((res) => res.rows[0]!.allowed),
  );

  expect(crossWorkspaceResult).toBe(false);

  const op2 = randomUUID();
  expect(await claim(scopeA, op2, 0)).toBe(false);

  const op3 = randomUUID();
  expect(await claim(scopeA, op3, 21)).toBe(false);

  await expect(
    db.tenant(scopeA.workspaceId, (sql) =>
      sql.query('SELECT * FROM flockletter_customer_jobs.provisioning_budget'),
    ),
  ).rejects.toMatchObject({ code: '42501' });

  await expect(
    db.tenant(scopeA.workspaceId, (sql) =>
      sql.query(
        `INSERT INTO flockletter_customer_jobs.provisioning_budget (operation_id, scope_hash, period) VALUES ($1, $2, now())`,
        [randomUUID(), new Uint8Array(32)],
      ),
    ),
  ).rejects.toMatchObject({ code: '42501' });

  await expect(
    db.tenant(scopeA.workspaceId, (sql) =>
      sql.query(`DELETE FROM flockletter_customer_jobs.provisioning_budget WHERE operation_id = $1`, [
        randomUUID(),
      ]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
});
