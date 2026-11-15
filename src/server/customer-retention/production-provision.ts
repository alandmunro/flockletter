import pg from 'pg';
import tables from '../../shared/runtime-tables.json' with {type:'json'};
import {productionDatabase,productionRestrictedRoles,productionRestrictedRoleGuard,productionRestrictedRoleCreationSql} from '../production-role-provision.js';

export type ProductionRetentionKind='planner'|'executor';
export type ProductionRetentionPhase='role'|'database'|'objects';
const schemas='public,flockletter_customer_jobs,flockletter_retention_control';
const privateTables=['flockletter_customer_jobs.scopes','flockletter_customer_jobs.resend_domain_claims','flockletter_customer_jobs.resend_sender_routes','flockletter_customer_jobs.sending_state','flockletter_customer_jobs.sending_admissions','flockletter_customer_jobs.support_reply_routes','flockletter_customer_jobs.confirmation_routes','flockletter_retention_control.platform_records'];

/** Fixed production SQL only; no connections, credential generation, LOGIN or erasure. */
export function productionRetentionGrantSql(kind:ProductionRetentionKind,phase:ProductionRetentionPhase):string {
 if(kind!=='planner'&&kind!=='executor')throw Error('Choose planner or executor.');
 if(phase==='role')return productionRestrictedRoleCreationSql(kind);
 if(phase!=='database'&&phase!=='objects')throw Error('Choose role, database or objects phase.');
 const role=productionRestrictedRoles[kind],q=pg.escapeIdentifier,literal=pg.escapeLiteral;
 const lines=[`-- Apply as ${phase==='database'?'the marked production database owner':'flockletter_production_migrator after all migrations'}.`,
  '-- The exact marked role must remain NOLOGIN with no sessions. No credentials or activation.',
  'BEGIN;',productionRestrictedRoleGuard(kind,phase)];
 if(phase==='database')lines.push(`REVOKE ALL ON DATABASE ${q(productionDatabase)} FROM ${q(role)};`,`GRANT CONNECT ON DATABASE ${q(productionDatabase)} TO ${q(role)};`);
 else {
  for(const scope of ['SCHEMA','ALL TABLES IN SCHEMA','ALL SEQUENCES IN SCHEMA','ALL FUNCTIONS IN SCHEMA'])
   lines.push(`REVOKE ALL ON ${scope} ${schemas} FROM ${q(role)};`);
  // Revoke only this role's direct column ACLs in these application namespaces.
  lines.push(`DO $columns$ DECLARE item record; BEGIN
   FOR item IN SELECT format('REVOKE %s (%I) ON %I.%I FROM %I',acl.privilege_type,a.attname,n.nspname,c.relname,${literal(role)}) AS statement
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
   CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE n.nspname IN ('public','flockletter_customer_jobs','flockletter_retention_control')
   AND acl.grantee=(SELECT oid FROM pg_roles WHERE rolname=${literal(role)}) LOOP EXECUTE item.statement; END LOOP;
   END $columns$;`);
  lines.push(`GRANT USAGE ON SCHEMA ${schemas} TO ${q(role)};`);
  const expected:Array<[string,string]>=[];
  function grant(name:string,permissions:string[]) {
   // All names are code-owned manifest/private-table entries, never caller identifiers.
   const [schema,table]=name.split('.');
   if(!schema||!table||name.split('.').length!==2)throw Error('Invalid production table manifest.');
   lines.push(`GRANT ${permissions.join(',')} ON ${q(schema)}.${q(table)} TO ${q(role)};`);
   for(const permission of permissions)expected.push([name,permission]);
  }
  for(const table of tables)grant('public.'+table.name,kind==='planner'?['SELECT']:
   ['subscribers','customer_retention_jobs','customer_retention_cases'].includes(table.name)?['SELECT','DELETE','UPDATE']:['SELECT','DELETE']);
  for(const name of privateTables)grant(name,kind==='planner'?['SELECT']:['SELECT','DELETE']);
  if(kind==='executor') {
   for(const name of ['authorizations','receipts','operations','approvals','restore_quarantines'])
    grant('flockletter_retention_control.'+name,['SELECT','INSERT','UPDATE']);
   grant('flockletter_retention_control.approval_history',['SELECT','INSERT']);
  }
  const functions=['flockletter_customer_jobs.trial_retention_inventory(text,text)',...(kind==='executor'?['flockletter_customer_jobs.trial_expire_claims(text,text)']:[])];
  for(const signature of functions)lines.push(`GRANT EXECUTE ON FUNCTION ${signature} TO ${q(role)};`);
  lines.push(`DO $verify$ BEGIN
   IF EXISTS(WITH expected(name,permission) AS (VALUES ${expected.map(([name,permission])=>`(${literal(name)},${literal(permission)})`).join(',')}),
   actual AS (SELECT n.nspname||'.'||c.relname AS name,p.permission FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] ||
     CASE WHEN current_setting('server_version_num')::int>=170000 THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END) p(permission)
    WHERE c.relkind IN('r','p','v','m','f') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    AND has_table_privilege(${literal(role)},c.oid,p.permission))
   SELECT FROM expected FULL JOIN actual USING(name,permission) WHERE expected.name IS NULL OR actual.name IS NULL)
   THEN RAISE EXCEPTION 'retention_table_grants_refused'; END IF;
   IF EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    AND acl.grantee IN(0,(SELECT oid FROM pg_roles WHERE rolname=${literal(role)}))) OR
    EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_'
     AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(${literal(role)},c.oid,'SELECT,USAGE,UPDATE') ELSE false END) OR
    EXISTS(SELECT FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege(${literal(role)},n.oid,'CREATE')) OR
    has_database_privilege(${literal(role)},current_database(),'CREATE') THEN RAISE EXCEPTION 'retention_extra_grants_refused'; END IF;
   IF EXISTS(WITH expected(oid) AS (VALUES ${functions.map(signature=>`(to_regprocedure(${literal(signature)})::oid)`).join(',')}),
    actual AS (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege(${literal(role)},n.oid,'USAGE')
     AND has_function_privilege(${literal(role)},p.oid,'EXECUTE'))
    SELECT FROM expected FULL JOIN actual USING(oid) WHERE expected.oid IS NULL OR actual.oid IS NULL)
    THEN RAISE EXCEPTION 'retention_function_grants_refused'; END IF;
   END $verify$;`);
 }
 lines.push('COMMIT;');
 return lines.join('\n')+'\n';
}
