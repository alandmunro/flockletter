import type { GiftNoticeRecord } from './notifications.js';
import type { GiftAlertPreferences } from '../../shared/workspace-gifts.js';
import type { Sql } from '../db.js';
import { requireCondition } from '../errors.js';

export type Lot = {
  id: string;
  brand: string;
  account: string;
  face: number;
  fee: number;
  total: number;
  created: string;
  state: 'checkout' | 'funded' | 'expired' | 'refunding' | 'refunded';
  session?: string;
  payment?: string;
  charge?: string;
  paidAt?: string;
  reserved: number;
  spent: number;
  returned: number;
  refundId?: string;
  externalRefundGross?: number;
  externalRefundHeld?: number;
  externalRefundFace?: number;
  live?: boolean;
  refundStarted?: string;
  refundFace?: number;
  nextCheck?: string;
  disputed: number;
  lost: number;
  disputes: Record<string, { amount: number; state: string; opened: string }>;
};
export type GiftCampaign = {
  id: string;
  brand: string;
  title: string;
  face: number;
  days: number;
  products: string[];
  created: string;
  expires: string;
  hash: string;
  live?: boolean;
  account?: string;
  brokerConfirmed: boolean;
};
export type GiftOffer = {
  id: string;
  campaign: string;
  brand: string;
  person: string;
  face: number;
  expires: string;
  state: 'offered' | 'pending' | 'claimed' | 'expired' | 'canceled';
  alloc: { id: string; amount: number }[];
  secret: string;
  order?: string;
  reward?: string;
  claimedAt?: string;
  reason?: string;
  retryAt?: string;
};
export type Entry = { faceMinor?:number; kind: string; amount: number; at: string; brand: string; ref: string };
export type Closure = { at: string; brand: string };
interface Records {
  notice: GiftNoticeRecord;
  noticePrefs: GiftAlertPreferences;
  lowEpisode: { low: boolean; count: number };

  event: { at: string };
  evidence: { summary: string };
  lot: Lot;
  campaign: GiftCampaign;
  offer: GiftOffer;
  entry: Entry;
  closure: Closure;
  signal: { kind: string; at: string; ref: string };
}
export const actorFor = (kind: keyof Records) => 'workspace-gifts:v1:' + kind;
export async function one<K extends keyof Records>(sql: Sql, kind: K, key: string) {
  const row = await sql.query<{ result: Records[K] }>(
    `SELECT result FROM operations
    WHERE workspace_id=current_setting('app.workspace_id') AND actor_id=$1 AND request_hash=$2
    ORDER BY operation_key DESC LIMIT 1`,
    [actorFor(kind), key],
  );
  return row.rows[0]?.result;
}
export async function all<K extends keyof Records>(sql: Sql, kind: K) {
  const row = await sql.query<{ result: Records[K] }>(
    `SELECT result FROM (
    SELECT DISTINCT ON (request_hash) request_hash,result,
      min(created_at) OVER (PARTITION BY request_hash) AS first_seen
    FROM operations WHERE workspace_id=current_setting('app.workspace_id') AND actor_id=$1
    ORDER BY request_hash,operation_key DESC
    ) AS latest ORDER BY first_seen,request_hash`,
    [actorFor(kind)],
  );
  return row.rows.map((r) => r.result);
}
// The runtime can only insert into the journal. Allocate a revision under the
// caller's transaction-scoped workspace lock. Fixed-width revisions sort in order
// even for several changes to one lot within a transaction.
export async function put<K extends Exclude<keyof Records, 'entry'>>(
  sql: Sql,
  w: string,
  kind: K,
  key: string,
  value: Records[K],
) {
  await sql.query(
    `INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result)
    SELECT $1,$2,$3||'/'||lpad((coalesce(max(right(operation_key,12)::bigint),0)+1)::text,12,'0'),$3,$4
    FROM operations WHERE workspace_id=$1 AND actor_id=$2 AND request_hash=$3`,
    [w, actorFor(kind), key, JSON.stringify(value)],
  );
}
export async function entry(sql: Sql, w: string, key: string, value: Entry) {
  const saved = await sql.query(
    'INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$3,$4) ON CONFLICT DO NOTHING',
    [w, actorFor('entry'), key, JSON.stringify(value)],
  );
  requireCondition(
    saved.rowCount,
    409,
    'gift_ledger_conflict',
    'The gift transaction already has a ledger entry.',
  );
}
export const feeFor = (face: number) => Math.round(face / 10);
export const unused = (lot: Lot) => lot.face - lot.spent - lot.reserved;
export function available(lot: Lot) {
  if (lot.state === 'checkout' || lot.state === 'expired') return 0;
  const withheld =
    lot.state === 'refunded' || lot.state === 'refunding' ? (lot.refundFace ?? unused(lot)) : 0;
  return unused(lot) - withheld - (lot.externalRefundFace ?? 0) - lot.disputed - lot.lost;
}
