import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { sandboxGiftWorkspace as workspace, type GiftEvent } from '../shared/gifting.js';
import { giftStatus, giftLink, recordGift, recipientGift } from './gifting.js';
import { GiftProviderError, type StagingGiftProviders } from './gifting-providers.js';
import type { Database } from './db.js';
import { lockWorkspace } from './workspace-lock.js';

export type SandboxResult = {
  payment: number;
  credit: number;
  reservedAtLaunch: number;
  claimed: number;
  orders: number;
  expired: number;
  spent: number;
  released: number;
  refund: number;
  available: number;
  reserved: number;
  verifiedAt: string;
};
const actor = 'gifting:sandbox:v1';
// These receipts contain only operation bindings, provider object references and aggregate evidence.
function receipts(db: Database) {
  async function get<T>(key: string) {
    return db.read(
      workspace,
      async (sql) =>
        (
          await sql.query<{ result: T; created_at: Date }>(
            'SELECT result,created_at FROM operations WHERE actor_id=$1 AND operation_key=$2',
            [actor, key],
          )
        ).rows[0],
    );
  }
  async function save<T>(key: string, value: T) {
    return db.tenant(workspace, async (sql) => {
      await lockWorkspace(sql, workspace);
      await sql.query(
        'INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$3,$4) ON CONFLICT DO NOTHING',
        [workspace, actor, key, JSON.stringify(value)],
      );
      return (
        await sql.query<{ result: T; created_at: Date }>(
          'SELECT result,created_at FROM operations WHERE actor_id=$1 AND operation_key=$2',
          [actor, key],
        )
      ).rows[0]!;
    });
  }
  return { get, save };
}
const fresh = (date: Date) => Date.now() - date.getTime() < 23 * 60 * 60 * 1000;
export function sandboxRun(db: Database, providers: StagingGiftProviders) {
  const receipt = receipts(db);
  const status = () => db.read(workspace, (sql) => giftStatus(sql, workspace));
  const write = (event: GiftEvent) =>
    db.tenant(workspace, async (sql) => {
      await lockWorkspace(sql, workspace);
      await recordGift(sql, workspace, event);
    });
  async function submit(person: number) {
    if (person < 1 || person > 5) throw new GiftProviderError('recipient_outside_sandbox_run');
    const before = await status(),
      offer = before.offers.find((o) => o.person === person);
    if (!offer || offer.state !== 'pending') return;
    // The recipient's intent has already committed. Recovery looks up the same external_id.
    const verified = await providers.order(offer.id, person, before.products);
    await write({ kind: 'tremendousOrder', person, offer: offer.id, ...verified });
  }
  async function link(person: number) {
    const order = await db.read(
      workspace,
      async (sql) =>
        (
          await sql.query<{ reward: string }>(
            "SELECT result->'event'->>'reward' reward FROM operations WHERE actor_id=$1 AND operation_key=$2",
            ['gifting:capture:v1', 'tremendousOrder-' + person],
          )
        ).rows[0],
    );
    if (!order?.reward) throw new GiftProviderError('tremendous_order_pending');
    return { path: await providers.rewardLink(order.reward) };
  }
  async function verify(progress: (phase: string) => void) {
    const completed = await receipt.get<SandboxResult>('complete');
    if (completed) return completed.result;
    await providers.checkAccount();
    const run = await receipt.save('purchase-intent', { id: randomUUID(), account: providers.account });
    if (run.result.account !== providers.account) throw new GiftProviderError('stripe_account_mismatch');
    const chosen =
      (await receipt.get<string[]>('catalog')) ??
      (await receipt.save('catalog', await providers.products()));
    const prior = await receipt.get<string>('payment');
    const id = await providers.payment(run.result.id, prior?.result, fresh(run.created_at));
    assert.equal((await receipt.save('payment', id)).result, id);
    const payment = await providers.confirm(run.result.id, id);
    await write({ kind: 'stripePaid', payment: id, total: payment });
    progress('Payment verified');
    await write({ kind: 'sandboxReserve', products: chosen.result });
    // Launch values can be recovered from the immutable terms even after subsequent consumption.
    const reservedAtLaunch = (await status()).offers.length * 500;
    assert.equal(reservedAtLaunch, 50000);
    for (const person of [1, 2, 3, 4, 5]) {
      const issued = await db.read(workspace, (sql) => giftLink(sql, workspace, person));
      const token = new URLSearchParams(issued.path.split('#')[1]).get('token')!;
      await recipientGift(db, workspace, person, token, false);
      const claimed = await recipientGift(db, workspace, person, token, true, submit);
      assert.equal(claimed.state, 'claimed');
    }
    await link(1); // Obtain a provider-hosted link without logging, storing or redeeming it.
    progress('Gift orders verified');
    await write({ kind: 'sandboxExpire' });
    const expired = (await status()).offers.filter((o) => o.state === 'expired').length;
    assert.equal(expired, 95);
    progress('Offers expired');
    await write({ kind: 'prepareRefund' });
    const beforeRefund = await status(),
      released = expired * 500;
    assert.equal(beforeRefund.refundDue, 52250);
    const intent = await receipt.save('refund-intent', { payment: id, amount: beforeRefund.refundDue });
    assert.deepEqual(intent.result, { payment: id, amount: 52250 });
    const refund = await providers.refund(
      run.result.id,
      id,
      intent.result.amount,
      fresh(intent.created_at),
    );
    await write({ kind: 'stripeRefund', payment: id, refund: refund.id, total: refund.total });
    const final = await status();
    assert.deepEqual(
      [final.spent, final.orders, final.refunded, final.available, final.reserved],
      [2500, 5, 52250, 0, 0],
    );
    const claimed = final.offers.filter((o) => o.state === 'claimed').length;
    assert.equal(claimed, 5);
    progress('Refund verified');
    return (
      await receipt.save<SandboxResult>('complete', {
        payment,
        credit: 50000,
        reservedAtLaunch,
        claimed,
        orders: final.orders,
        expired,
        spent: final.spent,
        released,
        refund: final.refunded,
        available: final.available,
        reserved: final.reserved,
        verifiedAt: new Date().toISOString(),
      })
    ).result;
  }
  return { submit, link, verify };
}
