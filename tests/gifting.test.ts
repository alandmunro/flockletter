import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/server/db.js';
import { startDatabase } from '../scripts/database-fixture.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { recipientGift } from '../src/server/gifting.js';
import { verifyStagingGifts } from '../src/server/gifting-evidence.js';
import type { GiftAction, GiftStatus } from '../src/shared/gifting.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database, service: CommandService;
const owner: Actor = {
  kind: 'session',
  workspaceId: 'org_gift_a',
  actorId: 'user:gift_a',
  userId: 'gift_a',
  owner: true,
  scopes: [],
  brandIds: null,
};
const other = { ...owner, workspaceId: 'org_gift_b' };
const build = (environment: 'test' | 'production') =>
  new CommandService(
    db,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    environment,
  );
const act = (action: GiftAction, operationKey = randomUUID()) =>
  service.execute('gifting.captureAction', { action, operationKey }, owner);
const status = (actor = owner) =>
  service.execute('gifting.captureStatus', {}, actor) as Promise<GiftStatus>;
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  service = build('test');
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});

it('keeps all capture commands behind owner authority and the server environment', async () => {
  await expect(build('production').execute('gifting.captureStatus', {}, owner)).rejects.toMatchObject({
    code: 'gift_capture_disabled',
  });
  for (const actor of [
    { ...owner, owner: false },
    { ...owner, kind: 'connection' as const },
  ]) {
    await expect(status(actor)).rejects.toMatchObject({ code: 'owner_required' });
  }
});
it('persists across service instances and serializes payment, reservation, claim and recovery', async () => {
  const key = randomUUID();
  await expect(act({ kind: 'reserve', days: 15, products: 1 })).rejects.toMatchObject({
    code: 'gift_action_unavailable',
  });
  await Promise.all([act({ kind: 'fund' }, key), act({ kind: 'fund' }, key), act({ kind: 'fund' })]);
  expect(await status()).toMatchObject({ available: 50000, reserved: 0 });
  await act({ kind: 'reserve', days: 15, products: 6 });
  await expect(act({ kind: 'reserve', days: 30, products: 1 })).rejects.toMatchObject({
    code: 'gift_terms_changed',
  });
  expect(await status()).toMatchObject({ available: 0, reserved: 50000 });
  const { path } = (await service.execute('gifting.captureLink', { person: 1 }, owner)) as {
    path: string;
  };
  const token = new URLSearchParams(path.split('#')[1]).get('token')!;
  await expect(recipientGift(db, other.workspaceId, 1, token, true)).rejects.toMatchObject({
    code: 'gift_unavailable',
  });
  await expect(recipientGift(db, owner.workspaceId, 2, token, true)).rejects.toMatchObject({
    code: 'gift_unavailable',
  });
  const open = (claim: boolean) => recipientGift(db, owner.workspaceId, 1, token, claim);
  expect(await open(false)).toMatchObject({ state: 'offered' });
  expect((await status()).orders).toBe(0);
  await act({ kind: 'timeout' });
  await Promise.all([open(true), open(true)]);
  expect(await status()).toMatchObject({ orders: 1, spent: 0, reserved: 50000 });
  service = build('test');
  await act({ kind: 'recover' });
  await act({ kind: 'expire' });
  expect(await status()).toMatchObject({ orders: 1, spent: 500, available: 49500, reserved: 0 });
  await act({ kind: 'refund' });
  expect(await status()).toMatchObject({ closed: true, refunded: 54450, reserved: 0, available: 0 });
  expect(await open(true)).toMatchObject({ state: 'claimed' });
  expect(await status(other)).toMatchObject({ funded: false, offers: [] });
});
it('runs the staging acceptance proof twice against PostgreSQL and recovers the same results', async () => {
  const first = await verifyStagingGifts(db);
  expect(first).toMatchObject({ claimed: 5, orders: 5, expired: 95, spent: 2500, refunded: 52250 });
  expect(await verifyStagingGifts(db)).toEqual(first);
});
