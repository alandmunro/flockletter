import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { startRetentionDrill } from '../scripts/retention-drill.js';
import { Database } from '../src/server/db.js';
import { giftRetentionArchive, reconcileGiftServiceEnd } from '../src/server/workspace-gifts/retention.js';
import { WorkspaceGifts } from '../src/server/workspace-gifts/service.js';
import { reserve } from '../src/server/workspace-gifts/ledger.js';
import { all, entry, one, put, type Lot } from '../src/server/workspace-gifts/store.js';
import { fixtureLot } from './helpers/gift-retention.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database;
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});
async function workspace(database = db) {
  const w = 'org_retention_fixture_' + randomUUID().replaceAll('-', ''),
    b = randomUUID();
  await database.tenant(w, async (sql) => {
    await sql.query("INSERT INTO workspaces(workspace_id,name) VALUES($1,'Ledger fixture')", [w]);
    await sql.query("INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,'Example')", [w, b]);
  });
  return { w, b };
}
const now = new Date('2030-01-15T12:00:00Z');
it('closes unclaimed reservations after effective service end, retaining an unknown claim for the gift worker', async () => {
  const { w, b } = await workspace();
  const lot = fixtureLot(b, now);
  await db.tenant(w, async (sql) => {
    await put(sql, w, 'lot', lot.id, lot);
    await entry(sql, w, 'fund:' + lot.id, {
      kind: 'purchased',
      brand: b,
      ref: lot.id,
      at: lot.paidAt!,
      amount: lot.face,
    });
    const people = [1, 2].map((i) => ({ id: randomUUID(), label: 'Synthetic ' + i }));
    await reserve(
      sql,
      w,
      {
        brandId: b,
        operationKey: randomUUID(),
        title: 'Fixture',
        face: 500,
        days: 30,
        products: ['CARD01'],
        personIds: people.map((p) => p.id),
        brokerConfirmed: true,
      },
      people,
      now,
    );
    const pending = (await all(sql, 'offer'))[0]!;
    await put(sql, w, 'offer', pending.id, { ...pending, state: 'pending' });
  });
  const end = {
    source: 'stripe' as const,
    status: 'canceled',
    version: '1',
    effectiveEnd: now.toISOString(),
  };
  await db.tenant(w, async (sql) => {
    expect(await reconcileGiftServiceEnd(sql, w, { ...end, effectiveEnd: '2031-01-01T00:00:00Z' }, now)).toBe(
      false,
    );
    expect(await reconcileGiftServiceEnd(sql, w, { ...end, source: 'complimentary' }, now)).toBe(false);
    await reconcileGiftServiceEnd(sql, w, end, now);
    await reconcileGiftServiceEnd(sql, w, end, now);
    expect((await all(sql, 'offer')).map((o) => o.state).sort()).toEqual(['expired', 'pending']);
    expect((await all(sql, 'entry')).filter((e) => e.kind === 'expired')).toHaveLength(1);
    expect((await one(sql, 'lot', lot.id))?.reserved).toBe(500);
    expect(await one(sql, 'closure', 'closed')).toEqual({ at: end.effectiveEnd, brand: b });
    await expect(giftRetentionArchive(sql, w, now)).rejects.toMatchObject({
      code: 'gift_reconciliation_required',
    });
  });
});

it('blocks unresolved funds, disputes, and incomplete refund evidence across append-only revisions', async () => {
  const { w, b } = await workspace();
  const l = fixtureLot(b, now);
  for (const changes of [
    { state: 'checkout' },
    { state: 'refunding' },
    { reserved: 1 },
    { disputed: 1 },
    { lost: 1 },
    { disputes: { dp: { state: 'under_review', amount: 0, opened: now.toISOString() } } },
    { state: 'refunded', returned: 1100 },
    { state: 'refunded', refundId: 're_fixture', returned: 1000 },
    {},
  ] satisfies Partial<Lot>[]) {
    await db.tenant(w, async (sql) => {
      await put(sql, w, 'lot', l.id, { ...l, ...changes });
      await expect(giftRetentionArchive(sql, w, now)).rejects.toMatchObject({
        code: 'gift_reconciliation_required',
      });
    });
  }
  await db.tenant(w, async (sql) => {
    await put(sql, w, 'lot', l.id, { ...l, state: 'refunded', refundId: 're_fixture', returned: 1100 });
    for (const [kind, amount] of [
      ['purchased', 1000],
      ['refunded', 1100],
    ] as const)
      await entry(sql, w, kind + ':' + l.id, {
        kind,
        amount,
        at: '2024-02-29T23:59:59Z',
        brand: b,
        ref: l.id,
      });
    const archive = await giftRetentionArchive(sql, w, now);
    expect(archive.exception).toMatchObject({ recordCount: 2, retainUntil: '2031-03-01T00:00:00.000Z' });
    expect(archive.rows).toEqual(
      ['purchased', 'refunded'].map((kind) => ({ day: '2024-02-29', kind, face: 1000, fee: 100 })),
    );
    expect((await giftRetentionArchive(sql, w, new Date('2031-03-01T00:00:00Z'))).rows).toEqual([]);
  });
});

it('keeps a restored database isolated if a verified purchase is still unsettled in the matching snapshot', async () => {
  const drill = await startRetentionDrill();
  const runtime = new Database(drill.fixture.url);
  try {
    const { w, b } = await workspace(runtime);
    const lot = fixtureLot(b, now);
    await runtime.tenant(w, (sql) => put(sql, w, 'lot', lot.id, lot));
    await runtime.close();
    await drill.takeSnapshot();
    await drill.sealCheckpoint();
    await expect(drill.reconcileRestore()).rejects.toMatchObject({ code: 'gift_reconciliation_required' });
    const url = new URL(drill.fixture.url);
    url.pathname = '/flockletter_retention_restore';
    const restored = new pg.Client({ connectionString: url.href });
    try {
      await expect(restored.connect()).rejects.toMatchObject({ code: '42501' });
    } finally {
      await restored.end();
    }
  } finally {
    await drill.fixture.stop();
  }
});

it('refuses a snapshot that predates a settled gift transaction on the sealed source', async () => {
  const drill = await startRetentionDrill();
  try {
    const original = new Database(drill.fixture.url);
    const { w, b } = await workspace(original);
    await original.close();
    await drill.takeSnapshot();
    const source = new Database(drill.fixture.url);
    try {
      await source.tenant(w, async (sql) => {
        const l = fixtureLot(b, now, { state: 'refunded', refundId: 're_stale_snapshot', returned: 1100 });
        await put(sql, w, 'lot', l.id, l);
        for (const [kind, amount] of [
          ['purchased', 1000],
          ['refunded', 1100],
        ] as const)
          await entry(sql, w, kind + ':' + l.id, {
            kind,
            amount,
            at: now.toISOString(),
            brand: b,
            ref: l.id,
          });
      });
    } finally {
      await source.close();
    }
    await drill.sealCheckpoint();
    await expect(drill.reconcileRestore()).rejects.toThrow('sealed checkpoint');
    const url = new URL(drill.fixture.url);
    url.pathname = '/flockletter_retention_restore';
    const restored = new pg.Client({ connectionString: url.href });
    try {
      await expect(restored.connect()).rejects.toMatchObject({ code: '42501' });
    } finally {
      await restored.end();
    }
  } finally {
    await drill.fixture.stop();
  }
});

it('refuses a new gift checkout once billing has ended, before the retention worker runs', async () => {
  const { w, b } = await workspace();
  await db.tenant(w, (sql) =>
    sql.query(
      `INSERT INTO customer_subscriptions(workspace_id,id,source,state,plan,
    provider_account,provider_customer,provider_subscription,effective_end_at)
    VALUES($1,$2,'stripe','canceled','starter','acct_fixture','cus_fixture','sub_fixture',$3)`,
      [w, randomUUID(), now],
    ),
  );
  const unexpected = async () => {
    throw Error('Unexpected provider call');
  };
  const gifts = new WorkspaceGifts(
    db,
    {
      account: 'acct_fixture',
      checkout: unexpected,
      payment: unexpected,
      refund: unexpected,
      products: unexpected,
      order: unexpected,
      link: unexpected,
    },
    { live: false, clock: () => now, waitMs: null, monthlyCap: null },
  );
  await expect(
    gifts.execute(
      'gifts.purchase',
      { brandId: b, face: 1000, operationKey: randomUUID() },
      {
        workspaceId: w,
        userId: 'user_fixture',
        actorId: 'user_fixture',
        kind: 'session',
        owner: true,
        brandIds: null,
        scopes: [],
      },
    ),
  ).rejects.toMatchObject({ code: 'gift_closed' });
  expect(await db.read(w, (sql) => all(sql, 'lot'))).toEqual([]);
});

it('recognizes a settled loss and keeps excess credit or a probation review on hold', async () => {
  const { w, b } = await workspace();
  const lot = fixtureLot(b, now, {
    state: 'refunded',
    refundId: 're_settled',
    refundFace: 700,
    returned: 770,
    lost: 300,
    disputes: { dp_fixture: { state: 'lost', amount: 300, opened: now.toISOString() } },
  });
  await db.tenant(w, async (sql) => {
    await put(sql, w, 'lot', lot.id, lot);
    for (const [kind, amount] of [
      ['purchased', 1000],
      ['dispute_lost', 300],
      ['refunded', 770],
    ] as const)
      await entry(sql, w, kind + ':' + lot.id, {
        kind,
        amount,
        brand: b,
        at: now.toISOString(),
        ref: lot.id,
      });
    const result = await giftRetentionArchive(sql, w, now);
    expect(result.rows.find((r) => r.kind === 'refunded')).toMatchObject({ face: 700, fee: 70 });
    await put(sql, w, 'signal', 'probation_loss', {
      kind: 'review_required',
      at: now.toISOString(),
      ref: lot.id,
    });
    await expect(giftRetentionArchive(sql, w, now)).rejects.toMatchObject({
      code: 'gift_reconciliation_required',
    });
  });
});
