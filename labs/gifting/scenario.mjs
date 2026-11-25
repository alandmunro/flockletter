import assert from 'node:assert/strict';
import { GiftLab } from './lab.mjs';
import { catalog, contacts } from './fixtures.mjs';

export function purchase(lab, workspace, lot, face) {
  lab.emit('stripe', {
    id: 'paid-' + lot,
    workspace,
    lot,
    kind: 'paid',
    face,
    total: face + Math.round(face / 10),
    currency: 'USD',
  });
}
export function exampleCampaign(lab, workspace, count = 100, days = 30, products = catalog.slice(0, 5)) {
  return lab.launch(workspace, { label: 'Appreciation', rows: contacts(count), face: 500, days, products });
}
export function runExample() {
  const lab = new GiftLab();
  try {
    const name = 'Studio';
    purchase(lab, name, 'example', 50000);
    const paid = lab.balances(name);
    exampleCampaign(lab, name);
    const reserved = lab.balances(name);
    for (const o of lab.offers(name).slice(0, 5)) lab.claim(name, o.id);
    lab.tick(30);
    const offers = lab.offers(name);
    const final = lab.balances(name);
    const [refund] = lab.closure(name);
    lab.emit('stripe', {
      id: 'refund-example',
      kind: 'refunded',
      workspace: name,
      lot: 'example',
      currency: 'USD',
      total: refund.total,
    });
    const report = {
      currency: 'USD',
      unit: 'cents',
      payment: 55000,
      paid,
      reserved,
      claimed: offers.filter((o) => o.state === 'claimed').length,
      expired: offers.filter((o) => o.state === 'expired').length,
      consumed: lab.one("SELECT -sum(reserved) n FROM ledger WHERE kind='claim'").n,
      beforeRefund: final,
      refund,
      afterRefund: lab.balances(name),
    };
    assert.deepEqual(
      [
        report.claimed,
        report.expired,
        report.consumed,
        final.available,
        final.reserved,
        refund.total,
        report.afterRefund.total,
      ],
      [5, 95, 2500, 47500, 0, 52250, 0],
    );
    return report;
  } finally {
    lab.db.close();
  }
}
