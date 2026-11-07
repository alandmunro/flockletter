import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest, contentGaps, renderPreview } from '../content.js';
import type { Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import type { Actor } from '../service.js';
import { type Campaign, type CampaignContent } from '../../shared/contracts.js';
import {
  maxPracticeRecipients,
  practiceMailbox,
  type Rehearsal,
  type RehearsalAudience,
} from '../../shared/rehearsal.js';
import { reservePractice, utcPeriod, workspaceAccess } from './access.js';
import { requireSegment } from '../subscribers/segments.js';

// This transport has no network or external provider. Only reserved test destinations can enter its mailbox.
export function isPracticeAddress(address: string) {
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  return domain.endsWith('.test') || ['example.com', 'example.net', 'example.org'].includes(domain);
}
const maxDays = 30;
type Row = {
  id: string;
  campaign_id: string;
  version: number;
  content: CampaignContent;
  creator_id: string;
  actor_id: string;
  audience: RehearsalAudience;
  segment_id: string | null;
  segment_name: string | null;
  state: Rehearsal['state'];
  due_at: Date;
  reviewed_at: Date;
  selected: number;
  excluded: number;
  access_revision: number;
  reason: string | null;
  render_html: string;
  render_text: string;
};
type ReportRow = Pick<
  Row,
  | 'id'
  | 'campaign_id'
  | 'version'
  | 'audience'
  | 'segment_id'
  | 'segment_name'
  | 'state'
  | 'due_at'
  | 'selected'
  | 'excluded'
  | 'reason'
> & { pending: number; captured: number; skipped: number };
const reportColumns = `r.id,r.campaign_id,r.version,r.audience,r.segment_id,r.segment_name,r.state,r.due_at,r.selected,r.excluded,r.reason,
  counts.pending,counts.captured,counts.skipped`;
const countRecipients = `CROSS JOIN LATERAL (
  SELECT count(*) FILTER(WHERE p.state='pending')::int pending,count(*) FILTER(WHERE p.state='captured')::int captured,
    count(*) FILTER(WHERE p.state IN('cancelled','excluded'))::int skipped
  FROM rehearsal_recipients p WHERE (p.workspace_id,p.brand_id,p.rehearsal_id)=(r.workspace_id,r.brand_id,r.id)
) counts`;
function reportView(row: ReportRow): Rehearsal {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    version: row.version,
    audience: row.audience,
    ...(row.segment_id && row.segment_name
      ? { segment: { id: row.segment_id, name: row.segment_name } }
      : {}),
    state: row.state,
    dueAt: row.due_at.toISOString(),
    selected: row.selected,
    excluded: row.excluded,
    pending: row.pending,
    captured: row.captured,
    skipped: row.skipped,
    reason: row.reason,
  };
}
export async function rehearsalReport(sql: Sql, id: string): Promise<Rehearsal> {
  const row = (
    await sql.query<ReportRow>(
      `SELECT ${reportColumns} FROM campaign_rehearsals r ${countRecipients} WHERE r.id=$1`,
      [id],
    )
  ).rows[0];
  requireCondition(row, 404, 'rehearsal_missing', 'This rehearsal is unavailable for this brand.');
  return reportView(row);
}
async function rehearsalRow(sql: Sql, id: string) {
  const row = (await sql.query<Row>('SELECT * FROM campaign_rehearsals WHERE id=$1', [id])).rows[0];
  requireCondition(row, 404, 'rehearsal_missing', 'This rehearsal is unavailable for this brand.');
  return row;
}
export async function listRehearsals(sql: Sql, campaignId: string, includeConfirmed: boolean) {
  const result = await sql.query<ReportRow>(
    `SELECT ${reportColumns} FROM (
    SELECT * FROM campaign_rehearsals WHERE campaign_id=$1 AND ($2::boolean OR audience='test')
    ORDER BY reviewed_at DESC,id DESC LIMIT 15
  ) r ${countRecipients} ORDER BY r.reviewed_at DESC,r.id DESC`,
    [campaignId, includeConfirmed],
  );
  return result.rows.map(reportView);
}
export async function reviewRehearsal(
  sql: Sql,
  actor: Actor,
  draft: Campaign,
  expectedVersion: number,
  audience: RehearsalAudience,
  due?: string,
  segmentId?: string,
) {
  requireCondition(
    !segmentId || audience === 'confirmed',
    422,
    'invalid_segment_audience',
    'Choose a group only for confirmed test contacts.',
  );
  requireCondition(
    draft.version === expectedVersion,
    409,
    'version_conflict',
    'Reload the current campaign before reviewing.',
  );
  requireCondition(
    contentGaps(draft).length === 0,
    422,
    'incomplete_content',
    'Complete the campaign content and preview it first.',
  );
  const now = new Date(),
    dueAt = due ? new Date(due) : now;
  requireCondition(
    !due || (dueAt > now && dueAt.getTime() <= now.getTime() + maxDays * 86400000),
    422,
    'invalid_schedule',
    'Choose a future time within 30 days.',
  );
  const access = await workspaceAccess(sql);
  requireCondition(
    audience === 'test' || access.plan,
    422,
    'access_required',
    'A complimentary plan is required for a brand audience rehearsal.',
  );
  const id = randomUUID();
  let segment: { id: string; name: string } | undefined;
  let selected = 1,
    excluded = 0;
  let recipients: { id: string; email_normalized: string }[] = [];
  if (audience === 'confirmed') {
    requireCondition(
      actor.kind === 'session' || actor.scopes.includes('audience:summary'),
      403,
      'scope_required',
      'Grant audience totals to review a brand audience.',
    );
    if (segmentId) segment = await requireSegment(sql, segmentId, true);
    // Take audience totals and confirmed test contacts from the same statement snapshot.
    const hits = (
      await sql.query<{ id: string; email_normalized: string; total: number }>(
        `WITH population AS MATERIALIZED (
          SELECT s.id,s.email_normalized,s.state FROM subscribers s
          WHERE $2::uuid IS NULL OR EXISTS (
            SELECT FROM audience_segment_members m
            WHERE (m.workspace_id,m.brand_id,m.subscriber_id)=(s.workspace_id,s.brand_id,s.id) AND m.segment_id=$2
          )
        )
        SELECT id,email_normalized,(SELECT count(*)::int FROM population) AS total FROM population
        WHERE state='confirmed' AND (lower(split_part(email_normalized,'@',2)) LIKE '%.test'
          OR lower(split_part(email_normalized,'@',2)) IN ('example.com','example.net','example.org'))
        ORDER BY id LIMIT $1`,
        [maxPracticeRecipients + 1, segmentId ?? null],
      )
    ).rows;
    requireCondition(
      hits.length > 0 && hits.length <= maxPracticeRecipients,
      422,
      'practice_audience',
      'A rehearsal needs between 1 and 25 confirmed contacts with reserved test addresses.',
    );
    recipients = hits;
    selected = hits.length;
    excluded = hits[0]!.total - selected;
  }
  const assetIds = draft.content.assetIds;
  const assets = (
    await sql.query<{ id: string; name: string; sha256: string }>(
      'SELECT id,name,sha256 FROM assets WHERE brand_id=$1 AND id=ANY($2::uuid[])',
      [draft.brandId, assetIds],
    )
  ).rows;
  const images = assetIds.map((asset) => assets.find((image) => image.id === asset));
  requireCondition(
    images.every(Boolean),
    422,
    'image_unavailable',
    'Review the campaign images before capture.',
  );
  const rendered = renderPreview(draft, images as typeof assets);
  await sql.query(
    `INSERT INTO campaign_rehearsals(workspace_id,brand_id,id,campaign_id,version,content,creator_id,actor_id,
    audience,access_revision,selected,excluded,due_at,period,render_html,render_text,segment_id,segment_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      actor.workspaceId,
      draft.brandId,
      id,
      draft.id,
      draft.version,
      JSON.stringify(draft.content),
      actor.userId,
      actor.actorId,
      audience,
      access.revision,
      selected,
      excluded,
      dueAt,
      utcPeriod(dueAt),
      rendered.html,
      rendered.text,
      segment?.id ?? null,
      segment?.name ?? null,
    ],
  );
  if (audience === 'test') {
    await sql.query(
      'INSERT INTO rehearsal_recipients(workspace_id,brand_id,rehearsal_id,id) VALUES($1,$2,$3,$4)',
      [actor.workspaceId, draft.brandId, id, randomUUID()],
    );
  } else {
    for (const person of recipients)
      await sql.query(
        `INSERT INTO rehearsal_recipients(workspace_id,brand_id,rehearsal_id,id,subscriber_id,email_digest)
      VALUES($1,$2,$3,$4,$5,$6)`,
        [actor.workspaceId, draft.brandId, id, randomUUID(), person.id, digest(person.email_normalized)],
      );
  }
  return rehearsalReport(sql, id);
}

export async function approveRehearsal(sql: Sql, actor: Actor, brand: string, id: string) {
  const row = await rehearsalRow(sql, id);
  requireCondition(
    row.actor_id === actor.actorId && row.creator_id === actor.userId,
    403,
    'reviewer_required',
    'Confirm a review prepared with this same account or connection.',
  );
  requireCondition(
    row.state === 'reviewed' && Date.now() - row.reviewed_at.getTime() <= 30 * 60000,
    409,
    'review_expired',
    'Prepare a fresh review before confirming.',
  );
  const version = (
    await sql.query<{ version: number }>('SELECT version FROM campaigns WHERE id=$1 AND brand_id=$2', [
      row.campaign_id,
      brand,
    ])
  ).rows[0]?.version;
  requireCondition(
    version === row.version,
    409,
    'version_conflict',
    'The draft changed. Review its current version.',
  );
  const access = await workspaceAccess(sql);
  requireCondition(
    row.access_revision === access.revision,
    409,
    'access_changed',
    'Service access changed. Prepare a fresh review.',
  );
  await reservePractice(
    sql,
    actor.workspaceId,
    brand,
    id,
    utcPeriod(row.due_at),
    row.selected,
    access,
    row.audience,
  );
  await sql.query("UPDATE campaign_rehearsals SET state='queued',approved_at=now() WHERE id=$1", [id]);
  return rehearsalReport(sql, id);
}

async function finish(
  sql: Sql,
  id: string,
  state: 'completed' | 'blocked' | 'cancelled',
  reason: string | null,
) {
  await sql.query(
    "UPDATE rehearsal_recipients SET state='cancelled' WHERE rehearsal_id=$1 AND state='pending'",
    [id],
  );
  const result = (
    await sql.query<{ n: number }>(
      "SELECT count(*)::int n FROM rehearsal_recipients WHERE rehearsal_id=$1 AND state='captured'",
      [id],
    )
  ).rows[0]!;
  await sql.query(
    "UPDATE rehearsal_reservations SET settled=true,messages=$2,slots=CASE WHEN $2=0 THEN 0 ELSE slots END WHERE rehearsal_id=$1 AND brand_id::text=current_setting('app.intake_brand_id',true)",
    [id, result.n],
  );
  await sql.query('UPDATE campaign_rehearsals SET state=$2,reason=$3,finished_at=now() WHERE id=$1', [
    id,
    state,
    reason,
  ]);
}
export async function cancelRehearsal(sql: Sql, id: string) {
  const row = await rehearsalRow(sql, id);
  requireCondition(
    ['queued', 'reviewed', 'cancelled'].includes(row.state),
    409,
    'already_finished',
    'This rehearsal has already finished.',
  );
  if (row.state !== 'cancelled') await finish(sql, id, 'cancelled', 'cancelled_by_owner');
  return rehearsalReport(sql, id);
}
export type CheckOwner = (user: string, workspace: string) => Promise<boolean>;
export async function processDue(
  sql: Sql,
  workspace: string,
  brand: string,
  isOwner: CheckOwner,
  id?: string,
) {
  // serialize with public opt-outs and owner commands within the same transaction.
  await sql.query('SELECT enabled FROM subscriber_intake_settings FOR UPDATE');
  const row = (
    await sql.query<Row>(
      `SELECT * FROM campaign_rehearsals WHERE state='queued' AND due_at<=now()
    AND ($1::uuid IS NULL OR id=$1) ORDER BY due_at,id LIMIT 1 FOR UPDATE`,
      [id ?? null],
    )
  ).rows[0];
  if (!row) return { processed: false };
  const access = await workspaceAccess(sql);
  const version = (
    await sql.query<{ version: number }>('SELECT version FROM campaigns WHERE id=$1 AND brand_id=$2', [
      row.campaign_id,
      brand,
    ])
  ).rows[0]?.version;
  const conn = row.actor_id.startsWith('connection:')
    ? (
        await sql.query(
          `SELECT id FROM connections WHERE id=$1 AND issuer_id=$2
    AND revoked_at IS NULL AND expires_at>now() AND $3::uuid=ANY(brand_ids) AND 'campaign:rehearse'=ANY(scopes) AND 'read'=ANY(scopes)
    AND ($4::text='test' OR 'audience:summary'=ANY(scopes))`,
          [row.actor_id.slice(11), row.creator_id, brand, row.audience],
        )
      ).rowCount
    : true;
  let reason: string | null = null;
  if (!conn || !(await isOwner(row.creator_id, workspace))) reason = 'authority_revoked';
  else if (version !== row.version) reason = 'draft_changed';
  else if (access.revision !== row.access_revision || (row.audience === 'confirmed' && !access.plan))
    reason = 'access_changed';
  if (reason) {
    await finish(sql, row.id, 'blocked', reason);
    return { processed: true, rehearsal: await rehearsalReport(sql, row.id) };
  }
  const recipients = (
    await sql.query<{ id: string; subscriber_id: string | null; email_digest: string | null }>(
      "SELECT id,subscriber_id,email_digest FROM rehearsal_recipients WHERE rehearsal_id=$1 AND state='pending' ORDER BY subscriber_id FOR UPDATE",
      [row.id],
    )
  ).rows;
  for (const recipient of recipients) {
    let eligible = row.audience === 'test' && !recipient.subscriber_id;
    if (recipient.subscriber_id && row.audience === 'confirmed') {
      const person = (
        await sql.query<{ email_normalized: string; state: string }>(
          'SELECT email_normalized,state FROM subscribers WHERE id=$1 FOR UPDATE',
          [recipient.subscriber_id],
        )
      ).rows[0];
      eligible = Boolean(
        person &&
        person.state === 'confirmed' &&
        isPracticeAddress(person.email_normalized) &&
        digest(person.email_normalized) === recipient.email_digest,
      );
    }
    await sql.query(
      `UPDATE rehearsal_recipients SET state=$3,captured_at=CASE WHEN $3='captured' THEN now() END
      WHERE rehearsal_id=$1 AND id=$2 AND state='pending'`,
      [row.id, recipient.id, eligible ? 'captured' : 'excluded'],
    );
  }
  await finish(sql, row.id, 'completed', null);
  return { processed: true, rehearsal: await rehearsalReport(sql, row.id) };
}

export async function capturedMessage(sql: Sql, brand: string, id: string) {
  const row = await rehearsalRow(sql, id),
    report = await rehearsalReport(sql, id);
  requireCondition(
    report.captured > 0,
    409,
    'mailbox_empty',
    'No message has been captured for this rehearsal.',
  );
  const ids = row.content.assetIds;
  const assets = (
    await sql.query<{ mime: string; bytes: Buffer }>(
      'SELECT mime,bytes FROM assets WHERE brand_id=$1 AND id=ANY($2::uuid[])',
      [brand, ids],
    )
  ).rows;
  const sources = new Map(
    assets.map((im) => [digest(im.bytes), 'data:' + im.mime + ';base64,' + im.bytes.toString('base64')]),
  );
  const html = row.render_html.replace(/src="cid:([a-f0-9]{64})"/g, (_match, hash: string) => {
    const source = sources.get(hash);
    requireCondition(source, 409, 'image_unavailable', 'A reviewed image is unavailable.');
    return 'src="' + source + '"';
  });
  return {
    mailbox: practiceMailbox,
    subject: row.content.subject,
    version: row.version,
    html,
    text: row.render_text,
  };
}
export const workspaceIdentifier = z.string().regex(/^org_[A-Za-z0-9_-]{1,120}$/);
