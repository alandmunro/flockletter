import { rejectOptionalCookies } from './browser-cookie-choice.js';
import { proveDeliveryOutcomes } from './prove-delivery-outcomes-flow.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser } from 'playwright-core';
import { startDatabase } from './database-fixture.js';
import { createApp } from '../src/server/app.js';
import { Authenticator, localIdentity } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { CustomerWorkflows } from '../src/server/customer-runtime.js';

const workspace = 'org_local_sample';
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
  process.env.FLOCKLETTER_REPORT_SCREENSHOTS ?? path.join(tmpdir(), 'flockletter-delivery-reports-proof');
const viewports = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
] as const;

const fixture = await startDatabase();
const db = new Database(fixture.url);
let browser: Browser | undefined;

try {
  await db.verifyBoundary();
  await mkdir(screenshotRoot, {recursive:true});
  browser = await chromium.launch({ channel: process.env.FLOCKLETTER_BROWSER_CHANNEL ?? 'chrome' });
  let brandId: string | undefined;

  for (const [index, viewport] of viewports.entries()) {
    const server = createServer();
    let customer: CustomerWorkflows | undefined;
    const page = await browser.newPage({ viewport, locale: 'en-US' });
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(error.message));
    page.setDefaultTimeout(15000);

    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const origin = `http://127.0.0.1:${address.port}`;
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

      if (index === 0) {
        await service.execute(
          'workspace.initialize',
          { name: 'Reports proof', brandName: 'Trail Reports', operationKey: randomUUID() },
          actor,
        );
      }

      const data = (await service.execute('workspace.get', {}, actor)) as {
        brands: Array<{ id: string }>;
      };
      const currentBrandId = data.brands[0]?.id;
      if (!currentBrandId) throw new Error('Workspace has no brands');

      if (index === 0) brandId = currentBrandId;
      else assert.equal(currentBrandId, brandId);

      server.on(
        'request',
        createApp(config, service, new Authenticator(db, identity, customer.billing.options)),
      );

      await page.goto(origin);
      await rejectOptionalCookies(page);
      await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();

      const screenshotPath = path.join(
        screenshotRoot,
        `report-outcomes-${index === 0 ? 'desktop' : 'phone'}-${randomUUID().slice(0, 8)}.png`,
      );

      await proveDeliveryOutcomes(page, db, service, customer, actor, currentBrandId, screenshotPath);
      assert.deepEqual(failures, [], 'No browser runtime errors');
    } catch (error) {
      try {
        await mkdir(screenshotRoot, { recursive: true });
        const failurePath = path.join(
          screenshotRoot,
          `failure-report-${index === 0 ? 'desktop' : 'phone'}-${randomUUID().slice(0, 8)}.png`,
        );
        await page.screenshot({ path: failurePath });
      } catch {
        // Failure screenshot is optional; do not mask the original error.
      }
      throw error;
    } finally {
      await page.close();
      if (customer) await customer.close();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  console.log(
    'Delivery reports proof passed on desktop and phone viewports with disposable data, captured providers, no live sends, and no browser runtime errors. Screenshots: ' +
      screenshotRoot,
  );
} finally {
  if (browser) await browser.close();
  await db.close();
  await fixture.stop();
}
