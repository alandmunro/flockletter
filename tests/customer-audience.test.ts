import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database, type Sql } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import {
  CustomerAudience,
  createCustomerOptOut,
  redeemCustomerOptOut,
  productionConsentEligible,
} from '../src/server/customer-audience/service.js';
import type { AudienceSettingsView } from '../src/shared/customer-audience.js';
import { makeAudienceConnection } from './helpers/audience-connection.js';
import { authorize } from '../src/server/service.js';
import { recordRestoredErasure } from './helpers/restored-erasure.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database;
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});
async function setup(limit = 250) {
  const workspace = 'org_' + randomUUID().replaceAll('-', ''),
    owner: Actor = {
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
    { operationKey: randomUUID(), name: 'Owner shop', brandName: 'Alpine' },
    owner,
  );
  const brand = ((await core.execute('workspace.get', {}, owner)) as { brands: { id: string }[] }).brands[0]!
    .id;
  const customer = new CustomerAudience(db, {
    mode: 'exercise',
    origin: 'https://mail.example.test',
    checkOwner: async () => true,
    contactLimit: async () => limit,
  });
  await customer.execute(
    'audienceOnboarding.configure',
    {
      operationKey: randomUUID(),
      brandId: brand,
      enabled: true,
      purpose: 'shop_news',
      policyVersion: 'v1',
      consentText: 'Send me occasional news from the Alpine shop. I can unsubscribe anytime.',
      sourceDomain: 'shop.example.test',
    },
    owner,
  );
  return {
    workspace,
    owner,
    brand,
    customer,
    settings: () =>
      customer.execute(
        'audienceOnboarding.status',
        { brandId: brand },
        owner,
      ) as Promise<AudienceSettingsView>,
  };
}
it('imports real-domain addresses as pending, reports all rows, preserves suppression and replays exactly', async () => {
  const a = await setup();
  const existing = randomUUID();
  await db.brand(a.workspace, a.brand, (sql) =>
    sql.query(
      "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'stopped@realshop.com','complained')",
      [a.workspace, a.brand, existing],
    ),
  );
  const input = {
    brandId: a.brand,
    operationKey: randomUUID(),
    csvBase64: Buffer.from(
      'email\nreader@realshop.com\nreader@realshop.com\nstopped@realshop.com\ninvalid',
    ).toString('base64'),
    emailColumn: 0,
    permissionAffirmed: true,
    source: 'Newsletter migration with permission',
  };
  const result = (await a.customer.execute('audienceOnboarding.import', input, a.owner)) as {
    rows: { outcome: string }[];
  };
  expect(result.rows.map((r) => r.outcome)).toEqual([
    'pending_added',
    'duplicate',
    'kept_complained',
    'invalid_email',
  ]);
  expect(await a.customer.execute('audienceOnboarding.import', input, a.owner)).toEqual(result);
  const saved = (await a.settings()).imports[0]!;
  expect(
    await a.customer.execute('audienceOnboarding.importResult', { brandId: a.brand, id: saved.id }, a.owner),
  ).toEqual(result);
  await expect(
    a.customer.execute('audienceOnboarding.import', { ...input, source: 'Different permission' }, a.owner),
  ).rejects.toMatchObject({ code: 'operation_conflict' });
  expect(await a.settings()).toMatchObject({ trackingEnabled: false, messages: [] });
});
it('shares unique contact capacity across brands and safely handles simultaneous final slots', async () => {
  const a = await setup(1);
  const core = new CommandService(db);
  // Create the second brand through the database fixture because preparation mode intentionally permits one brand.
  const second = randomUUID();
  await db.tenant(a.workspace, (sql) =>
    sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
      a.workspace,
      second,
      'Second brand',
    ]),
  );
  const apply = (brand: string, email: string) =>
    a.customer.execute(
      'audienceOnboarding.import',
      {
        brandId: brand,
        operationKey: randomUUID(),
        csvBase64: Buffer.from('email\n' + email).toString('base64'),
        emailColumn: 0,
        permissionAffirmed: true,
        source: 'Authorized source',
      },
      a.owner,
    ) as Promise<{ rows: { outcome: string }[] }>;
  const results = await Promise.all([apply(a.brand, 'one@domain.com'), apply(second, 'two@domain.com')]);
  expect(results.flatMap((r) => r.rows.map((row) => row.outcome)).sort()).toEqual([
    'contact_limit',
    'pending_added',
  ]);
  const email = await db.brand(
    a.workspace,
    a.brand,
    async (sql) =>
      (await sql.query<{ email_normalized: string }>('SELECT email_normalized FROM subscribers')).rows[0]
        ?.email_normalized,
  );
  const source = email ? a.brand : second,
    target = email ? second : a.brand,
    address = email ?? 'two@domain.com';
  expect((await apply(target, address)).rows[0]?.outcome).toBe('pending_added');
  expect(await core.execute('audience.summary', { brandId: source }, a.owner)).toMatchObject({ total: 1 });
});
it('captures signup, confirms using the same token path, and never treats the exercise as production consent', async () => {
  const a = await setup(),
    form = (await a.settings()).publicUrl!.split('/newsletter/')[1]!;
  expect(await a.customer.publicForm(form)).toMatchObject({ mode: 'exercise', policyVersion: 'v1' });
  await a.customer.publicSignup(form, {
    email: 'reader@realshop.com',
    consentAffirmed: true,
    policyVersion: 'v1',
  });
  const message = (await a.settings()).messages[0]!;
  const captured = (await a.customer.execute(
    'audienceOnboarding.confirmation',
    { brandId: a.brand, id: message.id },
    a.owner,
  )) as { confirmationUrl: string; unsubscribeUrl: string };
  const token = new URL(captured.confirmationUrl).searchParams.get('t')!;
  expect(await a.customer.confirm(form, token)).toEqual({ confirmed: true, mode: 'exercise' });
  expect(await a.customer.confirm(form, token)).toEqual({ confirmed: true, mode: 'exercise' });
  const subscriber = await db.brand(
    a.workspace,
    a.brand,
    async (sql) => (await sql.query<{ id: string }>('SELECT id FROM subscribers')).rows[0]!.id,
  );
  expect(await db.brand(a.workspace, a.brand, (sql) => productionConsentEligible(sql, subscriber))).toBe(
    false,
  );
  const unsub = new URL(captured.unsubscribeUrl).searchParams.get('t')!;
  await a.customer.unsubscribeConfirmation(form, unsub);
  await expect(a.customer.confirm(form, token)).rejects.toMatchObject({ code: 'link_unavailable' });
  expect(
    await db.brand(
      a.workspace,
      a.brand,
      async (sql) => (await sql.query('SELECT state FROM subscribers')).rows[0]?.state,
    ),
  ).toBe('unsubscribed');
});
it('keeps opt-out capabilities durable, scoped and valid when intake is disabled', async () => {
  const a = await setup(),
    b = await setup(),
    id = randomUUID();
  for (const fixture of [a, b])
    await db.brand(fixture.workspace, fixture.brand, (sql) =>
      sql.query(
        "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'shared@realshop.com','confirmed')",
        [fixture.workspace, fixture.brand, id],
      ),
    );
  const link = await db.brand(a.workspace, a.brand, (sql) =>
    createCustomerOptOut(sql, a.workspace, a.brand, id, 'https://mail.example.test'),
  );
  await db.brand(a.workspace, a.brand, (sql) =>
    sql.query('UPDATE customer_audience_settings SET enabled=false'),
  );
  const token = new URL(link.url).searchParams.get('t')!;
  await redeemCustomerOptOut(db, token);
  await redeemCustomerOptOut(db, token);
  expect(
    await db.brand(
      a.workspace,
      a.brand,
      async (sql) => (await sql.query('SELECT state FROM subscribers WHERE id=$1', [id])).rows[0]?.state,
    ),
  ).toBe('unsubscribed');
  expect(
    await db.brand(
      b.workspace,
      b.brand,
      async (sql) => (await sql.query('SELECT state FROM subscribers WHERE id=$1', [id])).rows[0]?.state,
    ),
  ).toBe('confirmed');
});
it('rejects changed consent, unauthorized actors and foreign forms without mutation', async () => {
  const a = await setup(),
    b = await setup();
  const form = (await a.settings()).publicUrl!.split('/newsletter/')[1]!;
  await expect(
    a.customer.publicSignup(form, { email: 'reader@shop.com', consentAffirmed: true, policyVersion: 'old' }),
  ).rejects.toMatchObject({ code: 'consent_changed' });
  await expect(
    a.customer.execute('audienceOnboarding.status', { brandId: a.brand }, b.owner),
  ).rejects.toMatchObject({ code: 'brand_unavailable' });
  await expect(
    a.customer.execute('audienceOnboarding.status', { brandId: a.brand }, { ...a.owner, kind: 'connection' }),
  ).rejects.toMatchObject({ code: 'owner_required' });
  expect((await a.settings()).messages).toHaveLength(0);
});

it('reconciles live confirmation delivery without resending and requires real confirmation after exercise', async () => {
  const a = await setup();
  const form = (await a.settings()).publicUrl!.split('/newsletter/')[1]!;
  await a.customer.publicSignup(form, {
    email: 'reader@realshop.com',
    consentAffirmed: true,
    policyVersion: 'v1',
  });
  const captured = (await a.settings()).messages[0]!;
  await a.customer.execute(
    'audienceOnboarding.exerciseConfirm',
    { brandId: a.brand, id: captured.id, operationKey: randomUUID() },
    a.owner,
  );
  const subscriber = await db.brand(
    a.workspace,
    a.brand,
    async (sql) => (await sql.query<{ id: string }>('SELECT id FROM subscribers')).rows[0]!.id,
  );
  let submitted = 0,
    lookups = 0,
    confirmationUrl = '';
  const live = new CustomerAudience(db, {
    mode: 'live',
    origin: 'https://mail.example.test',
    checkOwner: async () => true,
    confirmationKey: Buffer.alloc(32, 7),
    provider: {
      submit: async (message) => {
        submitted++;
        confirmationUrl = message.confirmUrl;
        throw Error('lost delivery response');
      },
      lookup: async () => {
        lookups++;
        return { state: 'accepted', providerId: 'message_fixture' };
      },
    },
  });
  await live.publicSignup(form, { email: 'reader@realshop.com', consentAffirmed: true, policyVersion: 'v1' });
  await live.tick(a.workspace, a.brand);
  expect(submitted).toBe(1);
  expect(await db.brand(a.workspace, a.brand, (sql) => productionConsentEligible(sql, subscriber))).toBe(
    false,
  );
  await db.brand(a.workspace, a.brand, (sql) =>
    sql.query(
      "UPDATE customer_audience_confirmations SET next_check_at=now()-interval '1 minute' WHERE mode='live'",
    ),
  );
  await live.tick(a.workspace, a.brand);
  expect(submitted).toBe(1);
  expect(lookups).toBe(1);
  await live.confirm(form, new URL(confirmationUrl).searchParams.get('t')!);
  expect(await db.brand(a.workspace, a.brand, (sql) => productionConsentEligible(sql, subscriber))).toBe(
    true,
  );
});

const delegatedImport = (brandId: string, address = 'delegated@retailer.test') => ({
  brandId,
  operationKey: randomUUID(),
  csvBase64: Buffer.from('email\n' + address).toString('base64'),
  emailColumn: 0,
  permissionAffirmed: true,
  source: 'Attested in-store opt-in',
});
it('permits only explicitly scoped imports, same-actor results and pending confirmation requests', async () => {
  const a = await setup(),
    otherBrand = randomUUID();
  await db.tenant(a.workspace, (sql) =>
    sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
      a.workspace,
      otherBrand,
      'Another brand',
    ]),
  );
  const writer = await makeAudienceConnection(db, a.owner, [a.brand]);
  expect(() => authorize(writer.actor, 'audienceOnboarding.import')).not.toThrow();
  expect(() => authorize(writer.actor, 'audienceOnboarding.status')).toThrow();
  expect(() => authorize(writer.actor, 'audience.list')).toThrow();
  expect(() => authorize(writer.actor, 'delivery.review')).toThrow();
  await expect(a.customer.execute('audienceOnboarding.configure', {}, writer.actor)).rejects.toMatchObject({
    code: 'owner_required',
  });
  const imported = (await a.customer.execute(
    'audienceOnboarding.import',
    delegatedImport(a.brand),
    writer.actor,
  )) as { id: string; rows: { subscriberId: string; outcome: string }[] };
  expect(imported.rows[0]?.outcome).toBe('pending_added');
  expect(JSON.stringify(imported)).not.toMatch(/token|confirmationUrl|unsubscribeUrl/);
  expect(
    await a.customer.execute(
      'audienceOnboarding.importResult',
      { brandId: a.brand, id: imported.id },
      writer.actor,
    ),
  ).toEqual(imported);
  const confirmation = await a.customer.execute(
    'audienceOnboarding.requestConfirmation',
    { brandId: a.brand, subscriberId: imported.rows[0]!.subscriberId, operationKey: randomUUID() },
    writer.actor,
  );
  expect(confirmation).toMatchObject({ status: 'captured' });
  expect(JSON.stringify(confirmation)).not.toMatch(/token|Url/);
  const another = await makeAudienceConnection(db, a.owner, [a.brand]);
  await expect(
    a.customer.execute(
      'audienceOnboarding.importResult',
      { brandId: a.brand, id: imported.id },
      another.actor,
    ),
  ).rejects.toMatchObject({ code: 'import_unavailable' });
  expect(
    await a.customer.execute(
      'audienceOnboarding.importResult',
      { brandId: a.brand, id: imported.id },
      a.owner,
    ),
  ).toEqual(imported);
  await expect(
    a.customer.execute('audienceOnboarding.import', delegatedImport(otherBrand), writer.actor),
  ).rejects.toMatchObject({ code: 'scope_required' });
  const forgedScope = { ...writer.actor, brandIds: [a.brand, otherBrand] };
  await expect(
    a.customer.execute('audienceOnboarding.import', delegatedImport(otherBrand), forgedScope),
  ).rejects.toMatchObject({ code: 'scope_required' });
  const ownerImport = (await a.customer.execute(
    'audienceOnboarding.import',
    delegatedImport(a.brand, 'owner@retailer.test'),
    a.owner,
  )) as { id: string };
  await expect(
    a.customer.execute(
      'audienceOnboarding.importResult',
      { brandId: a.brand, id: ownerImport.id },
      writer.actor,
    ),
  ).rejects.toMatchObject({ code: 'import_unavailable' });
  const message = (await a.settings()).messages[0]!;
  for (const [name, input] of [
    ['audienceOnboarding.status', { brandId: a.brand }],
    ['audienceOnboarding.confirmation', { brandId: a.brand, id: message.id }],
    ['audienceOnboarding.exerciseConfirm', { brandId: a.brand, id: message.id, operationKey: randomUUID() }],
    [
      'audienceOnboarding.signup',
      {
        brandId: a.brand,
        email: 'new@retailer.test',
        consentAffirmed: true,
        policyVersion: 'v1',
        operationKey: randomUUID(),
      },
    ],
  ] as const)
    await expect(a.customer.execute(name, input, writer.actor)).rejects.toMatchObject({
      code: 'owner_required',
    });
  const readOnly = await makeAudienceConnection(db, a.owner, [a.brand], ['read']);
  await expect(
    a.customer.execute('audienceOnboarding.import', delegatedImport(a.brand), readOnly.actor),
  ).rejects.toMatchObject({ code: 'scope_required' });
  const noLongerOwner = new CustomerAudience(db, { ...a.customer.options, checkOwner: async () => false });
  await expect(
    noLongerOwner.execute(
      'audienceOnboarding.importResult',
      { brandId: a.brand, id: imported.id },
      writer.actor,
    ),
  ).rejects.toMatchObject({ code: 'scope_required' });
});

it('checks connection revocation and expiry after waiting for the workspace lock, including retries', async () => {
  const a = await setup(),
    writer = await makeAudienceConnection(db, a.owner, [a.brand]);
  const request = delegatedImport(a.brand);
  await a.customer.execute('audienceOnboarding.import', request, writer.actor);
  let unlock!: () => void, held!: () => void;
  const ready = new Promise<void>((resolve) => {
      held = resolve;
    }),
    release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
  const blocker = db.tenant(a.workspace, async (sql) => {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [a.workspace]);
    held();
    await release;
  });
  await ready;
  const waiting = a.customer.execute('audienceOnboarding.import', request, writer.actor);
  const rejected = expect(waiting).rejects.toMatchObject({ code: 'scope_required' });
  const admin = new Database(fixture.adminUrl);
  try {
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      blocked = Boolean(
        (await admin.pool.query("SELECT FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rowCount,
      );
      if (blocked) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(blocked).toBe(true);
    // Independent administrative revocation may occur while application operations wait.
    await admin.pool.query('UPDATE connections SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[a.workspace,writer.id]);
  } finally {
    unlock();
    await blocker;
    await admin.close();
  }
  await rejected;
  const expired = await makeAudienceConnection(db, a.owner, [a.brand]);
  await db.tenant(a.workspace, (sql) =>
    sql.query("UPDATE connections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [
      expired.id,
    ]),
  );
  await expect(
    a.customer.execute('audienceOnboarding.import', delegatedImport(a.brand), expired.actor),
  ).rejects.toMatchObject({ code: 'scope_required' });
  await expect(
    a.customer.execute(
      'audienceOnboarding.importResult',
      { brandId: a.brand, id: (await a.settings()).imports[0]!.id },
      expired.actor,
    ),
  ).rejects.toMatchObject({ code: 'scope_required' });
});

it('uses the current clock when a grant expires during a workspace-lock wait', async () => {
  const a = await setup(),
    writer = await makeAudienceConnection(db, a.owner, [a.brand]);
  const imported = (await a.customer.execute(
    'audienceOnboarding.import',
    delegatedImport(a.brand),
    writer.actor,
  )) as { id: string };
  let unlock!: () => void, held!: () => void;
  const ready = new Promise<void>((resolve) => {
      held = resolve;
    }),
    release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
  const blocker = db.tenant(a.workspace, async (sql) => {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [a.workspace]);
    held();
    await release;
  });
  await ready;
  const attempt = a.customer.execute(
    'audienceOnboarding.importResult',
    { brandId: a.brand, id: imported.id },
    writer.actor,
  );
  const rejected = expect(attempt).rejects.toMatchObject({ code: 'scope_required' });
  const admin = new Database(fixture.adminUrl);
  try {
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      blocked = Boolean(
        (await admin.pool.query("SELECT FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rowCount,
      );
      if (blocked) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(blocked).toBe(true);
    await admin.pool.query("UPDATE connections SET expires_at=clock_timestamp()+interval '20 milliseconds' WHERE workspace_id=$1 AND id=$2",[a.workspace,writer.id]);
    await admin.pool.query('SELECT pg_sleep(0.03)');
  } finally {
    unlock();
    await blocker;
    await admin.close();
  }
  await rejected;
});

it('blocks restored queued confirmations after erasure while preserving read-only unknown-outcome lookup', async () => {
  const a = await setup();
  let submitted = 0,
    lookedUp = 0;
  const live = new CustomerAudience(db, {
    ...a.customer.options,
    mode: 'live',
    confirmationKey: Buffer.alloc(32, 9),
    provider: {
      submit: async () => {
        submitted++;
        throw Error('lost provider reply');
      },
      lookup: async () => {
        lookedUp++;
        return { state: 'accepted', providerId: 'already-submitted' };
      },
    },
  });
  const form = (await a.settings()).publicUrl!.split('/newsletter/')[1]!;
  await live.publicSignup(form, {
    email: 'unknown@retailer.test',
    consentAffirmed: true,
    policyVersion: 'v1',
  });
  await live.tick(a.workspace, a.brand);
  expect(submitted).toBe(1);
  await live.publicSignup(form, {
    email: 'queued@retailer.test',
    consentAffirmed: true,
    policyVersion: 'v1',
  });
  await recordRestoredErasure(fixture.adminUrl, a.workspace);
  await db.brand(a.workspace, a.brand, (sql) =>
    sql.query(
      "UPDATE customer_audience_confirmations SET next_check_at=now()-interval '1 second' WHERE state='uncertain'",
    ),
  );
  await live.tick(a.workspace, a.brand);
  await live.tick(a.workspace, a.brand);
  expect(submitted).toBe(1);
  expect(lookedUp).toBe(1);
  const states = await db.brand(
    a.workspace,
    a.brand,
    async (sql) =>
      (
        await sql.query<{
          email: string;
          state: string;
          attempts: number;
        }>(`SELECT s.email_normalized email,c.state,c.attempts FROM customer_audience_confirmations c
    JOIN subscribers s USING(workspace_id,brand_id) WHERE s.id=c.subscriber_id ORDER BY email`)
      ).rows,
  );
  expect(states).toEqual([
    { email: 'queued@retailer.test', state: 'cancelled', attempts: 0 },
    { email: 'unknown@retailer.test', state: 'accepted', attempts: 1 },
  ]);
});

it('rechecks erasure after a confirmation claim commits and before contacting the provider', async () => {
  const a = await setup();
  let submitted = 0;
  const options = {
    ...a.customer.options,
    mode: 'live' as const,
    confirmationKey: Buffer.alloc(32, 3),
    provider: {
      submit: async () => {
        submitted++;
        return { state: 'accepted' as const };
      },
      lookup: async () => ({ state: 'unknown' as const }),
    },
  };
  const form = (await a.settings()).publicUrl!.split('/newsletter/')[1]!;
  await new CustomerAudience(db, options).publicSignup(form, {
    email: 'claim-race@retailer.test',
    consentAffirmed: true,
    policyVersion: 'v1',
  });
  class RestoreAfterClaim extends Database {
    private pending = true;
    override async brand<T>(workspace: string, brand: string, action: (sql: Sql) => Promise<T>): Promise<T> {
      const result = await super.brand(workspace, brand, action);
      if (this.pending) {
        this.pending = false;
        await recordRestoredErasure(fixture.adminUrl, workspace);
      }
      return result;
    }
  }
  const restored = new RestoreAfterClaim(fixture.url);
  try {
    await new CustomerAudience(restored, options).tick(a.workspace, a.brand);
  } finally {
    await restored.close();
  }
  expect(submitted).toBe(0);
  expect(
    await db.brand(
      a.workspace,
      a.brand,
      async (sql) => (await sql.query('SELECT state,attempts FROM customer_audience_confirmations')).rows[0],
    ),
  ).toMatchObject({ state: 'cancelled', attempts: 0 });
});
