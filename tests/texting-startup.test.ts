import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import { Database } from '../src/server/db.js';
import { CustomerWorkflows } from '../src/server/customer-runtime.js';
import { textingSecretKeys } from '../src/server/texting/runtime.js';
import type { IdentityProvider } from '../src/server/auth.js';
import { fakeBitwarden } from './helpers/bitwarden-fake.js';

// 2026-11-19: production live mode crashed at start-up because neither entry point loaded the
// Bitwarden secrets. These tests start the workflows the way main.ts and the worker do.
const identity: IdentityProvider = {
  async session() { throw Error('This startup test does not authenticate a session.'); },
  async isOwner() { return false; },
};
const hex = (n: number) => randomBytes(n).toString('hex');
const productionValues = (): Record<string, string> => ({
  FLOCKLETTER_TWILIO_ACCOUNT_SID: 'AC' + hex(16), FLOCKLETTER_TWILIO_API_KEY_SID: 'SK' + hex(16), FLOCKLETTER_TWILIO_API_KEY_SECRET: hex(16),
  FLOCKLETTER_TWILIO_AUTH_TOKEN: hex(16), FLOCKLETTER_TWILIO_PLATFORM_ACCOUNT_SID: 'AC' + hex(16), FLOCKLETTER_TWILIO_PLATFORM_API_KEY_SID: 'SK' + hex(16),
  FLOCKLETTER_TWILIO_PLATFORM_API_KEY_SECRET: hex(16), FLOCKLETTER_TWILIO_PRIMARY_PROFILE_SID: 'BU' + hex(16), FLOCKLETTER_TEXTING_SEAL_KEY: hex(32),
});
const opened: { db: Database; customer?: CustomerWorkflows }[] = [];
function production(overrides: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = {
    APP_ENV: 'production', APP_ORIGIN: 'https://flockletter.example.com',
    DATABASE_URL: 'postgresql://unused@127.0.0.1/flockletter_unused',
    CLERK_PUBLISHABLE_KEY: 'pk_live_synthetic', CLERK_SECRET_KEY: 'sk_live_synthetic', ...overrides,
  };
  const config = loadConfig(env), db = new Database(config.databaseUrl!), entry = { db } as (typeof opened)[number];
  opened.push(entry);
  return { env, config, db, entry };
}
afterEach(async () => {
  for (const { db, customer } of opened.splice(0)) { await customer?.close(); await db.close(); }
});

it('starts production in live mode with the nine keys from its own Bitwarden project', async () => {
  const values = productionValues();
  expect(Object.keys(values).sort()).toEqual([...textingSecretKeys].sort());
  const bw = fakeBitwarden({ 'flockletter-staging': {}, 'flockletter-production': values });
  const { env, config, db, entry } = production({ FLOCKLETTER_TEXTING: 'live', FLOCKLETTER_TEXTING_ACTIVATION_APPROVED: 'true', BWS_PROJECT: 'flockletter-production', BWS_ACCESS_TOKEN: bw.token });
  const customer = entry.customer = await CustomerWorkflows.start(db, config, identity, env, bw.fetcher);
  expect(customer.texting).toBeDefined();
  expect(env.BWS_ACCESS_TOKEN).toBeUndefined();
  expect(bw.calls.some(path => path.endsWith('/connect/token'))).toBe(true);
});

it('fails start-up clearly when a live key is missing from the project', async () => {
  const values = productionValues();
  delete values.FLOCKLETTER_TWILIO_PRIMARY_PROFILE_SID;
  const bw = fakeBitwarden({ 'flockletter-staging': productionValues(), 'flockletter-production': values });
  const { env, config, db } = production({ FLOCKLETTER_TEXTING: 'live', FLOCKLETTER_TEXTING_ACTIVATION_APPROVED: 'true', BWS_PROJECT: 'flockletter-production', BWS_ACCESS_TOKEN: bw.token });
  await expect(CustomerWorkflows.start(db, config, identity, env, bw.fetcher)).rejects.toThrow('FLOCKLETTER_TWILIO_PRIMARY_PROFILE_SID in the flockletter-production');
});

it('reads nothing from Bitwarden when texting is off', async () => {
  const bw = fakeBitwarden();
  const { env, config, db, entry } = production({ BWS_PROJECT: 'flockletter-production', BWS_ACCESS_TOKEN: bw.token });
  const customer = entry.customer = await CustomerWorkflows.start(db, config, identity, env, bw.fetcher);
  expect(customer.texting).toBeUndefined();
  expect(bw.calls).toEqual([]);
});

it('refuses live mode built without loaded secrets', () => {
  const { env, config, db } = production({ FLOCKLETTER_TEXTING: 'live', FLOCKLETTER_TEXTING_ACTIVATION_APPROVED: 'true', BWS_PROJECT: 'flockletter-production' });
  expect(() => new CustomerWorkflows(db, config, identity, env)).toThrow('Live texting secrets were not loaded');
});

it('both production entry points start the workflows through CustomerWorkflows.start', () => {
  for (const file of ['src/server/main.ts', 'src/server/customer-worker-main.ts']) {
    const source = readFileSync(file, 'utf8');
    expect(source, file).toContain('await CustomerWorkflows.start(');
    expect(source, file).not.toMatch(/new CustomerWorkflows\(/);
  }
});
