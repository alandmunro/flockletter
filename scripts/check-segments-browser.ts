import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import { Database } from '../src/server/db.js';
import { recordAccess } from './complimentary-access.js';

export async function verifySegments(page: Page, origin: string, fixtureAdmin: string, workspaceId: string) {
  const url = new URL(fixtureAdmin);
  if (
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/flockletter_test' ||
    workspaceId !== 'org_local_sample'
  )
    throw Error('Use the disposable local browser fixture.');
  const operator = new Database(fixtureAdmin);
  const plan = (value: 'growth' | null) =>
    recordAccess(operator, workspaceId, {
      workspaceId,
      plan: value,
      reason: 'Group browser fixture',
      operator: 'fixture',
      operationKey: randomUUID(),
    });
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const panel = page.getByRole('region', { name: 'Audience groups', exact: true });
  const group = 'New release readers',
    renamed = 'Summer readers';
  async function enterAudience() {
    await button('Audience').click();
    await page.getByLabel('Brand', { exact: true }).selectOption({ label: 'Alpine Field Notes' });
    await panel.waitFor();
  }
  try {
    await plan('growth');
    await page.goto(origin);
    await enterAudience();
    await panel.locator('summary').filter({ hasText: 'Create a group' }).click();
    await panel.getByLabel('Group name', { exact: true }).fill(group);
    await panel.getByRole('button', { name: 'Create group', exact: true }).click();
    await panel.getByRole('heading', { name: group, exact: true }).waitFor();
    const membership = panel.locator('form').filter({ has: page.locator('textarea') });
    const rows = membership.locator('textarea');
    await rows.fill('reader-02@EXAMPLE.TEST\nmissing@example.test');
    await membership.getByRole('button').click();
    await membership.getByRole('alert').getByText(/row 2/).waitFor();
    assert.ok((await rows.inputValue()).includes('missing@example.test'));
    await rows.fill('reader-02@EXAMPLE.TEST\nreader-01@example.test');
    await membership.getByRole('button').click();
    await panel.getByText('2 contacts · 1 confirmed', { exact: true }).waitFor();
    assert.equal(await rows.inputValue(), '');
    await button('Campaigns').click();
    await page
      .locator('.campaign-row')
      .filter({ hasText: 'November field notes' })
      .getByRole('button')
      .click();
    await page.getByLabel('Practice audience', { exact: true }).selectOption('confirmed');
    await page.getByLabel('Audience group', { exact: true }).selectOption({ label: group });
    await button('Review capture').click();
    const reviewed = page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: group + ' · version 1', exact: true }) });
    await reviewed.getByText(/1 selected · 1 excluded at review/).waitFor();
    await enterAudience();
    await panel.getByLabel('Manage a group', { exact: true }).selectOption({ label: group });
    await panel.locator('summary').filter({ hasText: 'Rename group' }).click();
    await panel.getByLabel('New name', { exact: true }).fill(renamed);
    await panel.getByRole('button', { name: 'Confirm name change', exact: true }).click();
    await panel.getByRole('heading', { name: renamed, exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Delete group', exact: true }).click();
    await panel.getByRole('button', { name: 'Keep group', exact: true }).click();
    await panel.getByRole('button', { name: 'Delete group', exact: true }).click();
    await panel.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
    await panel.getByText('Group deleted. The contacts are still in your brand.', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('heading', { name: renamed, exact: true }).count(), 0);
    await button('Campaigns').click();
    await page
      .locator('.campaign-row')
      .filter({ hasText: 'November field notes' })
      .getByRole('button')
      .click();
    await reviewed.getByRole('button', { name: 'Approve capture', exact: true }).click();
    await reviewed.getByText(/1 captured · 0 pending/).waitFor();
  } finally {
    try {
      await plan(null);
    } finally {
      await operator.close();
    }
  }
}
