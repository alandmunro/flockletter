import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { type AssetSummary, type Campaign, emptyContent } from '../src/shared/contracts.js';
import { emptyStudio } from '../src/shared/studio.js';
import { keyed, type startStudioProof } from './studio-proof-fixture.js';
import { studioFixtureImage } from './studio-fixture-image.js';

export async function verifyStudioImageUpload(
  page: Page,
  site: Awaited<ReturnType<typeof startStudioProof>>,
) {
  if (new URL(site.origin).hostname !== '127.0.0.1') throw Error('Use the isolated Studio browser fixture.');
  const title = 'In-progress image upload proof';
  const subject = 'Keep this unsaved subject';
  const story = 'Keep this unsaved story beside the new original.';
  const name = 'During-draft original.png';
  const invalid = 'Invalid fixture.png';
  const original = await studioFixtureImage('#dbbf88');
  const draft = await site.command<Campaign>(
    'campaign.create',
    keyed({ brandId: site.brandId, content: { ...emptyContent(), title, studio: emptyStudio() } }),
  );
  const button = (label: string) => page.getByRole('button', { name: label, exact: true });
  await page.goto(site.origin);
  await button('Campaigns').click();
  await button('Edit ' + title).click();
  await page.getByRole('textbox', { name: 'Subject', exact: true }).fill(subject);
  await button('Edit paragraph block').click();
  const paragraph = page.getByRole('textbox', { name: 'Paragraph text', exact: true });
  await paragraph.fill(story);
  await page.getByText('Add original images', { exact: true }).click();
  await page.getByLabel('Add JPEG, PNG, GIF, WebP or SVG images', { exact: true }).setInputFiles([
    { name, mimeType: 'image/png', buffer: original },
    { name: invalid, mimeType: 'image/png', buffer: Buffer.from('not an image') },
  ]);
  const upload = button('Upload 2 images');
  const endpoint = '**/api/v1/commands/asset.uploadBatch';
  const attempts: {
    operationKey: string;
    brandId: string;
    files: { itemKey: string; name: string; base64: string }[];
  }[] = [];
  await page.route(endpoint, async (route) => {
    const request = route.request().postDataJSON() as (typeof attempts)[number];
    attempts.push(request);
    const response = await route.fetch();
    assert(response.ok(), 'The synthetic batch must commit before the simulated lost reply');
    if (attempts.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  try {
    await upload.click();
    await page
      .getByRole('alert')
      .filter({ hasText: /fetch|network|upload/i })
      .first()
      .waitFor();
    await upload.click();
    await page.getByText('Saved: ' + name, { exact: true }).waitFor();
    await page.getByText(new RegExp('^' + invalid.replace('.', '\\.') + ':')).waitFor();
  } finally {
    await page.unroute(endpoint);
  }
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts[0],
    attempts[1],
    'A retry reuses its operation key, all item keys and exact bytes.',
  );
  assert.equal(attempts[0]?.brandId, site.brandId);
  assert.equal(new Set(attempts[0]!.files.map((f) => f.itemKey)).size, 2);
  assert.equal(attempts[0]!.files[0]!.base64, original.toString('base64'));
  assert.equal(await page.getByRole('textbox', { name: 'Subject', exact: true }).inputValue(), subject);
  assert.equal(await paragraph.innerText(), story);
  assert.equal(
    (await site.command<Campaign>('campaign.get', { id: draft.id })).version,
    1,
    'Uploading does not save or overwrite the draft.',
  );
  const library = await site.command<AssetSummary[]>('asset.list', { brandId: site.brandId });
  const matching = library.filter((item) => item.name === name);
  assert.equal(matching.length, 1, 'The original should appear once after the unknown response.');
  assert(!library.some((item) => item.name === invalid));
  const file = matching[0]!;
  const download = await page.request.get(site.origin + '/api/v1/assets/' + file.id, {
    headers: { authorization: 'Bearer local-development-only' },
  });
  assert(download.ok());
  assert.deepEqual(await download.body(), original);
  await button('Add image').click();
  await page.getByRole('combobox', { name: 'Brand image', exact: true }).selectOption({ label: name });
  await page.getByLabel('Image description', { exact: true }).fill('Fictional trailhead landscape');
  await button('Save draft').click();
  await page.getByText('Saved version 2.', { exact: true }).waitFor();
  const saved = await site.command<Campaign>('campaign.get', { id: draft.id });
  assert.equal(saved.version, 2);
  assert.equal(saved.content.subject, subject);
  assert.deepEqual(saved.content.assetIds, [file.id]);
  assert(
    saved.content.studio?.blocks.some((b) => b.type === 'paragraph' && b.runs.some((r) => r.text === story)),
  );
  assert(
    saved.content.studio?.blocks.some(
      (b) => b.type === 'image' && b.assetId === file.id && b.alt === 'Fictional trailhead landscape',
    ),
  );
  await button('Image library').click();
  const brandPicker = page.getByLabel('Image library brand', { exact: true });
  await brandPicker.selectOption(site.siblingBrandId);
  await page.getByText(site.sibling.asset.name, { exact: true }).waitFor();
  assert.equal(await page.getByText(name, { exact: true }).count(), 0);
  await brandPicker.selectOption(site.brandId);
  await page.getByText(name, { exact: true }).waitFor();
}
