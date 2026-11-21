// The texting add-on behind the one command layer (customer `sms.*` and operator `platform.texting*`),
// plus its worker pass, signed webhooks, short-link redirects and the sign-up page hook.
import { businessRefusals, twilioBusiness } from '../../shared/texting-business.js';
import { randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Database, Sql } from '../db.js';
import { lockWorkspace } from '../workspace-lock.js';
import { AppError, requireCondition } from '../errors.js';
import type { Actor } from '../service.js';
import { safeLink } from '../content.js';
import { blockedCharacters, composeBroadcast, encodeText, findLinks, isTextingSetting, maxSegments, plainText, smsConsentPolicyVersion, smsConsentWording, confirmationText,
  textingCommands, textingSettingKeys, textingSettingValue, textingSettings, normalizeUsPhone, type ConsentState, type TextingCommand, type TextingSettingKey } from '../../shared/texting.js';
import { textingPlatformCommands, type TextingPlatformCommand } from '../../shared/texting-platform.js';
import { audit, once, readSettings, requestHash, requireSettings, sendingSettings, validZone, type Interface } from './storage.js';
import { TextingRegistration, type RegistrationRow, type StepRow } from './registration.js';
import { TextingMessaging, businessName, queueText, sendingNumber, setConsent, type Forward } from './messaging.js';
import { CredentialSeal, verifyTwilioSignature, type AccountCredentials, type TwilioMessagingPort, type TwilioPlatformPort } from './twilio.js';
import { TwilioMockMessaging, TwilioMockPlatform, TwilioMockState } from './twilio-mock.js';

export type TextingMode = 'off' | 'mock' | 'live';
export type TextingOptions = {
  mode: TextingMode; origin: string; linkOrigin: string; seal: CredentialSeal;
  platform: TwilioPlatformPort; port: TwilioMessagingPort; liveAccount?: AccountCredentials;
  forward?: Forward; isOwner: (user: string, workspace: string) => Promise<boolean>;
  wake?: (workspace: string) => Promise<void>; now?: () => Date;
};
export type OperatorActor = { userId: string; via: 'operator_ui' | 'operator_api' | 'operator_mcp' };
const unavailable = (what = 'item') => new AppError(404, 'not_found', `This ${what} is unavailable in this workspace.`);
const linkCode = () => { const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; return Array.from({ length: 7 }, () => alphabet[randomInt(alphabet.length)]).join(''); };
type SendRow = { id: string; company_id: string; kind: string; body: string; state: string; revision: number; scheduled_at: Date | null; confirmation: unknown; created_by: string };
type Recipient = { id: string; phone_e164: string; name: string | null };

export class Texting {
  readonly registration: TextingRegistration;
  readonly messaging: TextingMessaging;
  readonly mock?: { state: TwilioMockState; platform: TwilioMockPlatform; messaging: TwilioMockMessaging };
  constructor(readonly db: Database, readonly options: TextingOptions) {
    this.registration = new TextingRegistration({ db, platform: options.platform, seal: options.seal, origin: options.origin, ...(options.liveAccount ? { liveAccount: options.liveAccount } : {}), ...(options.now ? { now: options.now } : {}) });
    this.messaging = new TextingMessaging({ db, port: options.port, seal: options.seal, origin: options.origin, ...(options.forward ? { forward: options.forward } : {}), ...(options.now ? { now: options.now } : {}) });
    if (options.platform instanceof TwilioMockPlatform && options.port instanceof TwilioMockMessaging) this.mock = { state: options.platform.state, platform: options.platform, messaging: options.port };
  }
  static mock(db: Database, options: Omit<TextingOptions, 'mode' | 'platform' | 'port' | 'seal'>) {
    const state = new TwilioMockState(db);
    return new Texting(db, { ...options, mode: 'mock', seal: CredentialSeal.mock(), platform: new TwilioMockPlatform(state), port: new TwilioMockMessaging(state) });
  }
  owns(name: string): name is TextingCommand { return Object.hasOwn(textingCommands, name); }
  private now() { return this.options.now?.() ?? new Date(); }
  private async wake(workspace: string) { await this.options.wake?.(workspace).catch(() => undefined); }
  private enabled() { requireCondition(this.options.mode !== 'off', 503, 'texting_off', 'Texting is not enabled in this environment.'); }

  // ---------------- Customer commands ----------------
  async execute(name: TextingCommand, raw: unknown, actor: Actor, via: Interface): Promise<unknown> {
    this.enabled();
    textingCommands[name].schema.parse(raw);
    if (textingCommands[name].scope === 'owner' && textingCommands[name].mutation)
      requireCondition(await this.options.isOwner(actor.userId, actor.workspaceId), 403, 'owner_required', 'Current workspace ownership is required.');
    const w = actor.workspaceId;
    const write = <T>(input: { operationKey: string }, action: (sql: Sql) => Promise<T>) => this.db.tenant(w, async sql => { await lockWorkspace(sql, w); return once(sql, w, actor.actorId, input.operationKey, [name, input], () => action(sql)); });
    switch (name) {
      case 'sms.status': return this.db.read(w, sql => this.status(sql, w));
      case 'sms.configure': { const p = textingCommands['sms.configure'].schema.parse(raw); return write(p, sql => this.configure(sql, w, actor, via, p)); }
      case 'sms.contacts': { const p = textingCommands['sms.contacts'].schema.parse(raw); return this.db.read(w, sql => this.contacts(sql, p)); }
      case 'sms.addContact': { const p = textingCommands['sms.addContact'].schema.parse(raw); return write(p, sql => this.addContact(sql, w, actor, via, p)); }
      case 'sms.inbound': { const p = textingCommands['sms.inbound'].schema.parse(raw); return this.db.read(w, async sql => (await sql.query(`SELECT i.id,i.from_e164 AS "from",i.body,i.classification,i.forward_state AS "forwardState",i.received_at AS "receivedAt",c.name AS "contactName"
        FROM sms_inbound i LEFT JOIN sms_contacts c ON c.id=i.contact_id WHERE ($1::uuid IS NULL OR i.received_at<(SELECT received_at FROM sms_inbound WHERE id=$1)) ORDER BY i.received_at DESC LIMIT $2`, [p.cursor ?? null, p.limit])).rows); }
      case 'sms.draft': { const p = textingCommands['sms.draft'].schema.parse(raw); return write(p, sql => this.draft(sql, w, actor, via, p)); }
      case 'sms.preview': { const p = textingCommands['sms.preview'].schema.parse(raw); return this.db.read(w, async sql => this.snapshot(sql, w, await this.send(sql, p.id), false)); }
      case 'sms.review': { const p = textingCommands['sms.review'].schema.parse(raw); return this.db.read(w, async sql => this.snapshot(sql, w, await this.send(sql, p.id, p.expectedRevision), true)); }
      case 'sms.confirm': { const p = textingCommands['sms.confirm'].schema.parse(raw); const result = await write(p, sql => this.confirm(sql, w, actor, via, p)); await this.wake(w); return result; }
      case 'sms.pause': case 'sms.resume': case 'sms.cancel': { const p = textingCommands['sms.pause'].schema.parse(raw); const result = await write(p, sql => this.control(sql, w, actor, via, name, p.id)); await this.wake(w); return result; }
      case 'sms.sendStatus': { const p = textingCommands['sms.sendStatus'].schema.parse(raw); return this.db.read(w, async sql => {
        const send = await this.send(sql, p.id);
        const counts = (await sql.query<{ state: string; reason: string | null; n: number }>('SELECT state,reason,count(*)::int n FROM sms_messages WHERE send_id=$1 GROUP BY state,reason ORDER BY state,reason', [send.id])).rows;
        return { id: send.id, state: send.state, revision: send.revision, scheduledAt: send.scheduled_at, confirmation: send.confirmation, counts };
      }); }
      case 'sms.verifyPhone': { const p = textingCommands['sms.verifyPhone'].schema.parse(raw); const result = await write(p, sql => this.verifyPhone(sql, w, actor, via, p.phone)); await this.wake(w); return result; }
      case 'sms.confirmPhone': { const p = textingCommands['sms.confirmPhone'].schema.parse(raw); return write(p, sql => this.confirmPhone(sql, w, actor, via, p.code)); }
      case 'sms.testSend': { const p = textingCommands['sms.testSend'].schema.parse(raw); const result = await write(p, sql => this.testSend(sql, w, actor, via, p.id, p.expectedRevision)); await this.wake(w); return result; }
    }
  }
  private async profile(sql: Sql) {
    return (await sql.query<{ short_name: string | null; short_name_changed_at: Date | null; notification_email: string | null; time_zone: string; phone_field: boolean; birthday_field: boolean; anniversary_field: boolean; anniversary_label: string; revision: number }>('SELECT * FROM sms_workspace_profile')).rows[0] ?? null;
  }
  private async status(sql: Sql, w: string) {
    const settings = await readSettings(sql, w), profile = await this.profile(sql);
    const companies = (await sql.query<{ id: string; name: string; carrier_brand_id: string | null; registration: string | null; registration_state: string | null; e164: string | null; number_state: string | null }>(`
      SELECT c.id,c.name,b.id carrier_brand_id,r.id registration,r.state registration_state,n.e164,n.state number_state FROM companies c
      LEFT JOIN sms_carrier_brands b ON b.company_id=c.id LEFT JOIN sms_registrations r ON r.carrier_brand_id=b.id
      LEFT JOIN sms_numbers n ON n.carrier_brand_id=b.id AND n.state<>'released' ORDER BY c.name`)).rows;
    const usage = (await sql.query<{ segments_used: number; segments_reserved: number }>(`SELECT segments_used,segments_reserved FROM sms_usage WHERE period_month=$1::date`, [this.now().toISOString().slice(0, 8) + '01'])).rows[0];
    const missing = textingSettingKeys.filter(key => ['sending', 'always'].includes(textingSettings[key].required) && settings[key] === undefined);
    if (settings.reconcile_settle_minutes === undefined && (await sql.query(`SELECT 1 FROM sms_registration_steps s JOIN sms_registrations r ON r.id=s.registration_id AND r.revision=s.revision WHERE s.state='uncertain' LIMIT 1`)).rowCount) missing.push('reconcile_settle_minutes');
    return { mode: this.options.mode, profile: profile ? { shortName: profile.short_name, notificationEmail: profile.notification_email, timeZone: profile.time_zone,
        phoneField: profile.phone_field, birthdayField: profile.birthday_field, anniversaryField: profile.anniversary_field, anniversaryLabel: profile.anniversary_label, revision: profile.revision } : null,
      companies: companies.map(c => ({ id: c.id, name: c.name, carrierBrand: !!c.carrier_brand_id, registration: c.registration_state ?? 'not_started', number: c.e164, numberState: c.number_state,
        canSend: c.registration_state === 'approved' && c.number_state === 'active' })),
      usage: { month: this.now().toISOString().slice(0, 7), used: usage?.segments_used ?? 0, reserved: usage?.segments_reserved ?? 0, allowance: settings.monthly_segment_allowance ?? null },
      settingsNeeded: missing };
  }
  private async configure(sql: Sql, w: string, actor: Actor, via: Interface, p: { expectedRevision: number; shortName?: string; notificationEmail?: string | null; timeZone?: string; phoneField?: boolean; birthdayField?: boolean; anniversaryField?: boolean; anniversaryLabel?: string }) {
    let profile = await this.profile(sql);
    if (!profile) { await sql.query('INSERT INTO sms_workspace_profile(workspace_id) VALUES($1)', [w]); profile = (await this.profile(sql))!; }
    requireCondition(profile.revision === p.expectedRevision, 409, 'revision_conflict', 'These settings changed. Reload and try again.');
    if (p.timeZone !== undefined) requireCondition(validZone(p.timeZone) && /^America\/|^Pacific\/Honolulu$/.test(p.timeZone), 422, 'invalid_time_zone', 'Choose a US time zone.');
    if (p.shortName !== undefined && p.shortName !== profile.short_name) {
      const settings = requireSettings(await readSettings(sql, w), ['short_name_change_days', 'short_name_hold_days']);
      const recent = (await sql.query<{ recent: boolean }>('SELECT coalesce(short_name_changed_at>clock_timestamp()-make_interval(days=>$1),false) recent FROM sms_workspace_profile', [settings.short_name_change_days])).rows[0]!.recent;
      requireCondition(!recent,
        409, 'short_name_recently_changed', `The short name can change once every ${settings.short_name_change_days} days.`);
      const claimed = (await sql.query<{ ok: boolean }>('SELECT flockletter_customer_jobs.texting_claim_short_name($1,$2,$3) ok', [w, p.shortName, settings.short_name_hold_days])).rows[0]!.ok;
      requireCondition(claimed, 409, 'short_name_taken', 'This short name is not available.');
      // The old name keeps resolving for links already sent; it is held from other workspaces.
      if (profile.short_name) await sql.query('SELECT flockletter_customer_jobs.texting_release_short_name($1,$2)', [w, profile.short_name]);
    }
    const next = { short_name: p.shortName ?? profile.short_name, notification_email: p.notificationEmail === undefined ? profile.notification_email : p.notificationEmail,
      time_zone: p.timeZone ?? profile.time_zone, phone_field: p.phoneField ?? profile.phone_field, birthday_field: p.birthdayField ?? profile.birthday_field,
      anniversary_field: p.anniversaryField ?? profile.anniversary_field, anniversary_label: p.anniversaryLabel ?? profile.anniversary_label };
    await sql.query(`UPDATE sms_workspace_profile SET short_name=$1,notification_email=$2,time_zone=$3,phone_field=$4,birthday_field=$5,anniversary_field=$6,anniversary_label=$7,
      short_name_changed_at=CASE WHEN $1 IS DISTINCT FROM short_name THEN clock_timestamp() ELSE short_name_changed_at END,revision=revision+1,updated_at=clock_timestamp()`,
      [next.short_name, next.notification_email, next.time_zone, next.phone_field, next.birthday_field, next.anniversary_field, next.anniversary_label]);
    const old = { short_name: profile.short_name, notification_email: profile.notification_email, time_zone: profile.time_zone, phone_field: profile.phone_field,
      birthday_field: profile.birthday_field, anniversary_field: profile.anniversary_field, anniversary_label: profile.anniversary_label };
    await audit(sql, w, actor.actorId, via, 'texting.configure', null, old, next);
    return { revision: profile.revision + 1, ...next };
  }
  private async contacts(sql: Sql, p: { filter: string; cursor?: string; limit: number }) {
    const rows = (await sql.query(`SELECT c.id,c.phone_e164 AS phone,c.name,c.textable,c.not_textable_reason AS "notTextableReason",
      coalesce(json_agg(json_build_object('companyId',s.company_id,'state',s.state)) FILTER (WHERE s.company_id IS NOT NULL),'[]') AS consents
      FROM sms_contacts c LEFT JOIN sms_consents s ON s.contact_id=c.id
      WHERE ($1::uuid IS NULL OR c.id>$1) AND ($2='all' OR ($2='not_textable' AND NOT c.textable)
        OR ($2='opted_out' AND EXISTS(SELECT FROM sms_consents x WHERE x.contact_id=c.id AND x.state='opted_out'))
        OR ($2='pending' AND EXISTS(SELECT FROM sms_consents x WHERE x.contact_id=c.id AND x.state IN ('pending_confirmation','pending_reenrollment'))))
      GROUP BY c.workspace_id,c.id ORDER BY c.id LIMIT $3`, [p.cursor ?? null, p.filter, p.limit])).rows;
    return { contacts: rows, next: rows.length === p.limit ? (rows.at(-1) as { id: string }).id : null };
  }
  private async company(sql: Sql, id: string) { requireCondition((await sql.query('SELECT 1 FROM companies WHERE id=$1', [id])).rowCount, 404, 'not_found', 'This company is unavailable.'); }
  private async upsertContact(sql: Sql, w: string, phone: string, extra: { name?: string | null; brandId?: string | null; subscriberId?: string | null }) {
    const existing = (await sql.query<{ id: string }>('SELECT id FROM sms_contacts WHERE phone_e164=$1', [phone])).rows[0];
    if (existing) {
      await sql.query('UPDATE sms_contacts SET name=coalesce($2,name),brand_id=coalesce(brand_id,$3),subscriber_id=coalesce(subscriber_id,$4),updated_at=clock_timestamp() WHERE id=$1', [existing.id, extra.name ?? null, extra.brandId ?? null, extra.subscriberId ?? null]);
      return { id: existing.id, created: false };
    }
    const id = randomUUID();
    await sql.query('INSERT INTO sms_contacts(workspace_id,id,phone_e164,name,brand_id,subscriber_id) VALUES($1,$2,$3,$4,$5,$6)', [w, id, phone, extra.name ?? null, extra.brandId ?? null, extra.subscriberId ?? null]);
    return { id, created: true };
  }
  private async addContact(sql: Sql, w: string, actor: Actor, via: Interface, p: { companyId: string; phone: string; name?: string; acknowledgeOptOut: boolean }) {
    await this.company(sql, p.companyId);
    const contact = await this.upsertContact(sql, w, p.phone, { name: p.name ?? null });
    const consent = (await sql.query<{ state: ConsentState }>('SELECT state FROM sms_consents WHERE company_id=$1 AND contact_id=$2', [p.companyId, contact.id])).rows[0]?.state ?? null;
    if (consent === 'opted_out') {
      requireCondition(p.acknowledgeOptOut, 409, 'reenrollment_acknowledgement_required',
        'This contact opted out. They will receive no texts until they text START to your number. Confirm to add them as pending re-enrollment.');
      await setConsent(sql, w, p.companyId, contact.id, 'pending_reenrollment', 'reenrollment_pending', 'owner', actor.actorId, via);
      return { contactId: contact.id, consent: 'pending_reenrollment', warning: 'No texts go out until the contact texts START.' };
    }
    if (consent === null) await sql.query(`INSERT INTO sms_consents(workspace_id,company_id,contact_id,state) VALUES($1,$2,$3,'none')`, [w, p.companyId, contact.id]);
    await audit(sql, w, actor.actorId, via, 'contact.add', contact.id, null, { company: p.companyId, consent: consent ?? 'none' });
    // Imports and manual adds never carry SMS consent (FL-SMS-005).
    return { contactId: contact.id, consent: consent ?? 'none' };
  }
  private checkBody(body: string) {
    const blocked = blockedCharacters(plainText(body));
    if (blocked.length) throw new AppError(422, 'text_characters_blocked', 'Remove emoji and decorative symbols: ' + blocked.join(' '), { characters: blocked });
    return plainText(body);
  }
  private async draft(sql: Sql, w: string, actor: Actor, via: Interface, p: { companyId: string; body: string; id?: string; expectedRevision?: number }) {
    await this.company(sql, p.companyId);
    const body = this.checkBody(p.body);
    if (p.id) {
      const send = await this.send(sql, p.id, p.expectedRevision);
      requireCondition(send.state === 'draft' && send.kind === 'broadcast', 409, 'send_not_editable', 'Only a draft can be edited.');
      requireCondition(send.company_id === p.companyId, 422, 'company_fixed', 'A draft stays with its company.');
      await sql.query('UPDATE sms_sends SET body=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1', [send.id, body]);
      await audit(sql, w, actor.actorId, via, 'send.draft', send.id, { body: send.body, revision: send.revision }, { body, revision: send.revision + 1 });
      return { id: send.id, revision: send.revision + 1, body };
    }
    const id = randomUUID();
    await sql.query(`INSERT INTO sms_sends(workspace_id,id,company_id,kind,body,state,created_by) VALUES($1,$2,$3,'broadcast',$4,'draft',$5)`, [w, id, p.companyId, body, actor.actorId]);
    await audit(sql, w, actor.actorId, via, 'send.draft', id, null, { body, revision: 1 });
    return { id, revision: 1, body };
  }
  private async send(sql: Sql, id: string, expectedRevision?: number) {
    const send = (await sql.query<SendRow>('SELECT * FROM sms_sends WHERE id=$1', [id])).rows[0];
    if (!send) throw unavailable('text');
    if (expectedRevision !== undefined) requireCondition(send.revision === expectedRevision, 409, 'revision_conflict', 'This text changed. Review it again.');
    return send;
  }
  /** FL-SMS-010: only the workspace's verified domain or its Flockletter-hosted pages. */
  private async linkProblems(sql: Sql, companyId: string, body: string) {
    const links = findLinks(body);
    if (!links.length) return { links, problems: [] as string[] };
    const domains: string[] = [];
    for (const brand of (await sql.query<{ brand_id: string }>('SELECT brand_id FROM company_brands WHERE company_id=$1', [companyId])).rows) {
      await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [brand.brand_id]);
      domains.push(...(await sql.query<{ domain: string }>('SELECT domain FROM sender_domains WHERE verified_at IS NOT NULL')).rows.map(r => r.domain.toLowerCase()));
    }
    const app = new URL(this.options.origin);
    const problems = links.filter(link => {
      let url: URL; try { url = new URL(link); } catch { return true; }
      if (url.origin === app.origin && /^\/(signup|newsletter)\//.test(url.pathname)) return false;
      if (!safeLink(link)) return true;
      const host = url.hostname.toLowerCase();
      return !domains.some(domain => host === domain || host.endsWith('.' + domain));
    });
    return { links, problems };
  }
  private async recipients(sql: Sql, companyId: string) {
    return (await sql.query<Recipient>(`SELECT c.id,c.phone_e164,c.name FROM sms_consents s JOIN sms_contacts c ON c.id=s.contact_id
      WHERE s.company_id=$1 AND s.state='opted_in' AND c.textable ORDER BY c.id`, [companyId])).rows;
  }
  /** The exact confirmation shown before anything sends (FL-SMS-008/009/012, PAC-3). */
  private async snapshot(sql: Sql, w: string, send: SendRow, forConfirm: boolean) {
    const settings = await readSettings(sql, w), profile = await this.profile(sql);
    const business = await businessName(sql, send.company_id);
    const { links, problems } = await this.linkProblems(sql, send.company_id, send.body);
    const placeholder = `${this.options.linkOrigin}/${profile?.short_name ?? 'xxx'}/XXXXXXX`;
    const template = links.reduce((text, link) => text.split(link).join(placeholder), send.body);
    const people = await this.recipients(sql, send.company_id);
    let gsm7 = 0, ucs2 = 0, segments = 0, tooLong = 0;
    const perRecipient = people.map(person => {
      const encoded = encodeText(composeBroadcast(template, business, person));
      if (encoded.encoding === 'gsm7') gsm7++; else ucs2++;
      if (encoded.segments > maxSegments) tooLong++;
      segments += encoded.segments;
      return [person.id, encoded.segments] as const;
    });
    const sample = encodeText(composeBroadcast(template, business, { name: people[0]?.name ?? null }));
    const period = this.now().toISOString().slice(0, 8) + '01';
    const usage = (await sql.query<{ used: number; reserved: number; queued: number }>(`SELECT coalesce((SELECT segments_used FROM sms_usage WHERE period_month=$2::date),0)::int used,
      coalesce((SELECT segments_reserved FROM sms_usage WHERE period_month=$2::date),0)::int reserved,
      coalesce((SELECT sum(segments) FROM sms_messages WHERE state='pending' AND send_id IS DISTINCT FROM $1),0)::int queued`, [send.id, period])).rows[0]!;
    const allowance = settings.monthly_segment_allowance ?? null, daily = settings.carrier_daily_limit ?? null;
    const remaining = allowance === null ? null : Math.max(0, allowance - usage.used - usage.reserved - usage.queued);
    const digest = createHash('sha256').update(JSON.stringify({ send: send.id, revision: send.revision, body: send.body, recipients: perRecipient })).digest('hex');
    const gaps: string[] = [];
    if (problems.length) gaps.push('link_not_allowed');
    if (links.length && !profile?.short_name) gaps.push('short_name_required');
    if (tooLong) gaps.push('text_too_long');
    if (!people.length) gaps.push('no_opted_in_recipients');
    if (!await sendingNumber(sql, send.company_id)) gaps.push('registration_not_approved');
    try { requireSettings(settings, sendingSettings); } catch { gaps.push('texting_setting_required'); }
    if (remaining !== null && segments > remaining) gaps.push('allowance_insufficient');
    return { id: send.id, revision: send.revision, preview: sample.text, encoding: sample.encoding, perSegment: sample.perSegment,
      recipients: people.length, segments, gsm7Recipients: gsm7, ucs2Recipients: ucs2, allowance: { total: allowance, remaining, afterSend: remaining === null ? null : remaining - segments },
      daysNeeded: daily ? Math.max(1, Math.ceil(people.length / daily)) : null, links: links.map(link => ({ link, allowed: !problems.includes(link) })), gaps,
      ...(forConfirm ? { digest } : {}) };
  }
  private async confirm(sql: Sql, w: string, actor: Actor, via: Interface, p: { id: string; expectedRevision: number; digest: string; scheduledAt?: string }) {
    const send = await this.send(sql, p.id, p.expectedRevision);
    requireCondition(send.state === 'draft' && send.kind === 'broadcast', 409, 'send_not_draft', 'This text was already confirmed.');
    const snap = await this.snapshot(sql, w, send, true);
    requireCondition(snap.digest === p.digest, 409, 'review_changed', 'Recipients or the text changed since review. Review it again.');
    requireCondition(!snap.gaps.length, 409, 'send_not_ready', 'This text cannot be sent yet: ' + snap.gaps.join(', ') + '.', );
    const settings = requireSettings(await readSettings(sql, w), sendingSettings);
    const scheduledAt = p.scheduledAt ? new Date(p.scheduledAt) : null;
    if (scheduledAt) requireCondition(scheduledAt.getTime() > this.now().getTime() && scheduledAt.getTime() < this.now().getTime() + 90 * 86400000, 422, 'invalid_schedule', 'Schedule within the next 90 days.');
    const profile = (await this.profile(sql))!;
    // Rewrite each allowed link to the workspace short link (case-sensitive code).
    let body = send.body;
    for (const link of snap.links.map(l => l.link)) {
      const code = linkCode();
      const permanent = new URL(link).origin === new URL(this.options.origin).origin;
      await sql.query(`INSERT INTO sms_links(workspace_id,code,destination,expires_at) VALUES($1,$2,$3,CASE WHEN $4 THEN NULL ELSE clock_timestamp()+make_interval(days=>$5) END)`, [w, code, link, permanent, settings.link_life_days]);
      await sql.query('SELECT flockletter_customer_jobs.texting_register_link($1,$2,$3)', [w, profile.short_name, code]);
      body = body.split(link).join(`${this.options.linkOrigin}/${profile.short_name}/${code}`);
    }
    const business = await businessName(sql, send.company_id);
    for (const person of await this.recipients(sql, send.company_id))
      await queueText(sql, w, { sendId: send.id, companyId: send.company_id, contactId: person.id, purpose: 'broadcast', to: person.phone_e164, body: composeBroadcast(body, business, person), ...(scheduledAt ? { dueAt: scheduledAt } : {}) });
    const confirmation = { recipients: snap.recipients, segments: snap.segments, allowance: snap.allowance, daysNeeded: snap.daysNeeded, digest: snap.digest };
    await sql.query(`UPDATE sms_sends SET state=$2,scheduled_at=$3,confirmation=$4,confirmed_by=$5,confirmed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
      [send.id, scheduledAt ? 'scheduled' : 'confirmed', scheduledAt, JSON.stringify(confirmation), actor.actorId]);
    await audit(sql, w, actor.actorId, via, 'send.confirm', send.id, { state: 'draft' }, { state: scheduledAt ? 'scheduled' : 'confirmed', ...confirmation });
    return { id: send.id, state: scheduledAt ? 'scheduled' : 'confirmed', ...confirmation };
  }
  private async control(sql: Sql, w: string, actor: Actor, via: Interface, name: 'sms.pause' | 'sms.resume' | 'sms.cancel', id: string) {
    const send = await this.send(sql, id);
    const allowed = { 'sms.pause': ['confirmed', 'scheduled', 'running'], 'sms.resume': ['paused'], 'sms.cancel': ['draft', 'confirmed', 'scheduled', 'running', 'paused'] }[name];
    requireCondition(allowed.includes(send.state), 409, 'send_state', `This text is ${send.state}.`);
    const next = name === 'sms.pause' ? 'paused' : name === 'sms.resume' ? 'running' : 'cancelled';
    await sql.query('UPDATE sms_sends SET state=$2,updated_at=clock_timestamp() WHERE id=$1', [id, next]);
    if (next === 'cancelled') await sql.query(`UPDATE sms_messages SET state='cancelled',updated_at=clock_timestamp() WHERE send_id=$1 AND state IN ('pending','admitted')`, [id]);
    if (next === 'running') await this.messaging.finishSend(sql, id);
    await audit(sql, w, actor.actorId, via, name.replace('sms.', 'send.'), id, { state: send.state }, { state: next });
    return { id, state: next };
  }
  private codeDigest(w: string, user: string, code: string) { return createHash('sha256').update(`${w}:${user}:${code}`).digest('hex'); }
  private async anyNumber(sql: Sql) {
    const company = (await sql.query<{ company_id: string }>(`SELECT b.company_id FROM sms_carrier_brands b JOIN sms_registrations r ON r.carrier_brand_id=b.id AND r.state='approved'
      JOIN sms_numbers n ON n.carrier_brand_id=b.id AND n.state='active' ORDER BY b.created_at LIMIT 1`)).rows[0];
    requireCondition(company, 409, 'registration_not_approved', 'Texting starts once a company’s carrier registration is approved.');
    return company.company_id;
  }
  private async verifyPhone(sql: Sql, w: string, actor: Actor, via: Interface, phone: string) {
    const settings = requireSettings(await readSettings(sql, w), ['member_code_minutes', 'member_code_attempts']);
    const company = await this.anyNumber(sql);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await sql.query(`INSERT INTO sms_member_phones(workspace_id,user_id,phone_e164,code_digest,code_expires_at,code_attempts,verified_at) VALUES($1,$2,$3,$4,clock_timestamp()+make_interval(mins=>$5),0,NULL)
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET phone_e164=EXCLUDED.phone_e164,code_digest=EXCLUDED.code_digest,code_expires_at=EXCLUDED.code_expires_at,code_attempts=0,verified_at=NULL,updated_at=clock_timestamp()`,
      [w, actor.userId, phone, this.codeDigest(w, actor.userId, code), settings.member_code_minutes]);
    await queueText(sql, w, { companyId: company, contactId: null, purpose: 'verification', to: phone, body: `Flockletter: your verification code is ${code}. It expires in ${settings.member_code_minutes} minutes.` });
    await audit(sql, w, actor.actorId, via, 'member_phone.verify', actor.userId, null, { phone: phone.slice(0, -4) + '****' });
    return { sent: true, expiresInMinutes: settings.member_code_minutes };
  }
  private async confirmPhone(sql: Sql, w: string, actor: Actor, via: Interface, code: string) {
    const settings = requireSettings(await readSettings(sql, w), ['member_code_attempts']);
    const row = (await sql.query<{ code_digest: string | null; fresh: boolean; code_attempts: number }>('SELECT code_digest,coalesce(code_expires_at>clock_timestamp(),false) fresh,code_attempts FROM sms_member_phones WHERE user_id=$1 FOR UPDATE', [actor.userId])).rows[0];
    requireCondition(row?.code_digest && row.fresh && row.code_attempts < settings.member_code_attempts, 409, 'code_expired', 'Request a new code.');
    const ok = timingSafeEqual(Buffer.from(row.code_digest), Buffer.from(this.codeDigest(w, actor.userId, code)));
    if (!ok) { await sql.query('UPDATE sms_member_phones SET code_attempts=code_attempts+1 WHERE user_id=$1', [actor.userId]); return { verified: false }; }
    await sql.query('UPDATE sms_member_phones SET verified_at=clock_timestamp(),code_digest=NULL,code_expires_at=NULL WHERE user_id=$1', [actor.userId]);
    await audit(sql, w, actor.actorId, via, 'member_phone.confirmed', actor.userId, null, { verified: true });
    return { verified: true };
  }
  private async testSend(sql: Sql, w: string, actor: Actor, via: Interface, id: string, expectedRevision: number) {
    const settings = requireSettings(await readSettings(sql, w), ['test_texts_per_day']);
    const send = await this.send(sql, id, expectedRevision);
    requireCondition(send.kind === 'broadcast', 409, 'not_a_draft', 'Choose a draft text.');
    const phone = (await sql.query<{ phone_e164: string; verified_at: Date | null }>('SELECT phone_e164,verified_at FROM sms_member_phones WHERE user_id=$1', [actor.userId])).rows[0];
    requireCondition(phone?.verified_at, 409, 'phone_not_verified', 'Verify your own phone before sending a test.');
    requireCondition(await sendingNumber(sql, send.company_id), 409, 'registration_not_approved', 'Texting starts once this company’s registration is approved.');
    const today = this.now().toISOString().slice(0, 10);
    const used = (await sql.query<{ n: number }>(`SELECT count(*)::int n FROM sms_sends WHERE kind='test' AND test_day=$1`, [today])).rows[0]!.n;
    requireCondition(used < settings.test_texts_per_day, 429, 'test_limit', `The daily limit of ${settings.test_texts_per_day} test texts is used. Try again tomorrow.`);
    const testId = randomUUID();
    // The unique (day, slot) index stops two concurrent tests from sharing the last slot (D-047 pattern).
    await sql.query(`INSERT INTO sms_sends(workspace_id,id,company_id,kind,body,state,created_by,test_day,test_slot,confirmed_by,confirmed_at) VALUES($1,$2,$3,'test',$4,'running',$5,$6,$7,$5,clock_timestamp())`,
      [w, testId, send.company_id, send.body, actor.actorId, today, used + 1]);
    const business = await businessName(sql, send.company_id);
    await queueText(sql, w, { sendId: testId, companyId: send.company_id, contactId: null, purpose: 'test', to: phone.phone_e164, body: '[Test] ' + composeBroadcast(send.body, business, { name: null }) });
    await audit(sql, w, actor.actorId, via, 'send.test', testId, null, { draft: send.id, revision: send.revision });
    return { id: testId, remainingToday: settings.test_texts_per_day - used - 1 };
  }

  // ---------------- Sign-up page (FL-SMS-007) ----------------
  async signupFields(w: string) {
    if (this.options.mode === 'off') return null;
    return this.db.read(w, async sql => {
      const profile = await this.profile(sql);
      return profile ? { phone: profile.phone_field, birthday: profile.birthday_field, anniversary: profile.anniversary_field, anniversaryLabel: profile.anniversary_label } : null;
    });
  }
  /** What the hosted sign-up page shows: the workspace's optional fields, and the SMS checkbox wording if offered. */
  async signupView(sql: Sql, w: string, brandId: string, smsPreview = false) {
    if (this.options.mode === 'off') return null;
    const profile = await this.profile(sql);
    if (!profile || (!profile.phone_field && !profile.birthday_field && !profile.anniversary_field)) return null;
    const offer = profile.phone_field ? await this.smsOffer(sql, w, brandId, smsPreview) : null;
    return { phone: profile.phone_field, birthday: profile.birthday_field, anniversary: profile.anniversary_field, anniversaryLabel: profile.anniversary_label,
      smsWording: offer?.wording ?? null, smsTermsUrl: offer?.smsTermsUrl ?? null, privacyPolicyUrl: offer?.privacyPolicyUrl ?? null };
  }
  /**
   * The SMS checkbox shows only when the brand's company has an approved number. `preview` drops that one condition
   * for the view-only page carrier reviewers see before the number exists; it still needs the confirmed policies,
   * and a preview never records consent.
   */
  async smsOffer(sql: Sql, w: string, brandId: string, preview = false) {
    if (this.options.mode === 'off') return null;
    const company = (await sql.query<{ company_id: string }>('SELECT company_id FROM company_brands WHERE brand_id=$1', [brandId])).rows[0];
    if (!company || (!preview && !await sendingNumber(sql, company.company_id))) return null;
    const links = (await sql.query<{ sms_terms_url: string | null; privacy_policy_url: string | null }>(`SELECT profile->>'smsTermsUrl' sms_terms_url, profile->>'privacyPolicyUrl' privacy_policy_url
      FROM sms_carrier_brands WHERE company_id=$1 AND sms_terms_confirmed_at IS NOT NULL AND privacy_policy_confirmed_at IS NOT NULL`, [company.company_id])).rows[0];
    if (preview && !links?.sms_terms_url) return null;
    const settings = await readSettings(sql, w);
    if (settings.contact_monthly_limit === undefined || settings.unconfirmed_expiry_days === undefined) return null;
    const business = await businessName(sql, company.company_id);
    // A brand whose campaign covers stay texts shows (and records) the wider checkbox wording.
    const stayTexts = (await sql.query<{ stay: boolean | null }>(`SELECT (profile->'campaign'->>'stayTexts')::boolean stay FROM sms_carrier_brands WHERE company_id=$1`, [company.company_id])).rows[0]?.stay === true;
    return { companyId: company.company_id, wording: smsConsentWording(business, settings.contact_monthly_limit, stayTexts), policyVersion: smsConsentPolicyVersion(stayTexts), business, expiryDays: settings.unconfirmed_expiry_days,
      smsTermsUrl: links?.sms_terms_url ?? null, privacyPolicyUrl: links?.privacy_policy_url ?? null };
  }
  async recordSignup(sql: Sql, w: string, brandId: string, subscriberId: string | null, input: { phone?: string; smsConsent?: boolean; wordingShown?: string; birthday?: { month: number; day: number }; anniversary?: { month: number; day: number; year?: number } }) {
    if (this.options.mode === 'off') return;
    const fields = await this.profile(sql);
    if (!fields) return;
    const phone = fields.phone_field && input.phone ? normalizeUsPhone(input.phone) : null;
    requireCondition(!input.phone || !fields.phone_field || phone, 422, 'invalid_phone', 'Enter a valid US mobile number, or leave it blank.');
    let contactId: string | null = null;
    if (phone) contactId = (await this.upsertContact(sql, w, phone, { brandId, subscriberId })).id;
    const offer = await this.smsOffer(sql, w, brandId);
    if (contactId && offer && input.smsConsent) {
      // The wording recorded is exactly what the page showed; a mismatch is refused.
      requireCondition(input.wordingShown === offer.wording, 409, 'consent_wording_changed', 'Reload the page and try again.');
      const current = (await sql.query<{ state: ConsentState }>('SELECT state FROM sms_consents WHERE company_id=$1 AND contact_id=$2', [offer.companyId, contactId])).rows[0]?.state ?? 'none';
      const wordingDigest = createHash('sha256').update(offer.wording).digest('hex');
      if (current === 'opted_out' || current === 'pending_reenrollment') {
        // Phase 2 never clears a carrier opt-out by API; the contact must text START (CON-6).
        await setConsent(sql, w, offer.companyId, contactId, 'pending_reenrollment', 'reenrollment_pending', 'signup_page', 'subscriber', 'signup_page', { wording: offer.wording, wordingDigest, policyVersion: offer.policyVersion });
      } else if (current !== 'opted_in') {
        await setConsent(sql, w, offer.companyId, contactId, 'pending_confirmation', 'checkbox_opt_in', 'signup_page', 'subscriber', 'signup_page', { wording: offer.wording, wordingDigest, policyVersion: offer.policyVersion, pendingDays: offer.expiryDays });
        await queueText(sql, w, { companyId: offer.companyId, contactId, purpose: 'confirmation', to: phone!, body: confirmationText(offer.business) });
      }
    } else if (contactId && offer) {
      // A phone number alone is not consent (SUB-4).
      await sql.query(`INSERT INTO sms_consents(workspace_id,company_id,contact_id,state) VALUES($1,$2,$3,'none') ON CONFLICT DO NOTHING`, [w, offer.companyId, contactId]);
    }
    for (const [type, value, label] of [['birthday', fields.birthday_field ? input.birthday : undefined, 'Birthday'], ['anniversary', fields.anniversary_field ? input.anniversary : undefined, fields.anniversary_label]] as const) {
      if (!value) continue;
      const target = subscriberId ? { brand: brandId, subscriber: subscriberId, contact: contactId } : { brand: null, subscriber: null, contact: contactId };
      if (!target.subscriber && !target.contact) continue;
      const year = 'year' in value ? value.year ?? null : null;
      await sql.query(`INSERT INTO contact_dates(workspace_id,id,contact_id,brand_id,subscriber_id,type,label,month,day,year) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT DO NOTHING`, [w, randomUUID(), target.contact, target.brand, target.subscriber, type, label, value.month, value.day, year]);
    }
    if (contactId) await this.wake(w);
  }

  // ---------------- Worker ----------------
  async tick(workspace: string): Promise<Date | null> {
    if (this.options.mode === 'off') return null;
    if (this.mock) await this.deliverMockCallbacks();
    const registration = await this.registration.tick(workspace);
    const messages = await this.messaging.tick(workspace);
    await this.messaging.forwardPending(workspace);
    return [registration, messages].filter((d): d is Date => !!d).sort((a, b) => +a - +b)[0] ?? null;
  }
  /** Mock only: delivers queued, signed callbacks through the same handlers the HTTP routes use. */
  async deliverMockCallbacks() {
    if (!this.mock) return 0;
    let delivered = 0;
    for (const callback of await this.mock.state.pending()) {
      const signature = await this.mock.state.sign(callback);
      const url = new URL(callback.url), kind = url.pathname.split('/').pop() as 'inbound' | 'status' | 'registration';
      await this.webhook(kind, callback.url, callback.params, signature).catch(() => undefined);
      await this.mock.state.done(callback.id); delivered++;
    }
    return delivered;
  }

  // ---------------- Webhooks (FL-SMS-009/015) ----------------
  /** Verifies the Twilio signature with the auth token of the account named in the request, then routes. */
  async webhook(kind: 'inbound' | 'status' | 'registration', url: string, params: Record<string, string>, signature: string) {
    this.enabled();
    const accountSid = params.AccountSid ?? '';
    const workspace = /^AC[0-9a-f]{32}$/.test(accountSid) ? (await this.db.pool.query<{ w: string | null }>('SELECT flockletter_customer_jobs.texting_route_account($1) w', [accountSid])).rows[0]?.w ?? null : null;
    if (!workspace) throw new AppError(403, 'signature_rejected', 'This request is not signed by a known account.');
    const token = await this.db.read(workspace, async sql => (await this.registration.account(sql, workspace))?.authToken ?? '');
    if (!verifyTwilioSignature(url, params, signature, token)) throw new AppError(403, 'signature_rejected', 'This request is not signed by a known account.');
    const eventKey = `${kind}:${params.MessageSid ?? params.ResourceSid ?? ''}:${params.MessageStatus ?? params.Status ?? ''}`;
    const digest = requestHash(Object.entries(params).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0));
    const result = await this.db.tenant(workspace, async sql => {
      await lockWorkspace(sql, workspace);
      const prior = (await sql.query<{ digest: string }>('SELECT digest FROM sms_provider_events WHERE event_key=$1', [eventKey])).rows[0];
      if (prior) { requireCondition(prior.digest === digest, 409, 'event_conflict', 'This event identifier has different content.'); return { duplicate: true }; }
      await sql.query('INSERT INTO sms_provider_events(workspace_id,event_key,digest) VALUES($1,$2,$3)', [workspace, eventKey, digest]);
      if (kind === 'status') {
        const message = new URL(url).searchParams.get('m') ?? '';
        if (new URL(url).searchParams.get('w') !== workspace || !z.uuid().safeParse(message).success) return { ignored: true };
        return { applied: await this.messaging.statusCallback(sql, workspace, message, params) };
      }
      if (kind === 'registration') {
        const type = params.ResourceType === 'campaign' ? 'campaign' : 'brand';
        return { applied: await this.registration.status(sql, workspace, type, params.ResourceSid ?? '', params.Status ?? '', params.FailureReason ?? null, 'webhook') };
      }
      const route = (await sql.query<{ workspace_id: string; number_id: string }>('SELECT * FROM flockletter_customer_jobs.texting_route_number($1)', [params.To ?? ''])).rows[0];
      if (!route || route.workspace_id !== workspace) return { ignored: true };
      return this.messaging.inbound(sql, workspace, route.number_id, params, await readSettings(sql, workspace));
    });
    await this.wake(workspace);
    return result;
  }

  // ---------------- Short links (FL-SMS-010) ----------------
  async resolveLink(shortName: string, code: string): Promise<string | null> {
    if (this.options.mode === 'off' || !/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(shortName) || !/^[A-Za-z0-9]{7}$/.test(code)) return null;
    const workspace = (await this.db.pool.query<{ w: string | null }>('SELECT flockletter_customer_jobs.texting_route_link($1,$2) w', [shortName, code])).rows[0]?.w;
    if (!workspace) return null;
    return this.db.tenant(workspace, async sql => {
      const link = (await sql.query<{ destination: string }>(`UPDATE sms_links SET clicks=clicks+1 WHERE code=$1 AND (expires_at IS NULL OR expires_at>clock_timestamp()) RETURNING destination`, [code])).rows[0];
      return link?.destination ?? null;
    }).catch(() => null);
  }

  // ---------------- Operator commands (FL-SMS-004/013) ----------------
  async operator(name: TextingPlatformCommand, raw: unknown, operator: OperatorActor): Promise<unknown> {
    this.enabled();
    const input = textingPlatformCommands[name].schema.parse(raw) as Record<string, never> & { workspaceId?: string; operationKey?: string };
    const actor = 'operator:' + operator.userId;
    const write = <T>(w: string, action: (sql: Sql) => Promise<T>) => this.db.tenant(w, async sql => {
      await lockWorkspace(sql, w);
      requireCondition((await sql.query('SELECT 1 FROM workspaces')).rowCount, 404, 'workspace_unavailable', 'This workspace is unavailable.');
      return once(sql, w, actor, input.operationKey!, [name, input], () => action(sql));
    });
    switch (name) {
      case 'platform.textingSettings': {
        const w = input.workspaceId ?? '';
        const rows = (await this.db.pool.query<{ key: string; workspace_id: string | null; value: unknown; revision: number; updated_at: Date }>('SELECT * FROM flockletter_customer_jobs.texting_settings_list($1)', [w])).rows;
        return textingSettingKeys.map(key => ({ key, ...textingSettings[key], platform: rows.find(r => r.key === key && !r.workspace_id) ?? null, workspace: rows.find(r => r.key === key && r.workspace_id) ?? null }));
      }
      case 'platform.textingSettingHistory':
        return (await this.db.pool.query('SELECT * FROM flockletter_customer_jobs.texting_setting_history($1,$2)', [input.workspaceId ?? '', 100])).rows;
      case 'platform.textingSetSetting': {
        const p = input as unknown as { key: string; workspaceId: string | null; value: unknown; expectedRevision: number; reason: string };
        requireCondition(isTextingSetting(p.key), 422, 'unknown_setting', 'This setting does not exist.');
        let value: unknown;
        try { value = textingSettingValue(p.key as TextingSettingKey, p.value); } catch (error) { throw new AppError(422, 'setting_out_of_bounds', 'This value is outside the safe bounds for ' + p.key + '.', { issues: (error as z.ZodError).issues?.map(i => i.message) ?? [] }); }
        if (p.key === 'send_window_end_hour' || p.key === 'send_window_start_hour') {
          const current = await this.db.pool.query<{ key: string; value: number }>('SELECT key,value FROM flockletter_customer_jobs.texting_settings_list($1)', [p.workspaceId ?? '']);
          const start = p.key === 'send_window_start_hour' ? value : current.rows.find(r => r.key === 'send_window_start_hour')?.value;
          const end = p.key === 'send_window_end_hour' ? value : current.rows.find(r => r.key === 'send_window_end_hour')?.value;
          requireCondition(typeof start !== 'number' || typeof end !== 'number' || start < end, 422, 'setting_out_of_bounds', 'The sending window must start before it ends.');
        }
        const revision = await this.db.pool.query<{ r: number }>('SELECT flockletter_customer_jobs.texting_set_setting($1,$2,$3,$4,$5,$6,$7) r',
          [p.key, p.workspaceId, value === null ? null : JSON.stringify(value), p.expectedRevision, actor, operator.via, p.reason]).catch((error: Error) => {
          if (error.message.includes('texting_setting_revision_conflict')) throw new AppError(409, 'revision_conflict', 'This setting changed. Reload it first.');
          throw error;
        });
        if (p.workspaceId) await this.db.tenant(p.workspaceId, sql => audit(sql, p.workspaceId!, actor, operator.via, 'setting.change', p.key, null, { value })).catch(() => undefined);
        return { key: p.key, workspaceId: p.workspaceId, value, revision: revision.rows[0]!.r };
      }
      case 'platform.textingCarrierBrand': {
        const p = input as unknown as { workspaceId: string; companyId: string; legalName: string; dbaName: string | null; entityType: string; profile: Record<string, unknown>; campaign?: { description: string; samples: string[] }; helpContact: string; reason: string };
        const business = twilioBusiness(p.entityType, p.profile.businessType, p.profile.vertical);
        if ('reason' in business) throw new AppError(422, business.reason, businessRefusals[business.reason] ?? 'This business cannot be registered.');
        // The wording is stored with the registration profile; the campaign step files it as written.
        p.profile = { ...p.profile, ...(p.campaign ? { campaign: p.campaign } : {}) };
        return write(p.workspaceId, async sql => {
          await this.company(sql, p.companyId);
          const existing = (await sql.query<{ id: string; legal_name: string; profile: unknown }>('SELECT * FROM sms_carrier_brands WHERE company_id=$1', [p.companyId])).rows[0];
          if (existing) {
            const reg = (await sql.query<{ state: string }>('SELECT state FROM sms_registrations WHERE carrier_brand_id=$1', [existing.id])).rows[0];
            requireCondition(!reg || ['draft', 'rejected'].includes(reg.state), 409, 'registration_in_progress', 'Correct a carrier brand only while its registration is a draft or rejected.');
            await sql.query(`UPDATE sms_carrier_brands SET legal_name=$2,dba_name=$3,entity_type=$4,profile=$5,help_contact=$6,privacy_policy_confirmed_at=NULL,sms_terms_confirmed_at=NULL,updated_at=clock_timestamp() WHERE id=$1`,
              [existing.id, p.legalName, p.dbaName, p.entityType, JSON.stringify(p.profile), p.helpContact]);
            await audit(sql, p.workspaceId, actor, operator.via, 'carrier_brand.correct', existing.id, { legalName: existing.legal_name }, { legalName: p.legalName, reason: p.reason });
            return { carrierBrandId: existing.id, registrationId: (await sql.query<{ id: string }>('SELECT id FROM sms_registrations WHERE carrier_brand_id=$1', [existing.id])).rows[0]?.id };
          }
          const id = randomUUID(), registrationId = randomUUID();
          await sql.query(`INSERT INTO sms_carrier_brands(workspace_id,id,company_id,legal_name,dba_name,entity_type,profile,help_contact,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [p.workspaceId, id, p.companyId, p.legalName, p.dbaName, p.entityType, JSON.stringify(p.profile), p.helpContact, actor]);
          await sql.query(`INSERT INTO sms_registrations(workspace_id,id,carrier_brand_id,state) VALUES($1,$2,$3,'draft')`, [p.workspaceId, registrationId, id]);
          await audit(sql, p.workspaceId, actor, operator.via, 'carrier_brand.create', id, null, { company: p.companyId, legalName: p.legalName, reason: p.reason });
          return { carrierBrandId: id, registrationId };
        });
      }
      case 'platform.textingCampaignWording': {
        const p = input as unknown as { workspaceId: string; carrierBrandId: string; campaign: { description: string; samples: string[]; useCase?: 'MARKETING' | 'LOW_VOLUME'; stayTexts?: boolean }; reason: string };
        return write(p.workspaceId, async sql => {
          const brand = (await sql.query<{ id: string; profile: { campaign?: { stayTexts?: boolean } } }>('SELECT id,profile FROM sms_carrier_brands WHERE id=$1 FOR UPDATE', [p.carrierBrandId])).rows[0];
          requireCondition(brand, 404, 'not_found', 'This carrier brand is unavailable.');
          // Once the campaign has been sent to the carrier its wording is fixed; a change needs a new campaign.
          const filed = (await sql.query(`SELECT 1 FROM sms_registrations r JOIN sms_registration_steps s ON s.registration_id=r.id AND s.revision=r.revision AND s.step='campaign'
            WHERE r.carrier_brand_id=$1 AND r.state NOT IN ('draft','rejected') AND s.state NOT IN ('queued','held')`, [brand.id])).rowCount;
          requireCondition(!filed, 409, 'campaign_already_filed', 'This campaign has already been sent to the carrier. Its wording can no longer change.');
          const stayChanged = (brand.profile.campaign?.stayTexts === true) !== (p.campaign.stayTexts === true);
          // Stay-text coverage changes what the SMS terms must say, so they are confirmed again before filing.
          await sql.query(`UPDATE sms_carrier_brands SET profile=profile||jsonb_build_object('campaign',$2::jsonb),updated_at=clock_timestamp(),
            privacy_policy_confirmed_at=CASE WHEN $3 THEN NULL ELSE privacy_policy_confirmed_at END,sms_terms_confirmed_at=CASE WHEN $3 THEN NULL ELSE sms_terms_confirmed_at END WHERE id=$1`,
            [brand.id, JSON.stringify(p.campaign), stayChanged]);
          await audit(sql, p.workspaceId, actor, operator.via, 'carrier_brand.campaign_wording', brand.id, { campaign: brand.profile.campaign ?? null }, { campaign: p.campaign, policiesCleared: stayChanged, reason: p.reason });
          return { carrierBrandId: brand.id, policiesCleared: stayChanged };
        });
      }
      case 'platform.textingConfirmPolicies': {
        const p = input as unknown as { workspaceId: string; carrierBrandId: string; privacyPolicyUrl: string; smsTermsUrl: string; reason: string };
        return write(p.workspaceId, async sql => {
          const updated = await sql.query(`UPDATE sms_carrier_brands SET privacy_policy_confirmed_at=clock_timestamp(),sms_terms_confirmed_at=clock_timestamp(),
            profile=profile||jsonb_build_object('privacyPolicyUrl',$2::text,'smsTermsUrl',$3::text),updated_at=clock_timestamp() WHERE id=$1 RETURNING id`, [p.carrierBrandId, p.privacyPolicyUrl, p.smsTermsUrl]);
          requireCondition(updated.rowCount, 404, 'not_found', 'This carrier brand is unavailable.');
          await audit(sql, p.workspaceId, actor, operator.via, 'carrier_brand.policies_confirmed', p.carrierBrandId, null, { privacyPolicyUrl: p.privacyPolicyUrl, smsTermsUrl: p.smsTermsUrl, reason: p.reason });
          return { confirmed: true };
        });
      }
      case 'platform.textingSubmit': {
        const p = input as unknown as { workspaceId: string; registrationId: string };
        const result = await write(p.workspaceId, sql => this.registration.submit(sql, p.workspaceId, p.registrationId, actor, operator.via));
        await this.wake(p.workspaceId); return result;
      }
      case 'platform.textingCampaignResubmitted': {
        const p = input as unknown as { workspaceId: string; registrationId: string };
        const result = await write(p.workspaceId, sql => this.registration.campaignResubmitted(sql, p.workspaceId, p.registrationId, actor, operator.via));
        await this.wake(p.workspaceId); return result;
      }
      case 'platform.textingApprove': {
        const p = input as unknown as { workspaceId: string; registrationId: string; step: 'brand' | 'campaign' | 'number'; costNote: string; reason: string };
        requireCondition(this.options.mode === 'live', 409, 'approval_not_needed', 'Separate approvals apply only to live registration.');
        const result = await write(p.workspaceId, async sql => {
          const reg = (await sql.query<RegistrationRow>('SELECT * FROM sms_registrations WHERE id=$1', [p.registrationId])).rows[0];
          requireCondition(reg, 404, 'not_found', 'This registration is unavailable.');
          const id = randomUUID();
          await sql.query('INSERT INTO sms_operator_approvals(workspace_id,id,registration_id,revision,step,cost_note,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7)', [p.workspaceId, id, reg.id, reg.revision, p.step, p.costNote, actor]);
          await audit(sql, p.workspaceId, actor, operator.via, 'registration.approve_step', reg.id, null, { step: p.step, revision: reg.revision, costNote: p.costNote, reason: p.reason });
          return { approvalId: id };
        });
        await this.wake(p.workspaceId); return result;
      }
      case 'platform.textingRegistration': {
        const w = input.workspaceId!;
        return this.db.read(w, async sql => {
          const regs = (await sql.query<RegistrationRow & { company_id: string; legal_name: string }>(`SELECT r.*,b.company_id,b.legal_name FROM sms_registrations r JOIN sms_carrier_brands b ON b.id=r.carrier_brand_id ORDER BY r.created_at`)).rows;
          const steps = (await sql.query<StepRow>('SELECT * FROM sms_registration_steps ORDER BY created_at')).rows;
          const numbers = (await sql.query('SELECT id,carrier_brand_id AS "carrierBrandId",e164,state FROM sms_numbers')).rows;
          // An uncertain step is only retried after the settle time; without it the step waits for the operator (fail closed).
          const settingsNeeded = steps.some(s => s.state === 'uncertain' && regs.some(r => r.id === s.registration_id && r.revision === s.revision)) && (await readSettings(sql, w)).reconcile_settle_minutes === undefined ? ['reconcile_settle_minutes'] : [];
          return { mode: this.options.mode, settingsNeeded, registrations: regs.map(r => ({ ...r, steps: steps.filter(s => s.registration_id === r.id && s.revision === r.revision)
            .map(s => ({ step: s.step, state: s.state, attempts: s.attempts, operationKey: s.operation_key, reason: (s as unknown as { reason: string | null }).reason, nextCheckAt: s.next_check_at })) })), numbers };
        });
      }
      case 'platform.textingProcess': {
        const p = input as unknown as { workspaceId: string };
        await this.db.read(p.workspaceId, async sql => requireCondition((await sql.query('SELECT 1 FROM workspaces')).rowCount, 404, 'workspace_unavailable', 'This workspace is unavailable.'));
        const next = await this.tick(p.workspaceId);
        return { processed: true, nextDueAt: next };
      }
      case 'platform.textingMock': {
        requireCondition(this.mock, 409, 'mock_only', 'Mock actions run only with the mock Twilio client.');
        const p = input as unknown as { workspaceId: string; action: { kind: string; [k: string]: unknown } };
        const a = p.action;
        if (a.kind === 'fault') { await this.mock!.state.script(a.target as never, a.faults as never); return { queued: (a.faults as unknown[]).length }; }
        if (a.kind === 'deliver') return { delivered: await this.deliverMockCallbacks() };
        if (a.kind === 'inbound') { const ok = await this.mock!.messaging.inbound(String(a.from), String(a.to), String(a.body)); requireCondition(ok, 404, 'not_found', 'That number is not a mock number.'); return { queued: true, delivered: await this.deliverMockCallbacks() }; }
        const account = await this.db.read(p.workspaceId, sql => this.registration.account(sql, p.workspaceId));
        requireCondition(account, 409, 'no_account', 'This workspace has no provider account yet.');
        const reg = await this.db.read(p.workspaceId, async sql => (await sql.query<RegistrationRow>('SELECT * FROM sms_registrations WHERE id=$1', [String(a.registrationId)])).rows[0]);
        requireCondition(reg, 404, 'not_found', 'This registration is unavailable.');
        const type = a.kind === 'brand' ? 'brand' : 'campaign', sid = type === 'brand' ? reg.brand_sid : reg.campaign_sid;
        requireCondition(sid, 409, 'not_filed', `The ${type} has not been filed yet.`);
        await this.mock!.platform.decide(type, account, sid, a.status as never, this.registration.callbacks(p.workspaceId).registration);
        return { decided: true, delivered: await this.deliverMockCallbacks() };
      }
    }
  }
}
