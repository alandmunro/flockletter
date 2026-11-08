import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { practiceImportDeclarationText } from '../src/shared/import-preview.js';

export async function verifyPracticeImport(page: Page, origin: string) {
  const requests: string[] = [];
  await page.route('**/api/v1/commands/audience.applyPracticeImport', async (route) => {
    requests.push(route.request().postDataJSON().operationKey);
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    // Lose the first response after the server commits to exercise a safe UI retry.
    if (requests.length === 1) await route.fulfill({ status: 503, json: { error: { message: 'Test response interrupted. Retry the import.' } } });
    else await route.fulfill({ response });
  });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Audience', exact: true }).click();
  await page.getByText('Preview a contact CSV', { exact: true }).click();
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({
    name: 'practice.csv', mimeType: 'text/csv',
    buffer: Buffer.from('Email,Notes\r\npractice-check@sample.test,'+'x'.repeat(5000)+'\r\nreal@example.invalid,skip\r\npractice-check@sample.test,duplicate'),
  });
  await page.getByRole('button', { name: 'Preview CSV', exact: true }).click();
  const apply = page.getByRole('button', { name: 'Apply practice import', exact: true });
  await apply.waitFor();
  assert.equal(await apply.isEnabled(), false);
  assert.equal(requests.length, 0);
  await page.getByRole('checkbox', { name: practiceImportDeclarationText }).check();
  await apply.click();
  await page.getByText('Test response interrupted. Retry the import.').waitFor();
  await apply.click();
  const results = page.getByRole('region', { name: 'Practice import results' });
  await results.getByText('1 contact added as pending. No email was sent.').waitFor();
  await results.locator('summary').click();
  const rows = results.getByRole('table', { name: 'Applied import row outcomes' }).locator('tbody tr');
  assert.deepEqual(await rows.allTextContents(), ['2Added as pending','3Skipped domain outside .test','4Duplicate in this file']);
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
  await page.reload();
  await page.getByRole('button', { name: 'Audience', exact: true }).click();
  await page.getByRole('textbox', { name: 'Find an exact email' }).fill('practice-check@sample.test');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'practice-check@sample.test', exact: true }).click();
  await page.getByText('Pending confirmation', { exact: true }).waitFor();
  await page.getByText(/Added from practice CSV row 2/).waitFor();
  await page.getByText('No consent events recorded.', { exact: true }).waitFor();
}
