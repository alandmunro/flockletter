// Exercise the customer-facing package importer with synthetic content and generated, local-only pictures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import type { AssetSummary, Campaign } from '../src/shared/contracts.js';
import { startStudioProof } from './studio-proof-fixture.js';
import { studioFixtureImage } from './studio-fixture-image.js';
import { rejectOptionalCookies } from './browser-cookie-choice.js';

const draftTitle = 'Winter weekend letter';
const booking = 'https://retailer.example.com/winter';
const files = ['living-room.png', 'winter-lake.png', 'pool.png'];
const sections = ['Welcome to the lodge', 'A walk by the lake', 'An afternoon swim', 'Plan your stay'];
const source = `Subject: Winter at the lodge
Preview text: A weekend by the lake

# ${sections[0]}

Settle in for **two nights**.

![Living room](images/living-room.png)

## ${sections[1]}

![Winter lake](images/winter-lake.png)

- Lakeside trail
- Warm blankets
- Hot cocoa
- Snowshoes

## ${sections[2]}

![Pool](images/pool.png)

> [!TIP] Bring your towel.

## ${sections[3]}

[Book a stay](${booking})

Warm regards,\x20\x20
The lodge team 🦩
`;
const dir = await mkdtemp(path.join(tmpdir(), 'flockletter-import-browser-'));
const site = await startStudioProof();
let browser: Browser | undefined;
try {
  await mkdir(path.join(dir, 'images'));
  const photos = await Promise.all(['#821a34', '#aed3ee', '#eac06a'].map(studioFixtureImage));
  await writeFile(path.join(dir, 'newsletter.md'), source);
  for (const [i, name] of files.entries()) await writeFile(path.join(dir, 'images', name), photos[i]!);
  execFileSync(
    'zip',
    ['-q', '-X', 'newsletter.zip', 'newsletter.md', ...files.map((name) => 'images/' + name)],
    { cwd: dir },
  );

  browser = await chromium.launch({ channel: process.env.FLOCKLETTER_BROWSER_CHANNEL ?? 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === site.origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    errors.push('Unexpected network request to ' + url.origin);
    return route.abort();
  });
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  try {
    await page.goto(site.origin);
    await rejectOptionalCookies(page);
    await button('Campaigns').click();
    await page.getByRole('combobox', { name: /^Brand for new campaign/ }).selectOption(site.brandId);
    await button('Import newsletter').click();
    await page.getByLabel('Newsletter file', { exact: true }).setInputFiles(path.join(dir, 'newsletter.zip'));
    await button('Review import').click();
    await page.getByLabel('Use detected email headers and remove their lines from the body').check();
    await page.getByLabel('Draft title', { exact: true }).fill(draftTitle);
    assert.equal(await page.getByLabel('Email subject', { exact: true }).inputValue(), 'Winter at the lodge');
    assert.equal(await page.getByLabel('Preheader', { exact: true }).inputValue(), 'A weekend by the lake');
    await page.getByRole('checkbox', { name: /Book a stay/ }).check();
    for (const alt of ['Living room', 'Winter lake', 'Pool'])
      await page.getByRole('img', { name: alt, exact: true }).waitFor();
    const warnings = page.getByRole('checkbox', { name: 'I reviewed these formatting changes.' });
    if (await warnings.count()) await warnings.check();
    await button('Upload photos and preview draft').click();
    await button('Create draft').waitFor();
    assert.deepEqual(await site.command('campaign.list', {}), []);
    await button('Create draft').click();
    await button('Edit callout block').click();
    await page.getByRole('textbox', { name: 'Callout text', exact: true }).fill('Bring your swimming gear.');
    await button('Save draft').click();
    await page.getByText('Saved version 2.', { exact: true }).waitFor();
    await page.reload();
    await button('Campaigns').click();
    await button('Edit ' + draftTitle).click();
    await button('Preview & check').click();
    const frame = page.frameLocator('iframe[title="Campaign email preview"]');
    for (const width of ['Desktop', 'Mobile']) {
      if (width === 'Mobile') await page.setViewportSize({ width: 390, height: 844 });
      await button(width).click();
      assert.deepEqual(await frame.locator('h1,h2').allTextContents(), sections);
      assert.deepEqual(await frame.locator('li').allTextContents(), [
        'Lakeside trail',
        'Warm blankets',
        'Hot cocoa',
        'Snowshoes',
      ]);
      await frame.getByText(/Bring your swimming gear/).waitFor();
      await frame.getByText(/The lodge team 🦩/).waitFor();
      assert.equal(await frame.getByRole('link', { name: 'Book a stay' }).getAttribute('href'), booking);
      assert.deepEqual(
        await frame.locator('img').evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src'))),
        photos.map((bytes) => 'data:image/png;base64,' + bytes.toString('base64')),
      );
    }
    await page.getByText('Plain-text version', { exact: true }).click();
    const plain = await page
      .locator('details')
      .filter({ has: page.getByText('Plain-text version', { exact: true }) })
      .locator('pre')
      .innerText();
    assert.match(plain, /• Lakeside trail/);
    assert.ok(plain.split('\n').includes('Book a stay — ' + booking));
    assert.match(plain, /The lodge team 🦩/);
    const drafts = await site.command<Campaign[]>('campaign.list', {});
    assert.equal(drafts.length, 1);
    const [draft] = drafts;
    assert.ok(draft);
    assert.equal(draft.brandId, site.brandId);
    assert.equal(draft.content.studio?.version, 2);
    const uploaded = await site.command<AssetSummary[]>('asset.list', { brandId: site.brandId });
    assert.deepEqual(
      draft.content.assetIds.map((id) => uploaded.find((asset) => asset.id === id)?.sha256),
      photos.map((bytes) => createHash('sha256').update(bytes).digest('hex')),
    );
    assert.deepEqual(
      await site.command('rehearsal.list', { campaignId: draft.id, brandId: site.brandId }),
      [],
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error(await page.locator('main').ariaSnapshot());
    throw error;
  }
  console.info(
    'Newsletter ZIP import passed through Campaigns, Studio edit/save/reopen, and desktop/mobile previews. Three original image hashes matched.',
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
}
