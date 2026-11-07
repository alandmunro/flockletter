import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtemp } from 'node:fs/promises';
import { applyMigrations } from './apply-migrations.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject).listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No database port available.'));
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}
export async function startDatabase() {
  const directory = await mkdtemp(path.join(tmpdir(), 'flockletter-pg-'));
  const password = randomBytes(24).toString('hex');
  const port = await freePort();
  const postgres = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password, port, persistent: false, authMethod: 'scram-sha-256', autoRehydrateSymlinks: true, postgresFlags: ['-h', '127.0.0.1', '-c', 'max_connections=20', '-c', 'shared_buffers=32MB'], onLog: () => {}, onError: () => {} });
  await postgres.initialise();
  await postgres.start();
  const adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/flockletter_test`;
  try {
    await postgres.createDatabase('flockletter_test');
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE flockletter_runtime LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
      await admin.query('REVOKE ALL ON DATABASE flockletter_test FROM PUBLIC');
      await admin.query('GRANT CONNECT ON DATABASE flockletter_test TO flockletter_runtime');
      await applyMigrations(admin, 'flockletter_runtime');
    } finally { await admin.end(); }
    return { url: adminUrl.replace('postgres:', 'flockletter_runtime:'), adminUrl, stop: () => postgres.stop() };
  } catch (error) { await postgres.stop(); throw error; }
}
