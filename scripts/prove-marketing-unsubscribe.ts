import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startDatabase } from './database-fixture.js';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { Database } from '../src/server/db.js';
import { CommandService } from '../src/server/service.js';
import {
  buildMarketingMessageLinks,
  loadMarketingLinks,
  marketingUnsubscribePath,
} from '../src/server/subscribers/marketing-links.js';

const dir = await mkdtemp(path.join(tmpdir(), 'flockletter-form-tls-'));
let fixture: Awaited<ReturnType<typeof startDatabase>> | undefined,
  db: Database | undefined,
  browser: Browser | undefined,
  server: ReturnType<typeof createServer> | undefined;
try {
  const keyFile = path.join(dir, 'key.pem'),
    certFile = path.join(dir, 'cert.pem'),
    configFile = path.join(dir, 'openssl.cnf');
  await writeFile(
    configFile,
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n',
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-new',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-config',
      configFile,
      '-keyout',
      keyFile,
      '-out',
      certFile,
    ],
    { stdio: 'ignore' },
  );
  const key = await readFile(keyFile),
    cert = await readFile(certFile);
  // Trust only this disposable test server's TLS public key in the test-only Chromium process.
  const pin = createHash('sha256')
    .update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  server = createServer({ key, cert });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Expected an isolated HTTPS port');
  const origin = 'https://127.0.0.1:' + address.port;
  fixture = await startDatabase();
  db = new Database(fixture.url);
  await db.verifyBoundary();
  const scope = { workspaceId: 'org_oneclick_browser', brandId: randomUUID() },
    subscriberId = randomUUID();
  process.env.FLOCKLETTER_UNSUBSCRIBE_BINDINGS = JSON.stringify([scope]);
  process.env.FLOCKLETTER_UNSUBSCRIBE_SIGNING_KEY = randomBytes(32).toString('hex');
  const settings = loadMarketingLinks(origin)!;
  await db.tenant(scope.workspaceId, async (sql) => {
    await sql.query('INSERT INTO workspaces(workspace_id,name) VALUES($1,$2)', [
      scope.workspaceId,
      'Synthetic workspace',
    ]);
    await sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
      scope.workspaceId,
      scope.brandId,
      'Synthetic brand',
    ]);
  });
  const envelope = await db.brand(scope.workspaceId, scope.brandId, async (sql) => {
    await sql.query(
      "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'form@example.test','confirmed')",
      [scope.workspaceId, scope.brandId, subscriberId],
    );
    return buildMarketingMessageLinks(sql, settings, { ...scope, subscriberId });
  });
  const app = createApp(loadConfig({ APP_ENV: 'test', APP_ORIGIN: origin }), new CommandService(db));
  let browserOrigin = '',
    referrerLeak = false;
  server.on('request', (req, res) => {
    if (req.headers.referer && req.headers.referer !== origin + '/') referrerLeak = true;
    if (req.method === 'POST' && new URL(req.url ?? '/', origin).pathname === marketingUnsubscribePath)
      browserOrigin = req.headers.origin ?? '';
    app(req, res);
  });
  browser = await chromium.launch({
    channel: process.env.FLOCKLETTER_BROWSER_CHANNEL ?? 'chromium',
    args: ['--ignore-certificate-errors-spki-list=' + pin],
  });
  const page = await browser.newPage({ javaScriptEnabled: false });
  page.setDefaultTimeout(8000);
  const isSubscribed = () =>
    db!.brand(
      scope.workspaceId,
      scope.brandId,
      async (sql) =>
        (await sql.query('SELECT state FROM subscribers WHERE id=$1', [subscriberId])).rows[0]!.state,
    );
  await page.goto(envelope.bodyUrl);
  assert.equal(await isSubscribed(), 'confirmed');
  await page.getByRole('button', { name: 'Unsubscribe', exact: true }).click();
  await page.getByRole('heading', { name: 'Unsubscribe request received', exact: true }).waitFor();
  assert.equal(await isSubscribed(), 'unsubscribed');
  assert.equal(browserOrigin, origin);
  assert.equal(
    referrerLeak,
    false,
    'Unsubscribe navigation or an asset request included a path or query in its referrer.',
  );
  console.info(
    'Native HTTPS unsubscribe form passed with JavaScript disabled, exact same-origin POST and origin-only referrers.',
  );
} finally {
  await browser?.close();
  if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await db?.close();
  await fixture?.stop();
  await rm(dir, { recursive: true, force: true });
}
