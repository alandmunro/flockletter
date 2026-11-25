import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { rejectOptionalCookies } from './browser-cookie-choice.js';
import { workspaceGiftCommands, type WorkspaceGiftCommand } from '../src/shared/workspace-gifts.js';

// Browser contract proof. Every request, including the Stripe navigation, is intercepted.
const origin = 'https://gifts.example.test';
const brand = randomUUID(),
  otherBrand = randomUUID(),
  campaign = randomUUID(),
  purchase = randomUUID();
const people = Array.from({ length: 22 }, (_, i) => ({ id: randomUUID(), label: 'Reader ' + (i + 1) }));
const products = Array.from({ length: 6 }, (_, i) => ({ id: 'GIFT0' + i, name: 'Product ' + (i + 1) }));
const identity = { workspace: 'proof-workspace', offer: randomUUID(), token: '1'.repeat(64) };
const path = '/workspace-gift.html#' + new URLSearchParams(identity);
const bundle = await build({
  configFile: false,
  logLevel: 'error',
  publicDir: false,
  plugins: [react()],
  build: { write: false },
});
const result = Array.isArray(bundle) ? bundle[0] : bundle;
assert(result && 'output' in result);
const assets = new Map(result.output.map((file) => [file.fileName, file]));
const files = new Map(
  await Promise.all(
    ['workspace-gift.html', 'workspace-gift.js', 'subscriber-action.css', 'signup-postcard.css'].map(
      async (name) => [name, await readFile(resolve('public', name), 'utf8')] as const,
    ),
  ),
);
const browser = await chromium.launch({ channel: process.env.FLOCKLETTER_BROWSER_CHANNEL ?? 'chrome' });
try {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let configEnabled = false,
    statusReads = 0;
  let eligible = true,
    closed = false,
    launched = false,
    reconciled = false,
    failLaunch = true,
    invalidCheckout = true;
  let recipientState = 'offered',
    claimCount = 0,
    inspectCount = 0,
    loseClaimReply = true;
  let memberSession = false,
    memberHasGrant = true;
  let noticePreferences = { lowCredit: true, campaignEnded: true };
  let rewardUrl = 'https://rewards.tremendous.com/proof';
  const mutations: { name: string; key: string }[] = [];
  const button = (name: string) => page.getByRole('button', { name, exact: true });

  await context.route('**/*', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (url.origin === 'https://checkout.stripe.com' && url.pathname === '/proof') {
      return route.fulfill({ contentType: 'text/html', body: '<title>Intercepted checkout</title>' });
    }
    assert.equal(url.origin, origin);
    const asset = assets.get(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (asset)
      return route.fulfill({
        contentType:
          asset.type === 'chunk'
            ? 'text/javascript'
            : asset.fileName.endsWith('.css')
              ? 'text/css'
              : 'text/html',
        body:
          asset.type === 'chunk'
            ? asset.code
            : typeof asset.source === 'string'
              ? asset.source
              : Buffer.from(asset.source),
      });
    if (url.pathname === '/brand/frosty-flamingo-software.png')
      return route.fulfill({
        contentType: 'image/png',
        body: await readFile(resolve('public/brand/frosty-flamingo-software.png')),
      });
    if (url.pathname === '/api/config')
      return json({
        localIdentity: true,
        environment: 'test',
        setupGaps: [],
        workspaceGifts: configEnabled,
      });
    if (url.pathname === '/api/v1/commands/workspace.get')
      return json({
        result: {
          name: 'Gift proof workspace',
          canManageConnections: !memberSession,
          brands: memberSession
            ? memberHasGrant
              ? [{ id: brand, name: 'Alpine' }]
              : []
            : [
                { id: otherBrand, name: 'Other' },
                { id: brand, name: 'Alpine' },
              ],
        },
      });
    if (url.pathname === '/api/v1/commands/campaign.list') return json({ result: [] });
    if (url.pathname === '/api/v1/commands/workspace.preflight')
      return json({ error: { message: 'No setup data in this proof.' } }, 503);
    const file = files.get(url.pathname.slice(1));
    if (file) {
      assert.equal(url.search, '');
      const contentType = url.pathname.endsWith('.html')
        ? 'text/html'
        : url.pathname.endsWith('.js')
          ? 'text/javascript'
          : 'text/css';
      return route.fulfill({ contentType, body: file });
    }
    if (url.pathname === '/api/v1/commands/gifting.captureStatus')
      return json({
        result: { available: 0, reserved: 0, spent: 0, offers: [], funded: false, closed: false },
      });
    if (url.pathname === '/api/v1/commands/connection.list') return json({ result: [] });
    if (url.pathname === '/api/v1/commands/intake.status')
      return json({ error: { message: 'Intake is unavailable in this proof.' } }, 503);
    if (url.pathname === '/api/v1/commands/connection.create') {
      const input = req.postDataJSON();
      assert.deepEqual(input.scopes, ['read', 'gifts:read']);
      assert.deepEqual(input.brandIds, [brand]);
      assert.equal(input.name, 'Gift reporting');
      return json({ result: { token: 'fixture-only' } });
    }
    if (url.pathname.startsWith('/api/v1/workspace-gifts/')) {
      assert.equal(req.method(), 'POST');
      assert.deepEqual(req.postDataJSON(), identity);
      assert.equal(req.headers().authorization, undefined);
      assert.equal(req.headers().cookie, undefined);
      if (url.pathname.endsWith('/claim')) {
        assert.equal(req.headers().origin, origin);
        claimCount++;
        if (loseClaimReply) {
          loseClaimReply = false;
          recipientState = 'pending';
          return route.abort('failed');
        }
        recipientState = 'claimed';
      } else {
        assert(url.pathname.endsWith('/inspect'));
        inspectCount++;
      }
      return json({
        state: recipientState,
        face: 505,
        brand: 'Alpine',
        expiresAt: '2030-10-04T12:00:00Z',
        ...(recipientState === 'claimed' ? { rewardUrl } : {}),
      });
    }
    const name = url.pathname.replace('/api/v1/commands/', '') as WorkspaceGiftCommand;
    const definition = workspaceGiftCommands[name];
    assert(definition, 'Unexpected browser command');
    const input = req.postDataJSON();
    definition.schema.parse(input);
    assert.equal(req.method(), 'POST');
    assert.equal(req.headers().authorization, 'Bearer local-development-only');
    const managing = !memberSession && input.brandId === brand;
    if (memberSession) {
      assert(memberHasGrant);
      assert.equal(input.brandId, brand);
      assert.equal(name, 'gifts.status');
    }
    if (name === 'gifts.status') {
      assert(configEnabled);
      statusReads++;
      return json({
        result: {
          canManage: managing,
          ownerNotifications: managing
            ? {
                preferences: noticePreferences,
                notices: [
                  {
                    id: 'notice-1',
                    at: '2026-11-25T12:00:00Z',
                    message: 'A gift credit purchase was disputed.',
                    email: 'captured',
                  },
                ],
              }
            : undefined,
          eligibility: {
            eligible,
            reasons: eligible ? [] : ['registration_required'],
            brokerRequired: true,
          },
          closed,
          available: reconciled ? 5005 - (launched ? 1010 : 0) : 0,
          reserved: launched ? 1010 : 0,
          spent: 0,
          refunded: 0,
          purchases: managing
            ? [{ id: purchase, face: 5005, total: 5506, state: reconciled ? 'funded' : 'checkout' }]
            : [],
          campaigns:
            launched && managing
              ? [
                  {
                    id: campaign,
                    title: 'November thanks',
                    offered: 2,
                    claimed: 0,
                    expired: 0,
                    reserved: 1010,
                    spent: 0,
                    released: 0,
                    recipients: [people[0], people[20]].map((p) => ({
                      id: p!.id,
                      state: 'offered',
                      claimedAt: null,
                    })),
                  },
                ]
              : [],
          people: managing ? people : [],
          ledger: reconciled ? [{ kind: 'purchased', amount: 5005, at: '2026-11-25T15:00:00Z' }] : [],
        },
      });
    }
    assert(managing);
    if (definition.mutation) mutations.push({ name, key: input.operationKey });
    switch (name) {
      case 'gifts.notificationPreferences':
        assert.equal(input.lowCredit, false);
        assert.equal(input.campaignEnded, true);
        noticePreferences = { lowCredit: input.lowCredit, campaignEnded: input.campaignEnded };
        return json({ result: {} });
      case 'gifts.purchase':
        assert.equal(input.face, 5005);
        if (invalidCheckout) {
          invalidCheckout = false;
          return json({ result: { url: 'https://checkout.stripe.com.example.test/proof' } });
        }
        return json({ result: { url: 'https://checkout.stripe.com/proof' } });
      case 'gifts.reconcile':
        assert.equal(input.purchaseId, purchase);
        reconciled = true;
        return json({ result: {} });
      case 'gifts.catalog':
        assert.equal(input.face, 505);
        return json({ result: { products } });
      case 'gifts.launch':
        assert.deepEqual(
          input.products,
          products.slice(0, 5).map((p) => p.id),
        );
        assert.deepEqual(input.personIds, [people[0]!.id, people[20]!.id].sort());
        assert.equal(input.days, 15);
        assert.equal(input.title, 'November thanks');
        assert.equal(input.face, 505);
        assert.equal(input.brokerConfirmed, true);
        if (failLaunch) {
          failLaunch = false;
          return route.abort('failed');
        }
        launched = true;
        return json({ result: {} });
      case 'gifts.link':
        assert.equal(input.campaignId, campaign);
        assert.equal(input.personId, people[0]!.id);
        return json({ result: { path } });
      case 'gifts.close':
        closed = true;
        return json({ result: {} });
    }
  });

  await page.goto(origin + '/?gifts=1&brand=' + brand);
  await rejectOptionalCookies(page);
  await button('Gift lab').waitFor();
  assert.equal(await button('Gifts').count(), 0);
  await button('Gift lab').click();
  await button('Simulate $550 purchase for $500 credit').waitFor();
  assert.equal(statusReads, 0);
  configEnabled = true;
  await page.goto(origin);
  await button('Gifts').click();
  await page.getByLabel('Gift brand').selectOption(brand);
  await page.getByText(/A gift credit purchase was disputed.*Email captured/).waitFor();
  await page.getByLabel('Low gift credit', { exact: true }).uncheck();
  await button('Save alert preferences').click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('button')).some(
      (b) => b.textContent === 'Save alert preferences' && b.disabled,
    ),
  );
  assert.equal(noticePreferences.lowCredit, false);
  await page.getByLabel('Gift credit to buy (USD)').fill('50.05');
  await page.getByText('$5.01', { exact: true }).waitFor();
  await button('Continue to Stripe · $55.06').click();
  await page.getByRole('alert').filter({ hasText: 'Stripe checkout could not be opened' }).waitFor();
  await button('Continue to Stripe · $55.06').click();
  await page.waitForURL('https://checkout.stripe.com/proof');
  assert.equal(new Set(mutations.filter((m) => m.name === 'gifts.purchase').map((m) => m.key)).size, 1);
  await page.goto(origin + '/?gifts=1&purchase=' + purchase);
  await page.getByLabel('Gift brand').selectOption(brand);
  await button('Check returned purchase').waitFor();
  assert.equal(reconciled, false);
  await button('Check returned purchase').click();
  await page.getByText(/total · funded/).waitFor();
  await page.getByLabel('Campaign title').fill('November thanks');
  await page.getByLabel('Value per gift (USD)').fill('5.05');
  await page.getByLabel('Offer duration').selectOption('15');
  await button('Load products for this value').click();
  await page.getByLabel('Product 1', { exact: true }).check();
  await page.getByLabel('Value per gift (USD)').fill('5.06');
  assert.equal(await page.getByLabel('Product 1', { exact: true }).count(), 0);
  await page.getByLabel('Value per gift (USD)').fill('5.05');
  await button('Load products for this value').click();
  await page.getByLabel('Reader 1', { exact: true }).check();
  await button('Next recipients').click();
  await page.getByLabel('Reader 21', { exact: true }).check();
  await page.getByLabel(/My broker has approved/).check();
  for (const n of [1, 2]) await page.getByLabel('Product ' + n, { exact: true }).check();
  assert(await button('Review offers').isDisabled());
  for (const n of [3, 4, 5]) await page.getByLabel('Product ' + n, { exact: true }).check();
  await button('Review offers').click();
  await page.getByText(/Reserve \$10\.10 for 2 recipients/).waitFor();
  await button('Create funded offers').click();
  await page.getByRole('alert').waitFor();
  await button('Create funded offers').click();
  await page.getByRole('heading', { name: 'November thanks' }).waitFor();
  assert.equal(new Set(mutations.filter((m) => m.name === 'gifts.launch').map((m) => m.key)).size, 1);
  await page.getByLabel('Gift campaign', { exact: true }).selectOption(campaign);
  await page.getByLabel('Gift recipient', { exact: true }).selectOption(people[0]!.id);
  await button('Get recipient link').click();
  const link = page.getByRole('link', { name: 'Open private recipient link' });
  assert.equal(await link.getAttribute('href'), path);
  await page.getByLabel('Gift brand').selectOption(otherBrand);
  await page.getByText(/read-only access/).waitFor();
  assert.equal(await link.count(), 0);
  assert.equal(await button('Review gifting closure').count(), 0);
  assert.equal(await button('Check returned purchase').count(), 0);
  eligible = false;
  await page.getByLabel('Gift brand').selectOption(brand);
  await page.getByText('Complete the business registration.').waitFor();
  assert.equal(await page.getByLabel('Campaign title').count(), 0);
  await page.getByLabel('Gift credit to buy (USD)').waitFor();
  await button('Review gifting closure').click();
  assert.equal(closed, false);
  await button('Confirm closure and request refund').click();
  await page.getByText(/Workspace gifting is closed/).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await page.goto(origin + '/?gifts=1&purchase=' + purchase + '&brand=' + brand);
  await page.getByText(/Workspace gifting is closed/).waitFor();
  assert.equal(await page.getByLabel('Gift brand').inputValue(), brand);
  await button('Overview').click();
  assert.equal(new URL(page.url()).search, '');
  await page.goto(origin + '/?gifts=1&brand=' + randomUUID());
  await page.getByText('Choose a brand to view its gift activity.').waitFor();
  assert.equal(await page.getByRole('region', { name: 'Workspace gifts' }).count(), 0);

  await button('API & MCP').click();
  const read = page.getByLabel('Read drafts, previews and images', { exact: true });
  const giftRead = page.getByLabel(/View gift credit and campaign reports for selected brands/);
  assert(await read.isChecked());
  assert(!(await giftRead.isChecked()));
  await giftRead.check();
  await read.uncheck();
  assert(!(await giftRead.isChecked()));
  assert(await giftRead.isDisabled());
  await read.check();
  await giftRead.check();
  await page.getByLabel('Connection name').fill('Gift reporting');
  await page.getByRole('checkbox', { name: 'Other', exact: true }).uncheck();
  assert(await button('Create connection').isDisabled());
  await page.getByRole('checkbox', { name: 'Alpine', exact: true }).check();
  await button('Create connection').click();
  await page.getByText('Copy this token now. It is shown only once.').waitFor();

  memberSession = true;
  await page.goto(origin);
  await button('Gifts').click();
  await page.getByText(/read-only access/).waitFor();
  assert.equal(await page.getByLabel('Gift brand').locator('option').count(), 1);
  assert.equal(await page.getByLabel('Gift brand').inputValue(), brand);
  for (const name of [
    'Owner gift alerts',
    'Buy gift credit',
    'Create gift offers',
    'Recipient link',
    'Close workspace gifting',
  ]) {
    assert.equal(await page.getByRole('heading', { name, exact: true }).count(), 0);
  }
  assert.equal(await button('Gift lab').count(), 0);
  await button('Refresh gift credit balances').click();
  await button('Campaigns').click();
  assert.equal(new URL(page.url()).search, '');
  const beforeForeign = statusReads;
  await page.goto(origin + '/?gifts=1&brand=' + otherBrand);
  await page.getByText('Choose a brand to view its gift activity.').waitFor();
  assert.equal(statusReads, beforeForeign);
  memberHasGrant = false;
  await page.goto(origin + '/?gifts=1');
  await button('Campaigns').waitFor();
  assert.equal(await button('Gifts').count(), 0);
  assert.equal(statusReads, beforeForeign);

  await page.goto(origin + '/workspace-gift.html#token=incomplete');
  await page.getByText(/link is incomplete/).waitFor();
  assert.equal(inspectCount, 0);
  await page.goto('about:blank');
  await page.goto(origin + path);
  await page.getByText('A thank-you from Alpine').waitFor();
  await page.getByText(/\$5\.05 gift · Offer expires/).waitFor();
  assert.equal(claimCount, 0);
  await button('Claim gift').focus();
  await page.keyboard.press('Enter');
  await page.getByText(/couldn’t confirm your claim/).waitFor();
  await button('Check gift status').click();
  await page.getByText(/Your claim is pending/).waitFor();
  assert.equal(claimCount, 1);
  recipientState = 'claimed';
  await button('Check gift status').click();
  const reward = page.getByRole('link', { name: 'Open my reward at Tremendous' });
  assert.equal(await reward.getAttribute('href'), rewardUrl);
  await page.reload();
  await reward.waitFor();
  assert.equal(claimCount, 1);
  rewardUrl = 'https://tremendous.com.example.test/unsafe';
  await page.reload();
  await page.getByText(/Check again for your reward link/).waitFor();
  assert.equal(await reward.count(), 0);
  recipientState = 'expired';
  await button('Check gift status').click();
  await page.getByText(/offer has expired/).waitFor();
  assert.equal(await button('Claim gift').count(), 0);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  recipientState = 'offered';
  rewardUrl = 'https://testflight.tremendous.com/proof';
  await page.reload();
  await button('Claim gift').click();
  await reward.waitFor();
  assert.equal(await reward.getAttribute('href'), rewardUrl);
  assert.equal(claimCount, 2);
  assert.deepEqual(errors, []);
  console.log('Workspace gift browser contract passed with intercepted provider requests.');
} finally {
  await browser.close();
}
