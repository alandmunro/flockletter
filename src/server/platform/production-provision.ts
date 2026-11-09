import {operatorObjectGrants} from './provision.js';
import {productionRestrictedRoleGuard,productionRestrictedRoleCreationSql} from '../production-role-provision.js';

export type ProductionOperatorPhase = 'role' | 'database' | 'objects';
const database='flockletter_production',role='flockletter_production_operator';

/** SQL for review only. No connections, credentials or LOGIN activation. */
export function productionOperatorGrantSql(phase:ProductionOperatorPhase):string {
 if(phase==='role')return productionRestrictedRoleCreationSql('operator');
 if(phase!=='database'&&phase!=='objects')throw Error('Choose database or objects phase.');
 const checks=productionRestrictedRoleGuard('operator',phase);
 const grants=phase==='database'
  ? `REVOKE ALL ON DATABASE "${database}" FROM "${role}";\nGRANT CONNECT ON DATABASE "${database}" TO "${role}";`
  : operatorObjectGrants(role);
 const postflight=phase==='database'?'':`DO $verify$ DECLARE amount integer; BEGIN
 SELECT count(*) INTO amount FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] ||
  CASE WHEN current_setting('server_version_num')::integer>=170000 THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END) p(permission)
 WHERE c.relkind IN('r','p','v','m','f') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
 AND has_table_privilege('${role}',c.oid,p.permission);
 IF amount<>3 OR NOT has_table_privilege('${role}','flockletter_retention_control.platform_records','SELECT') OR
  NOT has_table_privilege('${role}','flockletter_retention_control.platform_records','INSERT') OR
  NOT has_table_privilege('${role}','flockletter_retention_control.platform_records','UPDATE') THEN
  RAISE EXCEPTION 'operator_table_grants_refused'; END IF;
 IF EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
 CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
 AND acl.grantee IN(0,(SELECT oid FROM pg_roles WHERE rolname='${role}'))) OR
 EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_'
 AND CASE WHEN c.relkind='S' THEN has_sequence_privilege('${role}',c.oid,'SELECT,USAGE,UPDATE') ELSE false END) OR
 EXISTS(SELECT FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege('${role}',n.oid,'CREATE')) OR
 has_database_privilege('${role}',current_database(),'CREATE') THEN RAISE EXCEPTION 'operator_extra_grants_refused'; END IF;
 SELECT count(*) INTO amount FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege('${role}',n.oid,'USAGE')
 AND has_function_privilege('${role}',p.oid,'EXECUTE');
 IF amount<>1 OR NOT has_function_privilege('${role}','flockletter_retention_control.expire_platform_inbox()','EXECUTE') THEN
  RAISE EXCEPTION 'operator_function_grants_refused'; END IF;
 END $verify$;`;
 return `-- Apply ${phase==='database'?'as the dedicated production database owner':'as flockletter_production_migrator'} after migrations.\n-- Exact existing NOLOGIN role only; credentials and activation stay outside this script.\nBEGIN;\n${checks}\n${grants}\n${postflight}\nCOMMIT;\n`;
}
