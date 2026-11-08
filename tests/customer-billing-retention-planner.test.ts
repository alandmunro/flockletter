import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { startBillingFixture } from './helpers/billing-fixture.js';
import { CommandService } from '../src/server/service.js';
import { retentionServiceEndSql, retentionClockSql } from '../src/server/customer-billing/service.js';
import { verifyRetentionIdentity } from '../src/server/customer-retention/identity.js';
let fixture: Awaited<ReturnType<typeof startBillingFixture>>,
  admin: pg.Client,
  planner: pg.Client,
  role: string;
const at = new Date('2026-11-08T15:00:00Z');
beforeAll(async () => {
  fixture = await startBillingFixture();
  admin = new pg.Client({ connectionString: fixture.adminUrl });
  await admin.connect();
  role = 'flockletter_plan_' + randomUUID().replaceAll('-', '').slice(0, 8);
  const executor = 'flockletter_erase_' + randomUUID().replaceAll('-', '').slice(0, 8),
    password = randomUUID();
  await admin.query(
    'CREATE ROLE ' +
      pg.escapeIdentifier(role) +
      ' LOGIN PASSWORD ' +
      pg.escapeLiteral(password) +
      ' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  );
  await admin.query(
    'CREATE ROLE ' +
      pg.escapeIdentifier(executor) +
      ' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  );
  const grant = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/retention-operator-grants.ts'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FLOCKLETTER_RETENTION_DATABASE_NAME: 'flockletter_test',
        FLOCKLETTER_RETENTION_RUNTIME_ROLE: 'flockletter_runtime',
        FLOCKLETTER_RETENTION_PLANNER_ROLE: role,
        FLOCKLETTER_RETENTION_EXECUTOR_ROLE: executor,
      },
    },
  );
  expect(grant.status).toBe(0);
  await admin.query(grant.stdout);
  const url = new URL(fixture.adminUrl);
  url.username = role;
  url.password = password;
  planner = new pg.Client({ connectionString: url.toString() });
  await planner.connect();
  await verifyRetentionIdentity(planner, 'flockletter_test', role, 'planner');
});
afterAll(async () => {
  await planner?.end();
  await admin?.end();
  await fixture?.close();
});
async function workspace() {
  const actor = fixture.actor();
  await new CommandService(fixture.db).execute(
    'workspace.initialize',
    { operationKey: randomUUID(), name: 'Read-only planning', brandName: 'Synthetic' },
    actor,
  );
  return actor.workspaceId;
}
async function facts(workspace: string) {
  await planner.query('BEGIN READ ONLY');
  try {
    await planner.query("SELECT set_config('app.workspace_id',$1,true)", [workspace]);
    return {
      fact: await retentionServiceEndSql(planner, workspace, {}, at),
      clock: await retentionClockSql(planner, workspace, {}, at),
    };
  } finally {
    await planner.query('ROLLBACK');
  }
}
it('uses the actual restricted planner role without broadening sending-gate permissions', async () => {
  const permissions = (
    await planner.query(
      `SELECT current_user name,has_function_privilege(current_user,'public.flockletter_platform_hold(text)','EXECUTE') hold,has_function_privilege(current_user,'flockletter_customer_jobs.trial_claim(text,text,text,text,integer,integer,text,uuid,text,text,text)','EXECUTE') claim,has_table_privilege(current_user,'customer_subscriptions','INSERT,UPDATE,DELETE') writes`,
    )
  ).rows[0];
  expect(permissions).toEqual({ name: role, hold: false, claim: false, writes: false });
  expect((await facts(await workspace())).fact).toEqual({
    source: 'exercise',
    status: 'preparation',
    effectiveEnd: null,
    version: '0',
  });
});
it('derives canceled exercise end and shifted clock despite platform/risk holds and preserves complimentary override', async () => {
  const w = await workspace(),
    end = new Date(at.getTime() + 14 * 86400000);
  await admin.query(
    `INSERT INTO customer_subscriptions(workspace_id,id,source,state,plan,revision,trial_started_at,trial_end_at,period_start_at,period_end_at,cancel_at,clock_offset_days,risk_hold)
 VALUES($1,$2,'exercise','trialing','starter',7,$3,$4,$3,$4,$4,14,true)`,
    [w, randomUUID(), at, end],
  );
  await admin.query(
    `INSERT INTO flockletter_retention_control.platform_records(workspace_id,kind,id,body) VALUES($1,'hold','current','{"held":true}')`,
    [w],
  );
  expect(await facts(w)).toEqual({
    fact: { source: 'exercise', status: 'canceled', effectiveEnd: end.toISOString(), version: '7' },
    clock: end,
  });
  await admin.query(
    `INSERT INTO workspace_access_events(workspace_id,revision,operation_key,plan,operator_name,reason) VALUES($1,4,$2,'pro','Synthetic','Read-only fact check')`,
    [w, randomUUID()],
  );
  expect(await facts(w)).toEqual({
    fact: { source: 'complimentary', status: 'active', effectiveEnd: null, version: '4' },
    clock: at,
  });
  await admin.query(
    `INSERT INTO workspace_access_events(workspace_id,revision,operation_key,plan,operator_name,reason) VALUES($1,5,$2,NULL,'Synthetic','Revoke synthetic override')`,
    [w, randomUUID()],
  );
  expect((await facts(w)).fact).toEqual({
    source: 'exercise',
    status: 'canceled',
    effectiveEnd: end.toISOString(),
    version: '7',
  });
});
it('derives verified Stripe failure closure and exact service revision without quota, setup or registry queries', async () => {
  const w = await workspace(),
    failed = new Date(at.getTime() - 31 * 86400000),
    end = new Date(failed.getTime() + 30 * 86400000);
  await admin.query(
    `INSERT INTO customer_subscriptions(workspace_id,id,source,state,plan,revision,failed_since,provider_account,provider_customer,provider_subscription,observed_at)
 VALUES($1,$2,'stripe','past_due','growth',11,$3,'acct_synthetic',$4,$5,$6)`,
    [w, randomUUID(), failed, 'cus_' + randomUUID(), 'sub_' + randomUUID(), at],
  );
  expect(await facts(w)).toEqual({
    fact: { source: 'stripe', status: 'closed', effectiveEnd: end.toISOString(), version: '11' },
    clock: at,
  });
});
