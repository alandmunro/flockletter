import type {Sql} from './db.js';
import {requireCondition} from './errors.js';
/** Recheck private retention after waiting; pre-lock snapshots cannot authorize provider work. */
export async function lockWorkspace(sql:Sql,workspace:string){
 await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[workspace]);
 requireCondition(!(await sql.query('SELECT public.flockletter_retention_blocked($1) blocked',[workspace])).rows[0]?.blocked,410,'workspace_retention_blocked','This workspace is erased or quarantined. Protected recovery review is required.');
}
