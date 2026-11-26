import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startDatabase } from './database-fixture.js';
import { rejectOptionalCookies } from './browser-cookie-choice.js';
import { createApp } from '../src/server/app.js';
import { Authenticator, localIdentity } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { CustomerWorkflows } from '../src/server/customer-runtime.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { Texting } from '../src/server/texting/service.js';
import { enrollmentPageReader } from '../src/server/texting/public-page-reader.js';
import { hostedBusinessUrls, policyPreview } from '../src/shared/texting-policy-pages.js';
import type { Workspace } from '../src/shared/contracts.js';

// Only the fictional applicant's three external documents are fixtures. The signup preview,
// enrollment commands, revision records, payment capture and carrier worker are the actual app.
const applicantSite = 'https://orchard.example.test';
const privacy = applicantSite + '/privacy';
const terms = applicantSite + '/sms-terms';
const practice = policyPreview('Orchard Practice LLC', 'support@orchard.example.test', 'Seasonal news.');
const hosted = process.argv.includes('--hosted-pages');
const actor: Actor = { workspaceId: 'org_local_sample', actorId: 'user:local_owner', userId: 'local_owner',
  owner: true, scopes: ['read'], kind: 'session', brandIds: null };

async function prove(page: Page, origin: string, reviewEvidence: () => Promise<void>) {
  await page.goto(origin);
  await rejectOptionalCookies(page);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Texting', exact: true }).click();
  const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Set up business texting', exact: true }) });
  const field = (name: string) => panel.getByLabel(name, { exact: true });
  const button = (name: string) => panel.getByRole('button', { name, exact: true });
  const values = {
    'Legal business name': 'Orchard Practice LLC', 'Employer identification number': '00-0010328',
    'Business website': applicantSite, 'Privacy policy URL': applicantSite + '/unfinished', 'SMS terms URL': terms,
    'Street address': '1 Example Street', 'City': 'Denver', 'State code': 'CO', 'ZIP code': '80202',
    'Authorized contact first name': 'Robin', 'Authorized contact last name': 'Sample', 'Job title': 'Owner',
    'Business email': 'owner@orchard.example.test', 'Business phone in +1 format': '+13035550126',
  };
  const picker = panel.getByRole('combobox',{name:/^Company to register/});
  const company = await picker.inputValue();
  const drafts = () => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('flockletter.texting.draft.')));
  await field('Legal business name').fill('Private unfinished orchard');
  await field('Employer identification number').fill(values['Employer identification number']);
  await button('Save unfinished draft').click();
  await panel.getByText('Private draft saved.').waitFor();
  const entries = await drafts();
  assert.equal(entries.length, 1);
  assert.doesNotMatch(JSON.stringify(entries), /Private unfinished orchard|00-0010328/);
  assert.deepEqual(Object.keys(JSON.parse(entries[0]![1])).sort(), ['ciphertext','iv','version']);
  await picker.selectOption({ label: 'Second practice company' });
  await panel.getByRole('heading',{name:'Prepare the signup form'}).waitFor();
  assert.equal(await field('Legal business name').inputValue(), '');
  await picker.selectOption(company);
  await panel.getByText('Private draft saved.').waitFor();
  await page.reload();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Texting', exact: true }).click();
  await panel.getByText('Private draft saved.').waitFor();
  assert.equal(await field('Legal business name').inputValue(), 'Private unfinished orchard');
  assert.equal(await field('Employer identification number').inputValue(), '');
  assert.equal(await panel.getByRole('checkbox',{name:/I am authorized/}).isChecked(),false);
  if (!hosted) {
    const otherTab = await page.context().newPage();
    await otherTab.goto(origin);
    await otherTab.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Texting',exact:true}).click();
    await otherTab.getByText('Private draft saved.').waitFor();
    await otherTab.getByLabel('Legal business name',{exact:true}).fill('Newer orchard draft');
    await otherTab.getByRole('button',{name:'Save unfinished draft'}).click();
    await otherTab.getByText('Private draft saved.').waitFor();
    await button('Discard saved draft').click();
    await panel.getByRole('alert').filter({hasText:'Another tab changed this draft'}).waitFor();
    await otherTab.close();
    await page.reload();
    await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Texting',exact:true}).click();
    await panel.getByText('Private draft saved.').waitFor();
    assert.equal(await field('Legal business name').inputValue(),'Newer orchard draft');
  }
  await button('Discard saved draft').click();
  await panel.getByText('Private draft saved.').waitFor({state:'hidden'});
  assert.equal((await drafts()).length, 0);
  if (hosted) {
    await panel.getByRole('checkbox', { name: 'Publish practice business and policy pages' }).check();
    await field('Public support email').fill('support@orchard.example.test');
    await field('Public business description').fill('Seasonal news.');
  }
  for (const [name, value] of Object.entries(values)) {
    if (hosted && ['Business website','Privacy policy URL','SMS terms URL'].includes(name)) continue;
    await field(name).fill(value);
  }
  await button('Save unfinished draft').click();
  await panel.getByText('Private draft saved.').waitFor();
  await panel.getByRole('checkbox', { name: hosted ? /I authorize publishing/ : /I am authorized/ }).check();
  await button('Save business details').click();
  if (!hosted) {
    await panel.getByText(/Explain how you use mobile opt-in data/).waitFor();
    assert.equal(await button('Confirm practice setup and submit').isEnabled(), false);
    await button('Edit business details').click();
    await field('Privacy policy URL').fill(privacy);
    await panel.getByRole('checkbox', { name: /I am authorized/ }).check();
    await button('Save business details').click();
  }
  await panel.getByText('All four pages passed the automated checks.').waitFor();
  assert.equal((await drafts()).length,0, 'Completing the form clears the local draft.');
  if (hosted) {
    const [publication] = await Promise.all([page.waitForEvent('popup'), panel.getByRole('link', { name: 'View published business and policy pages' }).click()]);
    await publication.getByRole('heading', { name: values['Legal business name'] }).waitFor();
    await publication.getByRole('button', { name: 'Subscribe' }).waitFor();
    await publication.getByRole('link', { name: 'Privacy policy', exact: true }).last().click();
    await publication.getByText(/will not be sold or shared with third parties for marketing/).waitFor();
    await publication.close();
    const evidence: Record<string, unknown>[] = [];
    page.on('request', req => {
      if (new URL(req.url()).pathname === '/api/v1/commands/sms.onboardingEvidence') evidence.push(req.postDataJSON());
    });
    assert.ok(await button('Attach practice ownership letter').isVisible());
    await panel.getByRole('combobox', { name: /^Practice IRS letter/ }).selectOption('147C');
    const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('link', { name: 'Download practice 147C letter' }).click()]);
    const path = await download.path();
    assert.ok(path);
    const bytes = await readFile(path);
    assert.ok(bytes.length > 1 && bytes.length <= 1024);
    const upload = async (buffer: Buffer) => {
      await field('Select downloaded practice letter').setInputFiles({ name: 'local-fixture-name.txt', mimeType: 'text/plain', buffer });
      await button('Verify and attach file').click();
    };
    await upload(Buffer.alloc(1025));
    await panel.getByRole('alert').filter({ hasText: '1 KiB or less' }).waitFor();
    const changed = Buffer.from(bytes);
    changed[0] = changed[0]! ^ 1;
    await upload(changed);
    await panel.getByRole('alert').filter({ hasText: 'does not match the selected practice letter' }).waitFor();
    assert.equal(evidence.length, 0, 'Invalid files must stay in the browser.');
    await upload(bytes);
    await panel.getByText(/Practice letter 147C attached/).waitFor();
    assert.equal(evidence.length, 1);
    assert.deepEqual(Object.keys(evidence[0]!).sort(), ['companyId', 'contents', 'document', 'expectedRevision', 'operationKey']);
    assert.equal(evidence[0]!.contents, bytes.toString('utf8'));
    assert.equal(evidence[0]!.document, '147C');
    assert.equal(evidence[0]!.expectedRevision, 1);
    assert.equal(evidence[0]!.companyId, await panel.getByRole('combobox', { name: /^Company to register/ }).inputValue());
    assert.equal(await button('Confirm practice setup and submit').isEnabled(), false);
  }
  await button('Request email code').waitFor();
  for (const channel of ['email', 'phone'] as const) {
    await button('Request ' + channel + ' code').click();
    const codeText = panel.getByText(/Practice code/).last();
    await codeText.waitFor();
    const code = /\b\d{6}\b/.exec(await codeText.innerText())?.[0];
    assert.ok(code, 'The capture must show its own verification code');
    await field(channel === 'email' ? 'Email verification code' : 'Phone verification code').fill(code);
    await button('Verify ' + channel).click();
    await panel.getByText(channel === 'email' ? 'Business email verified' : 'Business phone verified', { exact: true }).waitFor();
  }
  if (hosted) await reviewEvidence();
  await button('Confirm practice setup and submit').click({ timeout: 35_000 });
  await page.getByText(/registration approved.*\+1\d+.*ready to send/i).waitFor({ timeout: 90_000 });
  await panel.getByText('Enrollment updates', { exact: true }).click();
  await panel.getByText(/owner email notifications are captured/i).waitFor();
  await panel.getByRole('listitem').filter({ hasText: 'Your carrier registration was submitted.' }).waitFor();
  await panel.getByRole('listitem').filter({ hasText: 'Registration approved. Your assigned number is active.' }).waitFor();
}

const fixture = await startDatabase();
const db = new Database(fixture.url);
const server = createServer(), stop = new AbortController();
let browser: Browser | undefined, workflows: CustomerWorkflows | undefined, worker: Promise<void> | undefined;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  const config = loadConfig({ APP_ENV: 'local', LOCAL_TEST_IDENTITY: 'true', DATABASE_URL: fixture.url, APP_ORIGIN: origin });
  const identity = localIdentity();
  workflows = new CustomerWorkflows(db, config, identity, { FLOCKLETTER_CUSTOMER_BILLING: 'exercise',
    FLOCKLETTER_CUSTOMER_AUDIENCE: 'exercise', FLOCKLETTER_TEXTING: 'mock', FLOCKLETTER_TEXTING_ONBOARDING: 'capture' });
  assert.ok(workflows.texting?.mock);
  const allowedSignup = new Set<string>();
  const readOwn = enrollmentPageReader(origin, allowedSignup);
  const documents = new Map([[applicantSite, '<p>Orchard Practice LLC</p>'], [privacy, '<p>' + practice.privacy + '</p>'],
    [terms, '<p>' + practice.terms + '</p>'], [applicantSite + '/unfinished', '<p>Privacy</p>']]);
  const texting = new Texting(db, { ...workflows.texting.options, readEnrollmentPage: async url => documents.get(url) ?? readOwn(url) });
  Object.assign(workflows, { texting });
  Object.assign(workflows.audience.options, { texting });
  const service = new CommandService(db, undefined, identity.isOwner, undefined, undefined, identity.team, undefined, undefined, undefined, 'local', undefined, workflows);
  await service.execute('workspace.initialize', { name: 'Orchard Practice', brandName: 'Orchard', operationKey: randomUUID() }, actor);
  // Seed a sibling in this disposable database to verify draft isolation without a plan purchase.
  await db.tenant(actor.workspaceId,sql=>sql.query('INSERT INTO companies(workspace_id,id,name) VALUES($1,$2,$3)',
    [actor.workspaceId,randomUUID(),'Second practice company']));
  const workspace = await service.execute('workspace.get', {}, actor) as Workspace;
  for (const [key, value] of Object.entries({ carrier_daily_limit: 10, monthly_segment_allowance: 300,
    probation_canary_count: 1, probation_canary_minutes: 1, probation_min_days: 2, probation_delivered_min: 2,
    probation_initial_days: 1, probation_initial_daily_limit: 3, probation_daily_limit: 5 })) {
    await texting.operator('platform.textingSetSetting', { operationKey: randomUUID(), workspaceId: actor.workspaceId,
      key, value, expectedRevision: 0, reason: 'Synthetic browser exercise on loopback.' }, { userId: 'fixture', via: 'operator_api' });
  }
  await service.execute('sms.configure', { operationKey: randomUUID(), expectedRevision: 1, phoneField: true }, actor);
  const brandId = workspace.brands[0]!.id;
  const signup = await workflows.audience.execute('audienceOnboarding.configure', { brandId, operationKey: randomUUID(), enabled: true,
    purpose: 'orchard_news', policyVersion: 'v1', consentText: 'Email me orchard updates. I can unsubscribe at any time.', sourceDomain: 'orchard.example.test' }, actor) as { signupUrl: string };
  const allowed = new URL(signup.signupUrl);
  assert.equal(allowed.origin, origin);
  for (const url of Object.values(hostedBusinessUrls(allowed.href))) allowedSignup.add(url);
  allowed.searchParams.set('preview','sms');
  allowedSignup.add(allowed.href);
  server.on('request', createApp(config, service, new Authenticator(db, identity, workflows.billing.options)));
  worker = workflows.run(stop.signal);
  browser = await chromium.launch({ channel: process.env.FLOCKLETTER_BROWSER_CHANNEL ?? 'chrome' });
  const browserContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await browserContext.newPage();
  page.setDefaultTimeout(12_000);
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));
  const reviewEvidence = async () => {
    const companyId = await db.read(actor.workspaceId, async sql => (await sql.query<{ id: string }>('SELECT company_id AS id FROM company_brands WHERE brand_id=$1',[brandId])).rows[0]!.id);
    await texting.operator('platform.textingOnboardingReview', { operationKey: randomUUID(), workspaceId: actor.workspaceId,
      companyId, expectedRevision: 1, action: 'accept_evidence', reason: 'Reviewed fictional ownership letter in isolated practice.' },
    { userId: 'fixture-reviewer', via: 'operator_api' });
  };
  try { await prove(page, origin, reviewEvidence); } catch (error) {
    console.error((await page.locator('main').innerText()).slice(-3500));
    throw error;
  }
  assert.deepEqual(errors, []);
  console.log(hosted ? 'Verified actual hosted business, privacy, terms and opt-in pages, local rejection of two invalid files, downloaded letter attachment, fictional ownership review, one-step setup and submission, number activation and owner notices.'
    : 'Verified private draft recovery across reload, company isolation, stale-tab refusal, corrected policy, captured verification, number activation and owner notices.');
} finally {
  stop.abort();
  await worker;
  await browser?.close();
  await workflows?.close();
  server.closeAllConnections();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  await db.close();
  await fixture.stop();
}
