import { createHash } from 'node:crypto';
import type { Sql } from '../db.js';
import type { DeliveryEnvelope } from './delivery-provider.js';
import { rehearsalRow, settleReservation, submissionBlock, type CheckOwner } from './rehearsal.js';

type Reviewed = Awaited<ReturnType<typeof rehearsalRow>>;
export async function deliveryBlock(
  sql: Sql,
  row: Reviewed,
  workspace: string,
  brand: string,
  isOwner: CheckOwner,
) {
  await sql.query('SELECT enabled FROM subscriber_intake_settings FOR UPDATE');
  if (row.state !== 'queued') return row.reason ?? 'cancelled_by_owner';
  const authority = await submissionBlock(sql, row, workspace, brand, isOwner);
  if (authority) return authority;
  const reserved = await sql.query(
    "SELECT 1 FROM rehearsal_reservations WHERE rehearsal_id=$1 AND brand_id=$3 AND NOT settled AND (slots=1 OR $2::text='test') AND messages>=1 FOR UPDATE",
    [row.id, row.audience, brand],
  );
  return reserved.rowCount ? null : 'reservation_unavailable';
}
export async function reviewedEnvelope(
  sql: Sql,
  row: Reviewed,
  workspace: string,
  brand: string,
  operation: string,
  address: string,
): Promise<DeliveryEnvelope | null> {
  const images = await originalImages(sql, brand, row.content.assetIds);
  if (!images) return null;
  return {
    operationKey: operation,
    workspaceId: workspace,
    brandId: brand,
    to: address,
    subject: row.content.subject,
    html: row.render_html,
    text: row.render_text,
    images,
  };
}
export async function finishIfDone(sql: Sql, id: string) {
  await settleReservation(sql, id);
  await sql.query(
    `UPDATE campaign_rehearsals SET state='completed',finished_at=now()
    WHERE id=$1 AND state='queued' AND NOT EXISTS (SELECT FROM rehearsal_recipients
      WHERE rehearsal_id=$1 AND state IN ('pending','submitting','uncertain'))`,
    [id],
  );
}

async function originalImages(
  sql: Sql,
  brand: string,
  ids: string[],
): Promise<DeliveryEnvelope['images'] | null> {
  const { rows } = await sql.query<DeliveryEnvelope['images'][number] & { id: string }>(
    'SELECT id,name,mime,sha256,bytes FROM assets WHERE brand_id=$1 AND id=ANY($2::uuid[])',
    [brand, ids],
  );
  const ordered: DeliveryEnvelope['images'] = [];
  for (const id of ids) {
    const image = rows.find((row) => row.id === id);
    if (!image || createHash('sha256').update(image.bytes).digest('hex') !== image.sha256) return null;
    ordered.push(image);
  }
  return ordered;
}
