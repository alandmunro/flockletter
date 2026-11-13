import { randomUUID } from 'node:crypto';
import type { AddressInfo, Server } from 'node:net';
import express, { type Request, type Response, type NextFunction } from 'express';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { CustomerAudience, createCustomerOptOut } from '../src/server/customer-audience/service.js';
import { customerAudienceRoutes } from '../src/server/customer-audience/routes.js';
import type { Express } from 'express';
import { defaultDesign } from '../src/shared/signup-design.js';
import { postNativeForm } from './helpers/native-form.js';
let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database, server: Server, app: Express;
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  app = express();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  await db?.close();
  await fixture?.stop();
});
const getBaseUrl = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
it('handles public signup, confirmation, and durable opt-out', async () => {
  const base = getBaseUrl();
  const workspace = 'org_' + randomUUID().replaceAll('-', '');
  const owner: Actor = {
    workspaceId: workspace,
    userId: 'user_owner',
    actorId: 'user:owner',
    owner: true,
    kind: 'session',
    scopes: ['read'],
    brandIds: null,
  };

  const core = new CommandService(db);
  await core.execute(
    'workspace.initialize',
    { operationKey: randomUUID(), name: 'Shop B', brandName: 'Borealis' },
    owner,
  );

  const brand = ((await core.execute('workspace.get', {}, owner)) as { brands: { id: string }[] }).brands[0]!
    .id;

  const customer = new CustomerAudience(db, {
    mode: 'exercise',
    origin: base,
    checkOwner: async () => true,
    contactLimit: async () => 250,
  });

  await customer.execute(
    'audienceOnboarding.configure',
    {
      operationKey: randomUUID(),
      brandId: brand,
      enabled: true,
      purpose: 'shop_news',
      policyVersion: 'v2',
      consentText: 'Send me occasional news from the Borealis shop. I can unsubscribe anytime.',
      sourceDomain: 'shop-b.example.test',
    },
    owner,
  );

  app.use('/newsletter', customerAudienceRoutes(customer));
  app.use(
    (
      error: Error & { status?: number; code?: string },
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      res.status(error.status ?? 500).json({ error: { message: error.message, code: error.code } });
    },
  );

  const settings = (await customer.execute('audienceOnboarding.status', { brandId: brand }, owner)) as {
    publicUrl?: string;
  };

  const form = settings.publicUrl!.split('/newsletter/')[1]!;
  const formUrl = `${base}/newsletter/${form}`;

  const designInput = { brandId:brand, operationKey:randomUUID(), expectedRevision:0,
    design:{ ...defaultDesign, displayName:'Borealis Studio', heading:'Letters from the shop', introduction:'News & <updates>', accent:'#ffcc00' } };
  await customer.execute('audienceOnboarding.saveDesign',designInput,owner);
  await expect(customer.execute('audienceOnboarding.saveDesign',{...designInput,operationKey:randomUUID()},owner)).rejects.toMatchObject({code:'design_changed'});
  await expect(customer.execute('audienceOnboarding.saveDesign',{...designInput,expectedRevision:1,operationKey:randomUUID(),design:{...designInput.design,logoId:randomUUID()}},owner)).rejects.toMatchObject({code:'logo_unavailable'});
  // 1. GET signup form has brand name and checkbox
  const getRes = await fetch(formUrl);
  expect(getRes.status).toBe(200);
  const getHtml = await getRes.text();
  expect(getHtml).toContain('Borealis Studio');
  expect(getHtml).toContain('Letters from the shop');
  expect(getHtml).toContain('News &amp; &lt;updates&gt;');
  expect(getHtml).toContain('--postcard-accent:#ffcc00');
  expect(getHtml).toContain('type="checkbox"');

  // 2. POST current consent with URLSearchParams succeeds
  const postRes = await fetch(formUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      email: 'reader@borealis.com',
      consentAffirmed: 'yes',
      policyVersion: 'v2',
    }).toString(),
  });
  expect(postRes.status).toBe(200);

  // Inspect captured message with owner API
  const messages = (await customer.execute('audienceOnboarding.status', { brandId: brand }, owner)) as {
    messages: { id: string }[];
  };

  expect(messages.messages).toHaveLength(1);
  const messageId = messages.messages[0]!.id;

  const captured = (await customer.execute(
    'audienceOnboarding.confirmation',
    { brandId: brand, id: messageId },
    owner,
  )) as { confirmationUrl: string; unsubscribeUrl: string };

  // Subscriber should be pending
  const subscriberId = await db.brand(
    workspace,
    brand,
    async (sql) => (await sql.query<{ id: string }>('SELECT id FROM subscribers')).rows[0]!.id,
  );

  const pendingState = await db.brand(
    workspace,
    brand,
    async (sql) =>
      (await sql.query<{ state: string }>('SELECT state FROM subscribers WHERE id=$1', [subscriberId]))
        .rows[0]!.state,
  );
  expect(pendingState).toBe('pending');

  // 3. GET confirmation page does not change subscriber pending state
  const confirmUrl = new URL(captured.confirmationUrl);
  const confirmRes = await fetch(confirmUrl.toString());
  expect(confirmRes.status).toBe(200);

  const stateAfterGet = await db.brand(
    workspace,
    brand,
    async (sql) =>
      (await sql.query<{ state: string }>('SELECT state FROM subscribers WHERE id=$1', [subscriberId]))
        .rows[0]!.state,
  );
  expect(stateAfterGet).toBe('pending');

  // 4. POST confirms
  const token = new URL(captured.confirmationUrl).searchParams.get('t')!;
  const confirmPostRes = await fetch(confirmUrl.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });
  expect(confirmPostRes.status).toBe(200);

  const stateAfterConfirm = await db.brand(
    workspace,
    brand,
    async (sql) =>
      (await sql.query<{ state: string }>('SELECT state FROM subscribers WHERE id=$1', [subscriberId]))
        .rows[0]!.state,
  );
  expect(stateAfterConfirm).toBe('confirmed');

  // 5. Cross-origin POST rejects
  const crossOriginRes = await fetch(formUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://evil.example.com',
    },
    body: new URLSearchParams({
      email: 'attacker@evil.com',
      consentAffirmed: 'yes',
      policyVersion: 'v2',
    }).toString(),
  });
  expect(crossOriginRes.status).toBe(403);
  const opaqueCases: [Record<string, string>, number][] = [
    [{ Origin: 'null', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate' }, 200],
    [{ Origin: 'null' }, 403],
    [{ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }, 403],
    [{ Origin: 'null', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' }, 403],
    [{ Origin: 'null', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' }, 403],
    [{ Origin: 'null', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' }, 403],
    [
      { Origin: 'https://evil.example.com', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate' },
      403,
    ],
    [{ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' }, 403],
  ];
  for (const [index, [headers, status]] of opaqueCases.entries()) {
    expect(
      await postNativeForm(formUrl, headers, {
        email: `opaque-${index}@borealis.com`,
        consentAffirmed: 'yes',
        policyVersion: 'v2',
      }),
    ).toBe(status);
  }
  expect(
    await db.brand(
      workspace,
      brand,
      async (sql) =>
        (
          await sql.query(
            "SELECT email_normalized FROM subscribers WHERE email_normalized LIKE 'opaque-%' ORDER BY email_normalized",
          )
        ).rows,
    ),
  ).toEqual([{ email_normalized: 'opaque-0@borealis.com' }]);

  // 6. GET opt-out does not unsubscribe
  const unsubUrl = new URL(captured.unsubscribeUrl);
  const unsubGetRes = await fetch(unsubUrl.toString());
  expect(unsubGetRes.status).toBe(200);

  const stateAfterUnsubGet = await db.brand(
    workspace,
    brand,
    async (sql) =>
      (await sql.query<{ state: string }>('SELECT state FROM subscribers WHERE id=$1', [subscriberId]))
        .rows[0]!.state,
  );
  expect(stateAfterUnsubGet).toBe('confirmed');

  // Create a durable opt-out link and test originless POST
  const optOutLink = await db.brand(workspace, brand, (sql) =>
    createCustomerOptOut(sql, workspace, brand, subscriberId, base),
  );

  expect((await fetch(optOutLink.url)).status).toBe(200);
  expect(
    await db.brand(
      workspace,
      brand,
      async (sql) =>
        (await sql.query('SELECT state FROM subscribers WHERE id=$1', [subscriberId])).rows[0]?.state,
    ),
  ).toBe('confirmed');
  const optOutPostRes = await fetch(optOutLink.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }).toString(),
  });
  expect(optOutPostRes.status).toBe(204);

  const stateAfterOptOut = await db.brand(
    workspace,
    brand,
    async (sql) =>
      (await sql.query<{ state: string }>('SELECT state FROM subscribers WHERE id=$1', [subscriberId]))
        .rows[0]!.state,
  );
  expect(stateAfterOptOut).toBe('unsubscribed');
});
