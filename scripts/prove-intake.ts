// A private, loopback-only consumer fixture. No test authentication is installed in the hosted web app.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { consentPolicy, signupAccepted } from '../src/shared/subscriber.js';
import type { Workspace } from '../src/shared/contracts.js';
import { Database } from '../src/server/db.js';
import { loadConfig } from '../src/server/config.js';
import { Authenticator } from '../src/server/auth.js';
import { createApp } from '../src/server/app.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { SubscriberIntake } from '../src/server/subscribers/intake.js';
import type { IntakeBinding } from '../src/server/subscribers/config.js';
import { CapturedConfirmation } from '../src/server/confirmation/provider.js';
import { ConfirmationWorker } from '../src/server/confirmation/worker.js';

async function prove(db: Database) {
  await db.verifyBoundary();
  const w = 'org_intakeproof_' + randomUUID().replaceAll('-', '');
  const owner: Actor = {
    workspaceId: w,
    userId: 'synthetic_contract_owner',
    actorId: 'synthetic_contract_owner',
    kind: 'session',
    owner: true,
    scopes: ['read'],
    brandIds: null,
  };
  const setup = new CommandService(db);
  await setup.execute(
    'workspace.initialize',
    {
      name: 'Synthetic intake contract verification',
      brandName: 'FFA contract fixture',
      operationKey: randomUUID(),
    },
    owner,
  );
  const workspace = (await setup.execute('workspace.get', {}, owner)) as Workspace;
  const brand = workspace.brands[0]!.id;
  const email = 'contract-fixture@example.com';
  const binding: IntakeBinding = {
    workspaceId: w,
    brandId: brand,
    sourceDomain: 'ffa-staging.example.test',
    origin: 'https://flockletter.frostyflamingosoftware.com',
    key: randomBytes(32),
    sender: '',
    recipients: new Set([email]),
    mode: 'capture',
  };
  const intake = new SubscriberIntake(db, binding),
    service = new CommandService(db, intake);
  const mailbox = new CapturedConfirmation(),
    worker = new ConfirmationWorker(
      db,
      binding,
      mailbox,
      async (user, workspaceId) => user === owner.userId && workspaceId === w,
    );
  const auth = new Authenticator(db, {
    async session() {
      throw new Error('This private fixture accepts only its test connection.');
    },
    async isOwner(user, workspaceId) {
      return user === owner.userId && workspaceId === w;
    },
  });
  const config = loadConfig({ APP_ENV: 'staging', APP_ORIGIN: binding.origin });
  const server = createApp(config, service, auth).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot start private contract fixture.');
  const origin = 'http://127.0.0.1:' + address.port;
  let connectionId: string | undefined;
  try {
    await worker.tick();
    await service.execute(
      'intake.configure',
      { operationKey: randomUUID(), brandId: brand, enabled: true },
      owner,
    );
    const grant = (await service.execute(
      'connection.create',
      {
        operationKey: randomUUID(),
        name: 'Disposable proof',
        scopes: ['subscriber:signup'],
        brandIds: [brand],
        expiresInDays: 1,
      },
      owner,
    )) as { token: string; connection: { id: string } };
    connectionId = grant.connection.id;
    const operation = randomUUID();
    const body = {
      email,
      purpose: consentPolicy.purpose,
      consentVersion: consentPolicy.version,
      consentText: consentPolicy.text,
      consentAffirmed: true,
      source: 'storefront-footer',
      sourceDomain: binding.sourceDomain,
    };
    const submit = (changes: Record<string, unknown> = {}, op: string = operation) =>
      fetch(origin + '/api/v1/brands/' + brand + '/subscriber-signups', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + grant.token,
          'content-type': 'application/json',
          'idempotency-key': op,
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({ ...body, ...changes }),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    for (let i = 0; i < 2; i++) {
      const r = await submit();
      assert.equal(r.status, 202);
      assert.deepEqual(await r.json(), signupAccepted);
    }
    assert.equal((await submit({ source: 'storefront-homepage' })).status, 409);
    assert.equal((await submit({ consentAffirmed: false }, randomUUID())).status, 422);
    assert.equal(await worker.tick(), true);
    assert.equal(mailbox.messages.size, 1);
    const mail = [...mailbox.messages.values()][0]!;
    const link = new URL(mail.confirm);
    assert.equal((await fetch(origin + link.pathname)).status, 200);
    const state = () =>
      db.brand(w, brand, async (sql) => (await sql.query('SELECT state FROM subscribers')).rows[0]?.state);
    assert.equal(await state(), 'pending');
    const act = (url: string) => {
      const link = new URL(url);
      return fetch(origin + link.pathname, {
        method: 'POST',
        headers: { origin: binding.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ token: link.hash.slice(1) }),
      });
    };
    assert.equal((await act(mail.confirm)).status, 200);
    assert.equal((await act(mail.confirm)).status, 410);
    assert.equal(await state(), 'confirmed');
    assert.equal((await act(mail.unsubscribe)).status, 200);
    assert.equal((await submit({}, randomUUID())).status, 202);
    assert.equal(await state(), 'unsubscribed');
    await service.execute('connection.revoke', { id: connectionId, operationKey: randomUUID() }, owner);
    assert.equal((await submit()).status, 401);
    console.log(
      'Private contract passed: accepted, replay, conflict, consent, captured confirmation, inert GET, one-time POST, unsubscribe, suppression, revocation.',
    );
  } finally {
    try {
      if (connectionId)
        await service.execute('connection.revoke', { id: connectionId, operationKey: randomUUID() }, owner);
      await service.execute(
        'intake.configure',
        { operationKey: randomUUID(), brandId: brand, enabled: false },
        owner,
      );
    } finally {
      server.close();
      await once(server, 'close');
    }
  }
}

let fixture: Awaited<ReturnType<typeof import('./database-fixture.js').startDatabase>> | undefined,
  db: Database | undefined;
try {
  const mode = process.argv[2];
  let url: string;
  if (mode === 'local') {
    const { startDatabase } = await import('./database-fixture.js');
    fixture = await startDatabase();
    url = fixture.url;
  } else if (mode === 'staging') {
    const u = new URL(process.env.DATABASE_URL ?? '');
    if (
      process.env.APP_ENV !== 'staging' ||
      u.pathname !== '/flockletter_staging' ||
      u.username !== 'flockletter_staging_runtime'
    )
      throw new Error('Incorrect staging database.');
    url = u.href;
  } else throw new Error('Select local or staging explicitly.');
  db = new Database(url);
  await prove(db);
} catch (error) {
  console.error(
    'Private intake contract failed.',
    error instanceof assert.AssertionError
      ? 'Contract assertion failed.'
      : 'Check the staging fixture and schema.',
  );
  process.exitCode = 1;
} finally {
  await db?.close();
  await fixture?.stop();
}
