import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { lockWorkspace } from '../src/server/workspace-lock.js';
import {
  clerkGiftOwners,
  configuredGiftNotificationEmail,
  giftLowThreshold,
  giftNotificationView,
  processGiftNotifications,
  recordGiftNotice,
  saveGiftNotificationPreferences,
  scheduledGiftValue,
  type GiftNoticeEvent,
  type GiftNotificationEmail,
} from '../src/server/workspace-gifts/notifications.js';
import { all, put, type GiftOffer, type Lot } from '../src/server/workspace-gifts/store.js';
import { workspaceGiftCommands } from '../src/shared/workspace-gifts.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database;
const capture = { mode: 'capture', environment: 'staging' } as const;
const now = new Date('2026-11-25T12:00:00.000Z'),
  at = now.toISOString(),
  day = 86400000;
const later = (days: number) => new Date(now.getTime() + days * day);
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});
beforeEach(() => {
  vi.stubEnv('APP_ENV', 'staging');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('Unexpected network request');
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const inbox = (w: string) => db.read(w, giftNotificationView);
const events = (w: string) => db.read(w, (sql) => all(sql, 'notice'));
async function emit(w: string, event: GiftNoticeEvent) {
  await db.tenant(w, async (sql) => {
    await lockWorkspace(sql, w);
    await recordGiftNotice(sql, w, event);
  });
}
async function prefs(w: string, lowCredit: boolean, campaignEnded: boolean, key = randomUUID()) {
  await db.tenant(w, (sql) =>
    saveGiftNotificationPreferences(sql, w, key, { lowCredit, campaignEnded }),
  );
}

it.each([
  [0, 2000],
  [1999, 2000],
  [2000, 2000],
  [2001, 2001],
  [10000, 10000],
])('uses the greater low-credit threshold for %i cents', (scheduled, threshold) => {
  expect(giftLowThreshold(scheduled)).toBe(threshold);
});
it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid scheduled cents %s', (value) => {
  expect(() => giftLowThreshold(value)).toThrow();
});

it('counts each open scheduled offer once in the next seven days and before expiry', () => {
  const offer = {
    id: randomUUID(),
    campaign: randomUUID(),
    person: randomUUID(),
    state: 'offered' as const,
    face: 2500,
    expires: later(3).toISOString(),
  };
  const other = { ...offer, id: randomUUID(), person: randomUUID(), expires: later(10).toISOString() };
  const row = (person: string, due: Date) => ({ campaign: offer.campaign, person, due });
  expect(
    scheduledGiftValue(
      [offer, other],
      [
        row(offer.person, now),
        row(offer.person, later(1)),
        row(other.person, later(7)),
        row(other.person, later(-1)),
      ],
      now,
    ),
  ).toBe(2500);
  expect(
    scheduledGiftValue(
      [offer, { ...other, state: 'pending' }],
      [row(offer.person, later(3)), row(other.person, now)],
      now,
    ),
  ).toBe(0);
});

it('persists owner choices, never suppresses required kinds and captures synthetic email only once', async () => {
  const w = randomUUID(),
    other = randomUUID(),
    key = randomUUID();
  await prefs(w, false, false, key);
  expect((await inbox(other)).preferences).toEqual({ lowCredit: true, campaignEnded: true });
  const required = ['disputeOpened', 'paymentFailed', 'paused', 'suspended', 'closed'] as const;
  for (const kind of required) await emit(w, { kind, at, reference: 'same-provider-fact' });
  await Promise.all([
    emit(w, { kind: 'disputeOpened', at, reference: 'same-provider-fact' }),
    processGiftNotifications(db, w, capture, now),
  ]);
  await emit(w, { kind: 'campaignEnded', at, reference: 'one-campaign', released: 345 });
  await emit(w, { kind: 'lowCredit', at, reference: '1', available: 0, threshold: 2000 });
  await Promise.all([
    processGiftNotifications(db, w, capture, now),
    processGiftNotifications(db, w, capture, now),
  ]);
  const view = await inbox(w);
  expect(view.notices).toHaveLength(5);
  expect(view.notices.every((n) => n.email === 'captured')).toBe(true);
  const records = await events(w);
  expect(records).toHaveLength(7);
  expect(records.filter((n) => n.muted).every((n) => !n.capture)).toBe(true);
  expect(
    records
      .filter((n) => !n.muted)
      .every((n) => n.capture?.to.endsWith('@example.invalid') && n.capture.text.includes(n.message)),
  ).toBe(true);
  expect(JSON.stringify(view)).not.toContain('@');
  expect((await inbox(other)).notices).toEqual([]);
  await prefs(w, true, true);
  await prefs(w, false, false, key);
  expect((await inbox(w)).preferences).toEqual({ lowCredit: true, campaignEnded: true });
  await expect(prefs(w, true, false, key)).rejects.toThrow(/original request/);
  const cmd = workspaceGiftCommands['gifts.notificationPreferences'];
  expect(cmd.scope).toBe('owner');
  expect(
    cmd.schema.safeParse({
      brandId: randomUUID(),
      operationKey: key,
      lowCredit: false,
      campaignEnded: false,
      disputeOpened: false,
    }).success,
  ).toBe(false);
});

it('uses the actual date schedule, rearms after recovery, and records returned credit only when the campaign settles', async () => {
  const w = randomUUID(),
    b = randomUUID(),
    c = randomUUID(),
    person = randomUUID(),
    dateId = randomUUID(),
    occurrence = randomUUID();
  const offer: GiftOffer = {
    id: randomUUID(),
    brand: b,
    campaign: c,
    person,
    face: 3000,
    expires: later(4).toISOString(),
    state: 'offered',
    alloc: [],
    secret: 'fixture',
  };
  const lot: Lot = {
    id: randomUUID(),
    brand: b,
    face: 6000,
    fee: 600,
    total: 6600,
    state: 'funded',
    created: at,
    account: 'fixture',
    spent: 0,
    reserved: 3000,
    disputed: 0,
    lost: 0,
    returned: 0,
    disputes: {},
  };
  await db.brand(w, b, async (sql) => {
    await sql.query('INSERT INTO workspaces(workspace_id,name) VALUES($1,$2)', [w, 'Test workspace']);
    await sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [w, b, 'Test brand']);
    await sql.query(
      "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'one@example.invalid','confirmed')",
      [w, b, person],
    );
    await sql.query(
      "INSERT INTO contact_dates(workspace_id,brand_id,id,subscriber_id,type,label,month,day) VALUES($1,$2,$3,$4,'birthday','Birthday',11,26)",
      [w, b, dateId, person],
    );
    await sql.query(
      "INSERT INTO date_automations(workspace_id,brand_id,kind,revision,enabled,mode,activated_at) VALUES($1,$2,'birthday',1,true,'capture',$3)",
      [w, b, now],
    );
    await sql.query(
      "INSERT INTO date_automation_revisions(workspace_id,brand_id,kind,revision,settings) VALUES($1,$2,'birthday',1,$3)",
      [w, b, { giftCampaignId: c }],
    );
    await sql.query(
      "INSERT INTO date_occurrences(workspace_id,brand_id,id,kind,revision,date_id,annual_year,local_date,due_at,expires_at,zone,state) VALUES($1,$2,$3,'birthday',1,$4,2026,'2026-11-26',$5,$6,'UTC','planned')",
      [w, b, occurrence, dateId, later(1), later(2)],
    );
    await put(sql, w, 'campaign', c, {
      id: c,
      brand: b,
      title: 'Thank you',
      face: 3000,
      days: 15,
      products: [],
      created: at,
      expires: offer.expires,
      hash: 'fixture',
      brokerConfirmed: false,
    });
    await put(sql, w, 'offer', offer.id, offer);
    await put(sql, w, 'lot', lot.id, lot);
  });
  await processGiftNotifications(db, w, capture, now);
  expect((await inbox(w)).notices).toHaveLength(0); // available == scheduled
  lot.spent = 1;
  await db.tenant(w, (sql) => put(sql, w, 'lot', lot.id, lot));
  await processGiftNotifications(db, w, capture, now);
  expect((await inbox(w)).notices[0]?.message).toContain('$30.00');
  await processGiftNotifications(db, w, capture, now);
  expect((await inbox(w)).notices).toHaveLength(1);
  lot.spent = 0;
  await db.tenant(w, (sql) => put(sql, w, 'lot', lot.id, lot));
  await processGiftNotifications(db, w, capture, now);
  lot.spent = 1;
  await db.tenant(w, (sql) => put(sql, w, 'lot', lot.id, lot));
  await processGiftNotifications(db, w, capture, now);
  expect((await inbox(w)).notices).toHaveLength(2);
  await db.tenant(w, (sql) => put(sql, w, 'offer', offer.id, { ...offer, state: 'pending' }));
  await processGiftNotifications(db, w, capture, later(5));
  expect((await events(w)).filter((n) => n.kind === 'campaignEnded')).toHaveLength(0);
  await db.tenant(w, (sql) => put(sql, w, 'offer', offer.id, { ...offer, state: 'expired' }));
  await processGiftNotifications(db, w, capture, later(5));
  await processGiftNotifications(db, w, capture, later(6));
  expect((await events(w)).filter((n) => n.kind === 'campaignEnded')).toMatchObject([
    { email: 'captured', message: expect.stringContaining('$30.00') },
  ]);
});

it('keeps staging notices isolated and rechecks live recipients, including concurrent and uncertain work', async () => {
  const w = randomUUID();
  await emit(w, { kind: 'paymentFailed', reference: 'staging', at });
  vi.stubEnv('APP_ENV', 'production');
  await emit(w, { kind: 'disputeOpened', reference: 'live', at });
  const directory = {
    owners: vi.fn(async () => ['current', 'removed', 'uncertain', 'unverified']),
    verifiedEmail: vi.fn(async (_w: string, user: string) => {
      if (user === 'unverified') throw Error('Verification pending');
      return user === 'removed' ? null : user + '@example.invalid';
    }),
  };
  const provider = {
    submit: vi.fn(async ({ to }: { to: string }) =>
      to === 'current@example.invalid'
        ? { state: 'accepted' as const, id: 'receipt' }
        : { state: 'unknown' as const },
    ),
    lookup: vi.fn(),
  };
  const transport: GiftNotificationEmail = {
    mode: 'live',
    environment: 'production',
    directory,
    provider,
    from: 'fixture@example.invalid',
  };
  await Promise.all([
    processGiftNotifications(db, w, transport, now),
    processGiftNotifications(db, w, transport, now),
  ]);
  await processGiftNotifications(db, w, transport, later(1));
  expect(provider.submit.mock.calls.map(([m]) => m.to).sort()).toEqual([
    'current@example.invalid',
    'uncertain@example.invalid',
  ]);
  const receipts = await events(w);
  expect(receipts.find((n) => n.kind === 'paymentFailed')?.email).toBe('queued');
  expect(receipts.find((n) => n.kind === 'disputeOpened')?.owners?.map((d) => d.state)).toEqual([
    'accepted',
    'skipped',
    'review',
    'queued',
  ]);
  expect(JSON.stringify(receipts)).not.toContain('@');
});

it('requires explicit production gates, verified primary email and current membership in the exact Clerk organization', async () => {
  const env = {
    APP_ENV: 'staging',
    FLOCKLETTER_WORKSPACE_GIFTS: 'live',
    FLOCKLETTER_GIFT_OWNER_EMAIL: 'live',
  };
  expect(configuredGiftNotificationEmail({ environment: 'staging' }, env).mode).toBe('capture');
  expect(configuredGiftNotificationEmail({ environment: 'production' }, env).mode).toBe('off');
  expect(
    configuredGiftNotificationEmail({ environment: 'production' }, { ...env, APP_ENV: 'production' })
      .mode,
  ).toBe('off');
  const row = {
    organization: { id: 'org_one' },
    role: 'org:admin',
    publicUserData: { userId: 'user_one', identifier: 'untrusted@example.invalid' },
  };
  const profile = {
    id: 'user_one',
    primaryEmailAddressId: 'email_one',
    banned: false,
    locked: false,
    emailAddresses: [
      {
        id: 'email_one',
        verification: { status: 'verified' },
        emailAddress: 'verified@example.invalid',
      },
    ],
  };
  const memberships = vi.fn(async () => ({ totalCount: 1, data: [row] }));
  const clerk = {
    organizations: { getOrganizationMembershipList: memberships },
    users: { getUser: vi.fn(async () => profile) },
  };
  const directory = clerkGiftOwners(clerk as unknown as Parameters<typeof clerkGiftOwners>[0]);
  expect(await directory.owners('org_one')).toEqual(['user_one']);
  expect(await directory.verifiedEmail('org_one', 'user_one')).toBe('verified@example.invalid');
  profile.emailAddresses[0]!.verification.status = 'unverified';
  await expect(directory.verifiedEmail('org_one', 'user_one')).rejects.toThrow();
  row.organization.id = 'org_two';
  await expect(directory.owners('org_one')).rejects.toThrow();
  await expect(directory.verifiedEmail('org_one', 'user_one')).rejects.toThrow();
  row.organization.id = 'org_one';
  row.role = 'org:member';
  expect(await directory.verifiedEmail('org_one', 'user_one')).toBeNull();
});
