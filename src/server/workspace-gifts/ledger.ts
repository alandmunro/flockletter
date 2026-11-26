import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import { all, available, entry, one, put, type GiftCampaign, type GiftOffer, type Lot } from './store.js';
export type LaunchTerms = {
  brandId: string;
  operationKey: string;
  title: string;
  face: number;
  days: number;
  products: string[];
  personIds: string[];
  brokerConfirmed: boolean;
};
export type GiftPerson = { id: string; email?: string; phone?: string; label: string };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export function inputHash(t: LaunchTerms) {
  return sha(
    JSON.stringify([
      t.brandId,
      t.title,
      t.face,
      t.days,
      [...t.products].sort(),
      [...new Set(t.personIds)].sort(),
      t.brokerConfirmed,
    ]),
  );
}
export async function reserve(sql: Sql, w: string, t: LaunchTerms, people: GiftPerson[], now = new Date(), provenance?: {live:boolean; account:string}) {
  const prior = await one(sql, 'campaign', t.operationKey);
  if (prior) {
    requireCondition(
      prior.hash === inputHash(t),
      409,
      'gift_terms_changed',
      'The original gift terms differ.',
    );
    return prior;
  }
  requireCondition(
    !(await one(sql, 'closure', 'closed')),
    409,
    'gift_closed',
    'Workspace gifting is closed.',
  );
  requireCondition(people.length > 0, 422, 'gift_audience_empty', 'Choose at least one eligible recipient.');
  requireCondition(
    new Set(people.map((p) => p.id)).size === people.length,
    409,
    'gift_person_duplicate',
    'The audience contains unresolved duplicates.',
  );
  const lots = (await all(sql, 'lot')).filter(l=>!provenance || (l.account===provenance.account &&
    (provenance.live ? l.live===true : l.live!==true)));
  const cost = people.length * t.face;
  requireCondition(
    lots.reduce((n, l) => n + available(l), 0) >= cost,
    409,
    'gift_credit_shortfall',
    'Add enough gift credit to cover every recipient.',
  );
  const at = now.toISOString(),
    expires = new Date(now.getTime() + t.days * 86400000).toISOString();
  const campaign: GiftCampaign = {
    ...provenance,
    id: t.operationKey,
    brand: t.brandId,
    title: t.title,
    products: t.products,
    face: t.face,
    days: t.days,
    created: at,
    expires,
    hash: inputHash(t),
    brokerConfirmed: t.brokerConfirmed,
  };
  await put(sql, w, 'campaign', campaign.id, campaign);
  for (const person of people) {
    const alloc: GiftOffer['alloc'] = [];
    let remaining = t.face;
    for (const l of lots) {
      const amount = Math.min(remaining, Math.max(0, available(l)));
      if (!amount) continue;
      l.reserved += amount;
      alloc.push({ id: l.id, amount });
      remaining -= amount;
      if (!remaining) break;
    }
    requireCondition(!remaining, 409, 'gift_credit_shortfall', 'The full offer could not be reserved.');
    const offer: GiftOffer = {
      id: randomUUID(),
      brand: t.brandId,
      campaign: campaign.id,
      person: person.id,
      face: t.face,
      expires,
      state: 'offered',
      alloc,
      secret: randomBytes(32).toString('hex'),
    };
    await put(sql, w, 'offer', offer.id, offer);
  }
  for (const l of lots.filter((l) => l.state === 'funded')) await put(sql, w, 'lot', l.id, l);
  await entry(sql, w, 'reserve:' + campaign.id, {
    kind: 'reserved',
    amount: cost,
    at,
    brand: t.brandId,
    ref: campaign.id,
  });
  return campaign;
}
export function offerPath(workspace: string, o: GiftOffer) {
  return '/workspace-gift.html#' + new URLSearchParams({ workspace, offer: o.id, token: o.secret });
}
export async function reservedGiftLink(sql: Sql, w: string, brand: string, campaign: string, person: string) {
  const o = (await all(sql, 'offer')).find(
    (o) => o.brand === brand && o.campaign === campaign && o.person === person,
  );
  return o && o.state === 'offered' && Date.parse(o.expires) > Date.now() ? offerPath(w, o) : null;
}
export async function authenticateOffer(sql: Sql, id: string, token: string) {
  const o = await one(sql, 'offer', id);
  requireCondition(
    o &&
      /^[a-f0-9]{64}$/.test(token) &&
      timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(o.secret, 'hex')),
    404,
    'gift_unavailable',
    'This gift link is unavailable.',
  );
  return o;
}
export async function transition(
  sql: Sql,
  w: string,
  o: GiftOffer,
  kind: 'claimed' | 'expired' | 'canceled',
  now: Date,
  receipt?: { order: string; reward: string },
) {
  if (o.state === kind) return;
  requireCondition(
    kind === 'claimed' ? o.state === 'pending' && receipt : kind === 'canceled' ? o.state === 'pending' : o.state === 'offered',
    409,
    'gift_transition',
    'This offer requires reconciliation.',
  );
  for (const a of o.alloc) {
    const l = await one(sql, 'lot', a.id);
    requireCondition(
      l && l.reserved >= a.amount,
      409,
      'gift_reservation_mismatch',
      'The reserved credit needs operator review.',
    );
    l.reserved -= a.amount;
    if (kind === 'claimed') l.spent += a.amount;
    await put(sql, w, 'lot', l.id, l);
  }
  o.state = kind;
  if (receipt) {
    o.order = receipt.order;
    o.reward = receipt.reward;
    o.claimedAt = now.toISOString();
  }
  delete o.reason;
  delete o.retryAt;
  await put(sql, w, 'offer', o.id, o);
  await entry(sql, w, kind + ':' + o.id, {
    kind,
    amount: o.face,
    at: now.toISOString(),
    ref: o.id,
    brand: o.brand,
  });
}
export async function fund(
  sql: Sql,
  w: string,
  lot: Lot,
  payment: { payment: string; charge: string; paidAt: string; refunds?:{settled:number;held:number} },
) {
  if (lot.state !== 'checkout') {
    requireCondition(
      lot.payment === payment.payment && lot.charge === payment.charge,
      409,
      'gift_payment_conflict',
      'This purchase already has a different receipt.',
    );
    return;
  }
  lot.state = 'funded';
  lot.payment=payment.payment; lot.charge=payment.charge; lot.paidAt=payment.paidAt;
  if(payment.refunds){
    const {settled,held}=payment.refunds;
    lot.externalRefundGross=settled; lot.externalRefundHeld=held;
    lot.externalRefundFace=Math.round((settled+held)*lot.face/lot.total);
    if(settled)await entry(sql,w,'initial-refund:'+lot.id,{kind:'external_refund',amount:settled,ref:lot.id,brand:lot.brand,at:payment.paidAt});
  }
  await put(sql, w, 'lot', lot.id, lot);
  await entry(sql, w, 'fund:' + lot.id, {
    kind: 'purchased',
    amount: lot.face,
    brand: lot.brand,
    at: payment.paidAt,
    ref: lot.id,
  });
}
