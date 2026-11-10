import { expect, it } from 'vitest';
import type {PoolClient} from 'pg';
import { loadConfig } from '../src/server/config.js';
import { Database } from '../src/server/db.js';
import { startDatabase } from '../scripts/database-fixture.js';

it('defaults local and test pool sizes to five', () => {
  const local = loadConfig({ APP_ENV: 'local' });
  const test = loadConfig({ APP_ENV: 'test' });
  expect(local.databasePoolMax).toBe(5);
  expect(test.databasePoolMax).toBe(5);
});

it('defaults staging and production pool sizes to two', () => {
  const staging = loadConfig({ APP_ENV: 'staging', APP_ORIGIN: 'https://flockletter.example.test' });
  const production = loadConfig({
    APP_ENV: 'production',
    APP_ORIGIN: 'https://flockletter.example.test',
    CLERK_PUBLISHABLE_KEY: 'pk_live_SYNTHETIC',
    CLERK_SECRET_KEY: 'sk_live_SYNTHETIC'
  });
  expect(staging.databasePoolMax).toBe(2);
  expect(production.databasePoolMax).toBe(2);
});

it('rejects hosted pool sizes outside the one-to-two budget', () => {
  const invalid = [0, 3, 5, NaN, Infinity, 1.5];
  for (const value of invalid) {
    expect(() => loadConfig({ APP_ENV: 'staging', APP_ORIGIN: 'https://flockletter.example.test', FLOCKLETTER_DATABASE_POOL_MAX: String(value) })).toThrow();
  }
  expect(loadConfig({ APP_ENV: 'staging', APP_ORIGIN: 'https://flockletter.example.test', FLOCKLETTER_DATABASE_POOL_MAX: '1' }).databasePoolMax).toBe(1);
});

it('rejects local pool sizes outside the one-to-five budget', () => {
  expect(() => loadConfig({ APP_ENV: 'local', FLOCKLETTER_DATABASE_POOL_MAX: '0' })).toThrow();
  expect(() => loadConfig({ APP_ENV: 'local', FLOCKLETTER_DATABASE_POOL_MAX: '6' })).toThrow();
  expect(loadConfig({ APP_ENV: 'local', FLOCKLETTER_DATABASE_POOL_MAX: '5' }).databasePoolMax).toBe(5);
});

it('throws for invalid constructor bounds before connecting', () => {
  expect(() => new Database('postgresql://dummy:dummy@127.0.0.1:5432/dummy', 0)).toThrow();
  expect(() => new Database('postgresql://dummy:dummy@127.0.0.1:5432/dummy', 6)).toThrow();
});

it('queues excess clients at the hosted bound on a disposable database',async()=>{
  const fixture=await startDatabase();
  let db:Database|undefined;
  const held=new Set<PoolClient>();
  let pending:Promise<PoolClient>|undefined;
  try {
    db=new Database(fixture.url,2);
    const acquire=async()=>{const client=await db!.pool.connect();held.add(client);return client;};
    const acquired=await Promise.allSettled([acquire(),acquire()]);
    for(const result of acquired)if(result.status==='rejected')throw result.reason;
    const first=[...held][0]!;
    pending=db.pool.connect();
    expect(db.pool.waitingCount).toBe(1);
    expect(db.pool.totalCount).toBe(2);
    first.release();held.delete(first);
    const third=await pending;pending=undefined;held.add(third);
    expect(db.pool.waitingCount).toBe(0);
    expect(db.pool.totalCount).toBe(2);
  } finally {
    try {
      for(const client of held)client.release();
      held.clear();
      if(pending){const client=await pending.catch(()=>undefined);client?.release();}
      await db?.close();
    } finally {await fixture.stop();}
  }
});
