import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';

export async function verifyAuthoring(
  page: Page,
  origin: string,
  photo: (page: Page, name: string) => Promise<void>,
) {
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  await page.goto(origin);
  await button('Image library').click();
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'sample-product.png', mimeType: 'image/png', buffer: bytes });
  await button('Upload 1 image').click();
  await page.getByText('Saved: sample-product.png', { exact: true }).waitFor();
  await button('Campaigns').click();
  const entry = page.getByText('Start with a template or product', { exact: true });
  await entry.click();
  const choices = page.getByRole('group', { name: 'Choose a layout' });
  await choices.waitFor();
  assert.equal(await choices.getByRole('radio').count(), 3);
  await choices.getByRole('radio', { name: 'Seasonal collection', exact: true }).check();
  await photo(page, 'authoring-templates');
  await button('Use this template').click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'Title', exact: true }).inputValue(),
    'Seasonal collection',
  );
  await button('← Campaigns').click();
  await entry.click();
  await page.getByLabel('Draft source', { exact: true }).selectOption('product');
  await page.getByLabel('Product name', { exact: true }).fill('Sample Field Tee');
  await page
    .getByLabel('Published product URL', { exact: true })
    .fill('https://retailer.example.com/products/field-tee');
  await page.getByLabel('Approved product description', { exact: true }).fill('A printed mountain skyline.');
  await page.getByRole('checkbox', { name: 'sample-product.png', exact: true }).check();
  await photo(page, 'authoring-product');
  await button('Create product draft').click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'Title', exact: true }).inputValue(),
    'Sample Field Tee',
  );
  assert.equal(
    await page.getByLabel('Link address', { exact: true }).inputValue(),
    'https://retailer.example.com/products/field-tee',
  );
  await page.getByRole('checkbox', { name: 'sample-product.png', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('checkbox', { name: 'sample-product.png', exact: true }).isChecked(),
    true,
  );
  await button('Preview & check').click();
  const frame = page.frameLocator('iframe[title="Campaign email preview"]');
  await frame.getByRole('heading', { name: 'Sample Field Tee', exact: true }).waitFor();
  const link = frame.getByRole('link', { name: 'View product', exact: true });
  assert.equal(await link.getAttribute('href'), 'https://retailer.example.com/products/field-tee');
}
