import { createHmac, randomUUID } from 'node:crypto';
import { TerminalGiftOrder } from '../src/server/workspace-gifts/provider.js';
import { recordWorkspacePayment } from '../src/server/workspace-gifts/eligibility-receipt.js';
import { eligibleGiftRecipients,seedStagingGiftAudience } from '../src/server/workspace-gifts/audience.js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
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

it('reconciles duplicated, reversed and out-of-order external refunds against the bound purchase', async () => {
  const w = 'org_' + randomUUID(),
    brand = randomUUID(),
    lotId = randomUUID(),
    at = new Date().toISOString();
  const l: Lot = {
    id: lotId,
    brand,
    account: 'acct_test',
    face: 1000,
    fee: 100,
    total: 1100,
    created: at,
    paidAt: at,
    state: 'funded',
    payment: 'pi_fixture',
    charge: 'ch_fixture',
    spent: 500,
    reserved: 0,
    returned: 0,
    lost: 0,
    disputed: 0,
    disputes: {},
  };
  await db.tenant(w, async (sql) => {
    await lockWorkspace(sql, w);
    await put(sql, w, 'lot', lotId, l);
  });
  const binding = { workspace: w, brand, lot: lotId, payment: l.payment!, charge: l.charge! };
  const gifts = new WorkspaceGifts(db, { account: l.account } as GiftGateway, {
    live: false,
    waitMs: 0,
    monthlyCap: 1000,
  });
  const snapshot = async () => ({ settled: 825, held: 0 });
  await Promise.all([
    gifts.externalRefund(binding, 'e1', snapshot),
    gifts.externalRefund(binding, 'e1', snapshot),
  ]);
  await gifts.externalRefund(binding, 'older', snapshot);
  expect(await db.read(w, async (sql) => available((await one(sql, 'lot', lotId))!))).toBe(-250);
  expect(await db.read(w, (sql) => one(sql, 'signal', 'access'))).toMatchObject({ kind: 'paused' });
  await gifts.externalRefund(binding, 'reversed', async () => ({ settled: 0, held: 0 }));
  expect(await db.read(w, (sql) => one(sql, 'signal', 'access'))).toMatchObject({ kind: 'clear' });
  expect((await db.read(w, (sql) => all(sql, 'entry'))).map((e) => e.kind)).toEqual([
    'external_refund',
    'refund_reversed',
  ]);
  await expect(
    gifts.externalRefund({ ...binding, workspace: 'org_other' }, 'unrelated', snapshot),
  ).rejects.toThrow();
});

it('keeps only one provider event receipt after simultaneous delivery and binds it to the workspace', async () => {
  const w = 'org_' + randomUUID();
  const gifts = new WorkspaceGifts(db, {} as GiftGateway, { live: false, monthlyCap: null, waitMs: null });
  await Promise.all([gifts.markProcessed(w, 'evt_local'), gifts.markProcessed(w, 'evt_local')]);
  expect(await gifts.processed(w, 'evt_local')).toBe(true);
  expect(await gifts.processed('org_' + randomUUID(), 'evt_local')).toBe(false);
  expect(await db.read(w, (sql) => one(sql, 'event', 'evt_local'))).toHaveProperty('at');
});

it('reserves a fresh annual offer once and recovers pending claims after a worker restart', async () => {
  vi.stubEnv('APP_ENV', 'test');
  try {
    const { workspaceId: w, brandId: b } = await seedStagingGiftAudience(db, 'orchard');
    const account = 'acct_yearly',
      id = randomUUID(),
      now = new Date(),
      at = now.toISOString();
    const lot: Lot = {
      id,
      brand: b,
      account,
      face: 1500,
      fee: 150,
      total: 1650,
      state: 'funded',
      paidAt: at,
      created: at,
      reserved: 0,
      spent: 0,
      lost: 0,
      returned: 0,
      disputed: 0,
      disputes: {},
      charge: 'ch_annual',
      payment: 'pi_annual',
    };
    const person = await db.brand(w, b, async (sql) => {
      await lockWorkspace(sql, w);
      await put(sql, w, 'lot', id, lot);
      return (await eligibleGiftRecipients(sql, w, b, 'exercise'))[0]!.id;
    });
    const opts = { live: false, monthlyCap: 1500, waitMs: 86400000, clock: () => now };
    let mode: 'offline' | 'cancel' | 'executed' = 'offline';
    const unexpected = async () => {
      throw Error('Unexpected provider call');
    };
    const provider: GiftGateway = {
      account,
      checkout: unexpected,
      payment: unexpected,
      refund: unexpected,
      products: async () => [{ id: 'CARD01', name: 'Coffee' }],
      order: async () => {
        if (mode === 'offline') throw Error('Lost order response');
        if (mode === 'cancel') throw new TerminalGiftOrder('ORDER001', 'CANCELED');
        return { order: 'ORDER002', reward: 'REWARD002' };
      },
      link: async () => 'https://example.invalid/reward',
    };
    const gifts = new WorkspaceGifts(db, provider, opts);
    const terms = { face: 500, products: ['CARD01'], days: 30 as const, brokerConfirmed: true };
    const occurrence = randomUUID();
    const reserve = (key: string) =>
      db.brand(w, b, async (sql) => {
        await lockWorkspace(sql, w);
        await gifts.reserveOccurrence(sql, w, b, key, 'birthday', person, terms, now);
      });
    await expect(reserve(occurrence)).rejects.toMatchObject({ code: 'gift_ineligible' });
    await db.tenant(w, (sql) =>
      recordWorkspacePayment(sql, w, false, 'pi_plan', new Date(now.getTime() - 2 * 86400000).toISOString()),
    );
    await Promise.all([reserve(occurrence), reserve(occurrence)]);
    const [offer] = await db.read(w, (sql) => all(sql, 'offer'));
    expect(offer).toMatchObject({ face: 500, person });
    expect(await gifts.recipient(w, offer!.id, offer!.secret, true)).toMatchObject({ state: 'pending' });
    const restart = new WorkspaceGifts(db, provider, {
      ...opts,
      fixture: true,
      clock: () => new Date(now.getTime() + 120000),
    });
    mode = 'cancel';
    await restart.tick(w);
    await restart.tick(w);
    expect(await db.read(w, (sql) => one(sql, 'lot', id))).toMatchObject({ spent: 0, reserved: 0 });
    expect(await restart.recipient(w, offer!.id, offer!.secret, true)).toMatchObject({ state: 'canceled' });
    await reserve(randomUUID());
    mode = 'executed';
    const next = (await db.read(w, (sql) => all(sql, 'offer'))).find((o) => o.state === 'offered')!;
    expect(await restart.recipient(w, next.id, next.secret, true)).toMatchObject({ state: 'claimed' });
    expect(await db.read(w, (sql) => one(sql, 'lot', id))).toMatchObject({ spent: 500, reserved: 0 });
  } finally {
    vi.unstubAllEnvs();
  }
});

it('refunds credit released by a verified provider cancellation after workspace closure', async () => {
  const w = 'org_' + randomUUID(),
    b = randomUUID(),
    id = randomUUID(),
    o = randomUUID(),
    at = new Date().toISOString();
  const l: Lot = {
    id,
    brand: b,
    account: 'acct_old',
    face: 1000,
    fee: 100,
    total: 1100,
    state: 'refunded',
    paidAt: at,
    created: at,
    refundFace: 500,
    refundId: 're_first',
    returned: 550,
    reserved: 0,
    spent: 500,
    lost: 0,
    disputed: 0,
    disputes: {},
    charge: 'ch_old',
    payment: 'pi_old',
  };
  await db.tenant(w, async (sql) => {
    await lockWorkspace(sql, w);
    await put(sql, w, 'lot', id, l);
    await put(sql, w, 'closure', 'closed', { at, brand: b });
    await put(sql, w, 'offer', o, {
      id: o,
      campaign: randomUUID(),
      brand: b,
      person: randomUUID(),
      face: 500,
      expires: at,
      state: 'claimed',
      alloc: [{ id, amount: 500 }],
      secret: '00'.repeat(32),
      order: 'ORDER' + o,
      reward: 'REWARD' + o,
      claimedAt: at,
    });
  });
  const inbox = 'system:workspace-gifts:provider-events';
  const eventId = randomUUID();
  await db.tenant(inbox, (sql) =>
    sql.query(
      `INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result)
    VALUES($1,'workspace-gifts:vendor-event',$2,$2,$3)`,
      [inbox, eventId, { kind: 'ORDERS.CANCELED', resource: 'ORDER' + o }],
    ),
  );
  const refund = vi.fn(async (_w: string, _l: Lot, amount: number) => ({ id: 're_second', amount }));
  const service = new WorkspaceGifts(
    db,
    { account: l.account, canceledReceipt: async () => true, refund } as unknown as GiftGateway,
    { live: false, monthlyCap: null, waitMs: null },
  );
  await service.tick(w);
  await service.tick(w);
  expect(refund).toHaveBeenCalledTimes(1);
  expect(refund.mock.calls[0]![2]).toBe(550);
  expect(await db.read(w, (sql) => one(sql, 'lot', id))).toMatchObject({
    spent: 0,
    reserved: 0,
    returned: 1100,
    refundFace: 1000,
  });
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
