import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CommandService } from '../src/server/service.js';
import { loadMarketingLinks, redeemMarketingLink } from '../src/server/subscribers/marketing-links.js';
import { SubscriberIntake } from '../src/server/subscribers/intake.js';
import { CapturedConfirmation } from '../src/server/confirmation/provider.js';
import { ConfirmationWorker } from '../src/server/confirmation/worker.js';
import { DeliveryWorker } from '../src/server/campaign/delivery-worker.js';
import { consentPolicy } from '../src/shared/subscriber.js';
import { emptyContent, type Campaign, type AssetSummary } from '../src/shared/contracts.js';
import { type Rehearsal } from '../src/shared/rehearsal.js';
import { studioFixtureImage } from '../scripts/studio-fixture-image.js';
import { RecordingProvider, startDeliveryFixture } from './staging-delivery-fixture.js';

let site: Awaited<ReturnType<typeof startDeliveryFixture>>;
beforeAll(async () => {
  site = await startDeliveryFixture();
});
afterAll(async () => {
  await site?.close();
});

it('takes an opt-in through confirmation, a reviewed newsletter with its original photo, and exclusion after one-click unsubscribe', async () => {
  const a = await site.workspace(),
    { brandId, workspaceId, owner } = a;
  const origin = 'https://mail.example.test',
    email = 'reader@campaign.test';
  const bindings = JSON.stringify([{ workspaceId, brandId }]);
  const marketing = loadMarketingLinks(origin, {
    FLOCKLETTER_UNSUBSCRIBE_BINDINGS: bindings,
    FLOCKLETTER_UNSUBSCRIBE_SIGNING_KEY: randomBytes(32).toString('hex'),
  })!;
  const binding = {
    workspaceId,
    brandId,
    origin,
    sourceDomain: 'shop.example.test',
    key: randomBytes(32),
    sender: 'mail@example.test',
    mode: 'capture' as const,
    recipients: new Set([email]),
  };
  const intake = new SubscriberIntake(site.db, binding);
  const confirmations = new CapturedConfirmation();
  const worker = new ConfirmationWorker(site.db, binding, confirmations, site.identity.isOwner);
  const service = new CommandService(
    site.db,
    intake,
    site.identity.isOwner,
    undefined,
    undefined,
    undefined,
    () => true,
    undefined,
    undefined,
    'test',
    marketing,
  );
  const capture = new RecordingProvider();
  const delivery = new DeliveryWorker(
    site.db,
    site.identity.isOwner,
    capture,
    undefined,
    undefined,
    marketing,
  );
  const status = async () =>
    site.db.brand(
      workspaceId,
      brandId,
      async (sql) =>
        (await sql.query('SELECT state FROM subscribers WHERE email_normalized=$1', [email])).rows[0]?.state,
    );
  try {
    await worker.tick();
    await service.execute('intake.configure', { operationKey: randomUUID(), brandId, enabled: true }, owner);
    const issued = (await service.execute(
      'connection.create',
      {
        operationKey: randomUUID(),
        name: 'Storefront test',
        scopes: ['subscriber:signup'],
        brandIds: [brandId],
        expiresInDays: 1,
      },
      owner,
    )) as { connection: { id: string } };
    await intake.signup(
      {
        ...owner,
        kind: 'connection',
        actorId: 'connection:' + issued.connection.id,
        brandIds: [brandId],
        scopes: ['subscriber:signup'],
      },
      brandId,
      randomUUID(),
      {
        email,
        purpose: consentPolicy.purpose,
        consentAffirmed: true,
        consentVersion: consentPolicy.version,
        consentText: consentPolicy.text,
        source: 'storefront-footer',
        sourceDomain: binding.sourceDomain,
      },
    );
    expect(await status()).toBe('pending');
    await worker.tick();
    const confirmation = [...confirmations.messages.values()][0]!;
    expect(confirmation.to).toBe(email);
    await intake.act('confirm', new URL(confirmation.confirm).hash.slice(1));
    expect(await status()).toBe('confirmed');
    const original = await studioFixtureImage('#7c4058');
    const upload = await a.command<{ results: { asset: AssetSummary }[] }>('asset.uploadBatch', {
      operationKey: randomUUID(),
      brandId,
      files: [{ itemKey: randomUUID(), name: 'shop-original.png', base64: original.toString('base64') }],
    });
    const draft = await a.command<Campaign>('campaign.create', {
      operationKey: randomUUID(),
      brandId,
      content: {
        ...emptyContent(),
        title: 'Alpine release',
        subject: 'Trail news',
        heading: 'New this month',
        fromName: 'Alpine',
        replyTo: 'shop@example.test',
        body: 'A new shirt is ready.',
        assetIds: [upload.results[0]!.asset.id],
      },
    });
    const review = (includeUnsubscribe: boolean) =>
      service.execute(
        'rehearsal.review',
        {
          operationKey: randomUUID(),
          brandId,
          campaignId: draft.id,
          expectedVersion: draft.version,
          audience: 'confirmed',
          transport: 'provider_test',
          includeUnsubscribe,
        },
        owner,
      ) as Promise<Rehearsal>;
    const legacy = await review(false);
    const held = await review(true);
    const approved = await review(true);
    expect(approved.includesUnsubscribe).toBe(true);
    expect(legacy.includesUnsubscribe).toBeUndefined();
    expect(JSON.stringify(approved)).not.toContain('?t=');
    for (const id of [legacy.id, held.id, approved.id])
      await service.execute('rehearsal.approve', { operationKey: randomUUID(), brandId, id }, owner);
    await delivery.tick(workspaceId, brandId, legacy.id);
    expect(capture.submitted[0]?.unsubscribe).toBeUndefined();
    const changed = new DeliveryWorker(
      site.db,
      site.identity.isOwner,
      capture,
      undefined,
      undefined,
      loadMarketingLinks(origin, {
        FLOCKLETTER_UNSUBSCRIBE_BINDINGS: bindings,
        FLOCKLETTER_UNSUBSCRIBE_SIGNING_KEY: randomBytes(32).toString('hex'),
      }),
    );
    await changed.tick(workspaceId, brandId, held.id);
    expect(await a.command<Rehearsal>('rehearsal.report', { brandId, id: held.id })).toMatchObject({
      state: 'blocked',
      reason: 'unsubscribe_unavailable',
    });
    expect(capture.submitted).toHaveLength(1);
    await delivery.tick(workspaceId, brandId, approved.id);
    const message = capture.submitted[1]!;
    expect(message.images[0]?.bytes.equals(original)).toBe(true);
    const url = new URL(message.unsubscribe!.url);
    expect(message.html).toContain('href="' + url.href + '"');
    expect(message.text).toContain(url.href);
    expect(message.html).not.toContain('Preview only.');
    const queued = await review(true);
    await service.execute('rehearsal.approve', { operationKey: randomUUID(), brandId, id: queued.id }, owner);
    await redeemMarketingLink(site.db, marketing, url.searchParams.get('t')!);
    expect(await status()).toBe('unsubscribed');
    await delivery.tick(workspaceId, brandId, queued.id);
    expect(await a.command<Rehearsal>('rehearsal.report', { brandId, id: queued.id })).toMatchObject({
      state: 'completed',
      skipped: 1,
      accepted: 0,
    });
    await expect(review(true)).rejects.toMatchObject({ code: 'practice_audience' });
    expect(capture.submitted).toHaveLength(2);
  } finally {
    await a.close();
  }
});
