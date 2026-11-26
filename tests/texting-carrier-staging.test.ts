import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { Texting } from '../src/server/texting/service.js';
import { operationKey, type RegistrationRow } from '../src/server/texting/registration.js';
import { bodyDigest, CredentialSeal, twilioSignature } from '../src/server/texting/twilio.js';
import { TwilioMockState } from '../src/server/texting/twilio-mock.js';

const origin = 'http://127.0.0.1:4310';
let db: Database, fixture: Awaited<ReturnType<typeof startDatabase>>, texting: Texting, clock: number;
const operator = { userId: 'operator', via: 'operator_api' } as const;
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  clock = Date.now() + 60_000;
  texting = Texting.mock(db, {
    origin,
    linkOrigin: origin,
    onboardingCapture: true,
    now: () => new Date(clock),
    isOwner: async () => true,
  });
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});

async function draft(workspace: string, sole = false, another = false) {
  const owner: Actor = {
    workspaceId: workspace,
    userId: workspace,
    actorId: 'user:' + workspace,
    kind: 'session',
    owner: true,
    scopes: ['read'],
    brandIds: null,
  };
  const service = new CommandService(db, undefined, async () => true);
  if (!another)
    await service.execute(
      'workspace.initialize',
      { operationKey: randomUUID(), name: 'Synthetic business', brandName: 'Practice brand' },
      owner,
    );
  return db.tenant(workspace, async (sql) => {
    const company = another
      ? randomUUID()
      : (await sql.query<{ id: string }>('SELECT id FROM companies')).rows[0]!.id;
    if (another)
      await sql.query("INSERT INTO companies(workspace_id,id,name) VALUES($1,$2,'Practice company ' || $3::text)", [
        workspace,
        company,
        company,
      ]);
    const brand = randomUUID(),
      id = randomUUID();
    const profile = {
      website: 'https://tree.example.test',
      privacyPolicyUrl: 'https://tree.example.test/privacy',
      smsTermsUrl: 'https://tree.example.test/terms',
      businessType: 'Limited Liability Corporation',
      vertical: 'RETAIL',
      ein: sole ? '' : '000000005',
      address: { street: '1 Example', city: 'New York', region: 'NY', postalCode: '10001', country: 'US' },
      contact: {
        firstName: 'Test',
        lastName: 'Owner',
        title: 'Owner',
        email: 'test@tree.example.test',
        phone: '+12125550155',
      },
      plan: sole ? 'text_300' : 'text_2500',
      onboarding: { revision: 1, challenges: {} },
    };
    await sql.query(
      `INSERT INTO sms_carrier_brands(workspace_id,id,company_id,legal_name,dba_name,entity_type,profile,help_contact,created_by,privacy_policy_confirmed_at,sms_terms_confirmed_at)
      VALUES($1,$2,$3,'Tree LLC','Tree Books',$4,$5,'help@tree.example.test','fixture',now(),now())`,
      [workspace, brand, company, sole ? 'sole_proprietor' : 'private_profit', JSON.stringify(profile)],
    );
    await sql.query(
      "INSERT INTO sms_registrations(workspace_id,id,carrier_brand_id,state) VALUES($1,$2,$3,'draft')",
      [workspace, id, brand],
    );
    return { id, brand, workspace };
  });
}
type Draft = Awaited<ReturnType<typeof draft>>;
const submit = (r: Draft) =>
  db.tenant(r.workspace, (sql) => texting.registration.submit(sql, r.workspace, r.id, 'owner', 'ui', true));
const row = (r: Draft) =>
  db.read(
    r.workspace,
    async (sql) =>
      (await sql.query<RegistrationRow>('SELECT * FROM sms_registrations WHERE id=$1', [r.id])).rows[0]!,
  );
async function decision(r: Draft, kind: 'brand' | 'campaign', status: 'APPROVED' | 'VERIFIED' | 'FAILED') {
  await texting.operator(
    'platform.textingMock',
    { workspaceId: r.workspace, operationKey: randomUUID(), action: { registrationId: r.id, kind, status } },
    operator,
  );
}

it('keeps a reserved number unavailable through attachment and activates only on signed matching evidence', async () => {
  const r = await draft('org_capture_event');
  await submit(r);
  await texting.registration.tick(r.workspace);
  await decision(r, 'brand', 'APPROVED');
  await texting.registration.tick(r.workspace);
  await decision(r, 'campaign', 'VERIFIED');
  await texting.registration.advance(r.workspace, r.id);
  const account = (await db.read(r.workspace, (sql) => texting.registration.account(sql, r.workspace)))!;
  const number = await db.read(
    r.workspace,
    async (sql) =>
      (
        await sql.query<{ state: string; provider_sid: string; messaging_service_sid: string }>(
          'SELECT * FROM sms_numbers',
        )
      ).rows[0]!,
  );
  expect(number.state).toBe('reserved');
  expect((await texting.mock!.state.pending(account.accountSid)).filter((c) => c.body)).toHaveLength(0);
  await texting.registration.advance(r.workspace, r.id);
  expect((await row(r)).state).toBe('campaign_pending');
  const callback = (await texting.mock!.state.pending(account.accountSid)).find((c) => c.body)!;
  const event = JSON.parse(callback.body!)[0];
  // Sign an independently constructed receipt for another service using the correct account token.
  const mismatched = Buffer.from(
    JSON.stringify([
      { ...event, id: 'CE-other-service', data: { ...event.data, messagingservicesid: 'MG' + '0'.repeat(32) } },
    ]),
  );
  const mismatchedUrl =
    origin +
    '/api/v1/texting/twilio/carrier-events?bodySHA256=' +
    createHash('sha256').update(mismatched).digest('hex');
  await texting.carrierEvents(mismatchedUrl, mismatched, twilioSignature(mismatchedUrl, {}, account.authToken));
  await expect(
    texting.carrierEvents(callback.url, Buffer.from(callback.body!), twilioSignature(callback.url, {}, 'wrong')),
  ).rejects.toMatchObject({ code: 'signature_rejected' });
  await texting.registration.advance(r.workspace, r.id);
  expect((await row(r)).state).toBe('campaign_pending');
  await texting.operator(
    'platform.textingSetSetting',
    {
      workspaceId: r.workspace,
      operationKey: randomUUID(),
      key: 'registration_review_minutes',
      expectedRevision: 0,
      value: 5,
      reason: 'Synthetic stalled carrier review.',
    },
    operator,
  );
  const progress = () => db.read(r.workspace, (sql) => texting.registration.progress(sql, r.workspace, r.id));
  expect(await progress()).toMatchObject({ stage: 'number_pending', stalled: false });
  clock += 6 * 60_000;
  expect(await progress()).toMatchObject({ stage: 'number_pending', stalled: true });
  // Fresh instance proves an attachment awaiting its callback survives a worker restart.
  const restarted = Texting.mock(db, {
    origin,
    linkOrigin: origin,
    onboardingCapture: true,
    isOwner: async () => true,
    now: () => new Date(clock),
  });
  await restarted.tick(r.workspace);
  expect((await row(r)).state).toBe('approved');
  await restarted.carrierEvents(
    callback.url,
    Buffer.from(callback.body!),
    twilioSignature(callback.url, {}, account.authToken),
  );
  const audit = await db.read(r.workspace, (sql) =>
    sql.query("SELECT 1 FROM sms_audit WHERE action='registration.number_status'"),
  );
  expect(audit.rowCount).toBe(1);
  expect(await texting.mock!.platform.creates(account.accountSid, 'number', operationKey(r.id, 1, 'number'))).toBe(
    1,
  );
  expect(await progress()).toMatchObject({ stage: 'approved', stalled: false });
});

it('resubmits a corrected failed campaign on the same approved brand, service and campaign', async () => {
  const r = await draft('org_capture_correction');
  await submit(r);
  await texting.registration.tick(r.workspace);
  await decision(r, 'brand', 'APPROVED');
  await texting.registration.tick(r.workspace);
  await decision(r, 'campaign', 'FAILED');
  const initial = await row(r);
  expect(initial.state).toBe('rejected');
  await db.tenant(r.workspace, (sql) =>
    sql.query(
      "UPDATE sms_carrier_brands SET profile=jsonb_set(profile,'{smsTermsUrl}',to_jsonb($2::text)) WHERE id=$1",
      [r.brand, 'https://tree.example.test/corrected'],
    ),
  );
  await submit(r);
  await texting.registration.tick(r.workspace);
  expect(await row(r)).toMatchObject({
    state: 'campaign_pending',
    revision: 2,
    brand_sid: initial.brand_sid,
    customer_profile_sid: initial.customer_profile_sid,
    messaging_service_sid: initial.messaging_service_sid,
    campaign_sid: initial.campaign_sid,
    campaign_status: 'IN_PROGRESS',
  });
  await decision(r, 'campaign', 'VERIFIED');
  await texting.registration.tick(r.workspace);
  await texting.tick(r.workspace);
  expect((await row(r)).state).toBe('approved');
  const account = (await db.read(r.workspace, (sql) => texting.registration.account(sql, r.workspace)))!;
  const creates = (kind: 'subaccount' | 'brand' | 'campaign' | 'number', revision: number) =>
    texting.mock!.platform.creates(account.accountSid, kind, operationKey(r.id, revision, kind));
  expect(await creates('subaccount', 2)).toBeNull();
  expect(await creates('brand', 2)).toBeNull();
  expect(await creates('campaign', 2)).toBeNull();
  expect(await creates('number', 2)).toBe(1);
  const tier = await db.read(r.workspace, (sql) =>
    sql.query("SELECT facts->>'tier' tier FROM sms_registration_steps WHERE step='brand' AND revision=2"),
  );
  expect(tier.rows[0]?.tier).toBe('standard');
});

it('requires the distinct captured carrier verification before a no-EIN sole proprietor can start', async () => {
  const r = await draft('org_capture_sole', true);
  await expect(submit(r)).rejects.toMatchObject({ code: 'carrier_verification_required' });
  expect((await row(r)).account_sid).toBeNull();
  await db.tenant(r.workspace, (sql) =>
    sql.query(
      `UPDATE sms_carrier_brands SET profile=jsonb_set(profile,'{onboarding,challenges,carrier}','{"verified":true}') WHERE id=$1`,
      [r.brand],
    ),
  );
  await submit(r);
  await texting.registration.tick(r.workspace);
  const state = await row(r);
  expect(state).toMatchObject({ state: 'brand_pending', brand_sid: expect.any(String) });
  const result = await db.read(r.workspace, (sql) =>
    sql.query("SELECT facts->>'tier' tier FROM sms_registration_steps WHERE step='brand'"),
  );
  expect(result.rows[0]?.tier).toBe('sole_proprietor');
});

it('recovers a committed subaccount once, seals its credentials, and isolates two concurrent workspaces and companies', async () => {
  const a = await draft('org_capture_lookup_a'),
    b = await draft('org_capture_lookup_b');
  const sibling = await draft(a.workspace, false, true);
  await Promise.all([submit(a), submit(b), submit(sibling)]);
  await texting.operator(
    'platform.textingMock',
    {
      workspaceId: a.workspace,
      operationKey: randomUUID(),
      action: { kind: 'fault', target: 'subaccount', faults: ['timeout_after_commit'] },
    },
    operator,
  );
  const create = vi.spyOn(texting.mock!.platform, 'createSubaccount');
  try {
    // B must not consume A's scheduled fault. The parallel sibling should wait for A's uncertain account.
    await texting.registration.advance(b.workspace, b.id);
    await texting.registration.advance(a.workspace, a.id);
    await Promise.all([
      texting.registration.advance(sibling.workspace, sibling.id),
      texting.registration.advance(a.workspace, a.id),
    ]);
    const accountB = await db.read(b.workspace, (sql) => texting.registration.account(sql, b.workspace));
    expect(accountB).not.toBeNull();
    expect(await db.read(a.workspace, (sql) => texting.registration.account(sql, a.workspace))).toBeNull();
    expect(create.mock.calls).toHaveLength(2);
    const restarted = Texting.mock(db, {
      origin,
      linkOrigin: origin,
      onboardingCapture: true,
      isOwner: async () => true,
      now: () => new Date(clock),
    });
    const restartedCreate = vi.spyOn(restarted.mock!.platform, 'createSubaccount');
    clock += 61_000;
    await restarted.registration.advance(a.workspace, a.id);
    await restarted.registration.advance(sibling.workspace, sibling.id);
    const bound = await db.read(a.workspace, async (sql) => ({
      account: await restarted.registration.account(sql, a.workspace),
      sealed: (
        await sql.query<{ credentials: string }>(
          'SELECT credentials FROM flockletter_customer_jobs.texting_account($1)',
          [a.workspace],
        )
      ).rows[0]!.credentials,
      publicFacts: (await sql.query('SELECT facts FROM sms_registration_steps')).rows,
    }));
    expect(bound.account!.accountSid).toMatch(/^AC[0-9a-f]{32}$/);
    expect(bound.account!.accountSid).not.toBe(accountB!.accountSid);
    expect((await row(sibling)).account_sid).toBe(bound.account!.accountSid);
    expect(JSON.stringify(bound.publicFacts)).not.toContain(bound.account!.keySecret);
    expect(JSON.stringify(bound.publicFacts)).not.toContain(bound.account!.authToken);
    expect(bound.sealed).not.toContain(bound.account!.keySecret);
    expect(() => CredentialSeal.mock().open(bound.sealed, b.workspace)).toThrow();
    expect(restartedCreate).not.toHaveBeenCalled();
    expect(await restarted.mock!.platform.creates('', 'subaccount', operationKey(a.id, 1, 'subaccount'))).toBe(1);
  } finally {
    create.mockRestore();
  }
});

it('keeps ambiguous subaccount lookup and a lost one-time credential in review without another create', async () => {
  const r = await draft('org_capture_unresolved');
  await submit(r);
  await texting.operator(
    'platform.textingMock',
    {
      workspaceId: r.workspace,
      operationKey: randomUUID(),
      action: { kind: 'fault', target: 'subaccount', faults: ['timeout_after_commit'] },
    },
    operator,
  );
  await texting.registration.advance(r.workspace, r.id);
  const name = 'flockletter-' + bodyDigest(r.workspace).slice(0, 48);
  const lookupKey = 'accounts-by-name/' + name;
  const mock = texting.mock!;
  const list = (await mock.state.get<{
    accounts: { sid: string; owner_account_sid: string; friendly_name: string; status: string }[];
    next_page_uri: null;
  }>(lookupKey))!;
  expect(list.accounts[0]).toMatchObject({ friendly_name: name, status: 'active' });
  const original = list.accounts[0]!;
  const receiptKey = 'key-receipt/' + original.sid;
  await mock.state.put(lookupKey, { ...list, accounts: [original, { ...original, sid: 'AC' + 'f'.repeat(32) }] });
  clock += 60_000;
  await texting.registration.advance(r.workspace, r.id);
  const progress = () => db.read(r.workspace, (sql) => texting.registration.progress(sql, r.workspace, r.id));
  const review = () => texting.operator('platform.textingRegistration', { workspaceId: r.workspace }, operator);
  expect(await progress()).toMatchObject({ stage: 'carrier_recovery', stalled: true });
  expect(await review()).toMatchObject({ reviewQueue: [{ reason: 'subaccount_lookup_review' }] });
  expect((await row(r)).account_sid).toBeNull();
  await mock.state.put(lookupKey, list);
  const credential = await mock.state.get<string>(receiptKey);
  await mock.state.put(receiptKey, null);
  for (let pass = 0; pass < 2; pass++) {
    clock += 60_000;
    await texting.registration.advance(r.workspace, r.id);
  }
  expect(await review()).toMatchObject({ reviewQueue: [{ reason: 'subaccount_credentials_review' }] });
  expect((await row(r)).account_sid).toBeNull();
  expect(await mock.platform.creates('', 'subaccount', operationKey(r.id, 1, 'subaccount'))).toBe(1);
  await mock.state.put(receiptKey, credential);
  clock += 60_000;
  await texting.registration.advance(r.workspace, r.id);
  expect((await row(r)).account_sid).toBe(original.sid);
});

it('recovers a legacy pending callback beyond the first thousand acknowledged entries', async () => {
  const mock = new TwilioMockState(db);
  const accountSid = 'AC' + 'e'.repeat(32);
  await db.pool.query(`SELECT flockletter_customer_jobs.texting_mock_put(
    'callback/' || lpad(n::text,15,'0') || '/CB' || repeat('0',32), 'null'::jsonb) FROM generate_series(1,1001) n`);
  const id = 'CB' + 'd'.repeat(32);
  await mock.put('callback/000000000001002/' + id, { id, accountSid, params: {}, url: origin });
  const recovered = await mock.pending(accountSid);
  expect(recovered.map((c) => c.id)).toEqual([id]);
  await mock.done(recovered[0]!);
  expect(await new TwilioMockState(db).pending(accountSid)).toEqual([]);
});

const minute = 60_000;
async function watchdog(r: Draft) {
  for (const [key, value] of [
    ['registration_poll_minutes', 5],
    ['registration_review_minutes', 10],
  ] as const)
    await texting.operator(
      'platform.textingSetSetting',
      {
        workspaceId: r.workspace,
        operationKey: randomUUID(),
        key,
        value,
        expectedRevision: 0,
        reason: 'Local test of registration recovery.',
      },
      operator,
    );
}
const queue = async (r: Draft) => {
  const result = (await texting.operator(
    'platform.textingRegistration',
    { workspaceId: r.workspace },
    operator,
  )) as { reviewQueue: { id: string; reason: string; since: Date }[] };
  return result.reviewQueue;
};
const progress = (r: Draft) =>
  db.read(r.workspace, (sql) => texting.registration.progress(sql, r.workspace, r.id));

it('preserves review age across unchanged polls and resumes immediately when an approval callback was lost', async () => {
  const r = await draft('org_watchdog_age');
  await watchdog(r);
  await submit(r);
  const first = clock;
  expect(await texting.registration.tick(r.workspace)).toEqual(new Date(first + 5 * minute));
  const baseline = { stage: 'brand_pending', since: new Date(first).toISOString() };
  const account = (await db.read(r.workspace, (sql) => texting.registration.account(sql, r.workspace)))!;
  const reg = await row(r);
  const url = texting.registration.callbacks(r.workspace).registration;
  const pending = {
    AccountSid: account.accountSid,
    ResourceType: 'brand',
    ResourceSid: reg.brand_sid!,
    Status: 'PENDING',
  };
  expect(await progress(r)).toEqual({ ...baseline, stalled: false });
  clock += 5 * minute;
  await texting.webhook('registration', url, pending, twilioSignature(url, pending, account.authToken));
  await texting.webhook('registration', url, pending, twilioSignature(url, pending, account.authToken));
  await texting.registration.tick(r.workspace);
  expect(await progress(r)).toEqual({ ...baseline, stalled: false });
  clock += 5 * minute;
  await texting.registration.tick(r.workspace);
  expect(await progress(r)).toEqual({ ...baseline, stalled: true });
  expect(await queue(r)).toEqual([
    expect.objectContaining({ id: r.id, reason: 'registration_stalled', since: new Date(first) }),
  ]);

  await texting.mock!.platform.decide(
    'brand',
    account,
    reg.brand_sid!,
    'APPROVED',
    texting.registration.callbacks(r.workspace).registration,
  );
  for (const pending of await texting.mock!.state.pending(account.accountSid))
    await texting.mock!.state.done(pending);
  clock += 5 * minute;
  expect(await texting.registration.tick(r.workspace)).toEqual(new Date(clock));
  expect((await row(r)).brand_status).toBe('APPROVED');
  await texting.registration.tick(r.workspace);
  expect(await progress(r)).toEqual({
    stage: 'campaign_pending',
    since: new Date(clock).toISOString(),
    stalled: false,
  });
  expect(await queue(r)).toEqual([]);
  expect(await texting.mock!.platform.creates(account.accountSid, 'brand', operationKey(r.id, 1, 'brand'))).toBe(
    1,
  );
  const campaign = (await row(r)).campaign_sid!;
  await texting.mock!.platform.decide('campaign', account, campaign, 'VERIFIED', url);
  for (const callback of await texting.mock!.state.pending(account.accountSid))
    await texting.mock!.state.done(callback);
  clock += 5 * minute;
  expect(await texting.registration.tick(r.workspace)).toEqual(new Date(clock));
  expect(await progress(r)).toMatchObject({ stage: 'number_pending', stalled: false });
  await texting.registration.tick(r.workspace);
  expect(
    await texting.mock!.platform.creates(account.accountSid, 'campaign', operationKey(r.id, 1, 'campaign')),
  ).toBe(1);
  expect(await texting.mock!.platform.creates(account.accountSid, 'number', operationKey(r.id, 1, 'number'))).toBe(
    1,
  );
});

it('recovers a lost number callback after restart from the matching signed decision and rejects mismatched evidence', async () => {
  const r = await draft('org_watchdog_number');
  await watchdog(r);
  await submit(r);
  await texting.registration.tick(r.workspace);
  await decision(r, 'brand', 'APPROVED');
  await texting.registration.tick(r.workspace);
  await decision(r, 'campaign', 'VERIFIED');
  clock += minute;
  await texting.registration.advance(r.workspace, r.id); // reserve
  expect(await progress(r)).toMatchObject({ stage: 'number_pending', since: new Date(clock).toISOString() });
  clock += minute;
  await texting.registration.advance(r.workspace, r.id); // attach
  const attached = clock;
  expect(await progress(r)).toMatchObject({ stage: 'number_pending', since: new Date(attached).toISOString() });
  const account = (await db.read(r.workspace, (sql) => texting.registration.account(sql, r.workspace)))!;
  const callback = (await texting.mock!.state.pending(account.accountSid)).find((c) => !!c.body)!;
  await texting.mock!.state.done(callback); // transport lost the one delivery
  const restarted = Texting.mock(db, {
    origin,
    linkOrigin: origin,
    onboardingCapture: true,
    isOwner: async () => true,
    now: () => new Date(clock),
  });
  const event = JSON.parse(callback.body!)[0];
  const wrong = JSON.stringify([
    { ...event, id: 'CE-mismatched-test', data: { ...event.data, phonenumbersid: 'PN' + '0'.repeat(32) } },
  ]);
  const url = origin + '/api/v1/texting/twilio/carrier-events?bodySHA256=' + bodyDigest(wrong);
  const lookup = vi.spyOn(restarted.mock!.platform, 'capturedNumberReceipt');
  lookup.mockResolvedValueOnce({ url, body: wrong, signature: twilioSignature(url, {}, account.authToken) });
  lookup.mockResolvedValueOnce({ url: callback.url, body: callback.body!, signature: 'invalid' });
  const readNumber = async () =>
    (await db.read(r.workspace, (sql) => sql.query('SELECT state FROM sms_numbers'))).rows[0]!.state;
  clock = attached + 5 * minute;
  await restarted.tick(r.workspace);
  expect(await readNumber()).toBe('reserved');
  clock += 5 * minute;
  await restarted.tick(r.workspace);
  expect(await readNumber()).toBe('reserved');
  expect(await queue(r)).toEqual([
    expect.objectContaining({ reason: 'registration_stalled', since: new Date(attached) }),
  ]);
  clock += 5 * minute;
  expect(await restarted.tick(r.workspace)).toEqual(new Date(clock));
  expect(await readNumber()).toBe('active');
  await restarted.tick(r.workspace);
  expect((await row(r)).state).toBe('approved');
  expect(await queue(r)).toEqual([]);
  expect(await texting.mock!.platform.creates(account.accountSid, 'number', operationKey(r.id, 1, 'number'))).toBe(
    1,
  );
  expect(
    (
      await db.read(r.workspace, (sql) =>
        sql.query("SELECT 1 FROM sms_audit WHERE action='registration.number_status'"),
      )
    ).rowCount,
  ).toBe(1);
});

it('preserves a missed mock rejection during automatic approval until polling recovers it', async () => {
  const r = await draft('org_watchdog_rejection');
  await watchdog(r);
  await submit(r);
  await texting.registration.tick(r.workspace);
  const account = (await db.read(r.workspace, (sql) => texting.registration.account(sql, r.workspace)))!;
  const sid = (await row(r)).brand_sid!;
  await texting.mock!.platform.decide(
    'brand',
    account,
    sid,
    'FAILED',
    texting.registration.callbacks(r.workspace).registration,
    { errorCode: '30799' },
  );
  for (const cb of await texting.mock!.state.pending(account.accountSid)) await texting.mock!.state.done(cb);
  await db.tenant(r.workspace, (sql) =>
    sql.query(
      "UPDATE sms_carrier_brands SET profile=jsonb_set(profile,'{onboarding,submittedAt}',to_jsonb($2::text)) WHERE id=$1",
      [r.brand, new Date(clock).toISOString()],
    ),
  );
  clock += minute;
  expect(await texting.tick(r.workspace)).toEqual(new Date(clock + 4 * minute));
  expect((await row(r)).brand_status).toBe('PENDING');
  expect(await texting.mock!.platform.status('brand', account, sid)).toMatchObject({
    value: { status: 'FAILED' },
  });
  clock += 4 * minute;
  await texting.tick(r.workspace);
  expect(await row(r)).toMatchObject({
    state: 'rejected',
    brand_status: 'FAILED',
    rejection_reason: 'brand: 30799',
    campaign_sid: null,
  });
  expect(await texting.mock!.state.pending(account.accountSid)).toEqual([]);
});

it('leaves stored self-service applications alone when capture is disabled', async () => {
  const r = await draft('org_watchdog_capture_disabled');
  await watchdog(r);
  await submit(r);
  await texting.registration.tick(r.workspace);
  const off = Texting.mock(db, {
    origin,
    linkOrigin: origin,
    isOwner: async () => true,
    now: () => new Date(clock),
  });
  const lookup = vi.spyOn(off.mock!.platform, 'status');
  clock += 6 * minute;
  await off.registration.tick(r.workspace);
  expect(lookup).not.toHaveBeenCalled();
  expect(await row(r)).toMatchObject({ state: 'brand_pending', campaign_sid: null });
});

it('runs one chosen draft scenario per company and records the source of each number activation', async () => {
  const lost = await draft('org_armed_scenarios');
  const rejected = await draft(lost.workspace, false, true);
  const unaffected = await draft(lost.workspace, false, true);
  const foreign = await draft('org_foreign_scenario');
  const arm = (r: Draft, scenario: 'lose_number_notice' | 'reject_campaign_terms', scope = r.workspace) =>
    texting.operator(
      'platform.textingMock',
      {
        workspaceId: scope,
        operationKey: randomUUID(),
        action: {
          kind: 'registration_scenario',
          registrationId: r.id,
          scenario,
          reason: 'Exercise this synthetic registration path.',
        },
      },
      operator,
    );
  await expect(arm(lost, 'lose_number_notice')).rejects.toMatchObject({ code: 'registration_poll_required' });
  await watchdog(lost);
  await expect(arm(foreign, 'reject_campaign_terms', lost.workspace)).rejects.toMatchObject({
    code: 'registration_unavailable',
  });
  await Promise.all([arm(lost, 'lose_number_notice'), arm(lost, 'lose_number_notice')]);
  await expect(arm(lost, 'reject_campaign_terms')).rejects.toMatchObject({ code: 'scenario_already_chosen' });
  await arm(rejected, 'reject_campaign_terms');
  for (const r of [lost, rejected, unaffected]) {
    await submit(r);
    await db.tenant(r.workspace, (sql) =>
      sql.query(
        "UPDATE sms_carrier_brands SET profile=jsonb_set(profile,'{onboarding,submittedAt}',to_jsonb($2::text)) WHERE id=$1",
        [r.brand, new Date(clock).toISOString()],
      ),
    );
  }
  await expect(arm(unaffected, 'lose_number_notice')).rejects.toMatchObject({ code: 'scenario_requires_draft' });
  const ticks = async (n: number) => {
    for (let i = 0; i < n; i++) {
      clock += 6000;
      await texting.tick(lost.workspace);
    }
  };
  await ticks(6);
  const report = async () => {
    const data = (await texting.operator(
      'platform.textingRegistration',
      { workspaceId: lost.workspace },
      operator,
    )) as {
      registrations: {
        id: string;
        state: string;
        mockScenario: string | null;
        numberActivationSource: string | null;
      }[];
    };
    return data.registrations;
  };
  expect(await report()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: lost.id,
        state: 'campaign_pending',
        mockScenario: 'lose_number_notice',
        numberActivationSource: null,
      }),
      expect.objectContaining({
        id: rejected.id,
        state: 'rejected',
        mockScenario: 'reject_campaign_terms',
        rejection_reason: 'campaign: 30934',
      }),
      expect.objectContaining({
        id: unaffected.id,
        state: 'approved',
        mockScenario: null,
        numberActivationSource: 'callback',
      }),
    ]),
  );
  const reg = await row(rejected);
  expect(
    (
      await db.read(rejected.workspace, (sql) =>
        sql.query(
          `SELECT 1 FROM sms_audit WHERE target=$1 AND interface='webhook'
    AND action='registration.campaign_status' AND new_value->>'status'='FAILED'`,
          [rejected.id],
        ),
      )
    ).rowCount,
  ).toBe(1);
  await submit(rejected); // The corrected campaign gets an ordinary review.
  clock += 5 * minute;
  await ticks(5);
  expect(await report()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: lost.id, state: 'approved', numberActivationSource: 'lookup' }),
      expect.objectContaining({ id: rejected.id, state: 'approved', numberActivationSource: 'callback' }),
    ]),
  );
  expect((await row(rejected)).campaign_sid).toBe(reg.campaign_sid);
  expect(
    (
      await db.read(lost.workspace, (sql) =>
        sql.query(
          `SELECT action,interface FROM sms_audit WHERE target=$1 AND
    action IN ('mock.registration_scenario','mock.number_notice_omitted','registration.number_status') ORDER BY at,id`,
          [lost.id],
        ),
      )
    ).rows,
  ).toEqual([
    { action: 'mock.registration_scenario', interface: 'operator_api' },
    { action: 'mock.number_notice_omitted', interface: 'worker' },
    { action: 'registration.number_status', interface: 'worker' },
  ]);
  const number = await row(lost);
  expect(
    await texting.mock!.platform.creates(number.account_sid!, 'number', operationKey(lost.id, 1, 'number')),
  ).toBe(1);
});
