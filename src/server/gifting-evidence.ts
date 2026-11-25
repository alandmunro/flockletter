import assert from 'node:assert/strict';
import { giftLink, giftStatus, recipientGift, recordGift } from './gifting.js';
import { lockWorkspace } from './workspace-lock.js';
import type { GiftEvent } from '../shared/gifting.js';
import type { Database } from './db.js';

// Fixed internal fixture identities cannot be issued as Clerk organizations. Reuse this bounded
// journal across boots; simultaneous deployments serialize the same intents. Publish aggregates only.
export async function verifyStagingGifts(db: Database) {
  const workspace = 'fixture:gifting:v1:studio',
    other = 'fixture:gifting:v1:orchard';
  const write = (event: GiftEvent) =>
    db.tenant(workspace, async (sql) => {
      await lockWorkspace(sql, workspace);
      return recordGift(sql, workspace, event);
    });
  await write({ kind: 'fund' });
  await write({ kind: 'reserve', days: 30, products: 5 });
  await write({ kind: 'timeout' });
  for (const person of [1, 2, 3, 4, 5]) {
    const link = await db.read(workspace, (sql) => giftLink(sql, workspace, person));
    const token = new URLSearchParams(link.path.split('#')[1]).get('token')!;
    await recipientGift(db, workspace, person, token, false);
    await Promise.all([
      recipientGift(db, workspace, person, token, true),
      recipientGift(db, workspace, person, token, true),
    ]);
  }
  await write({ kind: 'recover' });
  await write({ kind: 'expire' });
  await write({ kind: 'refund' });
  const final = await db.read(workspace, (sql) => giftStatus(sql, workspace));
  const isolated = await db.read(other, (sql) => giftStatus(sql, other));
  const result = {
    currency: final.currency,
    claimed: final.offers.filter((o) => o.state === 'claimed').length,
    expired: final.offers.filter((o) => o.state === 'expired').length,
    orders: final.orders,
    spent: final.spent,
    refunded: final.refunded,
    available: final.available,
    reserved: final.reserved,
    otherOffers: isolated.offers.length,
  };
  assert.deepEqual(result, {
    currency: 'USD',
    claimed: 5,
    expired: 95,
    orders: 5,
    spent: 2500,
    refunded: 52250,
    available: 0,
    reserved: 0,
    otherOffers: 0,
  });
  return result;
}
