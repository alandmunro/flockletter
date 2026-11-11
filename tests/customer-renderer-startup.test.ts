import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import { Database } from '../src/server/db.js';
import { CustomerWorkflows } from '../src/server/customer-runtime.js';
import { CustomerEnginePool } from '../src/server/customer-delivery/engine.js';
import { startLegacyMessenger } from '../src/server/private-engine-startup.js';
import type { IdentityProvider } from '../src/server/auth.js';

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), access: vi.fn(),
}));

const identity: IdentityProvider = {
  async session() { throw Error('This startup test does not authenticate a session.'); },
  async isOwner() { return false; },
};
const runtimes: CustomerWorkflows[] = [];
const databases: Database[] = [];
const env: NodeJS.ProcessEnv = {
  APP_ENV: 'production', APP_ORIGIN: 'https://flockletter.example.com',
  DATABASE_URL: 'postgresql://unused@127.0.0.1/flockletter_unused',
  CLERK_PUBLISHABLE_KEY: 'pk_live_synthetic', CLERK_SECRET_KEY: 'sk_live_synthetic',
};
function runtime(overrides: NodeJS.ProcessEnv = {}) {
  const selected = { ...env, ...overrides }, config = loadConfig(selected);
  const db = new Database(config.databaseUrl!);
  databases.push(db);
  const customer = new CustomerWorkflows(db, config, identity, selected);
  runtimes.push(customer);
  return { selected, config, db, customer };
}
beforeEach(() => {
  vi.mocked(access).mockReset().mockResolvedValue(undefined);
  vi.spyOn(SESv2Client.prototype, 'send').mockImplementation(() => {
    throw Error('Startup must not contact SES.');
  });
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(customer => customer.close()));
  await Promise.all(databases.splice(0).map(db => db.close()));
  vi.restoreAllMocks();
});

it('keeps production workflows off without staging scopes, a renderer or binary access', async () => {
  const { config, selected, db, customer } = runtime();
  expect(customer.settings).toMatchObject({ delivery: 'off', renderer: false });
  expect(customer.engine).toBeUndefined();
  await customer.engine?.verify();
  await expect(startLegacyMessenger(config, db, identity.isOwner, undefined, selected)).resolves.toBeUndefined();
  expect(access).not.toHaveBeenCalled();
  expect(SESv2Client.prototype.send).not.toHaveBeenCalled();
});

it('prepares the gated production customer renderer without starting a legacy staging dispatcher or submitting mail', async () => {
  const { config, selected, db, customer } = runtime({
    FLOCKLETTER_PRIVATE_ENGINE: 'embedded',
    FLOCKLETTER_CUSTOMER_DELIVERY: 'ses', FLOCKLETTER_LIVE_MAILING_APPROVED: 'true',
    FLOCKLETTER_CUSTOMER_SES_ACCESS_KEY_ID: 'synthetic-not-a-key',
    FLOCKLETTER_CUSTOMER_SES_SECRET_ACCESS_KEY: 'synthetic-not-a-secret',
    FLOCKLETTER_CUSTOMER_SES_BINDINGS: JSON.stringify([{
      workspaceId: 'org_renderer_fixture', brandId: randomUUID(), region: 'us-west-2',
      accountId: '123456789012', tenant: 'fixture_tenant', configurationSet: 'fixture_config',
      from: 'news@brand.example.com', identityArn: 'arn:aws:ses:us-west-2:123456789012:identity/brand.example.com',
      topicArn: 'arn:aws:sns:us-west-2:123456789012:fixture_topic',
    }]),
  });
  expect(customer.engine).toBeDefined();
  await customer.engine!.verify();
  expect(access).toHaveBeenCalledExactlyOnceWith(resolve('dist/private/listmonk'), constants.X_OK);
  await expect(startLegacyMessenger(config, db, identity.isOwner, undefined, selected)).resolves.toBeUndefined();
  expect(access).toHaveBeenCalledTimes(1);
  expect(SESv2Client.prototype.send).not.toHaveBeenCalled();
});

it('still refuses unapproved mail and incomplete SES configuration before renderer readiness', () => {
  const mailing = { FLOCKLETTER_PRIVATE_ENGINE: 'embedded', FLOCKLETTER_CUSTOMER_DELIVERY: 'ses' };
  expect(() => runtime(mailing)).toThrow('explicit activation approval');
  expect(() => runtime({ ...mailing, FLOCKLETTER_LIVE_MAILING_APPROVED: 'true' })).toThrow('bindings and credentials');
  expect(access).not.toHaveBeenCalled();
  expect(SESv2Client.prototype.send).not.toHaveBeenCalled();
});

it.each(['ENOENT', 'EACCES'])('refuses configured renderer readiness when the binary check fails with %s', async code => {
  const error = Object.assign(Error(code), { code });
  vi.mocked(access).mockRejectedValue(error);
  const pool = new CustomerEnginePool(1);
  try { await expect(pool.verify()).rejects.toBe(error); }
  finally { await pool.close(); }
  expect(access).toHaveBeenCalledExactlyOnceWith(resolve('dist/private/listmonk'), constants.X_OK);
  expect(SESv2Client.prototype.send).not.toHaveBeenCalled();
});

it('receives only explicitly bound feedback with all external transports off', () => {
  const route = {
    workspaceId: 'org_inbound', brandId: randomUUID(), region: 'us-east-2',
    accountId: '123456789012', tenant: 'inbound_tenant', configurationSet: 'inbound_set',
    from: 'news@brand.example.com', identityArn: 'arn:aws:ses:us-east-2:123456789012:identity/brand.example.com',
    topicArn: 'arn:aws:sns:us-east-2:123456789012:inbound_topic',
  };
  expect(runtime().customer.feedback).toBeUndefined();
  const { customer } = runtime({ FLOCKLETTER_CUSTOMER_SES_FEEDBACK_BINDING: JSON.stringify(route) });
  expect(customer.feedback).toBeDefined();
  expect(customer.ses).toBeUndefined();
  expect(customer.engine).toBeUndefined();
  expect(customer.settings).toMatchObject({ delivery: 'off', billing: 'off' });
  expect(() => runtime({ FLOCKLETTER_CUSTOMER_SES_FEEDBACK_BINDING: JSON.stringify({...route, region: 'us-east-1'}) })).toThrow();
  expect(SESv2Client.prototype.send).not.toHaveBeenCalled();
});
