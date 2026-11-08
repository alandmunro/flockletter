import { randomUUID } from 'node:crypto';
import type { AudienceSummary } from '../../shared/audience.js';
import {
  segmentLimit,
  type Segment,
  type SegmentAction,
  type SegmentDirectory,
  type SegmentMembershipResult,
} from '../../shared/segments.js';
import type { Sql } from '../db.js';
import { AppError, requireCondition } from '../errors.js';

// Callers validate the current actor and brand and set the brand RLS context inside the transaction.
const unavailable = 'This group is unavailable for the selected brand.';
const nameConflict = 'This brand already has a group with this name.';
export async function requireSegment(sql: Sql, id: string, lock = false) {
  const result = await sql.query<{ id: string; name: string }>(
    'SELECT id,name FROM audience_segments WHERE id=$1' + (lock ? ' FOR UPDATE' : ''),
    [id],
  );
  requireCondition(result.rows[0], 404, 'segment_unavailable', unavailable);
  return result.rows[0];
}

async function segmentRows(sql: Sql, id: string | null) {
  const result = await sql.query<{ id: string; name: string } & AudienceSummary>(
    `SELECT g.id,g.name,count(s.id)::int AS total,
      count(*) FILTER (WHERE s.state='pending')::int AS pending,
      count(*) FILTER (WHERE s.state='confirmed')::int AS confirmed,
      count(*) FILTER (WHERE s.state='unsubscribed')::int AS unsubscribed,
      count(*) FILTER (WHERE s.state='hard_bounced')::int AS hard_bounced,
      count(*) FILTER (WHERE s.state='complained')::int AS complained
    FROM audience_segments g
    LEFT JOIN audience_segment_members m ON (m.workspace_id,m.brand_id,m.segment_id)=(g.workspace_id,g.brand_id,g.id)
    LEFT JOIN subscribers s ON (s.workspace_id,s.brand_id,s.id)=(m.workspace_id,m.brand_id,m.subscriber_id)
    WHERE ($1::uuid IS NULL OR g.id=$1)
    GROUP BY g.workspace_id,g.brand_id,g.id ORDER BY lower(g.name),g.id`,
    [id],
  );
  return result.rows.map(({ id: key, name, ...counts }): Segment => ({ id: key, name, counts }));
}

async function segmentDetail(sql: Sql, id: string) {
  const [segment] = await segmentRows(sql, id);
  requireCondition(segment, 404, 'segment_unavailable', unavailable);
  return segment;
}
export async function listSegments(sql: Sql): Promise<SegmentDirectory> {
  return { items: await segmentRows(sql, null), limit: segmentLimit };
}
export async function segmentSummary(sql: Sql, id: string): Promise<AudienceSummary> {
  return (await segmentDetail(sql, id)).counts;
}
export async function createSegment(sql: Sql, workspace: string, brand: string, name: string) {
  // Allocate from 50 physical slots. The scoped unique index enforces this limit even for concurrent inserts.
  const found = await sql.query('SELECT id FROM brands WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
    workspace,
    brand,
  ]);
  requireCondition(found.rowCount, 404, 'brand_unavailable', 'This brand is unavailable.');
  const slot = (
    await sql.query<{ slot: number }>(
      `SELECT slot FROM generate_series(1,$1::int) AS possible(slot)
     WHERE NOT EXISTS (SELECT FROM audience_segments g WHERE g.workspace_id=$2 AND g.brand_id=$3 AND g.slot=possible.slot)
     ORDER BY slot LIMIT 1`,
      [segmentLimit, workspace, brand],
    )
  ).rows[0];
  requireCondition(
    slot,
    422,
    'segment_limit',
    'This brand has 50 groups. Delete an unused group to add another.',
  );
  const id = randomUUID();
  const inserted = await sql.query(
    'INSERT INTO audience_segments(workspace_id,brand_id,id,name,slot) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
    [workspace, brand, id, name, slot.slot],
  );
  requireCondition(inserted.rowCount, 409, 'segment_name_conflict', nameConflict);
  return segmentDetail(sql, id);
}
export async function renameSegment(sql: Sql, id: string, name: string) {
  await requireSegment(sql, id, true);
  try {
    await sql.query('UPDATE audience_segments SET name=$2 WHERE id=$1', [id, name]);
  } catch (error) {
    const cause = error as { code?: string; constraint?: string } | null;
    if (cause?.code === '23505' && cause.constraint === 'audience_segments_name')
      throw new AppError(409, 'segment_name_conflict', nameConflict);
    throw error;
  }
  return segmentDetail(sql, id);
}
export async function deleteSegment(sql: Sql, id: string) {
  const result = await sql.query('DELETE FROM audience_segments WHERE id=$1 RETURNING id', [id]);
  requireCondition(result.rowCount, 404, 'segment_unavailable', unavailable);
  return { id };
}
export async function updateSegmentMembers(
  sql: Sql,
  workspace: string,
  brand: string,
  segmentId: string,
  action: SegmentAction,
  emails: string[],
): Promise<SegmentMembershipResult> {
  await requireSegment(sql, segmentId, true);
  const contacts = (
    await sql.query<{ id: string; email_normalized: string }>(
      'SELECT id,email_normalized FROM subscribers WHERE workspace_id=$1 AND brand_id=$2 AND email_normalized=ANY($3::text[])',
      [workspace, brand, [...new Set(emails)]],
    )
  ).rows;
  const found = new Set(contacts.map((contact) => contact.email_normalized));
  const missing = emails.flatMap((email, index) => (found.has(email) ? [] : [index + 1]));
  requireCondition(
    !missing.length,
    422,
    'segment_contacts_unavailable',
    'Every address must already be in this brand. Review ' +
      (missing.length === 1 ? 'row ' : 'rows ') +
      missing.slice(0, 10).join(', ') +
      (missing.length > 10 ? ' and ' + (missing.length - 10) + ' more' : '') +
      '.',
  );
  const ids = contacts.map((contact) => contact.id);
  const result =
    action === 'add'
      ? await sql.query(
          `INSERT INTO audience_segment_members(workspace_id,brand_id,segment_id,subscriber_id)
     SELECT $1,$2,$3,subscriber FROM unnest($4::uuid[]) AS input(subscriber) ON CONFLICT DO NOTHING`,
          [workspace, brand, segmentId, ids],
        )
      : await sql.query(
          'DELETE FROM audience_segment_members WHERE workspace_id=$1 AND brand_id=$2 AND segment_id=$3 AND subscriber_id=ANY($4::uuid[])',
          [workspace, brand, segmentId, ids],
        );
  return { segmentId, changed: result.rowCount ?? 0, counts: await segmentSummary(sql, segmentId) };
}
