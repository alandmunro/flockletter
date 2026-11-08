import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';

export async function verifyPublicPlans(
  page: Page,
  origin: string,
  photo: (page: Page, name: string) => Promise<void>,
) {
  await page.goto(origin + '/pricing');
  await page.getByRole('heading', { name: 'Plans and pricing', level: 1 }).waitFor();
  assert.equal(await page.getByRole('main').count(), 1);
  for (const name of ['Starter', 'Growth', 'Pro']) {
    const card = page.getByRole('article', { name, exact: true });
    await card.waitFor();
    assert.equal(await card.getByRole('definition').count(), 7);
  }

  await photo(page, 'public-pricing');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Pricing fits a phone',
  );
  await photo(page, 'public-pricing-mobile');
  const signup = page.getByRole('link', { name: 'Create a staging account', exact: true });
  assert.equal(await signup.getAttribute('href'), '/sign-up');
  await signup.focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(origin + '/sign-up');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(origin + '/pricing');
  const login = page.getByRole('link', { name: 'Sign in', exact: true });
  assert.equal(await login.getAttribute('href'), '/');
  await login.click();
  await page.waitForURL(origin + '/');
  const setup = page.getByRole('region', { name: 'Workspace setup' });
  await setup.getByText('Field Notes Studio', { exact: true }).waitFor();
  await setup.getByRole('button', { name: 'View workspace', exact: true }).click();
  await page.getByRole('heading', { name: 'Your workspace', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await setup.getByRole('button', { name: 'Open campaigns', exact: true }).click();
  await page.getByRole('heading', { name: 'Campaigns', exact: true }).waitFor();
}
