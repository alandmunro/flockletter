import pg from 'pg';
import { readProtectedRetentionFile } from '../src/server/customer-retention/configuration.js';
const url=(await readProtectedRetentionFile(process.env.FLOCKLETTER_OPERATOR_DATABASE_FILE)).trim();
const db=new pg.Client({connectionString:url,connectionTimeoutMillis:10000,statement_timeout:10000});
await db.connect();try{
 const identity=(await db.query(`SELECT current_database() db,current_user role,r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE rolname=current_user`)).rows[0];
 if(!identity?.db?.startsWith('flockletter_')||!identity.role?.endsWith('_maintenance')||identity.rolsuper||identity.rolbypassrls)throw Error('Use a separate restricted Flockletter maintenance role.');
 if(process.env.FLOCKLETTER_PLATFORM_INBOX_PURGE!=='approved')throw Error('Review the90-day global quarantine policy and set the explicit maintenance approval.');
 const result=await db.query(`DELETE FROM flockletter_retention_control.platform_records WHERE workspace_id='_platform_inbox' AND kind='inbound' AND created_at<clock_timestamp()-interval '90 days'`);
 console.info(JSON.stringify({purgedUnassignedEmails:result.rowCount}));
}finally{await db.end();}
