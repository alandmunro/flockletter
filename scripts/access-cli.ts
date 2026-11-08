import { readFile } from 'node:fs/promises';
import { Database } from '../src/server/db.js';
import { recordAccess } from './complimentary-access.js';
import { workspaceIdentifier } from '../src/server/campaign/rehearsal.js';

// A protected operator process supplies its migrator credential. The portal runtime has SELECT only.
try {
  const target = workspaceIdentifier.parse(process.env.FLOCKLETTER_COMPLIMENTARY_WORKSPACE);
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? '');
  if (
    process.env.APP_ENV !== 'staging' ||
    url.pathname !== '/flockletter_staging' ||
    url.username !== 'flockletter_staging_migrator'
  )
    throw Error('Use the isolated Flockletter staging release identity.');
  const filename = process.argv[2];
  if (!filename) throw Error('A JSON grant file is required.');
  const db = new Database(url.href);
  try {
    const identity = (await db.pool.query('SELECT current_database() AS db,current_user AS role')).rows[0]!;
    if (identity.db !== 'flockletter_staging' || identity.role !== 'flockletter_staging_migrator')
      throw Error('Unexpected release identity.');
    console.info(await recordAccess(db, target, JSON.parse(await readFile(filename, 'utf8'))));
  } finally {
    await db.close();
  }
} catch {
  console.error(
    'Complimentary grant was not applied. Verify the staging identity, workspace, input and operation key.',
  );
  process.exitCode = 1;
}
