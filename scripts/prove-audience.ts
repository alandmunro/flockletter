import assert from 'node:assert/strict';
import { verifyPracticeImport } from './check-practice-import.js';
import { verifyWorkspaceActivity } from './check-workspace-activity.js';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startDatabase } from './database-fixture.js';
import { verifyCompanies } from './check-companies.js';
import { verifyPublicPlans } from './check-public-plans.js';
import { verifyPlanComparison } from './check-plan-comparison.js';
import { verifySegments } from './check-segments-browser.js';
import { verifyAuthoring } from './check-authoring-browser.js';
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
      content: { ...emptyContent(), title: 'November field notes',subject:'November field notes',fromName:'Alpine Field Notes',
        replyTo:'shop@example.test',heading:'November on the trail',body:'The trail is ready for winter.' },
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
async function verifyCsv(page: Page) {
  let previewRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/commands/audience.previewImport') previewRequests++;
  });
  await page.getByText('Preview a contact CSV', { exact: true }).click();
  const csv =
    'Notes,Reader\r\n' +
    'a'.repeat(5000) +
    ',' +
    reader +
    '\r\nother,join@example.test\r\ndup,join@EXAMPLE.TEST\r\nmissing,';
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({
    name: 'fictional.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await page.getByLabel('Email column', { exact: true }).selectOption('1');
  assert.equal(previewRequests, 0, 'File selection and column mapping stay local');
  await page.getByRole('button', { name: 'Preview CSV', exact: true }).click();
  const report = page.getByRole('region', { name: 'CSV preview results', exact: true });
  await report.waitFor();
  assert.equal(previewRequests, 1);
  for (const [label, value] of [
    ['Data rows', '4'],
    ['New addresses', '1'],
    ['Already confirmed', '1'],
    ['Duplicate rows', '1'],
    ['Invalid rows', '1'],
  ]) {
    const actual = await report
      .getByText(label!, { exact: true })
      .evaluate((el) => el.nextElementSibling?.textContent);
    assert.equal(actual, value);
  }
  assert.ok(!(await report.innerText()).includes('@'));
  await page.getByRole('button', { name: 'Clear file', exact: true }).click();
  assert.equal(await report.count(), 0);
  await page.getByText('Preview a contact CSV', { exact: true }).click();
}
async function verifyExport(page: Page) {
  await page.getByText('Export brand contacts', { exact: true }).click();
  assert.equal(await page.getByRole('link', { name: /Download CSV/ }).count(), 0);
  await page.getByRole('button', { name: 'Prepare export', exact: true }).click();
  const link = page.getByRole('link', { name: 'Download CSV (27 contacts)', exact: true });
  await link.waitFor();
  const url = await link.getAttribute('href');
  assert.ok(url?.startsWith('blob:') && !url.includes(reader));
  const download = page.waitForEvent('download');
  await link.click();
  assert.match((await download).suggestedFilename(), /^flockletter-contacts-[\d-]+\.csv$/);
  await page.getByRole('button', { name: 'Discard file', exact: true }).click();
  assert.equal(await link.count(), 0);
  await page.getByRole('button', { name: 'Prepare export', exact: true }).click();
  await link.waitFor();
  await page.getByLabel('Brand', { exact: true }).selectOption({ label: secondary });
  await page.getByText('No contacts match this view.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: /Download CSV/ }).count(), 0);
  await page.getByLabel('Brand', { exact: true }).selectOption({ label: primary });
  await page.getByRole('table', { name: 'Audience contacts' }).waitFor();
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
  await verifyCsv(page);
  await verifyExport(page);
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
  await button('Review capture').click();
  await button('Approve capture').click();
  await button('Open captured email').click();
  await page.getByRole('heading',{name:'Captured email',exact:true}).waitFor();
  await page.frameLocator('iframe[title="Captured campaign email"]').getByRole('heading',{name:'November on the trail'}).waitFor();
  await photo(page,'campaign-capture');
  await page.getByRole('checkbox',{name:'Schedule for later'}).check();
  await button('Review capture').click();
  await page.getByText('Enter a future local time before creating this scheduled review.',{exact:true}).waitFor();
  const when=new Date(Date.now()+3600000);
  const localTime=new Date(when.getTime()-when.getTimezoneOffset()*60000).toISOString().slice(0,16);
  await page.getByLabel('Scheduled time (local)').fill(localTime);
  await button('Review capture').click();
  const reviewed=page.locator('article').filter({has:button('Approve capture')});
  await reviewed.waitFor();
  assert.ok((await reviewed.innerText()).includes(new Date(localTime).toLocaleTimeString('en-US')),'Saved future time matches selection');
  await reviewed.getByRole('button',{name:'Approve capture'}).click();
  await button('Process if due').waitFor();
  await button('Cancel rehearsal').click();
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
  await button('Workspace').click();
  const sender = page.locator('section').filter({has: page.getByRole('heading',{name:'Sending domain for '+primary,exact:true})}).last();
  await sender.getByRole('button',{name:'Check delivery setup'}).click();
  await sender.getByRole('status').filter({hasText:'Customer delivery is disabled'}).waitFor();
  const provider = sender.getByRole('listitem').filter({hasText:'Provider route'});
  assert.match(await provider.innerText(),/Action needed/);
  const dkim = sender.getByRole('listitem').filter({hasText:'DKIM signing'});
  assert.match(await dkim.innerText(),/Unverified/);
  assert.deepEqual(failures, []);
}
const fixture = await startDatabase();
const db = new Database(fixture.url);
let browser: Browser | undefined;
try {
  await db.verifyBoundary();
  const service = new CommandService(db,undefined,localIdentity().isOwner,undefined,undefined,undefined,undefined,undefined,undefined,'test');
  await seed(db, service);
  browser = await chromium.launch({ channel: process.env.FLOCKLETTER_BROWSER_CHANNEL ?? 'chromium' });
  const journeys: ((page:Page,origin:string)=>Promise<void>)[] = [
    verify,
    (page,origin)=>verifyPublicPlans(page,origin,photo),
    verifyPlanComparison,
    (page,origin)=>verifyAuthoring(page,origin,photo),
    (page,origin)=>verifySegments(page,origin,fixture.adminUrl,actor.workspaceId),
    (page,origin)=>verifyCompanies(page,origin,fixture.adminUrl,actor.workspaceId),
    verifyPracticeImport,
    (page,origin)=>verifyWorkspaceActivity(page,origin,db,actor.workspaceId),
  ];
  // Each independent journey gets a fresh browser session and server-side rate-limit window.
  for (const journey of journeys) {
    const server = createServer();
    const page = await browser.newPage({viewport:{width:1280,height:900},locale:'en-US'});
    try {
      server.listen(0,'127.0.0.1');
      await once(server,'listening');
      const address=server.address();
      if(!address||typeof address==='string') throw Error('Expected a local HTTP port.');
      const origin='http://127.0.0.1:'+address.port;
      const config=loadConfig({APP_ENV:'local',APP_ORIGIN:origin,LOCAL_TEST_IDENTITY:'true',DATABASE_URL:fixture.url});
      server.on('request',createApp(config,service,new Authenticator(db,localIdentity())));
      page.setDefaultTimeout(8000);
      await journey(page,origin);
    } finally {
      await page.close();
      if(server.listening) await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  }
  console.log('Audience, groups, pricing, onboarding, campaign authoring and company management browser checks passed using disposable sample data.');
} finally {
  await browser?.close();
  await db.close();
  await fixture.stop();
}
