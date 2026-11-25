import type { GiftRecipient } from '../workspace-gifts/audience.js';
import type { Sql } from '../db.js';

export type DateKind = 'birthday' | 'anniversary';
export type DateSource = {
  id: string; type: DateKind; month: number; day: number; year: number | null; label: string;
  subscriber_id: string | null; contact_id: string | null; first_name: string | null;
  email: string | null; email_state: string | null; phone_e164: string | null; time_zone: string | null; shared_phone: boolean;
};

// Use the current phone link rather than the number recorded when the date was saved.
// Unattributed legacy phone dates stay outside the planner until explicitly saved in a brand.
export async function dateSources(sql: Sql, brand: string, type: DateKind, months: number[],
  after: string | null, limit: number, exactId: string | null = null) {
  return (await sql.query<DateSource>(`
    SELECT d.id,d.type,d.month,d.day,d.year,d.label,d.subscriber_id,c.id contact_id,
      CASE WHEN d.subscriber_id IS NULL THEN c.first_name ELSE s.first_name END first_name,
      s.email_normalized email,s.state email_state,c.phone_e164,c.time_zone,
      EXISTS (SELECT FROM sms_contact_subscribers h WHERE h.contact_id=c.id AND
        (h.subscriber_id,h.brand_id) IS DISTINCT FROM (d.subscriber_id,d.brand_id))
        OR (c.subscriber_id IS NOT NULL AND (c.subscriber_id,c.brand_id)
          IS DISTINCT FROM (d.subscriber_id,d.brand_id)) shared_phone
    FROM contact_dates d
    LEFT JOIN subscribers s ON s.id=d.subscriber_id AND s.brand_id=d.brand_id
    LEFT JOIN sms_contact_subscribers link ON link.brand_id=d.brand_id AND link.subscriber_id=d.subscriber_id
    LEFT JOIN LATERAL (SELECT id FROM sms_contacts old WHERE old.brand_id=d.brand_id
      AND old.subscriber_id=d.subscriber_id ORDER BY old.updated_at DESC,id LIMIT 1) legacy ON link.contact_id IS NULL
    LEFT JOIN sms_contacts c ON c.id=CASE WHEN d.subscriber_id IS NULL THEN d.contact_id ELSE coalesce(link.contact_id,legacy.id) END
    WHERE d.brand_id=$1 AND d.type=$2 AND d.month=ANY($3::int[]) AND d.cleared_at IS NULL
      AND ($4::uuid IS NULL OR d.id>$4) AND ($6::uuid IS NULL OR d.id=$6)
      AND (d.subscriber_id IS NULL OR s.id IS NOT NULL)
    ORDER BY d.id LIMIT $5`, [brand,type,months,after,limit,exactId])).rows;
}

export async function smsRoute(sql:Sql,brand:string,s:DateSource) {
  if (!s.contact_id || s.shared_phone) return null;
  return (await sql.query<{company_id:string}>(`SELECT cb.company_id FROM company_brands cb JOIN sms_consents x USING(workspace_id,company_id)
    JOIN sms_contacts c ON c.id=x.contact_id WHERE cb.brand_id=$1 AND c.id=$2 AND c.textable AND x.state='opted_in'`,[brand,s.contact_id])).rows[0]??null;
}

// The audience owner resolves deduplication. A shared or newly reassigned endpoint
// cannot borrow an offer belonging to a different canonical person.
export function dateGiftPerson(people:ReadonlyMap<string,GiftRecipient>, source:DateSource, channel:'sms'|'email') {
  const sourceId=source.subscriber_id??source.contact_id;
  const person=sourceId?people.get(sourceId):undefined;
  if (!person) return null;
  return (channel==='sms'
    ? !source.shared_phone && person.phone && person.phone===source.phone_e164
    : person.email && person.email===source.email) ? person.id : null;
}
