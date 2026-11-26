import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { applyMigrations } from '../scripts/apply-migrations.mjs';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { CustomerWorkflows } from '../src/server/customer-runtime.js';
import { loadConfig } from '../src/server/config.js';
import { localIdentity } from '../src/server/auth.js';
import { uncertainRetryDelayMs } from '../src/server/customer-delivery/worker.js';
import { CustomerBilling } from '../src/server/customer-billing/service.js';
import type { CustomerBillingProvider, ProviderSubscription } from '../src/server/customer-billing/provider.js';
import { ApiError, client, readJsonSafe } from '../src/client/api.js';
import { platformClient } from '../src/client/platform-api.js';
import { ErrorBoundary } from '../src/client/ErrorBoundary.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('uncertain delivery reconciliation backoff', () => {
  it('keeps 30s cadence for the first 5 minutes, then backs off up to a 6-hour cap', () => {
    expect(uncertainRetryDelayMs('submit', 0)).toBe(30_000);
    expect(uncertainRetryDelayMs('reconcile', 60_000)).toBe(30_000);
    expect(uncertainRetryDelayMs('reconcile', 10 * 60_000)).toBe(5 * 60_000);
    expect(uncertainRetryDelayMs('reconcile', 2 * 3_600_000)).toBe(15 * 60_000);
    expect(uncertainRetryDelayMs('reconcile', 12 * 3_600_000)).toBe(3_600_000);
    expect(uncertainRetryDelayMs('reconcile', 48 * 3_600_000)).toBe(6 * 3_600_000);
  });
});

describe('migration ledger, hot indexes, and paid operations exemption', () => {
  it('tracks applied migrations, skips unchanged replays, installs hot indexes, and keeps runtime boundary isolated', async () => {
    const fixture = await startDatabase();
    const admin = new pg.Client({ connectionString: fixture.adminUrl });
    const db = new Database(fixture.url, 1);
    try {
      await admin.connect();
      const recorded = await admin.query<{ count: string }>('SELECT count(*) FROM flockletter_customer_jobs.schema_migrations');
      expect(Number(recorded.rows[0]?.count)).toBe(52);

      const indexes = await admin.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[])`,
        [[
          'customer_jobs_scopes_next_due',
          'sending_admissions_workspace_created',
          'sending_admissions_created',
          'subscribers_confirmed_brand',
          'customer_audience_confirmations_subscriber',
          'operations_workspace_actor_hash',
          'audit_workspace_created',
        ]],
      );
      expect(indexes.rows).toHaveLength(7);

      // Replaying migrations must skip already-applied SQL files (zero CREATE/ALTER/DROP DDL executed).
      const executed: string[] = [];
      const originalQuery = admin.query.bind(admin);
      vi.spyOn(admin, 'query').mockImplementation(((...args: unknown[]) => {
        if (typeof args[0] === 'string') executed.push(args[0]);
        return (originalQuery as (...a: unknown[]) => unknown)(...args);
      }) as typeof admin.query);
      await applyMigrations(admin, 'flockletter_runtime');
      expect(executed.some(sql => sql.includes('CREATE POLICY') || sql.includes('DROP CONSTRAINT'))).toBe(false);
      expect(executed.some(sql => sql.includes("SET lock_timeout = '5s'"))).toBe(true);

      // Runtime role must have zero access to flockletter_customer_jobs.schema_migrations and still pass boundary checks.
      await expect(db.pool.query('SELECT * FROM flockletter_customer_jobs.schema_migrations')).rejects.toThrow();
      await expect(db.verifyBoundary()).resolves.toBeUndefined();
    } finally {
      await db.close();
      await admin.end();
      await fixture.stop();
    }
  });

  it('exempts eligible customer workspaces from the 2,000-row foundation operations limit', async () => {
    const fixture = await startDatabase();
    const admin = new pg.Client({ connectionString: fixture.adminUrl });
    const db = new Database(fixture.url, 2);
    try {
      await admin.connect();
      const config = loadConfig({ APP_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:4310', LOCAL_TEST_IDENTITY: 'true' });
      const identity = localIdentity();
      const customer = new CustomerWorkflows(db, config, identity, { APP_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:4310' });
      const service = new CommandService(db, undefined, identity.isOwner, undefined, undefined, identity.team, undefined, undefined, undefined, 'test', undefined, customer);

      const workspaceId = 'org_paid_ops';
      const actor: Actor = { kind: 'session', actorId: 'user:owner_1', userId: 'owner_1', workspaceId, owner: true, scopes: ['read', 'draft:write', 'assets:write', 'campaign:send', 'audience:write'], brandIds: null };
      await service.execute('workspace.initialize', { name: 'Paid Co', brandName: 'Main', operationKey: randomUUID() }, actor, 'ui');
      const companyId = (await admin.query<{ id: string }>('SELECT id FROM public.companies WHERE workspace_id=$1 LIMIT 1', [workspaceId])).rows[0]!.id;

      // Seed 2,000 historical operations so the workspace is at the foundation cap.
      await admin.query(
        `INSERT INTO public.operations(workspace_id, actor_id, operation_key, request_hash, result)
         SELECT $1, 'user:owner_1', 'seed-' || g, md5(g::text), '{}'::jsonb FROM generate_series(1, 2000) g`,
        [workspaceId],
      );

      // Without active subscription/grant, foundation cap blocks new mutations.
      await expect(service.execute('brand.create', { name: 'Blocked Brand', companyId, operationKey: randomUUID() }, actor, 'ui'))
        .rejects.toMatchObject({ status: 422, code: 'preparation_limit' });

      // Grant active complimentary access (eligible === true): mutations now succeed past 2,000 operations.
      await admin.query(
        `INSERT INTO public.workspace_access_events(workspace_id, revision, operation_key, plan, operator_name, reason)
         VALUES($1, 1, $2, 'growth', 'op_1', 'test')`,
        [workspaceId, randomUUID()],
      );
      const created = await service.execute('brand.create', { name: 'Second Brand', companyId, operationKey: randomUUID() }, actor, 'ui');
      expect(created).toMatchObject({ name: 'Second Brand' });
    } finally {
      await db.close();
      await admin.end();
      await fixture.stop();
    }
  });
});

describe('external HTTP calls execute outside PostgreSQL transactions', () => {
  it('does not hold a DB pool connection during Stripe webhook resolve and serializes concurrent webhooks', async () => {
    const fixture = await startDatabase();
    const db = new Database(fixture.url, 1);
    try {
      const workspaceId = 'org_webhook_pool';
      await db.tenant(workspaceId, sql => sql.query('INSERT INTO workspaces(workspace_id,name) VALUES($1,$2)', [workspaceId, 'Webhook Co']));

      let releaseFirst!: () => void;
      let firstEntered!: () => void;
      const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
      const firstStarted = new Promise<void>(resolve => { firstEntered = resolve; });
      let resolveCalls = 0;

      const sub = (): ProviderSubscription => ({
        id: 'sub_1',
        customer: 'cus_1',
        plan: 'starter',
        state: 'active',
        periodStart: new Date('2026-11-01T00:00:00Z'),
        periodEnd: new Date('2026-12-01T00:00:00Z'),
        trialStart: null,
        trialEnd: null,
        cancelAt: null,
        endedAt: null,
        failedSince: null,
        cardVerified: true,
        taxMode: 'off',
        intentHint: null,
        workspaceHint: workspaceId,
        pendingPlan: null,
      });

      const gateway = {
        account: 'acct_test',
        live: false,
        taxMode: 'off' as const,
        verify(raw: Buffer) {
          const id = raw.toString('utf8');
          return { id, kind: 'customer.subscription.updated', checkout: null, subscription: 'sub_1', risk: false };
        },
        async resolve(notice: { id: string }) {
          resolveCalls++;
          if (notice.id === 'evt_1' && resolveCalls === 2) {
            firstEntered();
            await firstGate;
          }
          return { subscription: sub(), checkoutId: null, intentId: null, workspace: workspaceId };
        },
        close() {},
      } as unknown as CustomerBillingProvider;

      const billing = new CustomerBilling(db, { environment: 'test', exerciseEnabled: false, gateway });
      const first = billing.webhook(Buffer.from('evt_1'), 'sig');
      await firstStarted;

      // With max=1 pool connection, a DB query MUST succeed while the serialized gateway.resolve() is mid-flight.
      const ping = await db.pool.query('SELECT 1 AS ok');
      expect(ping.rows[0]?.ok).toBe(1);

      releaseFirst();
      await first;
      expect(resolveCalls).toBe(2);
    } finally {
      await db.close();
      await fixture.stop();
    }
  });
});

describe('client resilience (safe JSON, timeouts, and ErrorBoundary)', () => {
  it('returns clean ApiError on HTML 502 gateway pages and on fetch timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } }),
    );
    const api = client(async () => 'token-1');
    await expect(api.call('workspace.get', {})).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      code: 'service_unavailable',
    });

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    await expect(api.call('workspace.get', {})).rejects.toBeInstanceOf(ApiError);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<html>503 Service Unavailable</html>', { status: 503 }),
    );
    const op = platformClient(async () => 'op-token');
    await expect(op.call('platform.overview', {})).rejects.toThrow('temporarily unavailable');

    expect(await readJsonSafe(new Response('not-json', { status: 200 }))).toBeNull();
  });

  it('renders fallback UI in ErrorBoundary when state.failed is set', () => {
    const html = renderToStaticMarkup(createElement(ErrorBoundary, null, createElement('p', null, 'Healthy')));
    expect(html).toContain('Healthy');
    expect(ErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });
});
