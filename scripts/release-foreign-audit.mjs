/** Read-only foreign catalog audit. Never repairs another application's grants. */
export async function auditReleaseForeignAccess(admin,connect,target,roles){
 const other=await admin.query(`SELECT datname FROM pg_database d WHERE datallowconn AND NOT datistemplate AND datname<>$1
  AND EXISTS(SELECT FROM unnest($2::text[]) r(role) WHERE has_database_privilege(r.role,d.datname,'CONNECT'))`,[target,roles]);
 for(const {datname} of other.rows){
  const audit=connect(datname);await audit.connect();
  try{
   for(const role of roles){
    if(!(await audit.query("SELECT has_database_privilege($1,current_database(),'CONNECT') AS allowed",[role])).rows[0].allowed)continue;
    const result=await audit.query(`SELECT EXISTS(
     SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege($1,n.oid,'USAGE')
     AND CASE WHEN c.relkind='S' THEN has_sequence_privilege($1,c.oid,'SELECT,USAGE,UPDATE')
      WHEN c.relkind IN('r','p','v','m','f') THEN has_table_privilege($1,c.oid,
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'||CASE WHEN current_setting('server_version_num')::int>=170000 THEN ',MAINTAIN' ELSE '' END)
       OR has_any_column_privilege($1,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') ELSE false END
    ) OR EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND p.prosecdef
     AND has_schema_privilege($1,n.oid,'USAGE') AND has_function_privilege($1,p.oid,'EXECUTE'))
     OR EXISTS(SELECT FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege($1,n.oid,'CREATE'))
     OR has_database_privilege($1,current_database(),'CREATE') AS unsafe`,[role]);
    if(result.rows[0].unsafe)throw Error('A foreign database grants a Flockletter role access to application objects or a privileged function. Review its grants before activation.');
   }
  }finally{await audit.end();}
 }
 return other.rowCount;
}
