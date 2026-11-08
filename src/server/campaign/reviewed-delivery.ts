import { createHash } from 'node:crypto';
import type { Sql } from '../db.js';
import type { DeliveryEnvelope } from './delivery-provider.js';
import { rehearsalRow, settleReservation, submissionBlock, type CheckOwner } from './rehearsal.js';
import { AppError } from '../errors.js';
import {
  buildMarketingMessageLinks,
  unsubscribeProfile,
  type MarketingLinks,
} from '../subscribers/marketing-links.js';

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

// Personalize only at the last provider boundary. Drafts, engine callbacks, receipts
// and customer-facing reports never contain a redeemable capability.
export async function finalRecipientMessage(
  sql: Sql,
  row: Reviewed,
  message: DeliveryEnvelope,
  subscriberId: string | null,
  settings?: MarketingLinks,
): Promise<DeliveryEnvelope | null> {
  if (!row.content.unsubscribeProfile) return message;
  const scope = { workspaceId: message.workspaceId, brandId: message.brandId };
  if (!settings || !subscriberId || unsubscribeProfile(settings, scope) !== row.content.unsubscribeProfile)
    return null;
  try {
    const { bodyUrl } = await buildMarketingMessageLinks(sql, settings, { ...scope, subscriberId }, true);
    const footer =
      '<p style="text-align:center;font:14px Arial,sans-serif"><a href="' +
      bodyUrl +
      '">Unsubscribe from this newsletter</a></p>';
    const legacy =
      '<p style="font-size:12px;color:#69515d">Preview only. Verified sender details and unsubscribe controls are required before delivery.</p></main></body></html>';
    const html = message.html.endsWith(legacy)
      ? message.html.slice(0, -legacy.length) + footer + '</main></body></html>'
      : message.html.replace(/<\/body><\/html>$/i, footer + '</body></html>');
    if (html === message.html) return null;
    return {
      ...message,
      html,
      text: message.text + '\n\nUnsubscribe from this newsletter: ' + bodyUrl,
      unsubscribe: { url: bodyUrl },
    };
  } catch (error) {
    if (error instanceof AppError && ['unsubscribe_unavailable', 'recipient_ineligible'].includes(error.code))
      return null;
    throw error;
  }
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
