import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { lockWorkspace } from '../src/server/workspace-lock.js';
import { all, available, one, put, type Lot } from '../src/server/workspace-gifts/store.js';
import { WorkspaceGifts } from '../src/server/workspace-gifts/service.js';
import { verifyTremendousEvent } from '../src/server/workspace-gifts/routes.js';
import type { GiftGateway } from '../src/server/workspace-gifts/provider.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database;
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});

it('reconciles unused credit on multiple lots after a partial loss without refunding spent or disputed credit', async () => {
  const id = randomUUID(),
    workspace = 'org_' + id,
    brand = randomUUID(),
    now = new Date(),
    first = randomUUID(),
    second = randomUUID();
  const lot = (lotId: string, face: number, spent: number, lost: number): Lot => ({
    id: lotId,
    brand,
    account: 'acct_fixture',
    face,
    fee: Math.round(face / 10),
    total: face + Math.round(face / 10),
    state: 'funded',
    payment: 'pi_' + lotId,
    charge: 'ch_' + lotId,
    created: now.toISOString(),
    paidAt: now.toISOString(),
    spent,
    reserved: 0,
    returned: 0,
    disputed: 0,
    lost,
    disputes: {},
  });
  await db.tenant(workspace, async (sql) => {
    await lockWorkspace(sql, workspace);
    await sql.query('INSERT INTO workspaces(workspace_id,name) VALUES($1,$2)', [
      workspace,
      'Gift journal exercise',
    ]);
    await sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
      workspace,
      brand,
      'Journal fixture',
    ]);
    await put(sql, workspace, 'lot', first, lot(first, 1000, 900, 600));
    await put(sql, workspace, 'lot', second, lot(second, 1500, 0, 0));
    await put(sql, workspace, 'closure', 'closed', { at: now.toISOString(), brand });
  });
  const calls: number[] = [];
  const unexpected = async () => {
    throw Error('Unexpected provider action');
  };
  const provider: GiftGateway = {
    account: 'acct_fixture',
    checkout: unexpected,
    payment: unexpected,
    products: unexpected,
    link: unexpected,
    order: unexpected,
    refund: async (w, l, amount) => {
      expect(w).toBe(workspace);
      expect(l.id).toBe(second);
      calls.push(amount);
      return { id: 're_fixture', amount };
    },
  };
  const gifts = new WorkspaceGifts(db, provider, { live: false, monthlyCap: null, waitMs: null });
  await gifts.tick(workspace);
  await gifts.tick(workspace);
  expect(calls).toEqual([1100]);
  const amounts = await db.read(workspace, async (sql) => ({
    lots: await all(sql, 'lot'),
    ledger: await all(sql, 'entry'),
  }));
  expect(amounts.lots.reduce((n, l) => n + available(l), 0)).toBe(0);
  expect(amounts.ledger.filter((e) => e.kind === 'refunded').map((e) => e.amount)).toEqual([1100]);
});

it('keeps only one provider event receipt after simultaneous delivery and binds it to the workspace', async () => {
  const w = 'org_' + randomUUID();
  const gifts = new WorkspaceGifts(db, {} as GiftGateway, { live: false, monthlyCap: null, waitMs: null });
  await Promise.all([gifts.markProcessed(w, 'evt_local'), gifts.markProcessed(w, 'evt_local')]);
  expect(await gifts.processed(w, 'evt_local')).toBe(true);
  expect(await gifts.processed('org_' + randomUUID(), 'evt_local')).toBe(false);
  expect(await db.read(w, (sql) => one(sql, 'event', 'evt_local'))).toHaveProperty('at');
});

it('accepts the Tremendous raw-body HMAC and rejects a signed body whose bytes have changed', () => {
  const raw = Buffer.from(
    JSON.stringify({
      uuid: randomUUID(),
      event: 'ORDERS.CREATED',
      payload: { resource: { id: 'EXAMPLEORDER' } },
    }),
  );
  const key = 'local-only-signing-fixture',
    signature = 'sha256=' + createHmac('sha256', key).update(raw).digest('hex');
  expect(verifyTremendousEvent(raw, signature, key).event).toBe('ORDERS.CREATED');
  expect(() => verifyTremendousEvent(Buffer.concat([raw, Buffer.from(' ')]), signature, key)).toThrow();
  expect(() => verifyTremendousEvent(raw, '', key)).toThrow();
});
