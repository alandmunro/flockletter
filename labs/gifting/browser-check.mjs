import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { GiftLab } from './lab.mjs';
import { createLabServer } from './server.mjs';

const browser = await chromium.launch({ channel: process.env.FLOCKLETTER_BROWSER_CHANNEL ?? 'chrome' });
const lab = new GiftLab();
const server = createLabServer(lab);
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByRole('button', { name: 'Simulate $550 purchase for $500 credit', exact: true }).click();
  await page.getByLabel('Recipients').selectOption('5');
  await page.getByRole('button', { name: 'Reserve gifts' }).click();
  await page.getByText('Recipient offers', { exact: true }).click();
  await page.getByRole('link', { name: 'Recipient 1', exact: true }).click();
  await page.getByRole('button', { name: 'Claim gift' }).click();
  await page.getByRole('link', { name: 'View simulated reward' }).click();
  await page.getByText('sample-5', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.getByRole('combobox', { name: /^Days\b/ }).selectOption('30');
  await page.getByRole('button', { name: 'Advance lab clock' }).click();
  await page.getByText(/4 expired/).waitFor();
  await page.getByRole('button', { name: 'Close workspace and prepare refunds' }).click();
  await page.getByRole('button', { name: 'Confirm simulated refund of $544.50' }).click();
  assert.equal(lab.balances('Studio').available, 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log(
    'Browser purchase, reservation, claim, provider catalog, expiry and refund passed at desktop and phone widths.',
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  lab.db.close();
}
