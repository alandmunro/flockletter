import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { Database } from '../src/server/db.js';
import { OperatorStore } from '../src/server/platform/store.js';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import type { CommandService } from '../src/server/service.js';
import type { Authenticator } from '../src/server/auth.js';
import { CustomerWorkflows } from '../src/server/customer-runtime.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('database and operator pool resilience', () => {
  it('handles idle pool errors without throwing and preserves original errors when ROLLBACK fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = new Database('postgresql://flockletter_runtime:pass@127.0.0.1:5432/flockletter_test', 2);
    try {
      expect(() => db.pool.emit('error', Object.assign(new Error('terminating connection'), { code: '57P01' }), {} as PoolClient)).not.toThrow();
      expect(errorLog).toHaveBeenCalledWith('Unexpected idle PostgreSQL client error.', { error: 'Error', code: '57P01' });

      const release = vi.fn();
      const query = vi.fn(async (sql: string) => {
        if (sql === 'BEGIN') return { rows: [] };
        if (sql.includes('set_config')) return { rows: [] };
        if (sql.includes('flockletter_retention_blocked')) return { rows: [{ blocked: false }] };
        if (sql === 'ROLLBACK') throw new Error('socket closed');
        return { rows: [] };
      });
      vi.spyOn(db.pool, 'connect').mockImplementation((async () => ({ query, release })) as unknown as typeof db.pool.connect);

      const original = Object.assign(new Error('workspace_retention_busy'), { code: '55P03' });
      await expect(db.tenant('org_test', async () => { throw original; })).rejects.toMatchObject({
        status: 503,
        code: 'workspace_busy',
      });
      expect(release).toHaveBeenCalledWith(true);
    } finally {
      await db.close();
    }
  });

  it('handles idle operator pool errors and preserves original errors on failed ROLLBACK', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = new Database('postgresql://flockletter_runtime:pass@127.0.0.1:5432/flockletter_test', 1);
    const store = new OperatorStore(db, 'live', 'postgresql://flockletter_operator:pass@127.0.0.1:5432/flockletter_test');
    try {
      const pool = (store as unknown as { pool: Database['pool'] }).pool;
      expect(() => pool.emit('error', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }), {} as PoolClient)).not.toThrow();
      expect(errorLog).toHaveBeenCalledWith('Unexpected idle operator PostgreSQL client error.', { error: 'Error', code: 'ECONNRESET' });

      const release = vi.fn();
      const query = vi.fn(async (sql: string) => {
        if (sql === 'ROLLBACK') throw new Error('socket closed');
        return { rows: [] };
      });
      vi.spyOn(pool, 'connect').mockImplementation((async () => ({ query, release })) as unknown as typeof pool.connect);

      await expect(store.transaction('org_test', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      expect(release).toHaveBeenCalledWith(true);
    } finally {
      await store.close();
      await db.close();
    }
  });

  it('caches boundary verification for /readyz probes and invalidates on failure', async () => {
    const db = new Database('postgresql://flockletter_runtime:pass@127.0.0.1:5432/flockletter_test', 1);
    try {
      const verifySpy = vi.spyOn(db, 'verifyBoundary').mockImplementation(async () => {
        (db as unknown as { boundaryVerifiedAt: number }).boundaryVerifiedAt = Date.now();
      });
      const querySpy = vi.spyOn(db.pool, 'query').mockImplementation((async () => ({ rows: [{ '?column?': 1 }] })) as unknown as typeof db.pool.query);

      await db.checkReadiness(60_000);
      expect(verifySpy).toHaveBeenCalledTimes(1);
      expect(querySpy).not.toHaveBeenCalled();

      await db.checkReadiness(60_000);
      expect(verifySpy).toHaveBeenCalledTimes(1);
      expect(querySpy).toHaveBeenCalledWith('SELECT 1');

      querySpy.mockRejectedValueOnce(new Error('db_down'));
      await expect(db.checkReadiness(60_000)).rejects.toThrow('db_down');

      await db.checkReadiness(60_000);
      expect(verifySpy).toHaveBeenCalledTimes(2);
    } finally {
      await db.close();
    }
  });
});

describe('unhandled 500 error logging', () => {
  it('logs structured context without leaking path tokens or bodies', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = {
      db: { checkReadiness: vi.fn(async () => {}) },
      customer: {
        settings: { billing: 'off', delivery: 'off', deliveryScope: 'all', audience: 'off', team: 'off', support: 'off', retention: 'off' },
        texting: {
          resolveLink: vi.fn(async () => {
            throw Object.assign(new TypeError('sensitive-provider-payload'), { code: 'ECONNRESET' });
          }),
        },
      },
    } as unknown as CommandService;
    const auth = {} as Authenticator;
    const server = createApp(loadConfig({ APP_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:4310', LOCAL_TEST_IDENTITY: 'true' }), service, auth).listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP port');
      const response = await fetch(`http://127.0.0.1:${address.port}/l/mybrand/secret-token-value`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: { code: 'service_error', message: 'The operation could not finish. Retry with the same operation key.' },
      });
      expect(errorLog).toHaveBeenCalledWith('Unhandled request error.', {
        method: 'GET',
        route: '/l/:shortName/:code',
        error: 'TypeError',
        code: 'ECONNRESET',
      });
      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).not.toContain('secret-token-value');
      expect(logged).not.toContain('sensitive-provider-payload');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
  });
});

describe('customer workflow graceful shutdown ordering', () => {
  it('drains active workspace jobs before closing SES and engine, and deduplicates concurrent close calls', async () => {
    const events: string[] = [];
    let releaseJob!: () => void;
    const activeJob = new Promise<number>(resolve => {
      releaseJob = () => {
        events.push('job_finished');
        resolve(15_000);
      };
    });
    const fake = {
      closing: false,
      closePromise: undefined,
      active: new Map([['org_1', activeJob]]),
      ses: { close: vi.fn(() => { events.push('ses_closed'); }) },
      engine: { close: vi.fn(async () => { events.push('engine_closed'); }) },
      infrastructure: { options: { provider: { close: vi.fn(async () => { events.push('infra_closed'); }) } } },
    };

    const first = CustomerWorkflows.prototype.close.call(fake);
    const second = CustomerWorkflows.prototype.close.call(fake);
    await Promise.resolve();
    expect(events).toEqual([]);

    releaseJob();
    await Promise.all([first, second]);
    expect(events[0]).toBe('job_finished');
    expect(events).toContain('ses_closed');
    expect(events).toContain('engine_closed');
    expect(events).toContain('infra_closed');
    expect(fake.ses.close).toHaveBeenCalledTimes(1);
    expect(fake.engine.close).toHaveBeenCalledTimes(1);
    expect(fake.infrastructure.options.provider.close).toHaveBeenCalledTimes(1);
  });
});
