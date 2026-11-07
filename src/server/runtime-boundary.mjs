import tables from '../shared/runtime-tables.json' with {type:'json'};

const normalize = expression => expression?.replace(/[\s()]/g,'');
const workspace = "workspace_id=current_setting'app.workspace_id'::text,true";
const brand = workspace + "ANDbrand_id::text=current_setting'app.intake_brand_id'::text,true";

// Called as the actual runtime role. These checks cover effective permissions, including
// grants inherited from PUBLIC, role memberships, and accidental ownership.
export async function verifyRuntimeBoundary(client, expected={}) {
  const names=tables.map(table=>table.name);
  const identity=(await client.query(`
    SELECT current_database() AS database, current_user AS role,
      current_setting('server_version_num')::int AS version,
      has_schema_privilege(current_user,'public','CREATE') AS schema_create,
      has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
      EXISTS (SELECT FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND
        (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR
         r.oid IN (SELECT relowner FROM pg_class WHERE relnamespace='public'::regnamespace))) AS unsafe`)).rows[0];
  if (!identity?.database.startsWith('flockletter_') || identity.unsafe ||
      (expected.database && expected.database!==identity.database) ||
      (expected.role && expected.role!==identity.role))
    throw Error('Use a dedicated flockletter_ database and a restricted runtime role, separate from the migration owner.');
  if (identity.schema_create || identity.database_create) throw Error('The runtime role must not create schemas or tables.');
  const operations=['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
  if(identity.version>=170000) operations.push('MAINTAIN');
  const catalog=await client.query(`
    SELECT c.relname AS name,c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced,
      ARRAY(SELECT permission FROM unnest($2::text[]) p(permission)
        WHERE has_table_privilege(current_user,c.oid,p.permission)) AS permissions,
      ARRAY(SELECT permission FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p(permission)
        WHERE has_any_column_privilege(current_user,c.oid,p.permission)) AS column_permissions
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname=ANY($1)`,[names,operations]);
  const policies=await client.query(`
    SELECT tablename,policyname,qual,with_check,
      cmd='ALL' AND permissive='PERMISSIVE' AND roles=ARRAY['public']::name[] AS applies
    FROM pg_policies WHERE schemaname='public' AND tablename=ANY($1)`,[names]);
  for (const table of tables) {
    const found=catalog.rows.find(row=>row.name===table.name);
    if(!found?.enabled || !found.forced) throw Error('The foundation migration and forced tenant policies are required.');
    const active=policies.rows.filter(row=>row.tablename===table.name);
    const expectedPolicy=table.scope==='workspace'?workspace:brand;
    const rule=active[0];
    if(active.length!==1 || !rule.applies || normalize(rule.qual)!==expectedPolicy || normalize(rule.with_check)!==expectedPolicy)
      throw Error('The workspace and brand policies are required for '+table.name+'.');
    if(found.permissions.length!==table.permissions.length || table.permissions.some(permission=>!found.permissions.includes(permission)) ||
       found.column_permissions.some(permission=>!table.permissions.includes(permission))) {
      if(table.name==='subscriber_consent_events') throw Error('Consent evidence must be append-only for the runtime role.');
      if(table.name==='workspace_access_events') throw Error('Runtime access to operator grants must be read-only.');
      throw Error('Unexpected runtime privileges for '+table.name+'.');
    }
  }
  // During additive deployments an older web revision can see newer protected
  // tables. It may never have access to a tenant table outside forced RLS.
  const extra=await client.query(`SELECT EXISTS(SELECT FROM pg_class c
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') AND NOT (c.relname=ANY($1))
      AND NOT(c.relrowsecurity AND c.relforcerowsecurity)
      AND (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
           has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS unsafe`,[names]);
  if(extra.rows[0]?.unsafe) throw Error('An additional runtime-accessible table is missing forced tenant policies.');
  const functions=await client.query("SELECT has_function_privilege(current_user,'public.flockletter_default_company_id(text)','EXECUTE') AS allowed");
  if(!functions.rows[0]?.allowed) throw Error('The runtime role needs to initialize its default company.');
  return {database:identity.database,role:identity.role,protected_tables:names.length,schema_create:false,database_create:false};
}
