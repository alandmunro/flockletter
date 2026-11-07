import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import { Database } from '../src/server/db.js';
import { recordAccess } from './complimentary-access.js';

export async function verifyCompanies(page: Page, origin: string, fixtureAdmin: string, workspaceId: string) {
  const databaseUrl = new URL(fixtureAdmin);
  if (
    databaseUrl.hostname !== '127.0.0.1' ||
    databaseUrl.pathname !== '/flockletter_test' ||
    workspaceId !== 'org_local_sample'
  )
    throw Error('Use the disposable local browser fixture.');
  const operator = new Database(fixtureAdmin);
  const plan = (value: 'growth' | null) =>
    recordAccess(operator, workspaceId, {
      workspaceId,
      plan: value,
      operator: 'fixture',
      reason: 'Company browser test',
      operationKey: randomUUID(),
    });
  const open = async () => {
    await page.goto(origin);
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page
      .getByRole('region', { name: 'Companies & brands' })
      .getByRole('heading', { name: 'Field Notes Studio', exact: true })
      .waitFor();
  };
  const view = page.getByRole('region', { name: 'Companies & brands' });
  const article = (name: string) =>
    view.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  // Work with the native summary itself; no private document records are needed.
  const disclosure = (name: string) => view.getByText(name, { exact: true }).and(view.locator('summary'));
  try {
    await open();
    assert.equal(await disclosure('Add company').count(), 0);
    await plan('growth');
    await open();
    await disclosure('Add company').click();
    await view.getByLabel('New company name', { exact: true }).fill('Summit Retail');
    await view.getByRole('button', { name: 'Add company', exact: true }).click();
    const parent = article('Summit Retail');
    await parent.waitFor();
    await disclosure('Add a brand to Summit Retail').click();
    await parent.getByLabel('New brand name for Summit Retail', { exact: true }).fill('Winter edition');
    await parent.getByRole('button', { name: 'Add brand', exact: true }).click();
    await parent
      .locator('summary')
      .filter({ hasText: /^Winter edition$/ })
      .click();
    await parent.getByLabel('Brand name for Winter edition', { exact: true }).fill('Winter dispatch');
    await parent.getByRole('button', { name: 'Rename brand', exact: true }).click();
    await parent
      .locator('summary')
      .filter({ hasText: /^Winter dispatch$/ })
      .waitFor();
    const selector = parent.getByLabel('Company for Winter dispatch', { exact: true });
    if (!(await selector.isVisible()))
      await parent
        .locator('summary')
        .filter({ hasText: /^Winter dispatch$/ })
        .click();
    await selector.selectOption({ label: 'Field Notes Studio' });
    await parent.getByRole('button', { name: 'Move brand', exact: true }).click();
    await article('Field Notes Studio')
      .locator('summary')
      .filter({ hasText: /^Winter dispatch$/ })
      .waitFor();
    await plan(null);
    await open();
    await view.getByText(/Your plan limit has been exceeded/).waitFor();
    assert.equal(await disclosure('Add company').count(), 0);
    assert.equal(await article('Summit Retail').count(), 1);
    await article('Field Notes Studio')
      .locator('summary')
      .filter({ hasText: /^Winter dispatch$/ })
      .waitFor();
  } finally {
    await operator.close();
  }
}
