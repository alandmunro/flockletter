import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';

export async function verifyPlanComparison(page: Page, origin: string) {
  const billingWrites: string[] = [];
  page.on('request', req => {
    if (/\/billing\.(checkout|portal|restart)$/.test(new URL(req.url()).pathname)) billingWrites.push(req.url());
  });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  const target = page.getByLabel('Target tier', { exact: true });
  const compare = page.getByRole('button', { name: 'Compare allowances', exact: true });
  await target.selectOption('pro');
  await compare.click();
  await page.getByRole('heading', { name: 'Pro · $39 per month' }).waitFor();
  await page.getByText(/This tier has unlimited seats/).waitFor();
  await page.getByText('Confirmed contacts by brand').click();
  await page.getByText(/^Alpine Field Notes · \d+/).waitFor();

  await target.selectOption('starter');
  assert.equal(await page.getByRole('heading', { name: 'Pro · $39 per month' }).count(), 0);
  await page.route('**/api/v1/commands/billing.comparePlan', route =>
    route.fulfill({ status: 503, json: { error: { message: 'Comparison temporarily unavailable.' } } }), { times: 1 });
  await compare.click();
  await page.getByText('Could not compare this plan. Try again.', { exact: true }).waitFor();
  await compare.click();
  await page.getByRole('heading', { name: 'Starter · $15 per month' }).waitFor();
  await page.getByText(/Reconnect the Clerk directory/).waitFor();
  assert.deepEqual(billingWrites, []);
}
