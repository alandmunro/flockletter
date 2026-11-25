import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  contactUpdate,
  textStates,
  type AudienceContact,
  type ContactTexting,
  type PeopleSummary,
  type SpecialDate,
  type SubscriberState,
  type TextState,
} from '../../shared/audience.js';
import { normalizeUsPhone } from '../../shared/texting.js';
import type { Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import { sendingNumber, setConsent } from '../texting/messaging.js';
import { audit, type Interface } from '../texting/storage.js';

/*
 * One audience row per person (FL-AUD-020): an email subscriber with its optional phone, or a phone-only text contact.
 * Email status and text status stay separate. Text consent belongs to the phone number and to the brand's company.
 * Every query takes the brand as $1 and runs inside the caller's workspace and brand RLS context.
 */
const people = `
WITH co AS (SELECT company_id FROM company_brands WHERE brand_id=$1),
links AS (
  SELECT DISTINCT ON (subscriber_id) subscriber_id, contact_id FROM (
    SELECT l.subscriber_id, l.contact_id, 0 AS rank, l.created_at AS at FROM sms_contact_subscribers l WHERE l.brand_id=$1
    UNION ALL
    -- Links written before 041 live on the contact row.
    SELECT c.subscriber_id, c.id, 1, c.updated_at FROM sms_contacts c WHERE c.brand_id=$1 AND c.subscriber_id IS NOT NULL
  ) AS candidates ORDER BY subscriber_id, rank, at DESC),
base AS (
  SELECT s.id, 'subscriber'::text AS kind, s.email_normalized AS email, s.state, s.first_name, s.last_name,
    s.created_at, s.confirmed_at, k.contact_id
  FROM subscribers s LEFT JOIN links k ON k.subscriber_id=s.id
  UNION ALL
  -- A name typed on the Texting page before first and last names existed shows as the first name.
  SELECT c.id, 'phone', NULL, NULL, coalesce(c.first_name, CASE WHEN c.last_name IS NULL THEN c.name END), c.last_name, c.created_at, NULL, c.id FROM sms_contacts c
  WHERE NOT EXISTS (SELECT FROM links k WHERE k.contact_id=c.id)
    AND (c.brand_id=$1 OR EXISTS (SELECT FROM sms_consents x JOIN co ON co.company_id=x.company_id WHERE x.contact_id=c.id))),
rows AS (
  SELECT b.*, c.phone_e164 AS phone, c.not_textable_reason, x.company_id, x.updated_at AS consent_at, x.pending_expires_at,
    CASE WHEN c.id IS NULL THEN 'no_phone'
      WHEN x.state='opted_out' THEN 'opted_out'
      WHEN NOT c.textable THEN 'not_textable'
      WHEN x.state IN ('opted_in','pending_confirmation','pending_reenrollment') THEN x.state
      WHEN x.state='none' AND (SELECT e.event FROM sms_consent_events e WHERE e.company_id=x.company_id AND e.contact_id=c.id
        ORDER BY e.recorded_at DESC, e.id DESC LIMIT 1)='expired' THEN 'expired'
      ELSE 'phone_only' END AS text,
    bd.month AS b_month, bd.day AS b_day, bd.label AS b_label,
    an.month AS a_month, an.day AS a_day, an.year AS a_year, an.label AS a_label,
    coalesce(b.email, c.phone_e164) AS sort_key
  FROM base b
  LEFT JOIN sms_contacts c ON c.id=b.contact_id
  LEFT JOIN sms_consents x ON x.contact_id=c.id AND x.company_id=(SELECT company_id FROM co)
  LEFT JOIN contact_dates bd ON bd.type='birthday' AND bd.cleared_at IS NULL AND CASE WHEN b.kind='subscriber'
    THEN bd.brand_id=$1 AND bd.subscriber_id=b.id
    ELSE bd.contact_id=b.id AND bd.subscriber_id IS NULL AND coalesce(bd.brand_id,c.brand_id)=$1 END
  LEFT JOIN contact_dates an ON an.type='anniversary' AND an.cleared_at IS NULL AND CASE WHEN b.kind='subscriber'
    THEN an.brand_id=$1 AND an.subscriber_id=b.id
    ELSE an.contact_id=b.id AND an.subscriber_id IS NULL AND coalesce(an.brand_id,c.brand_id)=$1 END)`;

type PersonRow = {
  id: string; kind: 'subscriber' | 'phone'; email: string | null; state: SubscriberState | null;
  first_name: string | null; last_name: string | null; created_at: Date; confirmed_at: Date | null;
  contact_id: string | null; phone: string | null; not_textable_reason: string | null; company_id: string | null;
  consent_at: Date | null; pending_expires_at: Date | null; text: TextState;
  b_month: number | null; b_day: number | null; b_label: string | null;
  a_month: number | null; a_day: number | null; a_year: number | null; a_label: string | null;
  sort_key: string;
};
const date = (month: number | null, day: number | null, label: string | null, year: number | null = null): SpecialDate | null =>
  month && day ? { month, day, year, label: label ?? '' } : null;
export function personView(row: PersonRow): AudienceContact {
  return {
    id: row.id, kind: row.kind, email: row.email, state: row.state,
    firstName: row.first_name, lastName: row.last_name, phone: row.phone, text: row.text,
    birthday: date(row.b_month, row.b_day, row.b_label),
    anniversary: date(row.a_month, row.a_day, row.a_label, row.a_year),
    createdAt: row.created_at.toISOString(), confirmedAt: row.confirmed_at?.toISOString() ?? null,
  };
}

export async function personRow(sql: Sql, brand: string, id: string) {
  const row = (await sql.query<PersonRow>(`${people} SELECT * FROM rows WHERE id=$2`, [brand, id])).rows[0];
  requireCondition(row, 404, 'contact_unavailable', 'This contact is unavailable for this brand.');
  return row;
}

export type PeopleQuery = {
  state?: SubscriberState | 'no_email' | undefined;
  text?: TextState | undefined;
  email?: string | undefined;
  search?: string | undefined;
  dates?: 'birthday' | 'anniversary' | 'any' | undefined;
  month?: number | undefined;
  cursor?: string | undefined;
  limit: number;
};
const like = (value: string) => '%' + value.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
export async function listPeople(sql: Sql, brand: string, query: PeopleQuery) {
  let after: string | null = null;
  if (query.cursor) {
    const cursor = (await sql.query<{ sort_key: string }>(`${people} SELECT sort_key FROM rows WHERE id=$2`, [brand, query.cursor])).rows[0];
    requireCondition(cursor, 422, 'invalid_cursor', 'This audience page is unavailable. Return to the first page.');
    after = cursor.sort_key;
  }
  const term = query.search?.trim().toLowerCase() || null;
  const digits = term?.replace(/\D/g, '') ?? '';
  const { rows } = await sql.query<PersonRow>(
    `${people} SELECT * FROM rows WHERE
      ($2::text IS NULL OR ($2='no_email' AND email IS NULL) OR state=$2)
      AND ($3::text IS NULL OR text=$3)
      AND ($4::text IS NULL OR email=$4)
      AND ($5::text IS NULL OR email LIKE $5 OR lower(concat_ws(' ',first_name,last_name)) LIKE $5 OR ($6::text IS NOT NULL AND phone LIKE $6))
      AND ($7::text IS NULL OR ($7 IN ('birthday','any') AND b_month IS NOT NULL) OR ($7 IN ('anniversary','any') AND a_month IS NOT NULL))
      AND ($8::int IS NULL OR b_month=$8 OR a_month=$8)
      AND ($9::text IS NULL OR (sort_key,id::text) > ($9,$10))
    ORDER BY sort_key, id::text LIMIT $11`,
    [brand, query.state ?? null, query.text ?? null, query.email ?? null, term ? like(term) : null,
      digits.length >= 3 ? like(digits) : null, query.dates ?? null, query.month ?? null, after, query.cursor ?? '', query.limit + 1],
  );
  const items = rows.slice(0, query.limit).map(personView);
  return { items, nextCursor: rows.length > query.limit ? items[items.length - 1]!.id : null };
}

export async function peopleSummary(sql: Sql, brand: string): Promise<PeopleSummary> {
  const counts = textStates.map((s) => `count(*) FILTER (WHERE text='${s}')::int AS "${s}"`).join(',');
  const row = (await sql.query<Record<string, number>>(
    `${people}, tz AS (SELECT extract(month FROM now() AT TIME ZONE coalesce((SELECT time_zone FROM sms_workspace_profile),'UTC'))::int AS m)
    SELECT count(*)::int AS people, count(*) FILTER (WHERE kind='phone')::int AS phone_kind,
      count(*) FILTER (WHERE b_month IS NOT NULL)::int AS birthdays, count(*) FILTER (WHERE a_month IS NOT NULL)::int AS anniversaries,
      (count(*) FILTER (WHERE b_month=(SELECT m FROM tz)) + count(*) FILTER (WHERE a_month=(SELECT m FROM tz)))::int AS this_month, ${counts}
    FROM rows`, [brand])).rows[0]!;
  return {
    people: row.people!, phoneOnly: row.phone_kind!, birthdays: row.birthdays!, anniversaries: row.anniversaries!, thisMonth: row.this_month!,
    text: Object.fromEntries(textStates.map((s) => [s, row[s] ?? 0])) as Record<TextState, number>,
  };
}

export async function signupFields(sql: Sql) {
  const p = (await sql.query<{ birthday_field: boolean; anniversary_field: boolean; anniversary_label: string; name_field: boolean }>(
    'SELECT birthday_field,anniversary_field,anniversary_label,name_field FROM sms_workspace_profile')).rows[0];
  return { birthday: p?.birthday_field ?? false, anniversary: p?.anniversary_field ?? false, anniversaryLabel: p?.anniversary_label ?? 'Anniversary', name: p?.name_field ?? false };
}

/** The text side of the contact page: status for the brand's company and the number's own consent history. */
export async function personTexting(sql: Sql, brand: string, row: PersonRow): Promise<ContactTexting | null> {
  if (!row.contact_id) return null;
  const company = (await sql.query<{ id: string; name: string }>(
    'SELECT c.id,c.name FROM company_brands cb JOIN companies c ON c.id=cb.company_id WHERE cb.brand_id=$1', [brand])).rows[0];
  const companyId = company?.id ?? null;
  const events = companyId ? (await sql.query<{ id: string; event: string; source: string; recorded_at: Date; wording: string | null }>(
    `SELECT id,event,source,recorded_at,wording FROM sms_consent_events WHERE company_id=$1 AND contact_id=$2 ORDER BY recorded_at DESC, id DESC LIMIT 30`,
    [companyId, row.contact_id])).rows : [];
  const number = companyId ? await sendingNumber(sql, companyId) : null;
  return {
    companyName: company?.name ?? '', number: number?.e164 ?? null, state: row.text,
    changedAt: row.consent_at?.toISOString() ?? null, pendingExpiresAt: row.text === 'pending_confirmation' ? row.pending_expires_at?.toISOString() ?? null : null,
    notTextableReason: row.not_textable_reason,
    events: events.map((e) => ({ id: e.id, event: e.event, source: e.source, recordedAt: e.recorded_at.toISOString(), wording: e.wording })),
  };
}

/** Emails of other subscribers in this brand who share the person's phone. */
export async function sharedWith(sql: Sql, brand: string, row: PersonRow) {
  if (row.kind !== 'subscriber' || !row.contact_id) return [];
  return (await sql.query<{ email: string }>(`${people} SELECT email FROM rows WHERE contact_id=$2 AND kind='subscriber' AND id<>$3 ORDER BY email`,
    [brand, row.contact_id, row.id])).rows.map((r) => r.email);
}

/** Finds or creates the phone's contact. A new number never carries consent (SUB-4). */
export async function phoneContact(sql: Sql, workspace: string, brand: string, phone: string) {
  const existing = (await sql.query<{ id: string }>('SELECT id FROM sms_contacts WHERE phone_e164=$1', [phone])).rows[0];
  if (existing) return existing.id;
  const id = randomUUID();
  await sql.query('INSERT INTO sms_contacts(workspace_id,id,phone_e164,brand_id) VALUES($1,$2,$3,$4)', [workspace, id, phone, brand]);
  return id;
}
/** Gives a subscriber exactly one phone, or none. Other subscribers sharing the phone keep it (D2). */
export async function linkPhone(sql: Sql, workspace: string, brand: string, subscriber: string, contact: string | null) {
  await sql.query('DELETE FROM sms_contact_subscribers WHERE brand_id=$1 AND subscriber_id=$2', [brand, subscriber]);
  await sql.query('UPDATE sms_contacts SET subscriber_id=NULL,updated_at=clock_timestamp() WHERE brand_id=$1 AND subscriber_id=$2', [brand, subscriber]);
  if (contact) await sql.query('INSERT INTO sms_contact_subscribers(workspace_id,contact_id,brand_id,subscriber_id) VALUES($1,$2,$3,$4)', [workspace, contact, brand, subscriber]);
}
/** Sets or clears one special date. The person's own newest sign-up and the owner's edits both use this (D4). */
export async function setDate(sql: Sql, workspace: string, brand: string, target: { subscriber: string | null; contact: string | null },
  type: 'birthday' | 'anniversary', value: { month: number; day: number; year?: number | null } | null, label: string) {
  const bySubscriber = target.subscriber !== null;
  if (!bySubscriber && !target.contact) return;
  if (!value) {
    // Marked cleared rather than deleted: the runtime role has no DELETE on contact_dates (migration 041).
    await sql.query(bySubscriber
      ? 'UPDATE contact_dates SET cleared_at=clock_timestamp(),updated_at=clock_timestamp() WHERE brand_id=$1 AND subscriber_id=$2 AND type=$3 AND cleared_at IS NULL'
      : `UPDATE contact_dates d SET cleared_at=clock_timestamp(),updated_at=clock_timestamp() FROM sms_contacts c
         WHERE d.contact_id=c.id AND c.id=$2 AND d.subscriber_id IS NULL AND d.type=$3 AND d.cleared_at IS NULL
           AND coalesce(d.brand_id,c.brand_id)=$1`,
    [brand, bySubscriber ? target.subscriber : target.contact, type]);
    return;
  }
  const conflict = bySubscriber ? '(workspace_id,brand_id,subscriber_id,type) WHERE subscriber_id IS NOT NULL' : '(workspace_id,contact_id,type) WHERE subscriber_id IS NULL';
  // A phone-only date has a single persistent identity. A sibling brand may also
  // see the phone through company consent, but it cannot take over that date.
  const saved = await sql.query(`INSERT INTO contact_dates(workspace_id,id,contact_id,brand_id,subscriber_id,type,label,month,day,year) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT ${conflict} DO UPDATE SET month=EXCLUDED.month,day=EXCLUDED.day,year=EXCLUDED.year,label=EXCLUDED.label,
      brand_id=EXCLUDED.brand_id,contact_id=coalesce(EXCLUDED.contact_id,contact_dates.contact_id),cleared_at=NULL,updated_at=clock_timestamp()
      WHERE coalesce(contact_dates.brand_id,(SELECT c.brand_id FROM sms_contacts c WHERE c.id=contact_dates.contact_id))=EXCLUDED.brand_id`,
  [workspace, randomUUID(), target.contact, brand, target.subscriber, type, label, value.month, value.day, value.year ?? null]);
  requireCondition(saved.rowCount, 409, 'date_unavailable', 'This date cannot be updated for this brand.');
}

const masked = (phone: string | null) => (phone ? '***' + phone.slice(-4) : null);
export const updateInput = z.object(contactUpdate).strict();
export type PeopleActor = { id: string; via: Interface };

export async function updatePerson(sql: Sql, workspace: string, brand: string, id: string, input: z.infer<typeof updateInput>, actor: PeopleActor) {
  const row = await personRow(sql, brand, id);
  const fields = await signupFields(sql);
  const changes: Record<string, [unknown, unknown]> = {};
  if (input.firstName !== undefined || input.lastName !== undefined) {
    const first = input.firstName === undefined ? row.first_name : input.firstName;
    const last = input.lastName === undefined ? row.last_name : input.lastName;
    if (row.kind === 'subscriber') await sql.query('UPDATE subscribers SET first_name=$2,last_name=$3 WHERE id=$1', [id, first, last]);
    else await sql.query(`UPDATE sms_contacts SET first_name=$2,last_name=$3,name=nullif(concat_ws(' ',$2::text,$3::text),''),updated_at=clock_timestamp() WHERE id=$1`, [id, first, last]);
    changes.name = [[row.first_name, row.last_name], [first, last]];
  }
  let warning: string | null = null;
  if (input.phone !== undefined) {
    requireCondition(row.kind === 'subscriber', 422, 'phone_fixed',
      'A text contact is identified by its number. Add the new number as its own contact instead.');
    const phone = input.phone === null || input.phone === '' ? null : normalizeUsPhone(input.phone);
    requireCondition(input.phone === null || input.phone === '' || phone, 422, 'invalid_phone', 'Enter a valid US mobile number, or clear the phone.');
    if (phone !== row.phone) {
      const contact = phone ? await phoneContact(sql, workspace, brand, phone) : null;
      await linkPhone(sql, workspace, brand, id, contact);
      changes.phone = [masked(row.phone), masked(phone)];
      warning = phone
        ? 'Text consent belongs to the number, not the person. This number keeps its own text status; changing it here never subscribes anyone.'
        : row.phone ? 'The old number stays on file as its own text contact, so its consent and STOP history are kept.' : null;
    }
  }
  for (const type of ['birthday', 'anniversary'] as const) {
    const value = input[type];
    if (value === undefined) continue;
    const label = type === 'birthday' ? 'Birthday' : fields.anniversaryLabel;
    await setDate(sql, workspace, brand, row.kind === 'subscriber' ? { subscriber: id, contact: row.contact_id } : { subscriber: null, contact: id }, type, value, label);
    const old = type === 'birthday' ? date(row.b_month, row.b_day, row.b_label) : date(row.a_month, row.a_day, row.a_label, row.a_year);
    changes[type] = [old, value];
  }
  if (Object.keys(changes).length)
    await audit(sql, workspace, actor.id, actor.via, 'contact.update', id,
      Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v[0]])), Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v[1]])));
  return { contact: personView(await personRow(sql, brand, id)), ...(warning ? { warning } : {}) };
}

/** The owner can always stop texts. There is no owner action that starts them (FL-SMS-005). */
export async function stopTexts(sql: Sql, workspace: string, brand: string, id: string, actor: PeopleActor) {
  const row = await personRow(sql, brand, id);
  requireCondition(row.contact_id, 422, 'no_phone', 'This contact has no phone number.');
  const company = row.company_id ?? (await sql.query<{ company_id: string }>('SELECT company_id FROM company_brands WHERE brand_id=$1', [brand])).rows[0]?.company_id;
  requireCondition(company, 422, 'no_company', 'This brand has no company for texting.');
  if (row.text === 'opted_out') return { contact: personView(row), changed: false };
  await setConsent(sql, workspace, company, row.contact_id, 'opted_out', 'opted_out', 'owner', actor.id, actor.via);
  // A confirmation or broadcast still waiting in the queue is not sent.
  await sql.query("UPDATE sms_messages SET state='cancelled',updated_at=clock_timestamp() WHERE company_id=$1 AND contact_id=$2 AND state='pending'", [company, row.contact_id]);
  return { contact: personView(await personRow(sql, brand, id)), changed: true };
}
