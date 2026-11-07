import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startDatabase } from './database-fixture.js';
import { createApp } from '../src/server/app.js';
import { Authenticator, localIdentity } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { emptyContent, type Workspace } from '../src/shared/contracts.js';
import { subscriberStates } from '../src/shared/audience.js';

const primary = 'Alpine Field Notes',
  secondary = 'Summit Dispatch';
const reader = 'casey+field@example.test';
const actor: Actor = {
  kind: 'session',
  workspaceId: 'org_local_sample',
  userId: 'local_owner',
  actorId: 'user:local_owner',
  owner: true,
  brandIds: null,
  scopes: ['read'],
};
async function seed(db: Database, service: CommandService) {
  await service.execute(
    'workspace.initialize',
    { name: 'Field Notes Studio', brandName: primary, operationKey: randomUUID() },
    actor,
  );
  const workspace = (await service.execute('workspace.get', {}, actor)) as Workspace;
  const first = workspace.brands[0]!.id,
    second = randomUUID(),
    contact = randomUUID();
  await db.tenant(actor.workspaceId, (sql) =>
    sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
      actor.workspaceId,
      second,
      secondary,
    ]),
  );
  await db.brand(actor.workspaceId, first, async (sql) => {
    for (let i = 0; i < 27; i++) {
      const state = i === 0 ? 'confirmed' : subscriberStates[(i - 1) % subscriberStates.length]!;
      await sql.query(
        `INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state,created_at,confirmed_at)
        VALUES($1,$2,$3,$4,$5,now()-interval '2 hours',CASE WHEN $5='confirmed' THEN now()-interval '1 hour' END)`,
        [
          actor.workspaceId,
          first,
          i === 0 ? contact : randomUUID(),
          i === 0 ? reader : 'reader-' + String(i).padStart(2, '0') + '@example.test',
          state,
        ],
      );
    }
    for (const [event, source, age] of [
      ['signup_requested', 'storefront-footer', 2],
      ['confirmed', 'confirmation-link', 1],
    ] as const) {
      await sql.query(
        `INSERT INTO subscriber_consent_events(workspace_id,brand_id,id,subscriber_id,event,purpose,policy_version,text_digest,source,source_domain,recorded_at)
        VALUES($1,$2,$3,$4,$5,'brand_marketing','demo-v1','fixture',$6,'example.test',now()-$7::int*interval '1 hour')`,
        [actor.workspaceId, first, randomUUID(), contact, event, source, age],
      );
    }
  });
  await service.execute(
    'campaign.create',
    {
      brandId: first,
      operationKey: randomUUID(),
      content: { ...emptyContent(), title: 'November field notes' },
    },
    actor,
  );
}

async function photo(page: Page, name: string) {
  const dir = process.env.FLOCKLETTER_AUDIENCE_SCREENSHOTS;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await document.fonts.ready;
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  await page.screenshot({ path: path.join(dir, name + '.png') });
}
async function verify(page: Page, origin: string) {
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(e.message));
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const search = page.getByRole('textbox', { name: 'Find an exact email' });
  const list = page.getByRole('table', { name: 'Audience contacts' });
  const navigate = () => button('Audience').click();
  const openReader = () => button(reader).click();
  await page.goto(origin);
  await navigate();
  await list.waitFor();
  const total = page.getByText('Total contacts', { exact: true });
  assert.equal(await total.evaluate((el) => el.nextElementSibling?.textContent), '27');
  assert.equal(await list.locator('tbody tr').count(), 25);
  await photo(page, 'audience-directory');
  await button('Next contacts').click();
  await button('reader-26@example.test').waitFor();
  assert.equal(await list.locator('tbody tr').count(), 2);
  await button('Previous contacts').click();
  await button(reader).waitFor();
  await page.getByLabel('Status', { exact: true }).selectOption('hard_bounced');
  await list.getByText('Hard bounce', { exact: true }).first().waitFor();
  assert.equal(await list.locator('tbody tr').count(), 5);
  await page.getByLabel('Status', { exact: true }).selectOption('confirmed');
  await search.fill('casey+field@EXAMPLE.TEST');
  await button('Search').click();
  await button('Clear search').waitFor();
  await button(reader).waitFor();
  assert.equal(await list.locator('tbody tr').count(), 1);
  await openReader();
  await page.getByText('Storefront footer', { exact: true }).waitFor();
  await page.getByText('Email confirmed', { exact: true }).waitFor();
  await photo(page, 'audience-consent');
  await button('Unsubscribe contact').click();
  await button('Cancel').click();
  await button('Unsubscribe contact').click();
  await button('Confirm unsubscribe').click();
  await page.getByText('Marketing is stopped for this contact.', { exact: true }).waitFor();
  await page.getByText('Workspace owner', { exact: true }).waitFor();
  assert.equal(await button('Unsubscribe contact').count(), 0);
  assert.ok(!decodeURIComponent(page.url()).includes(reader));
  assert.ok(!(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).includes(reader));
  await page.reload();
  await navigate();
  await openReader();
  await page.getByText('Workspace owner', { exact: true }).waitFor();
  await button('← All contacts').click();
  await search.waitFor();
  assert.equal(await search.evaluate((el) => el === document.activeElement), true);
  await page.getByLabel('Brand', { exact: true }).selectOption({ label: secondary });
  await page.getByText('No contacts match this view.', { exact: true }).waitFor();
  assert.equal(await button(reader).count(), 0);
  assert.equal(await total.evaluate((el) => el.nextElementSibling?.textContent), '0');
  await page.getByLabel('Brand', { exact: true }).selectOption({ label: primary });
  await page.setViewportSize({ width: 390, height: 844 });
  await list.waitFor();
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Mobile directory fits viewport',
  );
  await photo(page, 'audience-mobile');
  await openReader();
  await page.getByText('Workspace owner', { exact: true }).waitFor();
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Mobile history fits viewport',
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await button('Campaigns').click();
  await page.locator('.campaign-row').getByRole('button').click();
  await button('Preview & check').click();
  const previewCounts = page.locator('.audience-preview-count');
  await previewCounts.waitFor();
  assert.match(await previewCounts.innerText(), /5 confirmed · 22 excluded/);
  await button('API & MCP').click();
  const totalsScope = page.getByRole('checkbox', { name: 'Read audience totals by status' });
  assert.equal(await totalsScope.isChecked(), false);
  await totalsScope.check();
  await page.getByLabel('Connection name', { exact: true }).fill('Audience smoke');
  await button('Create connection').click();
  await button('I have saved it securely').click();
  const grant = page.locator('.connection-row').filter({ hasText: 'Audience smoke' });
  assert.match(await grant.innerText(), /audience:summary/);
  await grant.getByRole('button', { name: 'Revoke', exact: true }).click();
  await grant.getByText(/Revoked/).waitFor();
  assert.deepEqual(failures, []);
}
const fixture = await startDatabase();
const db = new Database(fixture.url);
const server = createServer();
let browser: Browser | undefined;
try {
  await db.verifyBoundary();
  const service = new CommandService(db);
  await seed(db, service);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Expected a local HTTP port.');
  const origin = 'http://127.0.0.1:' + address.port;
  const config = loadConfig({
    APP_ENV: 'local',
    APP_ORIGIN: origin,
    LOCAL_TEST_IDENTITY: 'true',
    DATABASE_URL: fixture.url,
  });
  server.on('request', createApp(config, service, new Authenticator(db, localIdentity())));
  browser = await chromium.launch({ channel: process.env.FLOCKLETTER_BROWSER_CHANNEL ?? 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  page.setDefaultTimeout(8000);
  await verify(page, origin);
  console.log('Audience browser checks passed on desktop and mobile using disposable sample contacts.');
} finally {
  await browser?.close();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
  await fixture.stop();
}
