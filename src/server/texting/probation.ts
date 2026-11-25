import { plainText } from '../../shared/texting.js';
import type { Sql } from '../db.js';
import { audit, requireSettings, type SettingValues } from './storage.js';

const policyKeys = ['probation_canary_count', 'probation_canary_minutes', 'probation_min_days', 'probation_delivered_min',
  'probation_initial_days', 'probation_initial_daily_limit', 'probation_daily_limit'] as const;
type State = { state: 'canary' | 'active' | 'paused' | 'complete'; startsAt: string; sendId?: string; members?: string[] };
type Profile = { id: string; samples: string[] | null; state: State | null; approved_at: Date };

async function profile(sql: Sql, company: string) {
  return (await sql.query<Profile>(`SELECT b.id,b.profile#>'{campaign,samples}' samples,
    b.profile#>'{onboarding,probation}' state,r.updated_at approved_at
    FROM sms_carrier_brands b JOIN sms_registrations r ON r.carrier_brand_id=b.id
    WHERE b.company_id=$1 AND b.profile ? 'onboarding' AND r.state='approved'`, [company])).rows[0];
}

async function update(sql: Sql, id: string, state: State) {
  await sql.query("UPDATE sms_carrier_brands SET profile=jsonb_set(profile,'{onboarding,probation}',$2::jsonb) WHERE id=$1",
    [id, JSON.stringify(state)]);
}

export async function probationGaps(sql: Sql, company: string, template: string, settings: SettingValues) {
  const pending = await profile(sql, company);
  if (!pending || pending.state?.state === 'complete') return [];
  if (pending.state?.state === 'paused') return ['probation_paused'];
  const gaps = [];
  if (policyKeys.some(key => settings[key] === undefined)) gaps.push('probation_settings_required');
  if (!pending.samples?.some(sample => plainText(sample) === template)) gaps.push('probation_template_required');
  return gaps;
}

export async function assignCanary(sql: Sql, company: string, sendId: string, settings: SettingValues, workspace: string) {
  const pending = await profile(sql, company);
  if (!pending || pending.state) return;
  const policy = requireSettings(settings, policyKeys);
  const members = (await sql.query<{ id: string }>(`SELECT id FROM sms_messages WHERE send_id=$1 ORDER BY id LIMIT $2`,
    [sendId, policy.probation_canary_count])).rows.map(row => row.id);
  await update(sql, pending.id, { state: 'canary', startsAt: pending.approved_at.toISOString(), sendId, members });
  await audit(sql, workspace, 'worker', 'worker', 'probation.canary_selected', sendId, null, { recipients: members.length });
}

/** Called with the workspace lock at admission, before any outbound side effect. */
export async function probationHold(sql: Sql, workspace: string, company: string, messageId: string,
  settings: SettingValues, now: Date): Promise<{ at: Date; reason: string } | null> {
  const record = await profile(sql, company);
  if (!record || record.state?.state === 'complete') return null;
  const hold = (reason: string, at = new Date(now.getTime() + 60_000)) => ({ at, reason });
  const current = record.state;
  if (current?.state === 'paused') return hold('probation_paused', new Date(now.getTime() + 15 * 60_000));
  if (!current) return hold('probation_canary_required');
  if (policyKeys.some(key => settings[key] === undefined)) return hold('probation_settings_required');
  const policy = requireSettings(settings, policyKeys);
  if (current.state === 'canary') {
    const cohort = (await sql.query<{ state: string; updated_at: Date }>(
      'SELECT state,updated_at FROM sms_messages WHERE id=ANY($1::uuid[])', [current.members ?? []])).rows;
    if (cohort.some(item => ['failed', 'undelivered', 'skipped', 'cancelled'].includes(item.state))) {
      await update(sql, record.id, { ...current, state: 'paused' });
      await audit(sql, workspace, 'worker', 'worker', 'probation.canary_paused', current.sendId ?? null, null, { reason: 'cohort_failure' });
      return hold('probation_paused');
    }
    if (!current.members?.includes(messageId)) {
      if (!cohort.length || cohort.length !== current.members?.length || cohort.some(item => item.state !== 'delivered'))
        return hold('probation_canary_pending');
      const release = new Date(Math.max(...cohort.map(item => item.updated_at.getTime())) + policy.probation_canary_minutes * 60_000);
      if (now < release) return hold('probation_canary_pending', release);
      current.state = 'active';
      await update(sql, record.id, current);
      await audit(sql, workspace, 'worker', 'worker', 'probation.canary_released', current.sendId ?? null, null, null);
    }
  }
  const age = (now.getTime() - Date.parse(current.startsAt)) / 86400000;
  if (current.state === 'active' && age >= policy.probation_min_days) {
    const delivered = (await sql.query<{ count: number }>(`SELECT count(*)::int FROM sms_messages
      WHERE company_id=$1 AND purpose='broadcast' AND state='delivered' AND submitted_at>=$2`, [company, current.startsAt])).rows[0]!.count;
    if (delivered >= policy.probation_delivered_min) {
      await update(sql, record.id, { ...current, state: 'complete' });
      await audit(sql, workspace, 'worker', 'worker', 'probation.completed', record.id, null, { delivered });
      return null;
    }
  }
  const limit = age < policy.probation_initial_days ? policy.probation_initial_daily_limit : policy.probation_daily_limit;
  const today = now.toISOString().slice(0, 10);
  const used = (await sql.query<{ count: number }>(`SELECT count(*)::int FROM sms_messages WHERE company_id=$1 AND purpose='broadcast'
    AND send_day=$2 AND state IN ('calling','uncertain','accepted','delivered','failed','undelivered')`, [company, today])).rows[0]!.count;
  return used < limit ? null : hold('probation_daily_limit', new Date(Date.parse(today) + 86400000));
}
