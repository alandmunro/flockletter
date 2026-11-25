// Version 1 of the hosted capture. Persisted event identities and their replay order are stable.
import { createHash } from 'node:crypto';
import { GiftLab } from './lab.mjs';
import { catalog, contacts } from './fixtures.mjs';
import { purchase, exampleCampaign } from './scenario.mjs';

export function openCapture(workspace, history) {
  let identity = 0;
  const purchaseId = history.find((e) => e.kind === 'stripePaid')?.payment;
  const lab = new GiftLab(':memory:', () =>
    createHash('sha256')
      .update(
        JSON.stringify([
          ...(purchaseId ? ['gift-sandbox-v1', purchaseId] : ['gift-capture-v1']),
          workspace,
          ++identity,
        ]),
      )
      .digest('hex'),
  );
  const name = 'Studio';
  function apply(event) {
    switch (event.kind) {
      case 'stripePaid':
        return lab.atomic(() =>
          lab.paymentFact({
            kind: 'paid',
            workspace: name,
            currency: 'USD',
            lot: event.payment,
            face: 50000,
            total: event.total,
          }),
        );
      case 'sandboxReserve':
        return lab.launch(
          name,
          { label: 'Appreciation', rows: contacts(100), face: 500, days: 30, products: event.products },
          event.products,
        );
      case 'tremendousOrder': {
        const offer = lab.offer(name, event.offer);
        if (offer.person !== event.person || offer.state !== 'pending')
          throw Error('Order has no matching pending offer.');
        return lab.atomic(() => {
          lab.run(
            'INSERT INTO vendor_order VALUES(?,?,?,?,?)',
            offer.id,
            event.reward,
            offer.face,
            offer.products,
            'approved',
          );
          lab.settle(name, offer.id);
        });
      }
      case 'sandboxExpire':
        return lab.tick(30, false);
      case 'prepareRefund':
        return lab.closure(name);
      case 'stripeRefund':
        return lab.atomic(() =>
          lab.paymentFact({
            kind: 'refunded',
            workspace: name,
            currency: 'USD',
            lot: event.payment,
            total: event.total,
          }),
        );
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
    const offers = lab.all('SELECT id,person,state,issue FROM offer ORDER BY person');
    const [lot] = lab.lots(name);
    const { available, reserved } = lab.balances(name);
    return {
      currency: 'USD',
      products: JSON.parse(lab.one('SELECT products FROM campaign')?.products ?? '[]'),
      dispute: lot?.dispute ?? 'none',
      access: lab.access(name),
      funded: Boolean(lot),
      refundDue: lot?.refund_face ? lot.refund_face + lot.refund_fee : 0,
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
