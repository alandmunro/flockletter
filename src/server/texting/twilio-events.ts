import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database, Sql } from '../db.js';
import { AppError, requireCondition } from '../errors.js';
import { lockWorkspace } from '../workspace-lock.js';
import type { TextingRegistration } from './registration.js';
import { audit, requestHash } from './storage.js';
import { verifyTwilioSignature } from './twilio.js';

const prefix = 'com.twilio.messaging.compliance.';
const events = z.array(z.object({
  id: z.string().min(1).max(100), type: z.string().max(120),
  time: z.iso.datetime({ offset: true }),
  data: z.object({
    accountsid: z.string().regex(/^AC[0-9a-f]{32}$/).optional(),
    brandsid: z.string().regex(/^BN[0-9a-f]{32}$/).optional(),
    messagingservicesid: z.string().regex(/^MG[0-9a-f]{32}$/).optional(),
    phonenumbersid: z.string().regex(/^PN[0-9a-f]{32}$/).optional(),
    externalstatus: z.string().max(48).optional(),
    updateddate: z.number().int().positive().max(8640000000000000).optional(),
  }).passthrough(),
})).min(1).max(100);
type Event = z.infer<typeof events>[number];
const numberStates: Record<string, 'active' | 'reserved'> = {
  'number-registration.successful': 'active',
  'number-registration.failed': 'reserved',
  'number-deregistration.pending': 'reserved',
  'number-deregistration.successful': 'reserved',
};

export async function receiveCarrierEvents(db: Database, registration: TextingRegistration, url: string, raw: Buffer, signature: string) {
  const hashes = new URL(url).searchParams.getAll('bodySHA256');
  requireCondition(hashes.length === 1 && hashes[0] === createHash('sha256').update(raw).digest('hex'),
    403, 'signature_rejected', 'The Twilio event body did not match the signed request.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); }
  catch { throw new AppError(400, 'invalid_twilio_events', 'Send the Twilio Event Streams JSON array.'); }
  const list = events.safeParse(parsed);
  requireCondition(list.success, 400, 'invalid_twilio_events', 'Send the Twilio Event Streams JSON array.');
  const supported = list.data.filter(event => event.type.startsWith(prefix));
  if (!supported.length) return null;
  const sid = supported[0]!.data.accountsid;
  requireCondition(sid && supported.every(event => event.data.accountsid === sid), 403, 'signature_rejected', 'The Twilio event account did not match.');
  const workspace = (await db.pool.query<{ workspace: string | null }>(
    'SELECT flockletter_customer_jobs.texting_route_account($1) workspace', [sid])).rows[0]?.workspace;
  requireCondition(workspace, 403, 'signature_rejected', 'The Twilio event account is unknown.');
  await db.tenant(workspace, async sql => {
    await lockWorkspace(sql, workspace);
    const account = await registration.account(sql, workspace);
    requireCondition(account?.accountSid === sid && verifyTwilioSignature(url, {}, signature, account.authToken),
      403, 'signature_rejected', 'The Twilio event signature is invalid.');
    for (const event of supported) {
      const key = 'twilio-stream:' + event.id, digest = requestHash(event);
      const marked = await sql.query(`INSERT INTO sms_provider_events(workspace_id,event_key,digest) VALUES($1,$2,$3)
        ON CONFLICT DO NOTHING`, [workspace, key, digest]);
      if (marked.rowCount) await applyEvent(sql, registration, workspace, sid, event);
      else {
        const prior = (await sql.query<{ digest: string }>('SELECT digest FROM sms_provider_events WHERE event_key=$1', [key])).rows[0];
        requireCondition(prior?.digest === digest, 409, 'event_conflict', 'This carrier event identifier has different content.');
      }
    }
  });
  return workspace;
}

async function applyEvent(sql: Sql, registration: TextingRegistration, workspace: string, account: string, event: Event) {
  const kind = event.type.slice(prefix.length);
  const { brandsid, messagingservicesid, phonenumbersid, externalstatus, updateddate } = event.data;
  if (brandsid && ['brand-registration.brand-verified', 'brand-registration.brand-vetted-verified', 'brand-registration.brand-failure',
    'brand-registration.brand-unverified', 'brand-registration.brand-secondary-vetting-failure'].includes(kind)) {
    const owned = await sql.query('SELECT 1 FROM sms_registrations WHERE account_sid=$1 AND brand_sid=$2', [account, brandsid]);
    const status = kind.endsWith('verified') && !kind.endsWith('unverified') ? 'VERIFIED' : 'FAILED';
    if (owned.rowCount) await registration.status(sql, workspace, 'brand', brandsid, status, null, 'webhook');
  }
  // Campaign Event Streams may carry an external Campaign Registry SID rather than our QE SID.
  // Request an authoritative read of the exact Messaging Service instead of matching those SIDs.
  if (kind.startsWith('campaign-registration.') && messagingservicesid)
    await sql.query(`UPDATE sms_registrations SET status_checked_at=NULL WHERE account_sid=$1 AND messaging_service_sid=$2
      AND state='campaign_pending'`, [account, messagingservicesid]);
  if (!Object.hasOwn(numberStates, kind) || !phonenumbersid || !messagingservicesid) return;
  const next = numberStates[kind]!;
  if (next === 'active' && externalstatus !== 'registered') return;
  const row = (await sql.query<{ number_id: string; number_state: string; registration_id: string; registration_state: string; operation_key: string; last_event: string | null }>(`
    SELECT n.id number_id,n.state number_state,r.id registration_id,r.state registration_state,s.operation_key,s.facts->>'numberEventAt' last_event
    FROM sms_numbers n JOIN sms_registrations r ON r.carrier_brand_id=n.carrier_brand_id
    JOIN sms_registration_steps s ON s.registration_id=r.id AND s.revision=r.revision AND s.step='number' AND s.provider_sid=n.provider_sid
    WHERE r.account_sid=$1 AND r.messaging_service_sid=$2 AND n.messaging_service_sid=$2 AND n.provider_sid=$3 AND n.state<>'released'`,
  [account, messagingservicesid, phonenumbersid])).rows[0];
  const time = updateddate ?? Date.parse(event.time);
  if (!row || (row.last_event && (Number(row.last_event) > time ||
    (Number(row.last_event) === time && next === 'active')))) return;
  await sql.query("UPDATE sms_registration_steps SET facts=facts||jsonb_build_object('numberEventAt',$2::bigint),reason=$3 WHERE operation_key=$1",
    [row.operation_key, time, next === 'reserved' ? 'number_registration_attention' : null]);
  await sql.query("UPDATE sms_numbers SET state=$2,updated_at=clock_timestamp() WHERE id=$1", [row.number_id, next]);
  if (next === 'reserved' && ['approved', 'campaign_pending'].includes(row.registration_state))
    await sql.query("UPDATE sms_registrations SET state='suspended',rejection_reason='number_registration_attention',updated_at=clock_timestamp() WHERE id=$1", [row.registration_id]);
  await audit(sql, workspace, 'twilio', 'webhook', 'registration.number_status', row.registration_id,
    { state: row.number_state }, { state: next, event: kind });
}
