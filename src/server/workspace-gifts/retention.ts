import type { ServiceEnd } from '../../shared/customer-retention.js';
import {requireRetention} from '../customer-retention/approval.js';
import type {Sql} from '../db.js';
import {all,one,put} from './store.js';
import {transition} from './ledger.js';
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
