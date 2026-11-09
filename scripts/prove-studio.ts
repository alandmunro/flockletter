import {rejectOptionalCookies} from './browser-cookie-choice.js';
import { verifyStudioImageUpload } from './check-studio-image.js';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import type { Rehearsal } from '../src/shared/rehearsal.js';
import { emptyContent, type Campaign } from '../src/shared/contracts.js';
import { keyed, startStudioProof } from './studio-proof-fixture.js';

const proofs = process.env.FLOCKLETTER_STUDIO_PROOF_DIR;
const title = 'November on the ridge';
async function screenshot(page: Page, name: string) {
  if (!proofs) return;
  await mkdir(proofs, { recursive: true });
  await page.screenshot({ path: path.join(proofs, name + '.png'), animations: 'disabled' });
}
function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}
const palette = (page: Page) =>
  page
    .getByRole('group', { name: 'Add a block', exact: true })
    .filter({ has: button(page, 'Add two columns') });
async function editText(page: Page, name: string, value: string) {
  const field = page.getByRole('textbox', { name, exact: true });
  await field.fill(value);
  assert.equal(await field.innerText(), value);
}
async function pastePlain(editor: Locator) {
  await editor.press('End');
  await editor.evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/plain', ' Pasted marker.');
    data.setData('text/html', '<strong>Unapproved HTML marker</strong>');
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
}
async function scrollFits(page: Page) {
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Studio must fit the phone viewport',
  );
}
async function editorJourney(page: Page, site: Awaited<ReturnType<typeof startStudioProof>>) {
  await page.goto(site.origin);await rejectOptionalCookies(page);
  await button(page, 'Campaigns').click();
  await page.getByRole('combobox', { name: /^Brand for new campaign/ }).selectOption(site.brandId);
  await page.getByRole('button', { name: /New campaign/ }).click();
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Subject', { exact: true }).fill('Our November newsletter');
  await page.getByLabel('From name', { exact: true }).fill('Trail Post');
  await page.getByLabel('Reply-to', { exact: true }).fill('owner@example.test');
  await button(page, 'Cookie choices').click();
  await button(page, 'Reject optional cookies').click();
  assert.equal(await page.getByLabel('Title', {exact:true}).inputValue(),title,'Cookie withdrawal preserves unsaved campaign edits');
  assert.equal(await page.getByLabel('Subject', {exact:true}).inputValue(),'Our November newsletter');
  await button(page, 'Edit heading block').first().click();
  await editText(page, 'Heading text', 'Trailhead dispatch');
  await button(page, 'Edit paragraph block').first().click();
  await editText(page, 'Paragraph text', 'These are November field notes.');
  await pastePlain(page.getByRole('textbox', { name: 'Paragraph text', exact: true }));
  await page.getByText('Pasted as plain text.', { exact: true }).waitFor();
  const para = page.getByRole('textbox', { name: 'Paragraph text', exact: true });
  await para.press('ControlOrMeta+a');
  await button(page, 'Bold').click();
  await button(page, 'Italic').click();
  await para.press('End');
  await button(page, 'Link').click();
  const linkForm = page.getByRole('group', { name: 'Edit link', exact: true });
  await linkForm.getByLabel('Link text', { exact: true }).fill(' Field notes archive');
  await linkForm.getByLabel('Link address', { exact: true }).fill('javascript:alert(1)');
  await button(page, 'Apply link').click();
  await linkForm.getByRole('alert').waitFor();
  assert.equal(await button(page, 'Save draft').isDisabled(), true, 'A bad inline link cannot be saved');
  await linkForm.getByLabel('Link address', { exact: true }).fill('https://retailer.example.com/archive');
  await button(page, 'Apply link').click();
  const add = (name: string) => palette(page).getByRole('button', { name, exact: true }).click();
  await add('Add image');
  await page.getByRole('combobox', { name: /^Brand image/ }).selectOption(site.front.asset.id);
  await page.getByLabel('Image description', { exact: true }).fill('Front view of the sample');
  await add('Add button');
  await page.getByLabel('Button label', { exact: true }).fill('Browse shirts');
  await page.getByLabel('Button link', { exact: true }).fill('https://retailer.example.com/shop');
  await add('Add divider');
  await button(page, 'Move block up').click();
  await button(page, 'Move block down').click();
  await add('Add spacer');
  await page.getByRole('combobox', { name: /^Space height/ }).selectOption('large');
  await add('Add divider');
  await button(page, 'Remove block').click();
  await button(page, 'Keep block').click();
  await button(page, 'Remove block').click();
  await button(page, 'Confirm removal').click();
  await add('Add two columns');
  for (const [i, text] of ['Alpine layer', 'Forest layer'].entries()) {
    const column = page.getByRole('region', { name: 'Column ' + (i + 1), exact: true });
    await column
      .getByRole('group', { name: 'Add a block', exact: true })
      .getByRole('button', { name: 'Add paragraph', exact: true })
      .click();
    await editText(page, 'Paragraph text', text);
  }

  let lost = false;
  const url = '**/api/v1/commands/campaign.update';
  await page.route(url, async (route) => {
    if (lost) return route.continue();
    const committed = await route.fetch();
    assert.equal(committed.status(), 200);
    lost = true;
    await route.abort('connectionreset');
  });
  try {
    await button(page, 'Save draft').click();
    await page.getByRole('alert').first().waitFor();
    assert.ok(lost, 'The server committed the save before the response was lost');
    await button(page, 'Save draft').click();
    await page.getByText('Saved version 2.', { exact: true }).waitFor();
  } finally {
    await page.unroute(url);
  }
  const persisted = (await site.command<Campaign[]>('campaign.list', {})).find(
    (c) => c.content.title === title,
  )!;
  assert.ok(persisted);
  assert.equal(persisted.version, 2, 'An ambiguous save is retried without a new revision');
  const before = structuredClone(persisted.content.studio);
  assert.deepEqual(
    before?.blocks.map((b) => b.type),
    ['heading', 'paragraph', 'image', 'button', 'divider', 'spacer', 'columns'],
  );
  assert(!JSON.stringify(before).includes('Unapproved HTML marker'));
  assert(JSON.stringify(before).includes('Pasted marker.'));
  const paraBlock = before?.blocks.find((block) => block.type === 'paragraph');
  assert(paraBlock?.runs.some((run) => run.bold && run.italic));
  assert(paraBlock?.runs.some((run) => run.href === 'https://retailer.example.com/archive'));
  await page.reload();
  await button(page, 'Campaigns').click();
  await button(page, 'Edit ' + title).click();
  await button(page, 'Edit heading block').first().click();
  await page.getByRole('textbox', { name: 'Heading text', exact: true }).waitFor();
  await page
    .getByRole('region', { name: 'Newsletter Studio', exact: true })
    .evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await screenshot(page, 'studio-desktop');
  await button(page, 'Preview & check').click();
  const frame = page.frameLocator('iframe[title="Campaign email preview"]');
  await frame.getByRole('heading', { name: 'Trailhead dispatch', exact: true }).waitFor();
  assert.equal(
    await frame.getByRole('link', { name: 'Browse shirts', exact: true }).getAttribute('href'),
    'https://retailer.example.com/shop',
  );
  assert.equal(
    await frame.getByRole('img', { name: 'Front view of the sample', exact: true }).getAttribute('src'),
    'data:image/png;base64,' + site.front.bytes.toString('base64'),
  );
  await frame.getByText('Alpine layer', { exact: true }).waitFor();
  await frame.getByText('Forest layer', { exact: true }).waitFor();
  await page.getByText('Plain-text version', { exact: true }).click();
  const plain = page
    .locator('details')
    .filter({ has: page.getByText('Plain-text version', { exact: true }) })
    .locator('pre');
  assert.match(await plain.innerText(), /Pasted marker\./);
  assert((await plain.innerText()).includes('https://retailer.example.com/shop'));
  await button(page, 'Desktop').click();
  const desktop = await page.locator('iframe[title="Campaign email preview"]').boundingBox();
  await button(page, 'Mobile').click();
  const mobile = await page.locator('iframe[title="Campaign email preview"]').boundingBox();
  assert.ok(desktop && mobile && mobile.width < desktop.width, 'Mobile preview has a narrower frame');
  await page.setViewportSize({ width: 390, height: 844 });
  await scrollFits(page);
  await page
    .getByRole('heading', { name: 'Preview · version 2', exact: true })
    .evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await screenshot(page, 'studio-mobile');
  await page.setViewportSize({ width: 1280, height: 900 });
  const after = await site.command<Campaign>('campaign.get', { id: persisted.id });
  assert.deepEqual(after.content.studio, before);
  await verifyPendingPrivateApproval(page, site, persisted);
}
async function verifyPendingPrivateApproval(
  page: Page,
  site: Awaited<ReturnType<typeof startStudioProof>>,
  campaign: Campaign,
) {
  await site.command<Rehearsal>(
    'rehearsal.review',
    keyed({
      brandId: site.brandId,
      campaignId: campaign.id,
      expectedVersion: campaign.version,
      audience: 'test',
      transport: 'listmonk_test',
    }),
  );
  const approve = button(page, 'Approve private Listmonk test');
  await button(page, 'Refresh rehearsals').click();
  await approve.waitFor();

  const listUrl = site.origin + '/api/v1/commands/rehearsal.list';
  const processUrl = site.origin + '/api/v1/commands/rehearsal.process';
  const gates = new EventEmitter();
  const snapshot = once(gates, 'snapshot', { signal: AbortSignal.timeout(10_000) });
  const stale = once(gates, 'stale'),
    queued = once(gates, 'queued'),
    processing = once(gates, 'processed');
  let lists = 0,
    processes = 0;
  await page.route(listUrl, async (route) => {
    const first = ++lists === 1;
    const response = await route.fetch();
    if (first) gates.emit('snapshot');
    await (first ? stale : queued);
    await route.fulfill({ response });
  });
  await page.route(processUrl, async (route) => {
    processes++;
    await processing;
    await route.fulfill({ json: { result: { processingRequested: true } } });
  });
  try {
    await button(page, 'Refresh rehearsals').click();
    await snapshot; // The held response contains the reviewed state.
    await Promise.all([page.waitForRequest(processUrl), approve.click()]);
    const card = page
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: /^Private Listmonk test · Test mailbox/ }) });
    await card.getByText('queued', { exact: true }).waitFor();
    assert.equal(
      await approve.count(),
      0,
      'The approval receipt removes the action while processing is pending',
    );
    const oldResponse = page.waitForResponse(listUrl);
    gates.emit('stale');
    await oldResponse;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    assert.equal(await approve.count(), 0, 'A pre-approval report cannot restore the approve action');
    assert.equal(processes, 1, 'The browser issued exactly one processing request');
  } finally {
    gates.emit('stale');
    gates.emit('queued');
    gates.emit('processed');
    await page.unroute(listUrl);
    await page.unroute(processUrl);
  }
}

async function legacyJourney(page: Page, site: Awaited<ReturnType<typeof startStudioProof>>) {
  const product = await site.command<Campaign>(
    'campaign.fromProduct',
    keyed({
      brandId: site.brandId,
      productName: 'Original Alpine Tee',
      excerpt: 'Approved product story.',
      productUrl: 'https://retailer.example.com/products/alpine',
      assetIds: [site.back.asset.id, site.front.asset.id],
    }),
  );
  await page.goto(site.origin);await rejectOptionalCookies(page);
  await button(page, 'Campaigns').click();
  await button(page, 'Edit Original Alpine Tee').click();
  await button(page, 'Open Newsletter Studio').click();
  assert.equal(
    (await site.command<Campaign>('campaign.get', { id: product.id })).version,
    1,
    'Simply opening a legacy draft must not write it',
  );
  await button(page, 'Save draft').click();
  await page.getByText('Saved version 2.', { exact: true }).waitFor();
  const saved = await site.command<Campaign>('campaign.get', { id: product.id });
  const blocks = saved.content.studio?.blocks ?? [];
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading', 'image', 'image', 'paragraph', 'button'],
  );
  assert.deepEqual(saved.content.assetIds, [site.back.asset.id, site.front.asset.id]);
  assert.deepEqual(
    blocks.filter((b) => b.type === 'image').map((b) => b.assetId),
    saved.content.assetIds,
  );
  await button(page, 'Preview & check').click();
  const frame = page.frameLocator('iframe[title="Campaign email preview"]');
  await frame.getByRole('heading', { name: 'Original Alpine Tee' }).waitFor();
  assert.deepEqual(
    await frame.locator('img').evaluateAll((images) => images.map((img) => img.getAttribute('src'))),
    [site.back, site.front].map((photo) => 'data:image/png;base64,' + photo.bytes.toString('base64')),
  );
  assert.equal(
    await frame.getByRole('link', { name: 'View product', exact: true }).getAttribute('href'),
    'https://retailer.example.com/products/alpine',
  );
}
async function unknownJourney(page: Page, site: Awaited<ReturnType<typeof startStudioProof>>) {
  const original = await site.command<Campaign>(
    'campaign.create',
    keyed({ brandId: site.brandId, content: { ...emptyContent(), title: 'Imported future document' } }),
  );
  const foreign = {
    version: 1,
    blocks: [
      { type: 'paragraph', runs: [{ text: 'Earlier supported text' }] },
      { type: 'unknownFutureWidget', value: 'Keep this too' },
    ],
  };
  const future = { ...original.content, studio: foreign };
  // Simulate an existing document written by a newer application. The released API rejects this input.
  await site.db.tenant(site.owner.workspaceId, (sql) =>
    sql.query('UPDATE campaigns SET content=$1 WHERE id=$2', [JSON.stringify(future), original.id]),
  );
  await page.goto(site.origin);await rejectOptionalCookies(page);
  await button(page, 'Campaigns').click();
  await button(page, 'Edit Imported future document').click();
  await page
    .getByText(/unsupported or invalid/i)
    .first()
    .waitFor();
  assert.equal(await page.locator('.tiptap[contenteditable=true]').count(), 0);
  const save = button(page, 'Save draft');
  assert.ok(
    !(await save.count()) || !(await save.isEnabled()),
    'Invalid imported content cannot be overwritten from the editor',
  );
  const stored = await site.db.tenant(site.owner.workspaceId, (sql) =>
    sql.query('SELECT version,content FROM campaigns WHERE id=$1', [original.id]),
  );
  assert.equal(stored.rows[0].version, 1);
  assert.deepEqual(stored.rows[0].content, future);
}
const site = await startStudioProof({
  render: async () => {
    throw Error('The delayed approval proof intercepts processing.');
  },
});
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ channel: process.env.FLOCKLETTER_BROWSER_CHANNEL ?? 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  page.setDefaultTimeout(10000);
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  const external = new Set<string>();
  await page.route('**/*', (route) => {
    const target = new URL(route.request().url());
    if (target.origin === site.origin || target.protocol === 'blob:' || target.protocol === 'data:')
      return route.continue();
    external.add(target.origin);
    return route.abort();
  });
  try {
    await editorJourney(page, site);
    await legacyJourney(page, site);
    await unknownJourney(page, site);
    await verifyStudioImageUpload(page, site);
  } catch (error) {
    console.error(await page.locator('main').ariaSnapshot());
    throw error;
  }
  assert.deepEqual([...external], [], 'Preparing a campaign must not contact external vendors');
  assert.deepEqual(failures, []);
  console.log(
    'Studio browser proof passed for visual authoring, ambiguous saves, mobile preview, product photos and unknown-block recovery.',
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await site.close();
  }
}
