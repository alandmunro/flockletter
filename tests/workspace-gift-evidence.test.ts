import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { WorkspaceGifts } from '../src/server/workspace-gifts/service.js';
import { all } from '../src/server/workspace-gifts/store.js';
import { seedStagingGiftAudience } from '../src/server/workspace-gifts/audience.js';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/server/db.js';
import { verifyWorkspaceGiftEvidence } from '../src/server/workspace-gifts/evidence.js';

const expected = {
  gateway: 'simulated', unit: 'USD cents', charged: 55000, credit: 50000, initiallyReserved: 50000,
  claimed: 5, expired: 95, orders: 5, spent: 2500, released: 47500, availableBeforeClosure: 47500,
  refunded: 52250, available: 0, reserved: 0, foreignPurchases: 0, ledgerEntries: 105, negativeBalance: -2500,
  access: ['paused', 'suspended', 'closed'], reservedDuringCatalogOutage: 0,
};

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database;

beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url, 1);
});

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  try {
    await db?.close();
  } finally {
    await fixture?.stop();
  }
});

it.each(['production', 'local', '', undefined])('refuses environment %s before opening a database scope', async env => {
  vi.stubEnv('APP_ENV', env);
  const read = vi.spyOn(db, 'tenant');
  try {
    await expect(verifyWorkspaceGiftEvidence(db)).rejects.toThrow('requires staging or test');
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

it('resumes an interrupted PostgreSQL proof on overlapping boots and returns the exact public receipt', async () => {
  vi.stubEnv('APP_ENV', 'staging');
  const anotherBoot = new Database(fixture.url, 1);
  const oneConnection = new Database(fixture.url, 1);
  const originalTick = WorkspaceGifts.prototype.tick;
  const tick = vi.spyOn(WorkspaceGifts.prototype, 'tick').mockImplementation(async function(this: WorkspaceGifts, workspace) {
    if ((await this.db.read(workspace, sql => all(sql, 'offer'))).some(o => o.state === 'pending'))
      throw Error('Simulated process interruption');
    return originalTick.call(this, workspace);
  });
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network access'));
  try {

    await expect(verifyWorkspaceGiftEvidence(db)).rejects.toThrow('failed during order recovery');
    tick.mockRestore();
    // Model a killed boot that was unable to release its lease. Leave its committed
    // simulation and service checkpoints intact.
    const workspace = 'fixture:gifting:audience:v1:studio';
    const lease = 'workspace-gift-evidence:v1:lease';
    await db.tenant(workspace, sql => sql.query(`
      INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result,created_at)
      SELECT $1,$2,lpad((max(operation_key::integer)+1)::text,10,'0'),'stopped-boot','true',clock_timestamp()-interval '91 seconds'
      FROM operations WHERE workspace_id=$1 AND actor_id=$2`, [workspace, lease]));
    const results = await Promise.all([verifyWorkspaceGiftEvidence(db), verifyWorkspaceGiftEvidence(anotherBoot)]);
    expect(results).toStrictEqual([expected, expected]);
    expect(await verifyWorkspaceGiftEvidence(oneConnection)).toStrictEqual(expected);
    expect(network).not.toHaveBeenCalled();
  } finally {
    tick.mockRestore();
    network.mockRestore();
    await anotherBoot.close();
    await oneConnection.close();
  }
});

it('keeps lower-level diagnostics out of a hosted failure', async () => {
  vi.stubEnv('APP_ENV', 'test');
  const read = vi.spyOn(db, 'tenant').mockRejectedValueOnce(new Error('internal fixture diagnostic'));
  try {
    await expect(verifyWorkspaceGiftEvidence(db)).rejects.toThrow(/^Workspace gift fixture verification failed/);
  } finally {
    read.mockRestore();
  }
});

it('independently exercises the same provider and ledger races with a two-connection pool', async () => {
  vi.stubEnv('APP_ENV', 'staging');
  const isolated = await startDatabase(), concurrent = new Database(isolated.url, 2);
  try {
    expect(await verifyWorkspaceGiftEvidence(concurrent)).toStrictEqual(expected);
  } finally {
    try { await concurrent.close(); } finally { await isolated.stop(); }
  }
});

it('preserves an existing open purchase from a different gateway in the reserved fixture', async () => {
  vi.stubEnv('APP_ENV', 'test');
  const isolated = await startDatabase(), occupied = new Database(isolated.url, 2);
  try {
    const { workspaceId, brandId } = await seedStagingGiftAudience(occupied, 'studio');
    const unexpected = async () => { throw Error('Unexpected simulated gateway call'); };
    const service = new WorkspaceGifts(occupied, {
      account: 'acct_otherfixture', checkout: async () => ({ id: 'cs_otherfixture', url: null, expired: false }),
      payment: unexpected, refund: unexpected, products: unexpected, order: unexpected, link: unexpected,
    }, { live: false, waitMs: 0, monthlyCap: 50000, fixture: true });
    await service.execute('gifts.purchase', { brandId, operationKey: randomUUID(), face: 100 }, {
      kind: 'session', workspaceId, owner: true, scopes: [], brandIds: null, userId: 'other', actorId: 'user:other',
    });
    const before = await occupied.read(workspaceId, sql => all(sql, 'lot'));
    await expect(verifyWorkspaceGiftEvidence(occupied)).rejects.toThrow('failed during fixture setup');
    expect(await occupied.read(workspaceId, sql => all(sql, 'lot'))).toEqual(before);
    expect(await occupied.read(workspaceId, sql => all(sql, 'entry'))).toEqual([]);
  } finally {
    try { await occupied.close(); } finally { await isolated.stop(); }
  }
});
