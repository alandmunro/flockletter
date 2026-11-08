import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startPrivateMessenger } from '../src/server/campaign/private-messenger.js';
import { CommandService } from '../src/server/service.js';
import { emptyContent, type Campaign } from '../src/shared/contracts.js';
import type { Rehearsal, RecipientOutcome } from '../src/shared/rehearsal.js';
import { startDeliveryFixture } from '../tests/staging-delivery-fixture.js';
import { studioFixtureImage } from './studio-fixture-image.js';

// A real local Listmonk engine with its own empty database. The fixture supplies separate application
// PostgreSQL roles, an HTTP/MCP client and synthetic identity; it never uses hosted credentials.
const site = await startDeliveryFixture();
let account: Awaited<ReturnType<typeof site.workspace>> | undefined;
let running: Awaited<ReturnType<typeof startPrivateMessenger>>;
try {
  account = await site.workspace();
  const { workspaceId, brandId, owner } = account;
  const boot = () =>
    startPrivateMessenger(site.db, site.identity.isOwner, undefined, {
      APP_ENV: 'staging',
      FLOCKLETTER_PRIVATE_ENGINE: 'embedded',
      FLOCKLETTER_CAPTURE_WORKSPACE: workspaceId,
      FLOCKLETTER_CAPTURE_BRAND: brandId,
    });
  running = await boot();
  assert(running);
  const service = new CommandService(
    site.db,
    undefined,
    site.identity.isOwner,
    undefined,
    undefined,
    undefined,
    () => true,
    undefined,
    running.dispatcher,
  );
  const photo = await studioFixtureImage('#924054');
  const upload = await account.command<{ results: { asset: { id: string } }[] }>('asset.uploadBatch', {
    operationKey: randomUUID(),
    brandId,
    files: [{ itemKey: randomUUID(), name: 'Alpine-sample.png', base64: photo.toString('base64') }],
  });
  const draft = await account.command<Campaign>('campaign.create', {
    operationKey: randomUUID(),
    brandId,
    content: {
      ...emptyContent(),
      title: 'Restart proof',
      subject: 'Alpine {{ field notes }}',
      fromName: 'Test shop',
      replyTo: 'shop@example.test',
      heading: 'Trail report',
      body: 'Independent plain text with {{literal braces}}.',
      assetIds: [upload.results[0]!.asset.id],
    },
  });
  const item = (await service.execute(
    'rehearsal.review',
    {
      operationKey: randomUUID(),
      brandId,
      campaignId: draft.id,
      expectedVersion: draft.version,
      audience: 'test',
      transport: 'listmonk_test',
    },
    owner,
  )) as Rehearsal;
  const args = { brandId, id: item.id };
  await service.execute('rehearsal.approve', { ...args, operationKey: randomUUID() }, owner);
  await service.execute('rehearsal.process', { ...args, operationKey: randomUUID() }, owner);
  let saved = false;
  const deadline = Date.now() + 25000;
  while (!saved && Date.now() < deadline) {
    const status = await site.db.brand(workspaceId, brandId, (sql) =>
      sql.query('SELECT callback_at,provider_claim FROM listmonk_handoffs WHERE rehearsal_id=$1', [item.id]),
    );
    saved = Boolean(status.rows[0]?.callback_at && !status.rows[0].provider_claim);
    if (!saved) await delay(100);
  }
  assert(saved, 'The real Listmonk callback did not reach the protected durable handoff.');
  await running.close();
  running = undefined;
  running = await boot();
  assert(running);
  await running.dispatcher.tick(workspaceId, brandId, item.id);
  const report = await account.command<Rehearsal>('rehearsal.report', args);
  assert.equal(report.state, 'completed');
  assert.equal(report.accepted, 1);
  const outcomes = await account.command<{ recipients: RecipientOutcome[] }>('rehearsal.outcomes', args);
  assert.deepEqual(await account.tool('rehearsal_outcomes', args), outcomes);
  assert.equal(outcomes.recipients[0]?.feedback, 'delivered');
  assert.equal(outcomes.recipients[0]?.attempts, 1);
  const receipt = await site.db.brand(workspaceId, brandId, (sql) =>
    sql.query('SELECT operation_key FROM campaign_provider_receipts WHERE rehearsal_id=$1', [item.id]),
  );
  assert.equal(receipt.rowCount, 1);
  const original = await site.db.brand(workspaceId, brandId, (sql) =>
    sql.query('SELECT sha256,bytes FROM assets WHERE id=$1', [upload.results[0]!.asset.id]),
  );
  assert.equal(createHash('sha256').update(photo).digest('hex'), original.rows[0].sha256);
  assert.deepEqual(original.rows[0].bytes, photo);
  console.log(
    'Real Listmonk callback persisted with its original inline photo; replacing the handler and renderer produced one provider receipt, one attempt, and matching HTTP/MCP delivery reports.',
  );
} finally {
  await running?.close();
  await account?.close();
  await site.close();
}
