import type { Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import { audit, type Interface } from './storage.js';

// Called under the workspace lock. This grant covers one original failed-cohort exercise.
export async function releaseMockBroadcast(
  sql: Sql, workspace: string, send: string, actor: string, via: Interface, reason: string, now: Date,
) {
  const brand = (await sql.query<{ id: string; company_id: string; members: string[] }>(
    `SELECT b.id,b.company_id,b.profile#>'{onboarding,probation,members}' members
     FROM sms_carrier_brands b JOIN sms_registrations r ON r.carrier_brand_id=b.id
     JOIN sms_sends s ON s.company_id=b.company_id AND s.id=$2::uuid
     WHERE b.workspace_id=$1 AND r.state='approved' AND s.kind='broadcast' AND s.state='running'
       AND s.confirmed_at IS NOT NULL AND b.profile#>>'{onboarding,probation,state}'='paused'
       AND b.profile#>>'{onboarding,probation,sendId}'=$2::text
       AND EXISTS (SELECT 1 FROM sms_audit WHERE action='probation.canary_paused' AND target=$2::text
         AND new_value->>'reason'='cohort_failure')
       AND NOT EXISTS (SELECT 1 FROM sms_audit WHERE action='probation.mock_broadcast_released' AND target=$2::text)
       AND NOT EXISTS (SELECT 1 FROM sms_audit WHERE action IN ('probation.risk_paused','probation.risk_suspended')
         AND target=b.id::text AND at >= (b.profile#>>'{onboarding,probation,startsAt}')::timestamptz)
       AND NOT EXISTS (SELECT 1 FROM sms_sends other WHERE other.company_id=b.company_id AND other.id<>s.id
         AND other.kind='broadcast' AND other.state IN ('confirmed','scheduled','running','paused'))
     FOR UPDATE OF b,s`, [workspace, send],
  )).rows[0];
  requireCondition(brand && brand.members?.length === 1, 409, 'mock_release_unavailable',
    'The approved paused practice broadcast must be the only open broadcast for this company.');
  const rows = (await sql.query<{
    id: string; state: string; reason: string | null; attempts: number; provider_sid: string | null;
    submitted_at: Date | null; reserved_segments: number;
  }>(`SELECT id,state,reason,attempts,provider_sid,submitted_at,reserved_segments FROM sms_messages
      WHERE workspace_id=$1 AND company_id=$2 AND send_id=$3 AND purpose='broadcast' ORDER BY id FOR UPDATE`,
      [workspace, brand.company_id, send])).rows;
  const failed = rows.find(m => m.id === brand.members[0]);
  const held = rows.filter(m => m.id !== brand.members[0]);
  requireCondition(failed?.state === 'failed' && failed.reason === 'twilio_30005' && failed.attempts === 1 &&
    !!failed.provider_sid && held.length === 2 && held.every(m => m.state === 'pending' && m.attempts === 0 &&
      !m.provider_sid && !m.submitted_at && m.reserved_segments === 0),
    409, 'mock_release_outcomes_changed', 'The original failed text and two unattempted texts must still match the approved exercise.');
  await sql.query(`UPDATE sms_carrier_brands SET profile=jsonb_set(profile,'{onboarding,probation}',
    (profile#>'{onboarding,probation}') || jsonb_build_object('state','complete','overrideAt',$2::text)) WHERE id=$1`,
    [brand.id, now.toISOString()]);
  // Ask the worker to recheck its normal dispatch rules. Only these two unattempted records can wake.
  const pending = held.map(m => m.id);
  await sql.query(`UPDATE sms_messages SET next_check_at=least(next_check_at,$2::timestamptz)
    WHERE id=ANY($1::uuid[]) AND state='pending' AND attempts=0`, [pending, now]);
  await audit(sql, workspace, actor, via, 'probation.mock_broadcast_released', send, { state: 'paused' },
    { state: 'complete', reason, company: brand.company_id, preservedFailed: failed.id, released: pending });
  return { released: pending.length };
}
