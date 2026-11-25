import { textingReportCommands, type CampaignResult, type DeliveryCounts, type PracticeReportCommand, type RecipientResult } from '../../shared/texting-reports.js';
import type { Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import { coversTextCompany } from './company-access.js';

const counts = `count(m.id)::int AS recipients, count(m.provider_sid)::int AS "carrierReceipts",
  count(*) FILTER (WHERE m.state='delivered')::int AS delivered, count(*) FILTER (WHERE m.state IN ('failed','undelivered'))::int AS failed,
  count(*) FILTER (WHERE m.state IN ('pending','admitted','accepted'))::int AS pending,
  count(*) FILTER (WHERE m.state='pending' AND m.reason IS NOT NULL)::int AS held,
  count(*) FILTER (WHERE m.state IN ('calling','uncertain'))::int AS uncertain,
  count(*) FILTER (WHERE m.state='skipped')::int AS skipped, count(*) FILTER (WHERE m.state='cancelled')::int AS cancelled,
  coalesce(sum(m.segments) FILTER (WHERE m.provider_sid IS NOT NULL),0)::int AS "receiptSegments"`;
const dateBounds = `s.created_at >= ($2::date::timestamp AT TIME ZONE 'UTC') AND s.created_at < (($3::date+1)::timestamp AT TIME ZONE 'UTC')`;
export async function textingReport(sql: Sql, command: PracticeReportCommand, raw: unknown, brandIds: string[] | null) {
  const input = textingReportCommands[command].schema.parse(raw);
  const company = await sql.query('SELECT 1 FROM companies WHERE id=$1', [input.companyId]);
  requireCondition(company.rowCount && await coversTextCompany(sql,input.companyId,brandIds), 404, 'not_found', 'This company is unavailable.');
  if ('sendId' in input) {
    requireCondition((await sql.query('SELECT 1 FROM sms_sends WHERE company_id=$1 AND id=$2',[input.companyId,input.sendId])).rowCount,
      404, 'not_found', 'This text is unavailable in the selected company.');
    const rows = (await sql.query<RecipientResult>(`SELECT id,to_e164 phone,state,reason,segments,attempts,updated_at updated FROM sms_messages
      WHERE company_id=$1 AND send_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 101`, [input.companyId,input.sendId,input.cursor ?? null])).rows;
    return { recipients:rows.slice(0,100), next: rows.length > 100 ? rows[99]!.id : null };
  }
  // Totals and page use the same statement snapshot, including messages with uncertain or late receipts.
  const result = (await sql.query<{ totals: DeliveryCounts; campaigns: CampaignResult[] }>(`WITH sends AS MATERIALIZED (
    SELECT s.id,s.created_at,s.kind,s.state FROM sms_sends s WHERE s.company_id=$1 AND ${dateBounds}
  ), page AS (SELECT * FROM sends WHERE ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT 101), summary AS (
    SELECT ${counts} FROM sends s LEFT JOIN sms_messages m ON m.send_id=s.id AND m.company_id=$1
  ), details AS (
    SELECT s.id,s.created_at created,s.kind,s.state,${counts} FROM page s LEFT JOIN sms_messages m ON m.send_id=s.id AND m.company_id=$1
    GROUP BY s.id,s.created_at,s.kind,s.state
  ) SELECT (SELECT to_jsonb(summary) FROM summary) totals,coalesce((SELECT jsonb_agg(details ORDER BY id) FROM details),'[]'::jsonb) campaigns`,
  [input.companyId,input.from,input.through,input.cursor ?? null])).rows[0]!;
  return { totals:result.totals, campaigns:result.campaigns.slice(0,100), next:result.campaigns.length>100 ? result.campaigns[99]!.id : null };
}
