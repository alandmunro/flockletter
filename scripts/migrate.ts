import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (existsSync('.env')) loadEnvFile('.env');
const url = process.env.MIGRATION_DATABASE_URL;
const role = process.env.RUNTIME_DATABASE_ROLE;
if (!url || !role || !/^flockletter_[a-z0-9_]+$/.test(role)) throw new Error('Set the dedicated MIGRATION_DATABASE_URL and a flockletter_ runtime role.');
if (!new URL(url).pathname.startsWith('/flockletter_')) throw new Error('Migrations require a dedicated flockletter_ logical database.');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('flockletter:migrations'))");
  await client.query(await readFile(new URL('../migrations/001_foundation.sql', import.meta.url), 'utf8'));
  await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
  console.info('Foundation schema applied. Validate effective runtime privileges before activation.');
} finally { await client.end(); }
