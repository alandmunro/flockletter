import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { applyMigrations } from './apply-migrations.mjs';
import pg from 'pg';

if (existsSync('.env')) loadEnvFile('.env');
const url = process.env.MIGRATION_DATABASE_URL;
const role = process.env.RUNTIME_DATABASE_ROLE;
if (!url || !role || !/^flockletter_[a-z0-9_]+$/.test(role)) throw new Error('Set the dedicated MIGRATION_DATABASE_URL and a flockletter_ runtime role.');
if (!new URL(url).pathname.startsWith('/flockletter_')) throw new Error('Migrations require a dedicated flockletter_ logical database.');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await applyMigrations(client, role);
  console.info('Flockletter migrations applied.');
} finally { await client.end(); }
