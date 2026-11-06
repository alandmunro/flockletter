import { mkdir, writeFile } from 'node:fs/promises';
import { startDatabase } from './database-fixture.js';

const db = await startDatabase();
await mkdir('.local', { recursive: true });
await writeFile('.local/database.env', `APP_ENV=local\nLOCAL_TEST_IDENTITY=true\nAPP_ORIGIN=http://127.0.0.1:4310\nDATABASE_URL=${db.url}\n`, { mode: 0o600 });
console.info('Disposable PostgreSQL is running. Local-only configuration is in .local/database.env. Copy it to .env, then run npm run build and npm run dev. Data is removed when this process stops.');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void db.stop().finally(() => process.exit(0)); });
setInterval(() => {}, 60_000);
