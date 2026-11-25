import type { ServiceEnd } from '../../shared/customer-retention.js';
import { requireRetention, retentionDigest } from '../customer-retention/approval.js';
import type { RetentionException } from '../customer-retention/hosted-types.js';
import type { Sql } from '../db.js';
import { transition } from './ledger.js';
import { actorFor, all, one, put, type Entry, type Lot } from './store.js';

const hold = 'gift_reconciliation_required';
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
const disputeStates = [
  'warning_needs_response',
  'warning_under_review',
  'warning_closed',
  'needs_response',
  'under_review',
  'won',
  'lost',
  'prevented',
];
const eventKinds = new Set([
  'purchased',
  'reserved',
  'claimed',
  'expired',
  'refunded',
  ...disputeStates.map((state) => 'dispute_' + state),
]);
type AccountingRow = { day: string; kind: string; face: number; fee: number };
type GiftArchive = { rows: AccountingRow[]; exception: RetentionException | null };

async function checkScope(sql: Sql, workspace: string) {
  const ok = (await sql.query("SELECT current_setting('app.workspace_id',true)=$1 AS ok", [workspace]))
    .rows[0]?.ok;
  requireRetention(ok, 'gift_retention_scope');
}

export function giftServiceEnded(fact: ServiceEnd, now: Date) {
  return (
    fact.source !== 'complimentary' &&
    ['canceled', 'cancelled', 'closed'].includes(fact.status) &&
    !!fact.effectiveEnd &&
    Date.parse(fact.effectiveEnd) <= now.getTime()
  );
}

/** Caller holds the workspace lock. The gift worker owns provider lookup and refund settlement. */
export async function reconcileGiftServiceEnd(sql: Sql, workspace: string, fact: ServiceEnd, now: Date) {
  if (!giftServiceEnded(fact, now)) return false;
  await checkScope(sql, workspace);
  const lots = await all(sql, 'lot');
  if (!lots.length) return true;
  if (!(await one(sql, 'closure', 'closed')))
    await put(sql, workspace, 'closure', 'closed', { brand: lots[0]!.brand, at: fact.effectiveEnd! });
  for (const offer of await all(sql, 'offer')) {
    if (offer.state === 'offered') await transition(sql, workspace, offer, 'expired', now);
  }
  return true;
}

function checkLot(lot: Lot) {
  requireRetention(
    [lot.face, lot.fee, lot.total, lot.spent, lot.reserved, lot.returned, lot.disputed, lot.lost].every(
      integer,
    ) &&
      lot.face > 0 &&
      lot.face + lot.fee === lot.total &&
      lot.spent <= lot.face,
    hold,
  );
  requireRetention(lot.reserved === 0 && lot.disputed === 0 && lot.disputes, hold);
  const disputes = Object.values(lot.disputes);
  requireRetention(
    disputes.every((d) => integer(d.amount) && ['won', 'lost', 'warning_closed'].includes(d.state)),
    hold,
  );
  const loss = Math.min(
    lot.face,
    disputes.reduce((sum, d) => sum + (d.state === 'lost' ? d.amount : 0), 0),
  );
  requireRetention(lot.lost === loss, hold);
  if (lot.state === 'expired') {
    requireRetention(
      lot.session &&
        !lot.paidAt &&
        !lot.payment &&
        !lot.charge &&
        !lot.spent &&
        !lot.returned &&
        !disputes.length,
      hold,
    );
    return;
  }
  requireRetention(lot.paidAt && Number.isFinite(Date.parse(lot.paidAt)) && lot.payment && lot.charge, hold);
  if (lot.state === 'funded')
    requireRetention(lot.returned === 0 && !lot.refundId && !lot.refundStarted, hold);
  else {
    const face = lot.refundFace ?? lot.face - lot.spent;
    requireRetention(
      lot.state === 'refunded' &&
        lot.refundId &&
        integer(face) &&
        face > 0 &&
        face <= lot.face - lot.spent &&
        lot.returned === face + Math.round((lot.fee * face) / lot.face),
      hold,
    );
  }
}

// Keep the full UTC accounting day. PostgreSQL clamps February 29 to February 28
// when the seventh anniversary is in a common year, then expires the following day.
function expiry(day: string) {
  const d = new Date(day),
    year = d.getUTCFullYear() + 7,
    month = d.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay) + 1)).toISOString();
}

export async function giftRetentionArchive(sql: Sql, workspace: string, now: Date): Promise<GiftArchive> {
  await checkScope(sql, workspace);
  const lots = await all(sql, 'lot'),
    offers = await all(sql, 'offer'),
    entries = await all(sql, 'entry');
  const unknown = await sql.query(
    `SELECT FROM operations WHERE workspace_id=$1 AND actor_id ~ '^workspace-gifts:v[0-9]+:'
    AND actor_id <> ALL($2::text[]) LIMIT 1`,
    [
      workspace,
      (
        [
          'lot',
          'offer',
          'campaign',
          'closure',
          'signal',
          'entry',
          'evidence',
          'event',
          'notice',
          'noticePrefs',
          'lowEpisode',
        ] as const
      ).map(actorFor),
    ],
  );
  requireRetention(
    !unknown.rowCount && (await one(sql, 'signal', 'probation_loss'))?.kind !== 'review_required',
    hold,
  );
  const byLot = new Map(lots.map((l) => [l.id, l]));
  const byOffer = new Map(offers.map((o) => [o.id, o]));
  const tx = new Map<string, Entry>();
  const lossEntries = new Map<string, number>();
  for (const e of entries) {
    requireRetention(eventKinds.has(e.kind) && integer(e.amount) && Number.isFinite(Date.parse(e.at)), hold);
    if (e.kind === 'dispute_lost') lossEntries.set(e.ref, (lossEntries.get(e.ref) ?? 0) + e.amount);
    if (!e.kind.startsWith('dispute_')) {
      const key = e.kind + '/' + e.ref;
      requireRetention(!tx.has(key), hold);
      tx.set(key, e);
    }
  }
  function hasEntry(kind: string, ref: string, brand: string, amount: number) {
    const e = tx.get(kind + '/' + ref);
    return e?.brand === brand && e.amount === amount;
  }
  const consumed = new Map<string, number>(),
    reserved = new Map<string, number>();
  for (const o of offers) {
    requireRetention(
      (o.state === 'expired' || (o.state === 'claimed' && o.order && o.reward)) &&
        integer(o.face) &&
        o.face > 0 &&
        hasEntry(o.state, o.id, o.brand, o.face),
      hold,
    );
    let allocated = 0;
    for (const a of o.alloc) {
      requireRetention(byLot.has(a.id) && integer(a.amount) && a.amount > 0, hold);
      allocated += a.amount;
      if (o.state === 'claimed') consumed.set(a.id, (consumed.get(a.id) ?? 0) + a.amount);
    }
    requireRetention(allocated === o.face, hold);
    reserved.set(o.campaign, (reserved.get(o.campaign) ?? 0) + o.face);
    requireRetention(tx.get('reserved/' + o.campaign)?.brand === o.brand, hold);
  }
  let outstanding = 0;
  for (const l of lots) {
    checkLot(l);
    requireRetention(Math.min(l.face, lossEntries.get(l.id) ?? 0) === l.lost, hold);
    if (l.state !== 'expired') {
      const refundedFace = l.state === 'refunded' ? (l.refundFace ?? l.face - l.spent) : 0;
      outstanding += l.face - l.spent - l.lost - refundedFace;
    }
    requireRetention(l.spent === (consumed.get(l.id) ?? 0), hold);
    if (l.state !== 'expired') requireRetention(hasEntry('purchased', l.id, l.brand, l.face), hold);
    if (l.state === 'refunded') requireRetention(hasEntry('refunded', l.id, l.brand, l.returned), hold);
  }

  // A settled loss can consume credit from another lot. Only the verified funded,
  // claimed, lost and refunded principal across the entire workspace may net to zero.
  requireRetention(outstanding === 0, hold);

  const rows: AccountingRow[] = [];
  let retainUntil = '';
  for (const e of entries) {
    const lot = byLot.get(e.ref);
    let face = e.amount,
      fee = 0;
    if (e.kind === 'purchased') {
      requireRetention(lot && lot.state !== 'expired' && lot.brand === e.brand, hold);
      fee = lot.fee;
    } else if (e.kind === 'refunded') {
      requireRetention(lot?.state === 'refunded' && lot.brand === e.brand, hold);
      face = lot.refundFace ?? lot.face - lot.spent;
      fee = e.amount - face;
    } else if (e.kind === 'reserved') requireRetention(reserved.get(e.ref) === e.amount, hold);
    else if (e.kind === 'claimed' || e.kind === 'expired')
      requireRetention(byOffer.get(e.ref)?.state === e.kind, hold);
    else requireRetention(lot && lot.brand === e.brand, hold);
    const day = new Date(e.at).toISOString().slice(0, 10),
      until = expiry(day);
    if (Date.parse(until) <= now.getTime()) continue;
    rows.push({ day, kind: e.kind, face, fee });
    if (until > retainUntil) retainUntil = until;
  }
  rows.sort(
    (a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind) || a.face - b.face || a.fee - b.fee,
  );
  const exception: RetentionException | null = rows.length
    ? {
        store: 'gift_accounting',
        policyId: 'RET-3',
        policyVersion: 'gift-accounting-utc-day-v1',
        policyMode: 'bounded',
        retainUntil,
        recordCount: rows.length,
        digest: retentionDigest(rows),
      }
    : null;
  return { rows, exception };
}

/** Run after acquiring table locks, in the very transaction that deletes the source journal. */
export async function archiveGiftsForErasure(sql: Sql, workspace: string, now: Date) {
  const { rows } = await giftRetentionArchive(sql, workspace, now);
  if (rows.length) {
    await sql.query(
      `INSERT INTO flockletter_retention_control.gift_accounting(event_day,kind,face_minor,fee_minor,currency)
      SELECT day,kind,face,fee,'USD' FROM jsonb_to_recordset($1::jsonb) AS r(day date,kind text,face bigint,fee bigint)`,
      [JSON.stringify(rows)],
    );
  }
  await sql.query("SELECT set_config('app.gift_archive_workspace',$1,true)", [workspace]);
}
