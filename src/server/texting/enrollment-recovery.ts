import type { Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import { audit, type Interface } from './storage.js';

export async function enrollmentNotices(sql: Sql, brand: string) {
  const { rows } = await sql.query<{ at: Date; message: string }>(`SELECT at,new_value->>'message' message
    FROM sms_audit WHERE target=$1 AND action='onboarding.notice_captured' ORDER BY at DESC,id DESC LIMIT 20`, [brand]);
  return rows.map(row => ({ at: row.at.toISOString(), message: row.message }));
}

// A failed first broadcast never releases its unattempted remainder. The next reviewed broadcast gets a new cohort.
export async function restartPracticeProbation(sql: Sql, workspace: string, brand: string, registration: string, actor: string,
  via: Interface, reason: string, now: Date, expected: 'paused' | 'suspended') {
  const row = (await sql.query<{ company_id: string; send_id: string | null; state: string }>(`SELECT b.company_id,
    b.profile#>>'{onboarding,probation,sendId}' send_id,b.profile#>>'{onboarding,probation,state}' state FROM sms_carrier_brands b
    JOIN sms_registrations r ON r.carrier_brand_id=b.id WHERE b.id=$1 AND r.id=$2 AND r.state='approved' FOR UPDATE OF b`, [brand, registration])).rows[0];
  requireCondition(row?.state === expected, 409, 'probation_state_changed', 'The probation state changed. Review the current status.');
  if (row.send_id) {
    const unresolved = await sql.query(`SELECT 1 FROM sms_messages WHERE company_id=$1 AND send_id=$2 AND
      (state IN ('calling','uncertain','admitted') OR reserved_segments>0) LIMIT 1`, [row.company_id, row.send_id]);
    requireCondition(!unresolved.rowCount, 409, 'probation_reconciliation', 'The carrier is still reconciling this broadcast. Wait for it to finish.');
    await sql.query(`UPDATE sms_messages SET state='cancelled',reason='probation_restarted',updated_at=clock_timestamp()
      WHERE company_id=$1 AND send_id=$2 AND state='pending'`, [row.company_id, row.send_id]);
    await sql.query(`UPDATE sms_sends SET state='cancelled',updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2
      AND state IN ('running','confirmed','scheduled','paused')`, [row.company_id, row.send_id]);
  }
  await sql.query("UPDATE sms_carrier_brands SET profile=jsonb_set(profile,'{onboarding,probation}',$2::jsonb) WHERE id=$1",
    [brand, JSON.stringify({state:'awaiting_canary', startsAt:now.toISOString()})]);
  await audit(sql, workspace, actor, via, 'onboarding.probation_restarted', brand, { state: expected }, { reason });
  return { resumed: true };
}
