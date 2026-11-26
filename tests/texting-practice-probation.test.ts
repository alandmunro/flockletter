import {readProbationPolicy} from '../src/server/texting/probation-policy.js';
import {probationHold,assignCanary} from '../src/server/texting/probation.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { Texting } from '../src/server/texting/service.js';

const day = 86_400_000;
const start = Date.UTC(2035, 3, 12, 12);
const operator = { userId: 'synthetic-reviewer', via: 'operator_api' } as const;
// Deliberately small fixture values exercise exact boundaries independently of deployment settings.
const settings = {
  probation_canary_count: 1,
  probation_canary_minutes: 1,
  probation_min_days: 2,
  probation_delivered_min: 3,
  probation_initial_days: 1,
  probation_initial_daily_limit: 20,
  probation_daily_limit: 20,
  probation_pause_filter_bps: 4500,
  probation_pause_optout_bps: 4500,
  probation_risk_window_days: 1,
  probation_risk_minimum: 4,
  probation_suspend_filter_bps: 5000,
  probation_suspend_optout_bps: 5000,
};
let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database, texting: Texting, clock: number;
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  const origin = 'http://127.0.0.1:4310';
  texting = Texting.mock(db, {
    origin,
    linkOrigin: origin,
    now: () => new Date(clock),
    onboardingCapture: true,
    isOwner: async (userId, workspaceId) => userId === 'owner_' + workspaceId,
  });
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});

async function active(workspace: string, overrides: Record<string,number> = settings) {
  clock = start + 3_600_000;
  const owner: Actor = {
    kind: 'session',
    owner: true,
    workspaceId: workspace,
    userId: 'owner_' + workspace,
    actorId: 'user:owner_' + workspace,
    scopes: ['read'],
    brandIds: null,
  };
  const commands = new CommandService(db, undefined, async () => true);
  await commands.execute(
    'workspace.initialize',
    { operationKey: randomUUID(), name: 'Practice workspace', brandName: 'Practice' },
    owner,
  );
  for (const [key, value] of Object.entries(overrides))
    await texting.operator(
      'platform.textingSetSetting',
      {
        workspaceId: workspace,
        operationKey: randomUUID(),
        key,
        value,
        expectedRevision: 0,
        reason: 'Local synthetic test settings.',
      },
      operator,
    );
  const company = await db.read(
    workspace,
    async (sql) => (await sql.query<{ id: string }>('SELECT id FROM companies')).rows[0]!.id,
  );
  const brand = randomUUID(),
    send = randomUUID();
  await db.tenant(workspace, async (sql) => {
    const profile = {
      onboarding: {
        owner: owner.userId,
        revision: 1,
        challenges: {},
        probation: { state: 'active', startsAt: new Date(start).toISOString(), sendId: send },
      },
    };
    await sql.query(
      `INSERT INTO sms_carrier_brands(workspace_id,id,company_id,legal_name,entity_type,profile,help_contact,created_by)
      VALUES($1,$2,$3,'Practice','private_profit',$4,'help@example.test','fixture')`,
      [workspace, brand, company, JSON.stringify(profile)],
    );
    await sql.query(
      `INSERT INTO sms_registrations(workspace_id,id,carrier_brand_id,state) VALUES($1,$2,$3,'approved')`,
      [workspace, randomUUID(), brand],
    );
    await sql.query(
      `INSERT INTO sms_sends(workspace_id,id,company_id,kind,body,state,created_by)
      VALUES($1,$2,$3,'broadcast','Synthetic message','completed','fixture')`,
      [workspace, send, company],
    );
  });
  return { workspace, owner, brand, company, send };
}

type Practice = Awaited<ReturnType<typeof active>>;
// Persist terminal delivery facts from one synthetic broadcast. No worker or carrier action creates these rows.
async function receipt(p: Practice, index: number, filtered = false) {
  const contact = randomUUID(),
    phone = '+1' + String(212 + Math.floor(index/100)) + '55501' + String(index%100).padStart(2,'0');
  await db.tenant(p.workspace, async (sql) => {
    await sql.query('INSERT INTO sms_contacts(workspace_id,id,phone_e164) VALUES($1,$2,$3)', [
      p.workspace,
      contact,
      phone,
    ]);
    await sql.query(
      `INSERT INTO sms_messages(workspace_id,id,send_id,company_id,contact_id,purpose,to_e164,
      rendered_body,body_digest,encoding,segments,state,reason,attempts,submitted_at)
      VALUES($1,$2,$3,$4,$5,'broadcast',$6,'Synthetic message','fixture','gsm7',1,$7,$8,1,$9)`,
      [
        p.workspace,
        randomUUID(),
        p.send,
        p.company,
        contact,
        phone,
        filtered ? 'undelivered' : 'delivered',
        filtered ? 'twilio_30007' : null,
        new Date(start + 1000),
      ],
    );
  });
  return contact;
}

const state = (p: Practice) =>
  db.read(
    p.workspace,
    async (sql) =>
      (
        await sql.query<{ state: string }>(
          "SELECT profile#>>'{onboarding,probation,state}' state FROM sms_carrier_brands WHERE id=$1",
          [p.brand],
        )
      ).rows[0]!.state,
  );
const actions = (p: Practice, action: string) =>
  db.read(p.workspace, async (sql) =>
    (await sql.query('SELECT new_value FROM sms_audit WHERE target=$1 AND action=$2', [p.brand, action])).rows.map(
      (row) => row.new_value,
    ),
  );

it.each(['filtered', 'optout'] as const)(
  'suspends at the %s rate only after enough traffic, and requires operator review',
  async (kind) => {
    const p = await active('org_practice_risk_' + kind);
    const number = randomUUID();
    if (kind === 'optout')
      await db.tenant(p.workspace, (sql) =>
        sql.query(
          `INSERT INTO sms_numbers(workspace_id,id,carrier_brand_id,
    e164,provider_sid,messaging_service_sid,state) VALUES($1,$2,$3,'+13125550199','PNfixture','MGfixture','active')`,
          [p.workspace, number, p.brand],
        ),
      );
    async function outcome(index: number, adverse: boolean) {
      const contact = await receipt(p, index, adverse && kind === 'filtered');
      if (!adverse || kind !== 'optout') return;
      // Duplicate STOPs from one synthetic recipient must count once.
      await db.tenant(p.workspace, (sql) =>
        sql.query(
          `INSERT INTO sms_inbound(workspace_id,id,number_id,from_e164,contact_id,body,provider_sid,classification,received_at)
      SELECT $1,gen_random_uuid(),$2,phone_e164,$3,'STOP',gen_random_uuid()::text,'stop',$4 FROM sms_contacts CROSS JOIN generate_series(1,2)
      WHERE sms_contacts.id=$3`,
          [p.workspace, number, contact, new Date(start + 2000)],
        ),
      );
    }
    await outcome(1, true);
    await outcome(2, false);
    await texting.tick(p.workspace);
    expect(await state(p)).toBe('active'); // high rate below minimum sample size
    await outcome(3, false);
    await outcome(4, false);
    await texting.tick(p.workspace);
    expect(await state(p)).toBe('active'); // adequate sample size below the rate threshold
    await outcome(5, true);
    await outcome(6, true);
    await texting.tick(p.workspace);
    await texting.tick(p.workspace);
    expect(await state(p)).toBe('suspended');
    expect(await actions(p, 'probation.risk_suspended')).toEqual([{ reason: 'delivery_or_optout_rate' }]);
    const params = { companyId: p.company, expectedRevision: 1, reason: 'Reviewed synthetic delivery outcomes.' };
    await expect(
      texting.execute('sms.onboardingResume', { ...params, operationKey: randomUUID() }, p.owner, 'ui'),
    ).rejects.toMatchObject({ code: 'probation_state_changed' });
    expect(await state(p)).toBe('suspended');
    await expect(
      texting.operator(
        'platform.textingOnboardingReview',
        { ...params, operationKey: randomUUID(), workspaceId: p.workspace, action: 'complete_probation' },
        operator,
      ),
    ).rejects.toMatchObject({ code: 'registration_not_approved' });
    const lift = { ...params, workspaceId: p.workspace, operationKey: randomUUID(), action: 'lift_suspension' };
    expect(await texting.operator('platform.textingOnboardingReview', lift, operator)).toEqual({ resumed: true });
    expect(await texting.operator('platform.textingOnboardingReview', lift, operator)).toEqual({ resumed: true });
    await texting.tick(p.workspace);
    expect(await state(p)).toBe('awaiting_canary');
    expect(await actions(p, 'onboarding.probation_restarted')).toEqual([{ reason: params.reason }]);
  },
);

it('wakes at minimum age and graduates only the workspace with enough delivered texts, without another send', async () => {
  const ready = await active('org_practice_ready'),
    short = await active('org_practice_short');
  for (const p of [ready, short]) {
    await receipt(p, 1);
    await receipt(p, 2);
  }
  await receipt(ready, 3);
  await receipt(short, 3, true); // An attempted but undelivered text does not satisfy delivered volume.
  const end = start + settings.probation_min_days * day;
  clock = end - 1;
  const deliver = vi.spyOn(texting.mock!.messaging, 'send');
  try {
    expect(await texting.tick(ready.workspace)).toEqual(new Date(end));
    expect(await state(ready)).toBe('active');
    clock = end;
    await texting.tick(short.workspace);
    expect(await state(short)).toBe('active');
    await texting.tick(ready.workspace);
    await texting.tick(ready.workspace);
    expect(await state(ready)).toBe('complete');
    expect(await actions(ready, 'probation.completed')).toEqual([{ delivered: 3 }]);
    expect(await actions(short, 'probation.completed')).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
    expect(
      await db.read(
        ready.workspace,
        async (sql) =>
          (
            await sql.query(`SELECT count(DISTINCT send_id)::int sends,
      count(*)::int texts,sum(attempts)::int attempts FROM sms_messages`)
          ).rows,
      ),
    ).toEqual([{ sends: 1, texts: 3, attempts: 3 }]);
  } finally {
    deliver.mockRestore();
  }
});

it('enforces a whole private deployment profile at its exact filter, volume and cohort boundaries', async () => {
  const policy = readProbationPolicy(
    process.env.FLOCKLETTER_TEXTING_PROBATION_POLICY ??
      JSON.stringify({
        ...settings,
        probation_pause_filter_bps: 1000,
        probation_suspend_filter_bps: 7500,
        probation_pause_optout_bps: 1000,
        probation_suspend_optout_bps: 7500,
      }),
  )!;
  expect(() =>
    readProbationPolicy(
      JSON.stringify({ ...policy, probation_pause_optout_bps: policy.probation_suspend_optout_bps }),
    ),
  ).toThrow();
  const configured = Texting.mock(db, { ...texting.options, probationPolicy: policy });
  const p = await active('org_deployment_policy', {});
  const definitions = (await configured.operator(
    'platform.textingSettings',
    { workspaceId: p.workspace },
    operator,
  )) as { key: string; privateDefault: boolean; platform: unknown }[];
  expect(definitions.filter((d) => d.privateDefault)).toHaveLength(Object.keys(policy).length);
  expect(definitions.filter((d) => d.privateDefault).every((d) => d.platform === null)).toBe(true);
  const total = policy.probation_risk_minimum;
  const pause = Math.ceil((total * policy.probation_pause_filter_bps) / 10000);
  const suspend = Math.ceil((total * policy.probation_suspend_filter_bps) / 10000);
  for (let n = 1; n < total; n++) await receipt(p, n, n <= pause);
  await configured.tick(p.workspace);
  expect(await state(p)).toBe('active');
  await receipt(p, total);
  await configured.tick(p.workspace);
  expect(await state(p)).toBe('paused');
  if (suspend > pause) {
    await db.tenant(p.workspace, (sql) =>
      sql.query(
        `UPDATE sms_messages SET state='undelivered',reason='twilio_30007' WHERE id IN
      (SELECT id FROM sms_messages WHERE state='delivered' LIMIT $1)`,
        [suspend - pause],
      ),
    );
    await configured.tick(p.workspace);
    expect(await state(p)).toBe('suspended');
  }
  const opt = await active('org_private_optout', {});
  const number = randomUUID(),
    contacts: string[] = [];
  await db.tenant(opt.workspace, (sql) =>
    sql.query(
      `INSERT INTO sms_numbers(workspace_id,id,carrier_brand_id,e164,provider_sid,messaging_service_sid,state)
    VALUES($1,$2,$3,'+13125550198','PNfixture','MGfixture','active')`,
      [opt.workspace, number, opt.brand],
    ),
  );
  for (let n = 0; n < total - 1; n++) contacts.push(await receipt(opt, n));
  const stop = async (i: number) =>
    db.tenant(opt.workspace, (sql) =>
      sql.query(
        `INSERT INTO sms_inbound(workspace_id,id,number_id,from_e164,contact_id,body,provider_sid,classification,received_at)
    SELECT $1,gen_random_uuid(),$2,phone_e164,id,'STOP',gen_random_uuid()::text,'stop',$4 FROM sms_contacts WHERE id=$3`,
        [opt.workspace, number, contacts[i], new Date(start + 2000)],
      ),
    );
  const stopPause = Math.ceil((total * policy.probation_pause_optout_bps) / 10000);
  const stopSuspend = Math.ceil((total * policy.probation_suspend_optout_bps) / 10000);
  for (let i = 0; i < stopPause; i++) await stop(i);
  await configured.tick(opt.workspace);
  expect(await state(opt)).toBe('active');
  contacts.push(await receipt(opt, total));
  await configured.tick(opt.workspace);
  expect(await state(opt)).toBe('paused');
  for (let i = stopPause; i < stopSuspend; i++) await stop(i);
  await configured.tick(opt.workspace);
  expect(await state(opt)).toBe('suspended');
  const ramp = await active('org_private_ramp', {});
  for (let n = 0; n < policy.probation_daily_limit; n++) await receipt(ramp, n);
  const check = (at: number) =>
    db.tenant(ramp.workspace, (sql) =>
      probationHold(sql, ramp.workspace, ramp.company, null, policy, new Date(at)),
    );
  // Fixtures are all delivered in one broadcast. Count recipients individually at the UTC daily boundary.
  await db.tenant(ramp.workspace, (sql) =>
    sql.query('UPDATE sms_messages SET send_day=$1', [new Date(start).toISOString().slice(0, 10)]),
  );
  const allocate = (n: number, date: number) =>
    db.tenant(ramp.workspace, async (sql) => {
      await sql.query('UPDATE sms_messages SET send_day=NULL');
      await sql.query(
        'UPDATE sms_messages SET send_day=$1 WHERE id IN (SELECT id FROM sms_messages LIMIT $2)',
        [new Date(date).toISOString().slice(0, 10), n],
      );
    });
  await allocate(policy.probation_initial_daily_limit - 1, start);
  expect(await check(start + 3600000)).toBeNull();
  await allocate(policy.probation_initial_daily_limit, start);
  expect((await check(start + 3600000))?.reason).toBe('probation_daily_limit');
  const second = start + policy.probation_initial_days * day;
  expect(await check(second)).toBeNull();
  await allocate(policy.probation_daily_limit - 1, second);
  expect(await check(second)).toBeNull();
  await allocate(policy.probation_daily_limit, second);
  expect((await check(second))?.reason).toBe('probation_daily_limit');
  await db.tenant(ramp.workspace, async (sql) => {
    await sql.query("UPDATE sms_carrier_brands SET profile=jsonb_set(profile,'{onboarding,probation}',$1)", [
      JSON.stringify({ state: 'awaiting_canary', startsAt: new Date(start).toISOString() }),
    ]);
    await assignCanary(sql, ramp.company, ramp.send, policy, ramp.workspace);
    const count = (
      await sql.query(
        "SELECT jsonb_array_length(profile#>'{onboarding,probation,members}') n FROM sms_carrier_brands",
      )
    ).rows[0]!.n;
    expect(count).toBe(Math.min(policy.probation_daily_limit, policy.probation_canary_count));
    const delivery = new Date(start + 2000);
    await sql.query('UPDATE sms_messages SET updated_at=$1', [delivery]);
    const end = +delivery + policy.probation_canary_minutes * 60000;
    expect(
      (await probationHold(sql, ramp.workspace, ramp.company, null, policy, new Date(end - 1)))?.reason,
    ).toBe('probation_canary_pending');
    await probationHold(sql, ramp.workspace, ramp.company, null, policy, new Date(end));
    expect(
      (await sql.query("SELECT profile#>>'{onboarding,probation,state}' s FROM sms_carrier_brands")).rows[0]!
        .s,
    ).toBe('active');
  });
}, 60000);
