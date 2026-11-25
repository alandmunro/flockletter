// Version 1 of the hosted capture. Persisted event identities and their replay order are stable.
import { createHash } from 'node:crypto';
import { GiftLab } from './lab.mjs';
import { catalog } from './fixtures.mjs';
import { purchase, exampleCampaign } from './scenario.mjs';

export function openCapture(workspace, history) {
  let identity = 0;
  const lab = new GiftLab(':memory:', () =>
    createHash('sha256')
      .update(JSON.stringify(['gift-capture-v1', workspace, ++identity]))
      .digest('hex'),
  );
  const name = 'Studio';
  function apply(event) {
    switch (event.kind) {
      case 'fund':
        return purchase(lab, name, 'capture', 50000);
      case 'reserve':
        return exampleCampaign(lab, name, 100, event.days, catalog.slice(0, event.products));
      case 'intent':
      case 'submit': {
        const offer = lab.offers(name).find((o) => o.person === event.person);
        if (!offer) throw Error('This recipient has no gift offer.');
        if (event.kind === 'intent') return lab.beginClaim(name, offer.id);
        return lab.reconcile(name, offer.id);
      }
      case 'timeout':
        return lab.run("UPDATE platform SET fault='timeout'");
      case 'recover':
        lab.run("UPDATE platform SET fault='healthy'");
        return lab.tick(0);
      case 'expire': {
        const [first] = lab.offers(name);
        if (!first) throw Error('Reserve offers before advancing the clock.');
        return lab.tick(Math.max(0, first.expires - lab.day()));
      }
      case 'disputeOpen':
      case 'disputeWon':
      case 'disputeLost': {
        const kind = { disputeOpen: 'open', disputeWon: 'won', disputeLost: 'lost' }[event.kind];
        return lab.emit('stripe', {
          id: 'dispute-' + kind,
          workspace: name,
          lot: 'capture',
          kind,
          currency: 'USD',
          total: 55000,
        });
      }
      case 'refund': {
        if (
          !lab.offers(name).length ||
          lab.offers(name).some((o) => ['pending', 'offered'].includes(o.state))
        )
          throw Error('Resolve or expire the outstanding offers before refunding.');
        const [refund] = lab.closure(name);
        if (refund)
          lab.emit('stripe', {
            id: 'refund-capture',
            workspace: name,
            kind: 'refunded',
            currency: 'USD',
            lot: refund.lot,
            total: refund.total,
          });
        return;
      }
      default:
        throw Error('Unknown capture event version.');
    }
  }
  function status() {
    const offers = lab.all('SELECT person,state,issue FROM offer ORDER BY person');
    const [lot] = lab.lots(name);
    const { available, reserved } = lab.balances(name);
    return {
      currency: 'USD',
      products: JSON.parse(lab.one('SELECT products FROM campaign')?.products ?? '[]'),
      dispute: lot?.dispute ?? 'none',
      access: lab.access(name),
      funded: Boolean(lot),
      available,
      reserved,
      spent: offers.filter((o) => o.state === 'claimed').length * 500,
      refunded: lot?.refunded ? lot.refund_face + lot.refund_fee : 0,
      offers,
      days: lab.offers(name)[0]?.expires ?? 0,
      day: lab.day(),
      timeout: lab.one('SELECT fault FROM platform').fault === 'timeout',
      closed: Boolean(lab.workspace(name).closing),
      orders: lab.one('SELECT count(*) n FROM vendor_order').n,
    };
  }
  try {
    for (const event of history) apply(event);
    return { apply, status, close: () => lab.db.close() };
  } catch (err) {
    lab.db.close();
    throw err;
  }
}
