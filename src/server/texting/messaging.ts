import {giftSendingHold} from '../workspace-gifts/service.js';
// Consent (FL-SMS-005/006), delivery controls (FL-SMS-009/011/012) and inbound handling (FL-SMS-015).
import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import { lockWorkspace } from '../workspace-lock.js';
import { encodeText, helpText, type ConsentState } from '../../shared/texting.js';
import { audit, nextWindow, readSettings, requireSettings, sendingSettings, smsRecipientZones, type Interface, type SettingValues } from './storage.js';
import { bodyDigest, messageRank, type AccountCredentials, type CredentialSeal, type SendResult, type TwilioMessagingPort } from './twilio.js';
import { probationHold } from './probation.js';

export type MessageRow = { date_brand_id?:string|null; id: string; send_id: string | null; company_id: string; contact_id: string | null; purpose: 'broadcast' | 'test' | 'confirmation' | 'help' | 'verification';
  to_e164: string; rendered_body: string; body_digest: string; encoding: string; segments: number; state: string; reason: string | null; provider_sid: string | null;
  send_day: string | null; next_check_at: Date; attempts: number; submitted_at: Date | null; reserved_segments: number };
type ContactRow = { id: string; phone_e164: string; name: string | null; time_zone: string | null; textable: boolean; consecutive_temp_failures: number };
export type Forward = (message: {
  id: string; to: string; subject: string; text: string;
}) => Promise<'forwarded' | 'captured' | 'failed' | 'uncertain'>;
export type DispatchAuthority = (sql: Sql, workspace: string, companyId: string, actorId: string) => Promise<boolean>;
export type MessagingOptions = { annualClaim?:(sql:Sql,w:string,brand:string,id:string,now:Date,company:string)=>Promise<string|null>; db: Database; port: TwilioMessagingPort; seal: CredentialSeal; origin: string; forward?: Forward; canDispatch?: DispatchAuthority; now?: () => Date };

const permanentStatusCodes = new Set(['30005', '30006', '21211', '21614', '21612']);
const purposeNeedsWindow = new Set(['broadcast', 'confirmation']);
/** A sign-up confirmation admitted this soon after it was queued is sent outside quiet hours (FL-SMS-009). */
export const confirmationReplyMinutes = 10;

export async function businessName(sql: Sql, companyId: string) {
  const row = (await sql.query<{ name: string }>(`SELECT coalesce(b.dba_name,b.legal_name,c.name) AS name FROM companies c LEFT JOIN sms_carrier_brands b ON b.company_id=c.id WHERE c.id=$1`, [companyId])).rows[0];
  return row?.name ?? 'Flockletter';
}
/** Sending is locked until the company's registration is approved and its number is active. */
export async function sendingNumber(sql: Sql, companyId: string) {
  return (await sql.query<{ id: string; e164: string; messaging_service_sid: string; help_contact: string }>(`SELECT n.id,n.e164,n.messaging_service_sid,b.help_contact
    FROM sms_carrier_brands b JOIN sms_registrations r ON r.carrier_brand_id=b.id AND r.state='approved'
    JOIN sms_numbers n ON n.carrier_brand_id=b.id AND n.state='active' WHERE b.company_id=$1`, [companyId])).rows[0] ?? null;
}
export async function setConsent(sql: Sql, workspace: string, company: string, contact: string, state: ConsentState,
  event: string, source: string, actor: string, via: Interface, evidence: { wording?: string; wordingDigest?: string; policyVersion?: string; messageId?: string; pendingDays?: number } = {}) {
  const old = (await sql.query<{ state: ConsentState }>('SELECT state FROM sms_consents WHERE company_id=$1 AND contact_id=$2 FOR UPDATE', [company, contact])).rows[0]?.state ?? 'none';
  await sql.query(`INSERT INTO sms_consents(workspace_id,company_id,contact_id,state,pending_expires_at) VALUES($1,$2,$3,$4,CASE WHEN $5::int IS NULL THEN NULL ELSE clock_timestamp()+make_interval(days=>$5::int) END)
    ON CONFLICT(workspace_id,company_id,contact_id) DO UPDATE SET state=EXCLUDED.state,pending_expires_at=EXCLUDED.pending_expires_at,updated_at=clock_timestamp()`,
    [workspace, company, contact, state, evidence.pendingDays ?? null]);
  await sql.query(`INSERT INTO sms_consent_events(workspace_id,id,company_id,contact_id,event,source,wording,wording_digest,policy_version,evidence_message_id,recorded_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [workspace, randomUUID(), company, contact, event, source, evidence.wording ?? null, evidence.wordingDigest ?? null, evidence.policyVersion ?? null, evidence.messageId ?? null, actor]);
  await audit(sql, workspace, actor, via, 'consent.' + event, contact, { company, state: old }, { company, state });
  return old;
}
/** Queues one text. The message id is its stable operation key. */
export async function queueText(sql: Sql, workspace: string, m: { sendId?: string | null; companyId: string; contactId: string | null; purpose: MessageRow['purpose']; to: string; body: string; dueAt?: Date }) {
  const encoded = encodeText(m.body);
  const id = randomUUID();
  await sql.query(`INSERT INTO sms_messages(workspace_id,id,send_id,company_id,contact_id,purpose,to_e164,rendered_body,body_digest,encoding,segments,state,next_check_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',coalesce($12,clock_timestamp()))`,
    [workspace, id, m.sendId ?? null, m.companyId, m.contactId, m.purpose, m.to, encoded.text, bodyDigest(encoded.text), encoded.encoding, Math.min(encoded.segments, 10), m.dueAt ?? null]);
  return id;
}
const month = (at: Date) => at.toISOString().slice(0, 8) + '01';
const day = (at: Date) => at.toISOString().slice(0, 10);

export class TextingMessaging {
  constructor(readonly options: MessagingOptions) {}
  private now() { return this.options.now?.() ?? new Date(); }
  statusUrl(workspace: string, message: string) { return `${this.options.origin}/api/v1/texting/twilio/status?w=${encodeURIComponent(workspace)}&m=${message}`; }
  private async account(sql: Sql, workspace: string): Promise<AccountCredentials | null> {
    const row = (await sql.query<{ credentials: string }>('SELECT * FROM flockletter_customer_jobs.texting_account($1)', [workspace])).rows[0];
    return row ? this.options.seal.open(row.credentials, workspace) : null;
  }
  /** One delivery pass: up to `limit` due texts. Returns when more work is due. */
  async tick(workspace: string, limit = 25): Promise<Date | null> {
    const db = this.options.db;
    for (let i = 0; i < limit; i++) {
      const claim = await db.tenant(workspace, async sql => {
        await lockWorkspace(sql, workspace);
        const now = this.now();
        await this.expirePending(sql, workspace);
        const row = (await sql.query<MessageRow>(`SELECT m.*,m.send_day::text AS send_day FROM sms_messages m LEFT JOIN sms_sends s ON s.id=m.send_id
          WHERE m.state IN ('pending','admitted','calling','uncertain') AND m.next_check_at<=$1 AND (s.id IS NULL OR s.state IN ('running','scheduled','confirmed'))
          ORDER BY m.next_check_at,m.created_at LIMIT 1 FOR UPDATE OF m SKIP LOCKED`, [now])).rows[0];
        if (!row) return null;
        if (row.send_id) await sql.query(`UPDATE sms_sends SET state='running',updated_at=clock_timestamp() WHERE id=$1 AND state IN ('scheduled','confirmed')`, [row.send_id]);
        // After a restart, `calling` and `uncertain` texts are only ever looked up, never sent again.
        if (row.state === 'calling' || row.state === 'uncertain') return { kind: 'reconcile' as const, row, account: await this.account(sql, workspace) };
        const verdict = await this.admit(sql, workspace, row, now);
        if (verdict) return { kind: 'settled' as const };
        await sql.query(`UPDATE sms_messages SET state='calling',attempts=attempts+1,submitted_at=$2,updated_at=clock_timestamp() WHERE id=$1`, [row.id, now]);
        const number = (await sendingNumber(sql, row.company_id))!;
        return { kind: 'send' as const, row, number, account: await this.account(sql, workspace) };
      });
      if (!claim) break;
      if (claim.kind === 'settled') continue;
      if (!claim.account) { await this.settle(workspace, claim.row, { outcome: 'not_submitted', reason: 'provider_account_missing', retryAfterSeconds: 300 }); continue; }
      if (claim.kind === 'send') {
        const result = await this.options.port.send(claim.account, { op: claim.row.id, serviceSid: claim.number.messaging_service_sid, to: claim.row.to_e164,
          body: claim.row.rendered_body, statusCallback: this.statusUrl(workspace, claim.row.id) }).catch((): SendResult => ({ outcome: 'unknown', reason: 'adapter_error' }));
        await this.settle(workspace, claim.row, result);
      } else {
        const found = await this.options.port.lookup(claim.account, { op: claim.row.id, sid: claim.row.provider_sid, to: claim.row.to_e164,
          sentAfter: claim.row.submitted_at ?? claim.row.next_check_at, bodyDigest: claim.row.body_digest }).catch(() => ({ outcome: 'unknown' as const }));
        await this.reconciled(workspace, claim.row, found);
      }
    }
    return db.read(workspace, async sql => (await sql.query<{ at: Date | null }>(`SELECT min(m.next_check_at) at FROM sms_messages m LEFT JOIN sms_sends s ON s.id=m.send_id
      WHERE m.state IN ('pending','admitted','calling','uncertain') AND (s.id IS NULL OR s.state IN ('running','scheduled','confirmed'))`)).rows[0]?.at ?? null);
  }
  /**
   * The admission order (plan section 5): registration and number; consent and textable; quiet hours;
   * per-contact frequency; carrier daily limit; allowance. Returns true when the row was settled
   * (skipped or deferred), false when it may be sent now with its segments reserved.
   */
  private async admit(sql: Sql, workspace: string, row: MessageRow, now: Date): Promise<boolean> {
    const defer = async (at: Date, reason: string) => { await sql.query(`UPDATE sms_messages SET state='pending',reason=$2,next_check_at=$3,updated_at=clock_timestamp() WHERE id=$1`, [row.id, reason, at]); return true; };
    const skip = async (reason: string) => {
      await this.release(sql, row, false);
      await sql.query(`UPDATE sms_messages SET state='skipped',reason=$2,updated_at=clock_timestamp() WHERE id=$1`, [row.id, reason]);
      await audit(sql, workspace, 'worker', 'worker', 'message.skipped', row.id, null, { reason });
      await this.finishSend(sql, row.send_id); return true;
    };
    if (row.date_brand_id) {
      await sql.query("SELECT set_config('app.intake_brand_id',$1,true)",[row.date_brand_id]);
      const reason=this.options.annualClaim ? await this.options.annualClaim(sql,workspace,row.date_brand_id,row.id,now,row.company_id) : 'automation_off';
      if(reason==='outside_window'||reason==='authority_verification_unavailable'||reason==='subscription_ineligible') return defer(new Date(now.getTime()+60000),reason);
      if(reason) return skip(reason);
    }
    if (row.send_id && this.options.canDispatch) {
      const actor = (await sql.query<{ confirmed_by: string | null }>('SELECT confirmed_by FROM sms_sends WHERE id=$1', [row.send_id])).rows[0]?.confirmed_by;
      if (!actor) return skip('send_authority_revoked');
      let authorized: boolean;
      try { authorized = await this.options.canDispatch(sql, workspace, row.company_id, actor); }
      catch { return defer(new Date(now.getTime() + 5 * 60000), 'send_authority_unavailable'); }
      if (!authorized) return skip('send_authority_revoked');
    }
    const settings = await readSettings(sql, workspace);
    let required: ReturnType<typeof requireSettings<(typeof sendingSettings)[number]>>;
    try { required = requireSettings(settings, sendingSettings); } catch { return defer(new Date(now.getTime() + 15 * 60000), 'texting_setting_required'); }
    // 1. Registration approved and number active.
    if (!await sendingNumber(sql, row.company_id)) return defer(new Date(now.getTime() + 15 * 60000), 'registration_not_approved');
    // 2. Consent and textable.
    const contact = row.contact_id ? (await sql.query<ContactRow>('SELECT * FROM sms_contacts WHERE id=$1', [row.contact_id])).rows[0] : null;
    if (contact && !contact.textable) return skip('not_textable');
    if (row.purpose === 'broadcast' || row.purpose === 'confirmation') {
      const consent = (await sql.query<{ state: ConsentState }>('SELECT state FROM sms_consents WHERE company_id=$1 AND contact_id=$2', [row.company_id, row.contact_id])).rows[0]?.state ?? 'none';
      if (row.purpose === 'broadcast' && consent !== 'opted_in') return skip('no_consent');
      if (row.purpose === 'confirmation' && consent !== 'pending_confirmation') return skip('confirmation_not_pending');
    }
    // 3. Quiet hours in the recipient's time zone (contact, else area code, else workspace).
    // A confirmation sent within minutes of the sign-up is a direct reply to the person's own request, not marketing,
    // so it goes at once. One delayed past that (an outage, sending still locked) waits for the window like any other text.
    const freshReply = row.purpose === 'confirmation' && (await sql.query<{ fresh: boolean }>(
      `SELECT created_at > clock_timestamp() - make_interval(mins => $2) fresh FROM sms_messages WHERE id=$1`, [row.id, confirmationReplyMinutes])).rows[0]?.fresh === true;
    if (purposeNeedsWindow.has(row.purpose) && !freshReply) {
      const zones = await smsRecipientZones(sql, contact?.time_zone, row.to_e164);
      const window = nextWindow(now, zones, required.send_window_start_hour, required.send_window_end_hour);
      if (window > now) return defer(window, 'quiet_hours');
    }
    // 4. Per-contact monthly frequency (marketing texts only).
    if (row.purpose === 'broadcast') {
      if(await giftSendingHold(sql))return defer(new Date(now.getTime()+15*60000),'gift_dispute_hold');
      const hold = await probationHold(sql, workspace, row.company_id, row.id, settings, now);
      if (hold) return defer(hold.at, hold.reason);
      const sent = (await sql.query<{ n: number }>(`SELECT count(*)::int n FROM sms_messages WHERE contact_id=$1 AND purpose='broadcast' AND id<>$2
        AND state IN ('calling','accepted','delivered','undelivered','uncertain') AND submitted_at>=date_trunc('month',$3::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [row.contact_id, row.id, now])).rows[0]!.n;
      if (sent >= required.contact_monthly_limit) return skip('frequency_limit');
    }
    // 5. Carrier daily limit for the workspace.
    const today = (await sql.query<{ n: number }>(`SELECT count(*)::int n FROM sms_messages WHERE send_day=$1 AND state IN ('calling','accepted','delivered','undelivered','failed','uncertain')`, [day(now)])).rows[0]!.n;
    if (today >= required.carrier_daily_limit) {
      const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      return defer(tomorrow, 'daily_limit');
    }
    // 6. Allowance: segments reserved now, released if the provider does not accept.
    const period = month(now);
    await sql.query('INSERT INTO sms_usage(workspace_id,period_month) VALUES($1,$2) ON CONFLICT DO NOTHING', [workspace, period]);
    const usage = (await sql.query<{ segments_reserved: number; segments_used: number }>('SELECT * FROM sms_usage WHERE period_month=$1 FOR UPDATE', [period])).rows[0]!;
    if (usage.segments_reserved + usage.segments_used + row.segments > required.monthly_segment_allowance) return defer(new Date(now.getTime() + 15 * 60000), 'allowance_exhausted');
    await sql.query('UPDATE sms_usage SET segments_reserved=segments_reserved+$2 WHERE period_month=$1', [period, row.segments]);
    await sql.query(`UPDATE sms_messages SET state='admitted',reason=NULL,send_day=$2,reserved_segments=$3,updated_at=clock_timestamp() WHERE id=$1`, [row.id, day(now), row.segments]);
    return false;
  }
  private async release(sql: Sql, row: MessageRow, used: boolean) {
    if (!row.reserved_segments || !row.send_day) return;
    await sql.query(`UPDATE sms_usage SET segments_reserved=greatest(segments_reserved-$2,0),segments_used=segments_used+$3 WHERE period_month=date_trunc('month',$1::date)::date`,
      [row.send_day, row.reserved_segments, used ? row.reserved_segments : 0]);
    await sql.query('UPDATE sms_messages SET reserved_segments=0 WHERE id=$1', [row.id]);
  }
  private async settle(workspace: string, row: MessageRow, result: SendResult) {
    await this.options.db.tenant(workspace, async sql => {
      await lockWorkspace(sql, workspace);
      const current = (await sql.query<MessageRow>('SELECT *,send_day::text AS send_day FROM sms_messages WHERE id=$1 FOR UPDATE', [row.id])).rows[0]!;
      if (current.state !== 'calling') return;
      if (result.outcome === 'accepted') {
        await sql.query(`UPDATE sms_messages SET state='accepted',provider_sid=$2,reason=NULL,updated_at=clock_timestamp() WHERE id=$1`, [row.id, result.sid]);
        await this.release(sql, current, true);
      } else if (result.outcome === 'rejected') {
        await sql.query(`UPDATE sms_messages SET state='failed',reason=$2,updated_at=clock_timestamp() WHERE id=$1`, [row.id, result.reason ?? 'rejected']);
        await this.release(sql, current, false);
        if (result.permanent && current.contact_id) await this.permanentFailure(sql, workspace, current, result.permanent);
      } else if (result.outcome === 'not_submitted') {
        await sql.query(`UPDATE sms_messages SET state='pending',reason=$2,next_check_at=clock_timestamp()+make_interval(secs=>$3),updated_at=clock_timestamp() WHERE id=$1`,
          [row.id, result.reason ?? 'not_submitted', Math.max(1, result.retryAfterSeconds ?? 30)]);
        await this.release(sql, current, false);
      } else {
        await sql.query(`UPDATE sms_messages SET state='uncertain',reason=$2,next_check_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE id=$1`, [row.id, result.reason ?? 'unknown']);
      }
      await audit(sql, workspace, 'worker', 'worker', 'message.' + result.outcome, row.id, { state: 'calling' }, { reason: result.reason ?? null });
      if (result.outcome !== 'unknown') await this.finishSend(sql, current.send_id);
    });
  }
  private async reconciled(workspace: string, row: MessageRow, found: { outcome: string; sid?: string; status?: string }) {
    await this.options.db.tenant(workspace, async sql => {
      await lockWorkspace(sql, workspace);
      const current = (await sql.query<MessageRow>('SELECT *,send_day::text AS send_day FROM sms_messages WHERE id=$1 FOR UPDATE', [row.id])).rows[0]!;
      if (!['calling', 'uncertain'].includes(current.state)) return;
      if (found.outcome === 'accepted') {
        await sql.query(`UPDATE sms_messages SET state='accepted',provider_sid=coalesce(provider_sid,$2),reason=NULL,updated_at=clock_timestamp() WHERE id=$1`, [row.id, found.sid]);
        await this.release(sql, current, true);
        await this.finishSend(sql, current.send_id);
      } else if (found.outcome === 'not_submitted') {
        const settle = (await readSettings(sql, workspace)).reconcile_settle_minutes;
        const since = (current.submitted_at ?? current.next_check_at).getTime();
        if (settle !== undefined && since + settle * 60000 <= this.now().getTime()) {
          // Confirmed absent after the settle time: the reserved segments go back and it may be admitted again.
          await this.release(sql, current, false);
          await sql.query(`UPDATE sms_messages SET state='pending',reason='not_found_after_settle',next_check_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`, [row.id]);
        } else await sql.query(`UPDATE sms_messages SET state='uncertain',reason='not_found_yet',next_check_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() WHERE id=$1`, [row.id]);
      } else await sql.query(`UPDATE sms_messages SET state='uncertain',next_check_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() WHERE id=$1`, [row.id]);
      await audit(sql, workspace, 'worker', 'worker', 'message.reconcile', row.id, { state: current.state }, { found: found.outcome });
    });
  }
  async finishSend(sql: Sql, sendId: string | null) {
    if (!sendId) return;
    await sql.query(`UPDATE sms_sends SET state='completed',updated_at=clock_timestamp() WHERE id=$1 AND state='running'
      AND NOT EXISTS(SELECT FROM sms_messages WHERE send_id=$1 AND state IN ('pending','admitted','calling','uncertain'))`, [sendId]);
  }
  private async permanentFailure(sql: Sql, workspace: string, row: MessageRow, kind: 'invalid' | 'landline' | 'unsubscribed' | 'permanent_failure' | 'repeated_failures') {
    if (!row.contact_id) return;
    if (kind === 'unsubscribed') {
      // Twilio error 21610: the carrier holds a STOP for this number. Record it; never clear it here.
      await setConsent(sql, workspace, row.company_id, row.contact_id, 'opted_out', 'opted_out', 'delivery_status', 'twilio', 'webhook');
      return;
    }
    await sql.query(`UPDATE sms_contacts SET textable=false,not_textable_reason=$2,updated_at=clock_timestamp() WHERE id=$1`, [row.contact_id, kind]);
    await sql.query(`INSERT INTO sms_consent_events(workspace_id,id,company_id,contact_id,event,source,recorded_by) VALUES($1,$2,$3,$4,'not_textable','delivery_status','worker')`, [workspace, randomUUID(), row.company_id, row.contact_id]);
    await audit(sql, workspace, 'worker', 'worker', 'contact.not_textable', row.contact_id, null, { reason: kind });
  }
  /** Signed status callback. Forward-only; duplicates and older states are recorded and ignored. */
  async statusCallback(sql: Sql, workspace: string, messageId: string, params: Record<string, string>) {
    const status = (params.MessageStatus ?? '').toLowerCase(), sid = params.MessageSid ?? '';
    const row = (await sql.query<MessageRow>('SELECT *,send_day::text AS send_day FROM sms_messages WHERE id=$1 FOR UPDATE', [messageId])).rows[0];
    if (!row || (row.provider_sid && row.provider_sid !== sid)) return false;
    const current = row.state === 'accepted' ? 'accepted' : row.state;
    const rank = (state: string) => messageRank[state] ?? (['calling', 'uncertain', 'admitted', 'pending'].includes(state) ? 0 : 5);
    if (rank(status) <= rank(current === 'accepted' ? 'accepted' : current)) return true;
    if (['calling', 'uncertain'].includes(row.state)) await this.release(sql, row, true);
    if (status === 'sent' || status === 'sending') {
      await sql.query(`UPDATE sms_messages SET state='accepted',provider_sid=coalesce(provider_sid,$2),updated_at=clock_timestamp() WHERE id=$1`, [row.id, sid]);
    } else if (['delivered', 'undelivered', 'failed', 'read'].includes(status)) {
      const final = status === 'read' ? 'delivered' : status;
      await sql.query(`UPDATE sms_messages SET state=$2,provider_sid=coalesce(provider_sid,$3),reason=$4,updated_at=clock_timestamp() WHERE id=$1`, [row.id, final, sid, params.ErrorCode ? 'twilio_' + params.ErrorCode : null]);
      if (row.contact_id && final === 'delivered') await sql.query('UPDATE sms_contacts SET consecutive_temp_failures=0 WHERE id=$1', [row.contact_id]);
      if (row.contact_id && final !== 'delivered') {
        if (params.ErrorCode && permanentStatusCodes.has(params.ErrorCode)) await this.permanentFailure(sql, workspace, row, params.ErrorCode === '30006' ? 'landline' : 'permanent_failure');
        else if (params.ErrorCode === '21610') await this.permanentFailure(sql, workspace, row, 'unsubscribed');
        else {
          const limit = (await readSettings(sql, workspace)).consecutive_failure_limit ?? 3;
          const failures = (await sql.query<{ n: number }>('UPDATE sms_contacts SET consecutive_temp_failures=consecutive_temp_failures+1 WHERE id=$1 RETURNING consecutive_temp_failures n', [row.contact_id])).rows[0]!.n;
          if (failures >= limit) await this.permanentFailure(sql, workspace, row, 'repeated_failures');
        }
      }
    }
    await audit(sql, workspace, 'twilio', 'webhook', 'message.status', row.id, { state: row.state }, { status, error: params.ErrorCode ?? null });
    await this.finishSend(sql, row.send_id);
    return true;
  }
  /** Inbound text to one of the workspace's numbers. STOP/HELP/START/YES first; other replies are forwarded. */
  async inbound(sql: Sql, workspace: string, numberId: string, params: Record<string, string>, settings: SettingValues) {
    const from = params.From ?? '', body = (params.Body ?? '').slice(0, 1600), sid = params.MessageSid ?? '';
    const exists = (await sql.query('SELECT 1 FROM sms_inbound WHERE provider_sid=$1', [sid])).rowCount;
    if (exists) return { duplicate: true as const };
    const number = (await sql.query<{ carrier_brand_id: string; company_id: string; help_contact: string }>(`SELECT n.carrier_brand_id,b.company_id,b.help_contact FROM sms_numbers n JOIN sms_carrier_brands b ON b.id=n.carrier_brand_id WHERE n.id=$1`, [numberId])).rows[0]!;
    const contact = (await sql.query<ContactRow>('SELECT * FROM sms_contacts WHERE phone_e164=$1', [from])).rows[0];
    const keyword = body.trim().toUpperCase().replace(/[^\p{L}\p{N}]+$/u, '');
    const has = (list: string[] | undefined) => !!list?.includes(keyword);
    const consent = contact ? (await sql.query<{ state: ConsentState }>('SELECT state FROM sms_consents WHERE company_id=$1 AND contact_id=$2', [number.company_id, contact.id])).rows[0]?.state ?? 'none' : 'none';
    let classification: 'stop' | 'help' | 'start' | 'confirm' | 'other' | 'unknown_number';
    if (!contact) classification = 'unknown_number'; // INB-6: logged, never added as a contact
    else if (has(settings.opt_out_words)) classification = 'stop';
    else if (has(settings.help_words)) classification = 'help';
    else if (has(settings.start_words)) classification = 'start';
    else if (has(settings.confirm_words) && consent === 'pending_confirmation') classification = 'confirm';
    else classification = 'other';
    const id = randomUUID();
    await sql.query(`INSERT INTO sms_inbound(workspace_id,id,number_id,from_e164,contact_id,body,provider_sid,classification,forward_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [workspace, id, numberId, from, contact?.id ?? null, body, sid, classification, classification === 'other' ? 'queued' : 'none']);
    if (contact) {
      if (classification === 'stop') await setConsent(sql, workspace, number.company_id, contact.id, 'opted_out', 'opted_out', 'inbound_sms', 'contact', 'webhook', { messageId: sid });
      if (classification === 'start' && ['opted_out', 'pending_reenrollment'].includes(consent)) await setConsent(sql, workspace, number.company_id, contact.id, 'opted_in', 'opted_in_start', 'inbound_sms', 'contact', 'webhook', { messageId: sid });
      if (classification === 'confirm') await setConsent(sql, workspace, number.company_id, contact.id, 'opted_in', 'confirmed', 'inbound_sms', 'contact', 'webhook', { messageId: sid });
      if (classification === 'help') {
        await sql.query(`INSERT INTO sms_consent_events(workspace_id,id,company_id,contact_id,event,source,evidence_message_id,recorded_by) VALUES($1,$2,$3,$4,'help','inbound_sms',$5,'contact')`, [workspace, randomUUID(), number.company_id, contact.id, sid]);
        await queueText(sql, workspace, { companyId: number.company_id, contactId: contact.id, purpose: 'help', to: from, body: helpText(await businessName(sql, number.company_id), number.help_contact) });
      }
    }
    await audit(sql, workspace, 'twilio', 'webhook', 'inbound.' + classification, id, null, { contact: contact?.id ?? null });
    return { duplicate: false as const, id, classification, contactName: contact?.name ?? null };
  }
  /** INB-4: forward other replies to the notification email. Bodies stay out of logs. */
  async forwardPending(workspace: string) {
    const forward = this.options.forward;
    const ids = await this.options.db.read(workspace, async sql => (await sql.query<{ id: string }>(
      "SELECT id FROM sms_inbound WHERE forward_state='queued' ORDER BY received_at,id LIMIT 10",
    )).rows);
    for (const { id } of ids) {
      const item = await this.options.db.tenant(workspace, async sql => (await sql.query<{
        id: string; body: string; from_e164: string; name: string | null; email: string | null; forward_state: string;
      }>(`WITH recipient AS (SELECT (SELECT notification_email FROM sms_workspace_profile) AS email)
        UPDATE sms_inbound i SET forward_state=CASE
          WHEN r.email IS NULL THEN 'failed'
          WHEN $2::boolean THEN 'uncertain' ELSE 'captured' END
        FROM recipient r WHERE i.id=$1 AND i.forward_state='queued'
        RETURNING i.id,i.body,i.from_e164,
          (SELECT c.name FROM sms_contacts c WHERE c.id=i.contact_id) AS name,
          r.email,i.forward_state`, [id, Boolean(forward)])).rows[0]);
      // Commit the claim before submitting. Once acceptance is ambiguous, keep it visible
      // for reconciliation instead of replaying the reply against a possibly changed address.
      if (!item?.email || !forward || item.forward_state !== 'uncertain') continue;
      const to = item.email;
      const name = item.name?.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() || 'a contact';
      await this.options.db.tenant(workspace, async sql => {
        await lockWorkspace(sql, workspace);
        const currentAddress = (await sql.query<{ notification_email: string | null }>(
          'SELECT notification_email FROM sms_workspace_profile',
        )).rows[0]?.notification_email;
        const state = currentAddress === to ? await forward({
          id, to, subject: 'Text reply from ' + name,
          text: `${name} (${item.from_e164}) replied:\n\n${item.body}`,
        }).catch(() => 'uncertain' as const) : 'failed';
        if (state !== 'uncertain') await sql.query(
          "UPDATE sms_inbound SET forward_state=$2 WHERE id=$1 AND forward_state='uncertain'", [id, state],
        );
      });
    }
    if (ids.length < 10) return null;
    const more = await this.options.db.read(workspace, async sql => Boolean((await sql.query(
      "SELECT 1 FROM sms_inbound WHERE forward_state='queued' LIMIT 1",
    )).rowCount));
    return more ? this.now() : null;
  }
  /** Unconfirmed numbers expire after the configured period, with no text sent. */
  private async expirePending(sql: Sql, workspace: string) {
    const expired = (await sql.query<{ company_id: string; contact_id: string }>(`SELECT company_id,contact_id FROM sms_consents WHERE state='pending_confirmation' AND pending_expires_at<=clock_timestamp() LIMIT 20`)).rows;
    for (const row of expired) await setConsent(sql, workspace, row.company_id, row.contact_id, 'none', 'expired', 'worker', 'worker', 'worker');
  }
}
