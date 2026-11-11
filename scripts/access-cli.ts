import { readFile } from 'node:fs/promises';
import { Database } from '../src/server/db.js';
import { recordAccess } from './complimentary-access.js';
import { workspaceIdentifier } from '../src/server/campaign/rehearsal.js';
import {parseReleaseConnection} from './release-input.mjs';
import {readProtectedReleaseFile} from './release-plan.mjs';
import {runComplimentaryRelease} from './complimentary-release.js';

// A protected operator process supplies its migrator credential. The portal runtime has SELECT only.
try {
  if(['inspect','apply'].includes(process.argv[2]??'')){
    if(process.argv.length!==4)throw Error('Use the protected target file.');
    const result=await runComplimentaryRelease(JSON.parse(await readProtectedReleaseFile(process.argv[3],16384)),process.env,process.argv[2]!);
    console.info(JSON.stringify(result));
  }else{
  const target = workspaceIdentifier.parse(process.env.FLOCKLETTER_COMPLIMENTARY_WORKSPACE);
  const url = parseReleaseConnection(process.env.MIGRATION_DATABASE_URL);
  if (
    !url ||
    process.env.APP_ENV !== 'staging' ||
    url.pathname !== '/flockletter_staging' ||
    url.username !== 'flockletter_staging_migrator'
  )
    throw Error('Use the isolated Flockletter staging release identity.');
  const filename = process.argv[2];
  if (!filename) throw Error('A JSON grant file is required.');
  const db = new Database(url.href,1);
  try {
    const identity = (await db.pool.query('SELECT current_database() AS db,current_user AS role')).rows[0]!;
    if (identity.db !== 'flockletter_staging' || identity.role !== 'flockletter_staging_migrator')
      throw Error('Unexpected release identity.');
    console.info(await recordAccess(db, target, JSON.parse(await readFile(filename, 'utf8'))));
  } finally {
    await db.close();
  }
  }
} catch {
  console.error(
    'Complimentary operation did not complete. Verify the exact release identity, protected target, revision and operation key; reconcile before retrying.',
  );
  process.exitCode = 1;
}
