import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { startBillingFixture } from './helpers/billing-fixture.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { TrialRegistry, trialRegistryFromEnvironment } from '../src/server/customer-abuse/registry.js';
let f: Awaited<ReturnType<typeof startBillingFixture>>, admin: pg.Client;
const registry = () =>
  new TrialRegistry({
    key: 'synthetic-stable-key-for-disposable-tests-only',
    source: 'exercise',
    account: 'synthetic',
    policy: { id: 'synthetic-v1', version: 1, mode: 'bounded', retentionDays: 90, approved: true },
  });
beforeAll(async () => {
  f = await startBillingFixture();
  admin = new pg.Client({ connectionString: f.adminUrl });
  await admin.connect();
  if (
    !(await admin.query("SELECT to_regclass('public.customer_trial_setups') table_name")).rows[0]
      .table_name
  )
    await admin.query(
      await readFile(new URL('../migrations/025_trial_abuse.sql', import.meta.url), 'utf8'),
    );
  await admin.query('GRANT SELECT,INSERT,UPDATE ON customer_trial_setups TO flockletter_runtime');
  await admin.query(
    'GRANT EXECUTE ON FUNCTION flockletter_customer_jobs.trial_claim(text,text,text,text,integer,integer,text,uuid,text,text,text) TO flockletter_runtime',
  );
});
afterAll(async () => {
  await admin?.end();
  await f?.close();
});
async function shop(owner?: string) {
  const a = f.actor();
  if (owner) {
    a.userId = owner;
    a.actorId = 'user:' + owner;
  }
  await new CommandService(f.db).execute(
    'workspace.initialize',
    { name: 'Synthetic shop', brandName: 'Synthetic', operationKey: randomUUID() },
    a,
  );
  return a;
}
const claim = (
  r: TrialRegistry,
  a: Actor,
  id: string,
  action: 'reserve' | 'consume' | 'status',
  card: string | null = null,
) =>
  f.db.tenant(a.workspaceId, (sql) =>
    r.claim(sql, a.workspaceId, r.identity(a.workspaceId, a.userId), id, action, card),
  );
it('serializes concurrent owner reservations across workspaces without revealing the winning tenant', async () => {
  const r = registry(),
    owner = 'user_' + randomUUID(),
    a = await shop(owner),
    b = await shop(owner),
    ia = randomUUID(),
    ib = randomUUID();
  const results = await Promise.all([claim(r, a, ia, 'reserve'), claim(r, b, ib, 'reserve')]);
  expect(results.sort()).toEqual(['allowed', 'trial_unavailable']);
  const denied = results.find((v) => v !== 'allowed')!;
  expect(denied).not.toContain(a.workspaceId);
  expect(denied).not.toContain(b.workspaceId);
});
it('permits exact replay but blocks consumed owner or card reuse across workspaces', async () => {
  const r = registry(),
    a = await shop(),
    b = await shop(),
    c = await shop(a.userId),
    id = randomUUID(),
    card = r.card('synthetic-card-' + randomUUID());
  expect(await claim(r, a, id, 'reserve')).toBe('allowed');
  expect(await claim(r, a, id, 'consume', card)).toBe('allowed');
  expect(await claim(r, a, id, 'consume', card)).toBe('allowed');
  expect(await claim(r, a, id, 'status', card)).toBe('allowed');
  expect(await claim(r, c, randomUUID(), 'reserve')).toBe('trial_unavailable');
  const other = randomUUID();
  expect(await claim(r, b, other, 'reserve')).toBe('allowed');
  expect(await claim(r, b, other, 'consume', card)).toBe('trial_unavailable');
  expect(await claim(r, b, id, 'status', card)).toBe('identity_hold');
});
it('serializes competing new owners sharing one verified card', async () => {
  const r = registry(),
    a = await shop(),
    b = await shop(),
    ia = randomUUID(),
    ib = randomUUID(),
    card = r.card('synthetic-shared-' + randomUUID());
  await Promise.all([claim(r, a, ia, 'reserve'), claim(r, b, ib, 'reserve')]);
  expect(
    (await Promise.all([claim(r, a, ia, 'consume', card), claim(r, b, ib, 'consume', card)])).sort(),
  ).toEqual(['allowed', 'trial_unavailable']);
});
it('allows abandoned lease recovery with a new intent but never extends an old lease', async () => {
  const r = registry(),
    a = await shop(),
    id = randomUUID();
  await claim(r, a, id, 'reserve');
  const before = await admin.query(
    'SELECT expires_at FROM flockletter_customer_jobs.trial_attempts WHERE intent_id=$1',
    [id],
  );
  await claim(r, a, id, 'reserve');
  expect(
    (
      await admin.query(
        'SELECT expires_at FROM flockletter_customer_jobs.trial_attempts WHERE intent_id=$1',
        [id],
      )
    ).rows[0].expires_at,
  ).toEqual(before.rows[0].expires_at);
  await admin.query(
    "UPDATE flockletter_customer_jobs.trial_attempts SET expires_at=now()-interval '1 second' WHERE intent_id=$1",
    [id],
  );
  await admin.query(
    "UPDATE flockletter_customer_jobs.trial_claims SET expires_at=now()-interval '1 second' WHERE intent_id=$1",
    [id],
  );
  expect(await claim(r, a, id, 'consume', r.card('synthetic-expired'))).toBe('reservation_expired');
  expect(await claim(r, a, randomUUID(), 'reserve')).toBe('allowed');
});
it('fails closed on unknown HMAC key changes and separates provider source/account', async () => {
  const r = registry(),
    a = await shop(),
    id = randomUUID();
  await claim(r, a, id, 'reserve');
  const changed = new TrialRegistry({ ...r.config, key: 'a-different-stable-private-key-for-test' });
  expect(await claim(changed, a, randomUUID(), 'reserve')).toBe('configuration_hold');
  const separate = new TrialRegistry({ ...r.config, account: 'other-synthetic' });
  expect(await claim(separate, a, randomUUID(), 'reserve')).toBe('allowed');
  expect(() => new TrialRegistry({ ...r.config, source: 'stripe_test' })).toThrow('approved retention');
  expect(
    trialRegistryFromEnvironment({ APP_ENV: 'staging' }, 'stripe_live', 'acct_test'),
  ).toBeUndefined();
});
it('keeps private tables and retention routines unavailable to runtime role', async () => {
  const a = await shop();
  await expect(
    f.db.tenant(a.workspaceId, (sql) =>
      sql.query('SELECT * FROM flockletter_customer_jobs.trial_claims'),
    ),
  ).rejects.toThrow('permission denied');
  await expect(
    f.db.tenant(a.workspaceId, (sql) =>
      sql.query('SELECT flockletter_customer_jobs.trial_retention_inventory($1,$2)', [
        'a'.repeat(64),
        'b'.repeat(64),
      ]),
    ),
  ).rejects.toThrow('permission denied');
  const r = registry(),
    who = r.identity(a.workspaceId, a.userId);
  await expect(
    f.db.tenant(a.workspaceId, (sql) => r.claim(sql, 'org_wrong', who, randomUUID(), 'reserve')),
  ).rejects.toThrow('Invalid trial registry scope');
});
it('inventories exact minimal records and expires only due bounded claims', async () => {
  const r = registry(),
    a = await shop(),
    id = randomUUID(),
    who = r.identity(a.workspaceId, a.userId);
  await claim(r, a, id, 'reserve');
  await claim(r, a, id, 'consume', r.card('synthetic-retention-' + id));
  const inventory = async () =>
    (
      await admin.query('SELECT flockletter_customer_jobs.trial_retention_inventory($1,$2) inventory', [
        r.namespace,
        who.workspaceDigest,
      ])
    ).rows[0].inventory;
  const first = await inventory();
  expect(first).toMatchObject({
    recordCount: 3,
    policyId: 'synthetic-v1',
    policyMode: 'bounded',
    retentionDays: 90,
  });
  expect(JSON.stringify(first)).not.toContain(a.workspaceId);
  expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  await admin.query('SELECT flockletter_customer_jobs.trial_expire_claims($1,$2)', [
    r.namespace,
    who.workspaceDigest,
  ]);
  expect((await inventory()).recordCount).toBe(3);
  await admin.query(
    "UPDATE flockletter_customer_jobs.trial_claims SET expires_at=now()-interval '1 second' WHERE intent_id=$1",
    [id],
  );
  await admin.query(
    "UPDATE flockletter_customer_jobs.trial_attempts SET expires_at=now()-interval '1 second' WHERE intent_id=$1",
    [id],
  );
  await admin.query('SELECT flockletter_customer_jobs.trial_expire_claims($1,$2)', [
    r.namespace,
    who.workspaceDigest,
  ]);
  expect((await inventory()).recordCount).toBe(0);
});
it('requires an explicit real-provider history baseline and approved policy before initializing hosted protection', () => {
  const env = {
    APP_ENV: 'staging',
    FLOCKLETTER_TRIAL_HMAC_KEY: 'synthetic-key-for-private-unit-tests-only',
    FLOCKLETTER_TRIAL_RETENTION_APPROVED: 'true',
    FLOCKLETTER_TRIAL_POLICY_ID: 'synthetic-policy',
    FLOCKLETTER_TRIAL_POLICY_VERSION: '1',
  };
  expect(trialRegistryFromEnvironment(env, 'stripe_test', 'acct_synthetic')).toBeUndefined();
  expect(
    trialRegistryFromEnvironment(
      { ...env, FLOCKLETTER_TRIAL_HISTORY_BASELINE: 'verified-empty' },
      'stripe_test',
      'acct_synthetic',
    )?.config.historyBaseline,
  ).toBe('verified-empty');
  expect(
    trialRegistryFromEnvironment(
      { ...env, FLOCKLETTER_TRIAL_HISTORY_BASELINE: 'unverified' },
      'stripe_test',
      'acct_synthetic',
    ),
  ).toBeUndefined();
});
