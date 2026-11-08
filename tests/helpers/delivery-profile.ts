import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../../src/server/db.js';
import type { Actor } from '../../src/server/service.js';
import type { CustomerDelivery } from '../../src/server/customer-delivery/service.js';

const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export async function saveSenderProfile(
  delivery: CustomerDelivery,
  actor: Actor,
  brandId: string,
  postalAddress = '100 Example Lane, Denver, CO 80202',
): Promise<void> {
  await delivery.execute(
    'delivery.saveSender',
    {
      operationKey: randomUUID(),
      brandId,
      fromName: 'Trail shop',
      fromEmail: 'news@shop.test',
      replyTo: 'support@shop.test',
      organization: 'Synthetic Trail Shop',
      postalAddress,
    },
    actor,
  );
}

export async function addCampaignPhoto(
  db: Database,
  actor: Actor,
  brandId: string,
  campaignId: string,
): Promise<{ id: string; name: string; bytes: Buffer; sha256: string }> {
  const id = randomUUID();
  const itemKey = `photo-${randomUUID()}`;
  const bytes = Buffer.from(PNG_1PX_BASE64, 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  await db.tenant(actor.workspaceId, async (sql) => {
    await sql.query(
      `INSERT INTO assets (workspace_id, id, brand_id, item_key, name, mime, bytes, sha256, width, height)
       VALUES ($1, $2::uuid, $3::uuid, $4, $5, 'image/png', $6, $7, 1, 1)`,
      [actor.workspaceId, id, brandId, itemKey, 'photo.png', bytes, sha256],
    );

    await sql.query(
      `UPDATE campaigns SET content = jsonb_set(content, '{assetIds}', to_jsonb(ARRAY[$1::uuid]), true)
       WHERE workspace_id = $2 AND id = $3::uuid`,
      [id, actor.workspaceId, campaignId],
    );
  });

  return { id, name: 'photo.png', bytes, sha256 };
}
