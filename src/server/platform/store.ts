import pg from 'pg';
import type { Database,Sql } from '../db.js';
import { requireCondition } from '../errors.js';
export type RecordKind='case'|'health'|'alert'|'ack'|'inbound'|'approval'|'hold'|'notification';
export interface PlatformStore {
 read<T>(kind:RecordKind,workspace?:string,id?:string):Promise<T[]>;
 transaction<T>(workspace:string,action:(records:{count(kind:RecordKind):Promise<number>;find<T>(kind:RecordKind):Promise<T[]>;get<T>(kind:RecordKind,id:string):Promise<T|null>;put(kind:RecordKind,id:string,value:unknown,immutable?:boolean):Promise<void>})=>Promise<T>):Promise<T>;
 cleanup():Promise<number>;
 pendingNotifications<T>(workspace:string):Promise<T[]>;
 close():Promise<void>;
}
export class OperatorStore implements PlatformStore {
 private pool?:pg.Pool;
 private operatorUrl?:URL;
 constructor(readonly db:Database,readonly mode:'capture'|'live',url?:string){
  if(mode!=='live')return;
  requireCondition(!!url&&['hostname','port','pathname'].every(key=>new URL(url)[key as 'hostname'|'port'|'pathname']===new URL(db.pool.options.connectionString!)[key as 'hostname'|'port'|'pathname']),503,'operator_database_required','Use a restricted operator connection to this Flockletter database.');
  this.operatorUrl=new URL(url);
  requireCondition([...this.operatorUrl.searchParams.keys()].every(k=>k==='sslmode'),503,'operator_database_unsafe','Do not override the reviewed database host, user or database through query parameters.');
  // One web pool plus its rolling replacement fits the restricted role's two connections.
  this.pool=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:5000,statement_timeout:10000});
 }
 async verify(){
  if(!this.pool)return;
  const identity=(await this.pool.query(`SELECT current_database() db,current_user role,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,
   has_database_privilege(current_user,current_database(),'CREATE') db_create,
   EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid) memberships,
   EXISTS(SELECT FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege(current_user,n.oid,'CREATE')) schema_create
   FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  requireCondition(identity?.db===decodeURIComponent(new URL(this.db.pool.options.connectionString!).pathname.slice(1))&&identity.role===decodeURIComponent(this.operatorUrl!.username)&&identity.role.endsWith('_operator')&&identity.role!==new URL(this.db.pool.options.connectionString!).username&&!identity.rolsuper&&!identity.rolbypassrls&&!identity.rolcreatedb&&!identity.rolcreaterole&&!identity.rolreplication&&!identity.db_create&&!identity.memberships&&!identity.schema_create,503,'operator_database_unsafe','Use an isolated metadata-only operator role without inherited or creation privileges.');
  const grants=await this.pool.query<{name:string;permission:string;owns:boolean}>(`SELECT n.nspname||'.'||c.relname name,p.permission,c.relowner=current_user::regrole::oid owns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] || CASE WHEN current_setting('server_version_num')::integer>=170000 THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END) p(permission) WHERE c.relkind IN('r','p','v','m','f') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_table_privilege(current_user,c.oid,p.permission)`);
  requireCondition(grants.rowCount===3&&grants.rows.every(r=>r.name==='flockletter_retention_control.platform_records'&&!r.owns&&['SELECT','INSERT','UPDATE'].includes(r.permission)),503,'operator_database_unsafe','Use exact operator metadata permissions.');
  const drift=(await this.pool.query(`SELECT
   EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND acl.grantee IN(0,current_user::regrole::oid)) column_acl,
   EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(current_user,c.oid,'SELECT,USAGE,UPDATE') ELSE false END) sequence_acl,
   EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege(current_user,n.oid,'USAGE') AND has_function_privilege(current_user,p.oid,'EXECUTE') AND p.oid<>to_regprocedure('flockletter_retention_control.expire_platform_inbox()')) function_acl`)).rows[0];
  requireCondition(!drift.column_acl&&!drift.sequence_acl&&!drift.function_acl,503,'operator_database_unsafe','Operator function, column or sequence grants have drifted.');
 }
 async cleanup(){return this.pool?Number((await this.pool.query('SELECT flockletter_retention_control.expire_platform_inbox() n')).rows[0]?.n??0):0;}
 async pendingNotifications<T>(workspace:string):Promise<T[]>{
 const run=async(sql:Sql)=>(await sql.query<{body:T}>(`SELECT body FROM (
 (SELECT body FROM ${this.table()} WHERE workspace_id=$1 AND kind='notification' AND body->>'state'='queued' ORDER BY created_at ASC LIMIT 5)
 UNION ALL
 (SELECT body FROM ${this.table()} WHERE workspace_id=$1 AND kind='notification' AND body->>'state' IN('submitting','unknown') ORDER BY coalesce(body->>'lastChecked',body->>'createdAt'),created_at LIMIT 5)) pending`,[workspace])).rows.map(r=>r.body);
 return this.pool?run(this.pool):this.db.read(workspace,run);
 }
 private table(){return this.mode==='capture'?'public.platform_exercise_records':'flockletter_retention_control.platform_records';}
 async read<T>(kind:RecordKind,workspace?:string,id?:string):Promise<T[]>{
 requireCondition(this.mode!=='capture'||!!workspace,403,'workspace_required','An exercise is limited to the selected workspace.');
 const run=async(sql:Sql)=>{const rows=(await sql.query<{body:T}>(`SELECT body FROM ${this.table()} WHERE kind=$1 AND ($2::text IS NULL OR workspace_id=$2) AND ($3::text IS NULL OR id=$3) ORDER BY created_at DESC LIMIT 10001`,[kind,workspace??null,id??null])).rows;requireCondition(rows.length<=10000,503,'platform_capacity_review','The platform record capacity needs operator review.');return rows.map(r=>r.body);};
 return this.pool?run(this.pool):this.db.read(workspace!,run);
 }
 async transaction<T>(workspace:string,action:Parameters<PlatformStore['transaction']>[1]):Promise<T>{
  const run=async(sql:Sql)=>{await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[workspace]);return action({count:async(kind)=>(await sql.query<{n:number}>(`SELECT count(*)::int n FROM ${this.table()} WHERE workspace_id=$1 AND kind=$2`,[workspace,kind])).rows[0]!.n,find:async<T>(kind:RecordKind)=>(await sql.query<{body:T}>(`SELECT body FROM ${this.table()} WHERE workspace_id=$1 AND kind=$2 ORDER BY created_at DESC LIMIT 1000`,[workspace,kind])).rows.map(r=>r.body),get:async<T>(kind:RecordKind,id:string)=>(await sql.query<{body:T}>(`SELECT body FROM ${this.table()} WHERE workspace_id=$1 AND kind=$2 AND id=$3`,[workspace,kind,id])).rows[0]?.body??null,put:async(kind,id,value,immutable=false)=>{await sql.query(`INSERT INTO ${this.table()}(workspace_id,kind,id,body) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,kind,id) ${immutable?'DO NOTHING':'DO UPDATE SET body=excluded.body'}`,[workspace,kind,id,JSON.stringify(value)]);}}) as Promise<T>;};
  if(!this.pool)return this.db.tenant(workspace,run);const client=await this.pool.connect();try{await client.query('BEGIN');const result=await run(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 async close(){await this.pool?.end();}
}
