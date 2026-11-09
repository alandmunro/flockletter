import {rejectOptionalCookies} from './browser-cookie-choice.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startDatabase } from './database-fixture.js';
import { createApp } from '../src/server/app.js';
import { Authenticator, localIdentity } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { CustomerWorkflows } from '../src/server/customer-runtime.js';
import type { Workspace } from '../src/shared/contracts.js';

// Qwen supplied the first harness draft; chat corrected configuration, canonical service
// wiring, lifecycle cleanup and authority assumptions, then built/reviewed the real journeys.
const workspace = 'org_local_sample',
  reader = 'reader@trail.example.com',
  suppressed = 'stopped@trail.example.com';
const consent = 'I agree to receive Trail Notes newsletters and understand I can unsubscribe at any time.';
const actor: Actor = {
  kind: 'session',
  workspaceId: workspace,
  userId: 'local_owner',
  actorId: 'user:local_owner',
  owner: true,
  brandIds: null,
  scopes: ['read'],
};
const screenshotRoot =
  process.env.FLOCKLETTER_CUSTOMER_SCREENSHOTS ?? path.join(tmpdir(), 'flockletter-customer-proof');
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const navigate = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name, exact: true })
    .click();
async function photo(page: Page, name: string) {
  await mkdir(screenshotRoot, { recursive: true });
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.screenshot({ path: path.join(screenshotRoot, name + '.png'), fullPage: false });
}
async function noAlerts(page: Page) {
  const errors = await page.getByRole('alert').allTextContents();
  assert.deepEqual(errors, [], 'The normal customer flow must not show an application error.');
}
async function waitForCommand(page: Page, name: string, action: () => Promise<unknown>) {
  const responseWait = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/commands/' + name &&
      response.request().method() === 'POST',
  );
  const [response] = await Promise.all([responseWait, action()]);
  assert.equal(response.status(), 200, name + ': ' + (await response.text()));
  // Wait for controls to leave the mutation state before the next independent action.
  await page.waitForFunction(
    () =>
      !document.querySelector('button.btn[disabled]') ||
      ![...document.querySelectorAll('button')].some((node) =>
        /Saving|Creating|Processing/.test(node.textContent ?? ''),
      ),
  );
}
async function assertContact(db: Database, brand: string, email: string, state: string) {
  const row = await db.brand(
    workspace,
    brand,
    async (sql) =>
      (await sql.query<{ state: string }>('SELECT state FROM subscribers WHERE email_normalized=$1', [email]))
        .rows[0],
  );
  assert.equal(row?.state, state, 'The durable subscriber state must match the customer result.');
}
async function confirmSignup(page: Page, email: string) {
  const section = page.locator('.audience-onboarding');
  const summary = section.locator('summary').filter({ hasText: '3. Exercise signup and confirmation' });
  if (!(await summary.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
    await summary.click();
  await section.getByLabel('Test email address', { exact: true }).fill(email);
  await section.getByRole('checkbox', { name: consent, exact: true }).check();
  await waitForCommand(page, 'audienceOnboarding.signup', () =>
    section.getByRole('button', { name: 'Exercise signup', exact: true }).click(),
  );
  const row = section.getByRole('listitem').filter({ hasText: email });
  await row.getByRole('button', { name: 'Inspect captured message', exact: true }).click();
  await page.getByRole('region', { name: 'Captured confirmation', exact: true }).waitFor();
  if (email === reader) {
    const [confirmation] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByRole('link', { name: 'Open confirmation page', exact: true }).click(),
    ]);
    const [reply] = await Promise.all([
      confirmation.waitForResponse((response) => response.request().method() === 'POST'),
      confirmation.getByRole('button', { name: 'Confirm subscription', exact: true }).click(),
    ]);
    assert.equal(reply.status(), 200, 'Native confirmation form succeeds without weakening origin checks.');
    await confirmation.getByRole('heading', { name: 'Subscription confirmed', exact: true }).waitFor();
    await confirmation.close();
    await button(page, 'Close captured message').click();
  } else
    await waitForCommand(page, 'audienceOnboarding.exerciseConfirm', () =>
      button(page, 'Confirm as an exercise').click(),
    );
}
async function phaseOne(page: Page, db: Database, brand: string) {
  await navigate(page, 'Subscription');
  await page
    .getByRole('checkbox', {
      name: 'Simulate confirming the required card for this 14-day trial.',
      exact: true,
    })
    .check();
  await page.getByRole('combobox', { name: /^Plan/ }).selectOption('growth');
  await waitForCommand(page, 'customerBilling.startTrial', () =>
    button(page, 'Start captured trial').click(),
  );
  await waitForCommand(page, 'customerBilling.exercisePayment', () =>
    button(page, 'Simulate successful payment').click(),
  );
  await page
    .getByText('Subscription eligibility is satisfied. Sender, audience and campaign checks still apply.', {
      exact: true,
    })
    .waitFor();
  await photo(page, '01-subscription-active');
  await noAlerts(page);

  await navigate(page, 'Audience');
  const audience = page.locator('.audience-onboarding');
  await audience.getByLabel('Consent shown next to the signup checkbox', { exact: true }).fill(consent);
  await audience.getByLabel('Source website domain', { exact: true }).fill('trail.example.com');
  await audience.getByRole('checkbox', { name: 'Enable this brand’s signup form', exact: true }).check();
  await waitForCommand(page, 'audienceOnboarding.configure', () =>
    button(page, 'Save signup settings').click(),
  );
  const signupLink = audience.locator('a').filter({ hasText: 'Open signup page' });
  await signupLink.waitFor({ state: 'attached' });
  const signupDetails = audience.locator('summary').filter({ hasText: '1. Signup page and consent' });
  if (!(await signupDetails.evaluate((node) => (node.parentElement as HTMLDetailsElement).open)))
    await signupDetails.click();
  const [signup] = await Promise.all([page.waitForEvent('popup'), signupLink.click()]);
  await signup.waitForLoadState();
  await signup.getByLabel('Email address', { exact: true }).fill('public@trail.example.com');
  await signup.getByRole('checkbox', { name: consent, exact: true }).check();
  const [signupResult] = await Promise.all([
    signup.waitForResponse((response) => response.request().method() === 'POST'),
    signup.getByRole('button', { name: 'Subscribe', exact: true }).click(),
  ]);
  if (signupResult.status() !== 200) {
    const headers = await signupResult.request().allHeaders();
    console.error('Native form boundary', {
      origin: headers.origin,
      site: headers['sec-fetch-site'],
      mode: headers['sec-fetch-mode'],
      target: signup.url(),
    });
  }
  assert.equal(signupResult.status(), 200, 'Public signup: ' + (await signupResult.text()));
  await signup.getByRole('heading', { name: 'Check your email', exact: true }).waitFor();
  await signup.close();
  await confirmSignup(page, reader);
  await confirmSignup(page, suppressed);
  await assertContact(db, brand, reader, 'confirmed');
  await assertContact(db, brand, suppressed, 'confirmed');
  await page.getByLabel('Find an exact email', { exact: true }).fill(suppressed);
  await button(page, 'Search').click();
  await button(page, suppressed).click();
  await button(page, 'Unsubscribe contact').click();
  await waitForCommand(page, 'audience.unsubscribe', () => button(page, 'Confirm unsubscribe').click());
  await assertContact(db, brand, suppressed, 'unsubscribed');
  await navigate(page, 'Campaigns');
  await navigate(page, 'Audience');
  await audience.locator('summary').filter({ hasText: '2. Import contacts' }).click();
  await audience.getByLabel('CSV with a header row', { exact: true }).setInputFiles({
    name: 'synthetic-permission.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'Email\n' +
        suppressed +
        '\n' +
        suppressed.replace('@trail.example.com', '@TRAIL.EXAMPLE.COM') +
        '\nnew@trail.example.com\ninvalid-address\n',
    ),
  });
  await waitForCommand(page, 'audience.previewImport', () => button(page, 'Preview import').click());
  await audience
    .getByRole('status')
    .filter({ hasText: /1 suppressed.*1 duplicate.*1 invalid/ })
    .waitFor();
  await audience
    .getByLabel('How did these contacts give permission?', { exact: true })
    .fill('Synthetic permission proof at the Trail Notes signup desk');
  await audience
    .getByRole('checkbox', {
      name: 'I have permission to contact these people on behalf of this brand.',
      exact: true,
    })
    .check();
  await waitForCommand(page, 'audienceOnboarding.import', () => button(page, 'Import as pending').click());
  await page.getByRole('region', { name: 'Import results', exact: true }).waitFor();
  await assertContact(db, brand, suppressed, 'unsubscribed');
  await assertContact(db, brand, 'new@trail.example.com', 'pending');
  await photo(page, '02-audience-import-and-consent');
  await noAlerts(page);

  await navigate(page, 'Campaigns');
  await page.getByText('Start with a template or product', { exact: true }).click();
  await button(page, 'Use this template').click();
  await page.getByLabel('Title', { exact: true }).fill('Trail Notes browser proof');
  await page.getByLabel('Subject', { exact: true }).fill('A winter note from Trail Notes');
  await page.getByLabel('From name', { exact: true }).fill('Trail Notes');
  await page.getByLabel('Reply-to', { exact: true }).fill('hello@trail.example.com');
  await page
    .getByLabel('Body', { exact: true })
    .fill('A synthetic winter newsletter created through the normal campaign editor.');
  await waitForCommand(page, 'campaign.update', () => button(page, 'Save draft').click());
  await button(page, '← Campaigns').click();
  await page.getByRole('button', { name: 'Edit Trail Notes browser proof', exact: true }).waitFor();
  await photo(page, '03-saved-campaign');
  await noAlerts(page);

  await navigate(page, 'Delivery');
  await waitForCommand(page, 'delivery.review', () => button(page, 'Review saved campaign').click());
  await waitForCommand(page, 'delivery.approve', () => button(page, 'Approve captured delivery').click());
  // Run the same durable worker through its owner UI; the render dependency is a deterministic
  // injected no-network adapter. The separate pinned Listmonk integration has its own proof.
  await navigate(page, 'Operations');
  await button(page, 'Run saved jobs').click();
  await navigate(page, 'Delivery');
  await button(page, 'View captured email 1').click();
  await page
    .frameLocator('iframe[title="Captured campaign email"]')
    .getByText('A synthetic winter newsletter created through the normal campaign editor.', { exact: true })
    .waitFor();
  await waitForCommand(page, 'delivery.exerciseFeedback', () => button(page, 'Capture delivered').click());
  await photo(page, '04-captured-email-and-feedback');
  await page
    .getByRole('heading', { name: 'Captured email', exact: true })
    .locator('..')
    .screenshot({ path: path.join(screenshotRoot, '04-captured-email-detail.png') });
  await noAlerts(page);
  const captured = await db.tenant(
    workspace,
    async (sql) =>
      (await sql.query('SELECT count(*)::int count FROM customer_delivery_captures')).rows[0]!.count,
  );
  assert.equal(captured, 1, 'Only the confirmed unsuppressed reader receives the captured newsletter.');
  await button(page, 'Close email').click();
  await page.getByLabel('From name', { exact: true }).fill('Trail Notes');
  await page.getByLabel('From email', { exact: true }).fill('news@trail.example.com');
  await page.getByLabel('Reply-to email', { exact: true }).fill('hello@trail.example.com');
  await page.getByLabel('Business or organization', { exact: true }).fill('Synthetic Trail Notes LLC');
  await page
    .getByLabel('Postal address for the email footer', { exact: true })
    .fill('123 Synthetic Trail Road, Denver, CO 80202, US');
  await waitForCommand(page, 'delivery.saveSender', () => button(page, 'Save sender profile').click());
  await navigate(page, 'Operations');
  const infrastructure = page.getByRole('region', { name: 'Sender infrastructure', exact: true });
  await waitForCommand(page, 'infrastructure.review', () =>
    button(page, 'Review infrastructure plan').click(),
  );
  await waitForCommand(page, 'infrastructure.approve', () => button(page, 'Approve reviewed plan').click());
  await waitForCommand(page, 'infrastructure.process', () => button(page, 'Process / reconcile').click());
  await infrastructure.getByRole('heading', { name: /Plan captured/ }).waitFor();
  assert.match(await infrastructure.innerText(), /\.invalid/);
  await infrastructure.screenshot({ path: path.join(screenshotRoot, '09-captured-infrastructure.png') });
  await noAlerts(page);
  const provisioned = await db.brand(
    workspace,
    brand,
    async (sql) => (await sql.query('SELECT captured,verified FROM customer_provider_routes')).rows[0],
  );
  assert.deepEqual(provisioned, { captured: true, verified: false });
}
async function phaseTwo(page: Page, db: Database) {
  await navigate(page, 'Team');
  await waitForCommand(page, 'teamLifecycle.initializeExercise', () =>
    button(page, 'Start team exercise').click(),
  );
  await page.getByLabel('Teammate email', { exact: true }).fill('teammate@trail.example.com');
  await waitForCommand(page, 'teamLifecycle.invite', () =>
    button(page, 'Create exercise invitation').click(),
  );
  await waitForCommand(page, 'teamLifecycle.exerciseAccept', () =>
    button(page, 'Exercise acceptance').click(),
  );
  await page.getByText('Invitation accepted in the separate scenario.', { exact: true }).waitFor();
  await photo(page, '05-team-scenario');
  await noAlerts(page);

  await navigate(page, 'Support');
  await page.getByLabel('Subject', { exact: true }).fill('Where can I find the captured newsletter?');
  await page
    .getByLabel('How can we help?', { exact: true })
    .fill('Please explain where my campaign capture appears.');
  await page.getByLabel('Topic', { exact: true }).selectOption('campaigns');
  await waitForCommand(page, 'support.create', () => button(page, 'Open conversation').click());
  await waitForCommand(page, 'support.draft', () =>
    button(page, 'Prepare reply from approved guidance').click(),
  );
  await waitForCommand(page, 'support.approve', () =>
    button(page, 'Approve and capture saved reply').click(),
  );
  await page.getByText('Captured reply', { exact: true }).waitFor();
  await photo(page, '06-reviewed-support-capture');
  await page
    .locator('article[aria-labelledby="support-conversation-title"]')
    .screenshot({ path: path.join(screenshotRoot, '06-reviewed-support-detail.png') });
  await noAlerts(page);

  await navigate(page, 'Subscription');
  await waitForCommand(page, 'customerBilling.cancel', () => button(page, 'Cancel at period end').click());
  await page.getByRole('combobox', { name: /^Advance only this workspace/ }).selectOption('120');
  await waitForCommand(page, 'customerBilling.advanceExercise', () =>
    button(page, 'Advance captured clock').click(),
  );
  await navigate(page, 'Data & privacy');
  await waitForCommand(page, 'retention.inspect', () => button(page, 'Review current inventory').click());
  await waitForCommand(page, 'retention.request', () =>
    button(page, 'Request operator review of this inventory').click(),
  );
  await waitForCommand(page, 'retention.exercise', () => button(page, 'Capture exercise outcome').click());
  await page.getByText(/Records deleted: 0\./).waitFor();
  await photo(page, '07-retention-captured-zero-delete');
  await noAlerts(page);
  const counts = await db.tenant(
    workspace,
    async (sql) =>
      (
        await sql.query(
          "SELECT (SELECT count(*) FROM workspaces)::int workspaces,(SELECT count(*) FROM customer_retention_receipts)::int erasures,(SELECT count(*) FROM customer_retention_jobs WHERE state='captured')::int captures",
        )
      ).rows[0],
  );
  assert.deepEqual(counts, { workspaces: 1, erasures: 0, captures: 1 });
  await navigate(page, 'Operations');
  await waitForCommand(page, 'operations.process', () => button(page, 'Run saved jobs').click());
  await noAlerts(page);
  const failure = await page
    .getByText('Last Failure', { exact: true })
    .evaluate((node) => node.nextElementSibling?.textContent);
  assert.equal(failure, '—', 'Saved customer jobs complete without hidden worker failures.');
  await photo(page, '08-operations');
  for (const name of [
    'Subscription',
    'Audience',
    'Campaigns',
    'Delivery',
    'Team',
    'Support',
    'Data & privacy',
    'Operations',
  ]) {
    const loaded: Record<string, string> = {
      Subscription: 'customerBilling.status',
      Audience: 'audienceOnboarding.status',
      Campaigns: 'campaign.list',
      Delivery: 'delivery.list',
      Team: 'teamLifecycle.status',
      Support: 'support.list',
      'Data & privacy': 'retention.status',
      Operations: 'operations.status',
    };
    const [response] = await Promise.all([
      page.waitForResponse((item) => new URL(item.url()).pathname === '/api/v1/commands/' + loaded[name]),
      navigate(page, name),
    ]);
    assert.equal(response.status(), 200, 'Loaded ' + name + ' content');
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('main p')].some((node) =>
          /^Loading .*…$/.test(node.textContent ?? ''),
        ),
    );
    if (name === 'Data & privacy')
      await page.getByText('Review stored account records', { exact: true }).click();
    if (name === 'Support') {
      await page.getByRole('button', { name: /^Where can I find the captured newsletter/ }).click();
      await page.getByText('Captured reply', { exact: true }).waitFor();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      name + ' fits a390px viewport',
    );
    await noAlerts(page);
    await photo(page, 'mobile-' + name.replaceAll(/[^a-z]/gi, '-').toLowerCase());
    await page.setViewportSize({ width: 1280, height: 900 });
  }
}

const fixture = await startDatabase(),
  db = new Database(fixture.url);
let browser: Browser | undefined;
try {
  await db.verifyBoundary();
  browser = await chromium.launch({ channel: process.env.FLOCKLETTER_BROWSER_CHANNEL ?? 'chrome' });
  for (const [index, journey] of [phaseOne, phaseTwo].entries()) {
    const server = createServer();
    let customer: CustomerWorkflows | undefined;
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(error.message));
    page.setDefaultTimeout(15000);
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const origin = 'http://127.0.0.1:' + address.port;
      const config = loadConfig({
        APP_ENV: 'local',
        APP_ORIGIN: origin,
        LOCAL_TEST_IDENTITY: 'true',
        DATABASE_URL: fixture.url,
      });
      const identity = localIdentity();
      customer = new CustomerWorkflows(db, config, identity, {
        APP_ENV: 'local',
        FLOCKLETTER_CUSTOMER_BILLING: 'exercise',
        FLOCKLETTER_CUSTOMER_DELIVERY: 'capture',
        FLOCKLETTER_CUSTOMER_AUDIENCE: 'exercise',
        FLOCKLETTER_CUSTOMER_TEAM: 'exercise',
        FLOCKLETTER_CUSTOMER_SUPPORT: 'capture',
        FLOCKLETTER_CUSTOMER_RETENTION: 'capture',
        FLOCKLETTER_CUSTOMER_INFRASTRUCTURE: 'capture',
      });
      customer.delivery.options.render = async () => {};
      const service = new CommandService(
        db,
        undefined,
        identity.isOwner,
        undefined,
        undefined,
        identity.team,
        undefined,
        undefined,
        undefined,
        'local',
        undefined,
        customer,
      );
      if (index === 0)
        await service.execute(
          'workspace.initialize',
          { name: 'Customer Studio', brandName: 'Trail Notes', operationKey: randomUUID() },
          actor,
        );
      const data = (await service.execute('workspace.get', {}, actor)) as Workspace;
      server.on(
        'request',
        createApp(config, service, new Authenticator(db, identity, customer.billing.options)),
      );
      await page.goto(origin);await rejectOptionalCookies(page);
      await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
      await journey(page, db, data.brands[0]!.id);
      assert.deepEqual(failures, [], 'No browser runtime errors');
    } catch (error) {
      await photo(page, 'failure-phase-' + (index + 1));
      console.error('Failed URL:', page.url());
      throw error;
    } finally {
      await page.close();
      await customer?.close();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  console.log(
    'Seven customer workflows passed normal desktop and390px browser journeys with disposable data and captured providers. Screenshots: ' +
      screenshotRoot,
  );
} finally {
  await browser?.close();
  await db.close();
  await fixture.stop();
}
