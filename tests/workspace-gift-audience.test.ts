import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import type { SubscriberState } from '../src/shared/audience.js';
import type { ConsentState } from '../src/shared/texting.js';
import { Database, type Sql } from '../src/server/db.js';
import {
  eligibleGiftRecipients,
  giftWorkspaceOnboardingFacts,
  seedStagingGiftAudience,
} from '../src/server/workspace-gifts/audience.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database;
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});

async function workspace() {
  const workspaceId = 'org_gift_' + randomUUID(),
    brandId = randomUUID();
  const companyId = await db.tenant(workspaceId, async (sql) => {
    await sql.query('INSERT INTO workspaces(workspace_id,name) VALUES($1,$2)', [
      workspaceId,
      'Test workspace',
    ]);
    await sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
      workspaceId,
      brandId,
      'Test brand',
    ]);
    return (
      await sql.query<{ company_id: string }>('SELECT company_id FROM company_brands WHERE brand_id=$1', [
        brandId,
      ])
    ).rows[0]!.company_id;
  });
  return { workspaceId, brandId, companyId };
}
type Scope = Awaited<ReturnType<typeof workspace>>;
const read = (s: Scope) =>
  db.brand(s.workspaceId, s.brandId, (sql) => eligibleGiftRecipients(sql, s.workspaceId, s.brandId));
const facts = (s: Scope) =>
  db.brand(s.workspaceId, s.brandId, (sql) => giftWorkspaceOnboardingFacts(sql, s.workspaceId, s.brandId));

async function insertSubscriber(
  sql: Sql,
  s: Scope,
  email: string,
  state: SubscriberState,
  firstName?: string,
) {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state,first_name)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [s.workspaceId, s.brandId, id, email, state, firstName ?? null],
  );
  return id;
}
async function insertPhone(sql: Sql, s: Scope, phone: string, legacySubscriber?: string) {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO sms_contacts(workspace_id,id,phone_e164,brand_id,subscriber_id)
    VALUES($1,$2,$3,$4,$5)`,
    [s.workspaceId, id, phone, s.brandId, legacySubscriber ?? null],
  );
  return id;
}
async function link(sql: Sql, s: Scope, contact: string, subscriber: string) {
  await sql.query(
    `INSERT INTO sms_contact_subscribers(workspace_id,contact_id,brand_id,subscriber_id)
    VALUES($1,$2,$3,$4)`,
    [s.workspaceId, contact, s.brandId, subscriber],
  );
}
async function smsConsent(sql: Sql, s: Scope, contact: string, state: ConsentState) {
  await sql.query(`INSERT INTO sms_consents(workspace_id,company_id,contact_id,state) VALUES($1,$2,$3,$4)`, [
    s.workspaceId,
    s.companyId,
    contact,
    state,
  ]);
}

it('selects one real person per shared phone, respects current links and keeps each channel independently eligible', async () => {
  const s = await workspace();
  const { keeper, emailOnly, phoneOnly, linkedPhoneOnly } = await db.brand(
    s.workspaceId,
    s.brandId,
    async (sql) => {
      const keeper = await insertSubscriber(sql, s, 'CaseSensitive@example.test', 'confirmed', 'Avery');
      const relative = await insertSubscriber(sql, s, 'relative@example.test', 'unsubscribed', 'Relative');
      const replaced = await insertPhone(sql, s, '+12125550100', keeper);
      await smsConsent(sql, s, replaced, 'opted_in');
      const shared = await insertPhone(sql, s, '+12125550101', relative);
      await link(sql, s, shared, keeper);
      await smsConsent(sql, s, shared, 'opted_in');

      const emailOnly = await insertSubscriber(sql, s, 'stopped@example.test', 'confirmed');
      const stopped = await insertPhone(sql, s, '+12125550102', emailOnly);
      await smsConsent(sql, s, stopped, 'opted_out');

      const phoneOnly = await insertPhone(sql, s, '+12125550103');
      await smsConsent(sql, s, phoneOnly, 'opted_in');
      const linkedPhoneOnly = await insertSubscriber(sql, s, 'bounced@example.test', 'hard_bounced');
      const legacy = await insertPhone(sql, s, '+12125550104', linkedPhoneOnly);
      await smsConsent(sql, s, legacy, 'opted_in');

      const blocked = await insertPhone(sql, s, '+12125550105');
      await smsConsent(sql, s, blocked, 'opted_in');
      await sql.query("UPDATE sms_contacts SET textable=false,not_textable_reason='landline' WHERE id=$1", [
        blocked,
      ]);
      for (const [index, state] of (
        ['pending_confirmation', 'pending_reenrollment', 'none', 'opted_out'] as const
      ).entries())
        await smsConsent(sql, s, await insertPhone(sql, s, '+1212555011' + index), state);
      await insertPhone(sql, s, '+12125550119');
      for (const state of ['pending', 'unsubscribed', 'complained', 'hard_bounced'] as const)
        await insertSubscriber(sql, s, state + '@example.test', state);
      return { keeper, emailOnly, phoneOnly, linkedPhoneOnly };
    },
  );
  const result = await read(s);
  expect(result).toHaveLength(4);
  expect(result).toEqual(
    expect.arrayContaining([
      { id: keeper, label: 'Avery', email: 'CaseSensitive@example.test', phone: '+12125550101' },
      { id: emailOnly, label: 'stopped@example.test', email: 'stopped@example.test' },
      { id: phoneOnly, label: 'Phone ending 0103', phone: '+12125550103' },
      { id: linkedPhoneOnly, label: 'Phone ending 0104', phone: '+12125550104' },
    ]),
  );
  // STOP now suppresses the SMS channel. The household still has just one eligible email.
  await db.brand(s.workspaceId, s.brandId, (sql) =>
    sql.query(
      "UPDATE sms_consents SET state='opted_out' WHERE contact_id IN (SELECT id FROM sms_contacts WHERE phone_e164='+12125550101')",
    ),
  );
  expect((await read(s)).find((row) => row.id === keeper)).toEqual({
    id: keeper,
    label: 'Avery',
    email: 'CaseSensitive@example.test',
  });
});

it('deduplicates different confirmed email subscribers on the same phone even after STOP', async () => {
  const s = await workspace();
  const primary = await db.brand(s.workspaceId, s.brandId, async (sql) => {
    const id = await insertSubscriber(sql, s, 'older@example.test', 'confirmed', 'Older');
    const second = await insertSubscriber(sql, s, 'newer@example.test', 'confirmed', 'Newer');
    await sql.query("UPDATE subscribers SET created_at=now()-interval '1 day' WHERE id=$1", [id]);
    const contact = await insertPhone(sql, s, '+12125550130', id);
    await link(sql, s, contact, second);
    await smsConsent(sql, s, contact, 'opted_out');
    return id;
  });
  expect(await read(s)).toEqual([{ id: primary, label: 'Older', email: 'older@example.test' }]);
});

it('keeps foreign workspaces, sibling brand contacts, conflicting context and unrelated company consent outside the audience', async () => {
  const a = await workspace(),
    b = await workspace();
  const sibling = { ...a, brandId: randomUUID() };
  await db.tenant(a.workspaceId, (sql) =>
    sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
      a.workspaceId,
      sibling.brandId,
      'Sibling',
    ]),
  );
  for (const s of [sibling, b]) {
    await db.brand(s.workspaceId, s.brandId, async (sql) => {
      await insertSubscriber(sql, s, 'reader@example.test', 'confirmed');
      await smsConsent(sql, s, await insertPhone(sql, s, '+12125550140'), 'opted_in');
    });
  }
  await db.brand(a.workspaceId, a.brandId, async (sql) => {
    const otherCompany = randomUUID();
    await sql.query("INSERT INTO companies(workspace_id,id,name) VALUES($1,$2,'Other company')", [
      a.workspaceId,
      otherCompany,
    ]);
    await smsConsent(
      sql,
      { ...a, companyId: otherCompany },
      await insertPhone(sql, a, '+12125550141'),
      'opted_in',
    );
    expect(await eligibleGiftRecipients(sql, b.workspaceId, b.brandId)).toEqual([]);
    expect(await eligibleGiftRecipients(sql, a.workspaceId, sibling.brandId)).toEqual([]);
    expect((await giftWorkspaceOnboardingFacts(sql, a.workspaceId, sibling.brandId)).companyId).toBeNull();
  });
  expect(await read(a)).toEqual([]);
  expect(await read(sibling)).toHaveLength(2);
  expect(await read(b)).toHaveLength(2);
});

it('reads only scoped registration and recognized WA-05 probation and test setup facts', async () => {
  const a = await workspace(),
    b = await workspace(),
    carrier = randomUUID(),
    registration = randomUUID();
  const empty = {
    registrationState: null,
    registrationSource: null,
    industry: null,
    probationState: null,
    probationSource: null,
    setupPaymentSource: null,
    firstClearedPaymentAt: null,
    firstClearedPaymentSource: null,
  };
  expect(await facts(a)).toEqual({ companyId: a.companyId, ...empty });
  await db.brand(a.workspaceId, a.brandId, async (sql) => {
    const profile = {
      vertical: 'REAL_ESTATE',
      onboarding: { probation: { state: 'complete' }, payment: { state: 'paid', source: 'stripe_test' } },
    };
    await sql.query(
      `INSERT INTO sms_carrier_brands(workspace_id,id,company_id,legal_name,entity_type,profile,help_contact,created_by)
      VALUES($1,$2,$3,'Example','private_profit',$4,'help@example.test','fixture')`,
      [a.workspaceId, carrier, a.companyId, profile],
    );
    await sql.query(
      `INSERT INTO sms_registrations(workspace_id,id,carrier_brand_id,state) VALUES($1,$2,$3,'approved')`,
      [a.workspaceId, registration, carrier],
    );
    await sql.query(
      `INSERT INTO customer_billing_events(workspace_id,source,event_id,digest,event_kind,finished)
      VALUES($1,'stripe','evt_fixture','digest','invoice.paid',true)`,
      [a.workspaceId],
    );
  });
  expect(await facts(a)).toEqual({
    companyId: a.companyId,
    ...empty,
    registrationState: 'approved',
    registrationSource: 'wa05_mock_onboarding',
    industry: 'REAL_ESTATE',
    probationState: 'complete',
    probationSource: 'wa05_mock_onboarding',
    setupPaymentSource: 'stripe_test',
  });
  expect(await facts(b)).toEqual({ companyId: b.companyId, ...empty });
  await db.tenant(a.workspaceId, (sql) =>
    sql.query(`UPDATE sms_carrier_brands SET profile=$1 WHERE id=$2`, [
      {
        vertical: 'unknown',
        onboarding: { probation: { state: 'unknown' }, payment: { state: 'paid', source: 'stripe_live' } },
      },
      carrier,
    ]),
  );
  expect(await facts(a)).toEqual({
    companyId: a.companyId,
    ...empty,
    registrationState: 'approved',
    registrationSource: 'wa05_mock_onboarding',
  });
  await db.tenant(a.workspaceId, async (sql) => {
    await sql.query('UPDATE sms_carrier_brands SET profile=$1 WHERE id=$2', [
      { onboarding: { probation: { state: 'complete' }, payment: { state: 'paid', source: 'capture' } } },
      carrier,
    ]);
    await sql.query("UPDATE sms_registrations SET state='suspended' WHERE id=$1", [registration]);
  });
  expect(await facts(a)).toEqual({
    companyId: a.companyId,
    ...empty,
    registrationState: 'suspended',
    registrationSource: 'wa05_mock_onboarding',
    setupPaymentSource: 'capture',
  });
});

it('seeds two fixed evidence workspaces idempotently and never promotes exercise confirmation or restores an opt-out', async () => {
  try {
    vi.stubEnv('APP_ENV', 'staging');
    const [a, again, b] = await Promise.all([
      seedStagingGiftAudience(db, 'studio'),
      seedStagingGiftAudience(db, 'studio'),
      seedStagingGiftAudience(db, 'orchard'),
    ]);
    expect(again).toEqual(a);
    for (const [s, industry] of [
      [a, 'RETAIL'],
      [b, 'REAL_ESTATE'],
    ] as const) {
      const observed = await db.brand(s.workspaceId, s.brandId, (sql) =>
        giftWorkspaceOnboardingFacts(sql, s.workspaceId, s.brandId),
      );
      expect(observed).toMatchObject({
        registrationState: 'approved',
        industry,
        probationState: 'active',
        registrationSource: 'staging_fixture',
        probationSource: 'staging_fixture',
        setupPaymentSource: null,
        firstClearedPaymentAt: null,
      });
    }
    const list = (s: typeof a, mode?: 'exercise' | 'live') =>
      db.brand(s.workspaceId, s.brandId, (sql) =>
        eligibleGiftRecipients(sql, s.workspaceId, s.brandId, mode),
      );
    const first = await list(a, 'exercise');
    expect(first).toHaveLength(100);
    expect(await list(b, 'exercise')).toHaveLength(1);
    expect(await list(a)).toEqual([]);
    await db.brand(a.workspaceId, a.brandId, (sql) =>
      sql.query("UPDATE subscribers SET state='unsubscribed' WHERE id=$1", [first[0]!.id]),
    );
    await seedStagingGiftAudience(db, 'studio');
    expect(await list(a, 'exercise')).toEqual(first.slice(1));
    vi.stubEnv('APP_ENV', 'production');
    expect(await list(a, 'exercise')).toEqual([]);
    await expect(seedStagingGiftAudience(db, 'studio')).rejects.toThrow();
  } finally {
    vi.unstubAllEnvs();
  }
});
