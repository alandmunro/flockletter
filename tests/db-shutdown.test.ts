import { expect, it, vi } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';

it('finishes closing idle clients before a disposable database is allowed to stop', async () => {
  const fixture = await startDatabase();
  const db = new Database(fixture.url);
  const client = await db.pool.connect();
  const closeClient = client.end.bind(client);
  let finish: (() => void) | undefined;
  const removed = new Promise<void>((resolve) => {
    vi.spyOn(client, 'end').mockImplementation(((callback?: () => void) => {
      finish = () => {
        void closeClient(callback ?? (() => {}));
      };
      resolve();
    }) as typeof client.end);
  });
  client.release();
  let closed = false;
  const shutdown = db.close().then(() => {
    closed = true;
  });
  try {
    await removed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
  } finally {
    finish?.();
    await shutdown;
    await fixture.stop();
  }
  expect(closed).toBe(true);
});
