import type {
  AudienceSummary,
  ConsentEvent,
  ContactDetail,
  ContactPage,
  SubscriberState,
} from '../../shared/audience.js';
import type { Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import { suppress } from './intake.js';
import { listPeople, personRow, personTexting, personView, sharedWith, signupFields, type PeopleQuery } from './people.js';

type EventRow = {
  id: string;
  event: ConsentEvent['event'];
  purpose: string;
  policy_version: string;
  source: string;
  source_domain: string;
  recorded_at: Date;
  evidence_source: string;
  recorded_by: string;
};
// Callers verify brand ownership and set app.intake_brand_id inside the same workspace transaction.
export async function audienceSummary(sql: Sql): Promise<AudienceSummary> {
  const { rows } = await sql.query<{ state: SubscriberState; count: string }>(
    'SELECT state,count(*) AS count FROM subscribers GROUP BY state',
  );
  const counts: AudienceSummary = {
    total: 0,
    pending: 0,
    confirmed: 0,
    unsubscribed: 0,
    hard_bounced: 0,
    complained: 0,
  };
  for (const row of rows) {
    counts[row.state] = Number(row.count);
    counts.total += counts[row.state];
  }
  return counts;
}

export async function listContacts(sql: Sql, brand: string, query: PeopleQuery): Promise<ContactPage> {
  return listPeople(sql, brand, query);
}

const historySize = 15;
export async function contactDetail(sql: Sql, brand: string, id: string, cursor?: string): Promise<ContactDetail> {
  const person = await personRow(sql, brand, id);
  const extra = { texting: await personTexting(sql, brand, person), sharedWith: await sharedWith(sql, brand, person), fields: await signupFields(sql) };
  if (person.kind === 'phone') {
    requireCondition(!cursor, 422, 'invalid_cursor', 'This history page is unavailable. Reopen the contact.');
    return { contact: personView(person), events: [], nextCursor: null, ...extra };
  }
  if (cursor) {
    const event = await sql.query(
      'SELECT id FROM subscriber_consent_events WHERE subscriber_id=$1 AND id=$2',
      [id, cursor],
    );
    requireCondition(
      event.rowCount,
      422,
      'invalid_cursor',
      'This history page is unavailable. Reopen the contact.',
    );
  }
  const { rows } = await sql.query<EventRow>(
    `SELECT id,event,purpose,policy_version,source,source_domain,recorded_at,evidence_source,recorded_by
    FROM subscriber_consent_events WHERE subscriber_id=$1 AND ($2::uuid IS NULL OR (recorded_at,id) <
      (SELECT recorded_at,id FROM subscriber_consent_events WHERE subscriber_id=$1 AND id=$2))
    ORDER BY recorded_at DESC,id DESC LIMIT $3`,
    [id, cursor ?? null, historySize + 1],
  );
  const events = rows
    .slice(0, historySize)
    .map((row) => ({
      id: row.id,
      event: row.event,
      purpose: row.purpose,
      policyVersion: row.policy_version,
      source: row.source,
      sourceDomain: row.source_domain,
      recordedAt: row.recorded_at.toISOString(),
      ...(row.evidence_source ? { evidenceSource: row.evidence_source } : {}),
      ...(row.recorded_by ? { recordedBy: row.recorded_by } : {}),
    }));
  // An owner's practice-import declaration is provenance, not subscriber consent.
  // Read the original workspace/brand receipt without retaining the uploaded file.
  const origin = !cursor && (await sql.query<{ recorded_at: Date; row: number }>(`
    SELECT o.created_at AS recorded_at, (item->>'row')::int AS row
    FROM operations o CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(o.result->'rows')='array' THEN o.result->'rows' ELSE '[]'::jsonb END) AS item
    WHERE o.result->>'source'='practice_csv' AND o.result->>'brandId'=current_setting('app.intake_brand_id',true)
      AND o.result @> jsonb_build_object('rows',jsonb_build_array(jsonb_build_object('subscriberId',$1::text)))
      AND item->>'subscriberId'=$1 AND item->>'outcome'='pending_added' LIMIT 1`,[id])).rows[0];
  return {
    contact: personView(person),
    events,
    nextCursor: rows.length > historySize ? events[historySize - 1]!.id : null,
    ...(origin ? { practiceImport: { row: origin.row, recordedAt: origin.recorded_at.toISOString() } } : {}),
    ...extra,
  };
}

export async function unsubscribeContact(
  sql: Sql,
  id: string,
  source: 'workspace-owner' | 'marketing-unsubscribe-link' = 'workspace-owner',
) {
  // The confirmation worker and public actions lock the brand gate before the subscriber.
  await sql.query('SELECT enabled FROM subscriber_intake_settings FOR UPDATE');
  const person = (
    await sql.query<{ state: SubscriberState }>('SELECT state FROM subscribers WHERE id=$1 FOR UPDATE', [id])
  ).rows[0];
  requireCondition(person, 404, 'contact_unavailable', 'This contact is unavailable for this brand.');
  if (person.state === 'confirmed' || person.state === 'pending') {
    const evidence = (
      await sql.query<{ id: string }>(
        `SELECT id FROM subscriber_consent_events
      WHERE subscriber_id=$1 AND event='signup_requested' ORDER BY recorded_at DESC,id DESC LIMIT 1`,
        [id],
      )
    ).rows[0];
    await suppress(sql, id, evidence?.id ?? null, 'unsubscribed', source);
  }
  return { id, suppressed: true };
}
