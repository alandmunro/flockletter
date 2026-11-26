import { randomUUID, createHash } from 'node:crypto';
import type { Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import { areaCodeZones, textingSettings, type TextingSettingKey } from '../../shared/texting.js';

export type Interface = 'ui' | 'api' | 'mcp' | 'worker' | 'webhook' | 'signup_page' | 'operator_ui' | 'operator_api' | 'operator_mcp';
export type SettingValues = { [K in TextingSettingKey]?: (typeof textingSettings)[K]['kind'] extends 'int' ? number : string[] };

/** Reads every texting setting for one workspace: the workspace override, else the platform value. */
export async function readSettings(sql: Sql, workspace: string, defaults?: SettingValues): Promise<SettingValues> {
  const rows = (await sql.query<{ key: string; workspace_id: string | null; value: unknown }>('SELECT * FROM flockletter_customer_jobs.texting_settings_list($1)', [workspace])).rows;
  const values: Record<string, unknown> = {};
  for (const row of rows) if (Object.hasOwn(textingSettings, row.key) && (row.workspace_id !== null || !(row.key in values))) values[row.key] = row.value;
  return { ...defaults, ...values } as SettingValues;
}
/** Fails closed with a named reason when any required setting is unset (FL-SMS-013). */
export function requireSettings<K extends TextingSettingKey>(values: SettingValues, keys: readonly K[]): { [P in K]: NonNullable<SettingValues[P]> } {
  const missing = keys.filter(key => values[key] === undefined || values[key] === null);
  requireCondition(!missing.length, 409, 'texting_setting_required', 'An operator must set these texting settings first: ' + missing.join(', ') + '.');
  return values as { [P in K]: NonNullable<SettingValues[P]> };
}
export const sendingSettings = ['send_window_start_hour', 'send_window_end_hour', 'contact_monthly_limit', 'carrier_daily_limit', 'monthly_segment_allowance', 'link_life_days', 'opt_out_words'] as const;

export async function audit(sql: Sql, workspace: string, actor: string, via: Interface, action: string, target: string | null, oldValue: unknown, newValue: unknown) {
  await sql.query('INSERT INTO sms_audit(workspace_id,id,actor_id,interface,action,target,old_value,new_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [workspace, randomUUID(), actor, via, action, target, oldValue === undefined ? null : JSON.stringify(oldValue), newValue === undefined ? null : JSON.stringify(newValue)]);
  const message = enrollmentNotice(action, newValue);
  if (message && target) {
    await sql.query(`INSERT INTO sms_audit(workspace_id,id,actor_id,interface,action,target,new_value)
      SELECT $1,$2,$3,$4,'onboarding.notice_captured',b.id::text,$5 FROM sms_carrier_brands b
      JOIN sms_registrations r ON r.carrier_brand_id=b.id WHERE b.workspace_id=$1 AND b.profile ? 'onboarding'
      AND (b.id::text=$6 OR r.id::text=$6 OR b.profile#>>'{onboarding,probation,sendId}'=$6 OR EXISTS
        (SELECT 1 FROM sms_registration_steps s WHERE s.registration_id=r.id AND s.operation_key=$6))`,
    [workspace, randomUUID(), actor, via, JSON.stringify({ message, mail: 'captured', inApp: true, event: action }), target]);
  }
}
export const requestHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Captured owner mail and the in-app notice share the exact durable source event in practice enrollment. */
function enrollmentNotice(action: string, value: unknown): string | null {
  const facts = value as { state?: string; status?: string } | null;
  switch (action) {
    case 'registration.submit': return 'Your carrier registration was submitted.';
    case 'registration.approved': return 'Registration approved. Your assigned number is active.';
    case 'registration.brand_status': case 'registration.campaign_status':
      if (facts?.status === 'FAILED') return 'The carrier requested corrections. Open business texting to see the next step.';
      if (facts?.status === 'SUSPENDED') return 'The carrier suspended this registration. Sending is on hold.';
      if (action === 'registration.brand_status' && ['APPROVED', 'VERIFIED'].includes(facts?.status ?? '')) return 'Your brand was approved. Campaign review follows.';
      return null;
    case 'registration.call': return facts?.state === 'rejected' ? 'The carrier rejected a registration step. Review the corrections in Texting.' : null;
    case 'registration.number_status': return facts?.state === 'reserved' ? 'Your number needs carrier attention.' : null;
    case 'onboarding.review': return 'Ownership or payer evidence needs review.';
    case 'onboarding.request_correction': return 'An operator requested a correction to your enrollment.';
    case 'onboarding.accept_evidence': return 'Your practice evidence was accepted. Continue enrollment.';
    case 'probation.canary_paused': case 'probation.risk_paused': return 'Sending paused. Review the first broadcast and recent delivery results.';
    case 'probation.risk_suspended': return 'Sending suspended after a delivery or opt-out threshold was reached. Operator review is required.';
    case 'onboarding.probation_restarted': return 'Probation restarted. A freshly reviewed broadcast must pass the first-cohort check.';
    case 'probation.completed': case 'onboarding.complete_probation': return 'Texting probation ended.';
    default: return null;
  }
}

/** Replays the stored result for a repeated operation key; a different request with the same key is a conflict. */
export async function once<T>(sql: Sql, workspace: string, actor: string, key: string, request: unknown, action: () => Promise<T>): Promise<T> {
  const hash = requestHash(request);
  const previous = (await sql.query<{ request_hash: string; result: T }>('SELECT request_hash,result FROM operations WHERE actor_id=$1 AND operation_key=$2', [actor, key])).rows[0];
  if (previous) { requireCondition(previous.request_hash === hash, 409, 'operation_conflict', 'Retry the original request with this operation key.'); return previous.result; }
  const result = await action();
  await sql.query('INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4,$5)', [workspace, actor, key, hash, JSON.stringify(result ?? null)]);
  return result;
}

/** Local wall-clock parts in an IANA zone. */
export function localParts(at: Date, zone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return parts as { year: number; month: number; day: number; hour: number; minute: number };
}
export function validZone(zone: string) { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; } }
export async function smsRecipientZones(sql: Sql, contactZone: string | null | undefined, phone: string): Promise<readonly string[]> {
  if (contactZone && validZone(contactZone)) return [contactZone];
  const byArea = areaCodeZones(phone);
  if (byArea.length) return byArea;
  const zone = (await sql.query<{ time_zone: string }>('SELECT time_zone FROM sms_workspace_profile')).rows[0]?.time_zone;
  return [zone && validZone(zone) ? zone : 'America/New_York'];
}
/**
 * Earliest instant at or after `from` that falls inside [start, end) local hours in every zone given.
 * Several zones are given when an area code spans more than one; the window is their intersection.
 */
export function nextWindow(from: Date, zones: readonly string[], start: number, end: number): Date {
  const inside = (at: Date) => zones.every(zone => { const h = localParts(at, zone).hour; return h >= start && h < end; });
  if (inside(from)) return from;
  let at = new Date(Math.ceil(from.getTime() / 900000) * 900000);
  for (let i = 0; i < 4 * 24 * 3; i++, at = new Date(at.getTime() + 900000)) if (inside(at)) return at;
  return new Date(from.getTime() + 86400000); // zones with no shared window: retry tomorrow and recheck
}
