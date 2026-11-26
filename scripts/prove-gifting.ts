import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { startDatabase } from './database-fixture.js';
import { rejectOptionalCookies } from './browser-cookie-choice.js';
import { Database } from '../src/server/db.js';
import { loadConfig } from '../src/server/config.js';
import { Authenticator, localIdentity } from '../src/server/auth.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { createApp } from '../src/server/app.js';

const fixture = await startDatabase(),
  db = new Database(fixture.url),
  server = createServer();
const browser = await chromium.launch({ channel: process.env.FLOCKLETTER_BROWSER_CHANNEL ?? 'chrome' });
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  const config = loadConfig({
    APP_ENV: 'test',
    LOCAL_TEST_IDENTITY: 'true',
    APP_ORIGIN: origin,
    DATABASE_URL: fixture.url,
  });
  const identity = localIdentity(),
    service = new CommandService(
      db,
      undefined,
      identity.isOwner,
      undefined,
      undefined,
      identity.team,
      undefined,
      undefined,
      undefined,
      'test',
    );
  const owner: Actor = {
    workspaceId: 'org_local_sample',
    userId: 'local_owner',
    actorId: 'user:local_owner',
    kind: 'session',
    owner: true,
    scopes: ['read'],
    brandIds: null,
  };
  await service.execute(
    'workspace.initialize',
    { operationKey: randomUUID(), name: 'Sample studio', brandName: 'Alpine' },
    owner,
  );
  server.on('request', createApp(config, service, new Authenticator(db, identity)));
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(origin);
  await rejectOptionalCookies(page);
  await page.getByRole('button', { name: 'Gift lab', exact: true }).click();
  await page.getByRole('button', { name: 'Simulate $550 purchase for $500 credit' }).click();
  await page.getByRole('button', { name: 'Reserve $500' }).click();
  await page.getByRole('button', { name: 'Get recipient link' }).click();
  const gift = await browser.newPage();
  await gift.goto(
    new URL(
      (await page.getByRole('link', { name: 'Open simulated gift' }).getAttribute('href'))!,
      origin,
    ).href,
  );
  await gift.getByRole('button', { name: 'Claim gift' }).click();
  await gift.getByRole('link', { name: 'View simulated reward' }).click();
  await gift.getByText('sample-5', { exact: true }).waitFor();
  await gift.goBack();
  await gift.getByRole('link', { name: 'View simulated reward' }).waitFor();
  await page.getByRole('combobox', { name: 'Recipient' }).selectOption({ label: '2 · offered' });
  await page.getByRole('button', { name: 'Get recipient link' }).click();
  const nextOffer = await page.getByRole('link', { name: 'Open simulated gift' }).getAttribute('href');
  assert(nextOffer);
  await gift.goto(new URL(nextOffer, origin).href);
  await gift.getByRole('button', { name: 'Claim gift' }).waitFor();
  assert.equal(await gift.getByRole('link', { name: 'View simulated reward' }).count(), 0);
  await page.getByRole('button', { name: 'Advance to expiry' }).click();
  await page.getByText(/99 expired/).waitFor();
  await page.getByRole('button', { name: 'Close and refund unused credit' }).click();
  await page.getByText(/refund including the unused fee was \$544.50/).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log(
    'Authenticated dashboard, anonymous claim, reward choices, expiry, refund and phone layout passed.',
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
  await fixture.stop();
}
