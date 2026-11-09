import tables from '../shared/runtime-tables.json' with { type: 'json' };

const normalize = (expression) => expression?.replace(/[\s()]/g, '');
const workspace = "workspace_id=current_setting'app.workspace_id'::text,true";
const brand = workspace + "ANDbrand_id::text=current_setting'app.intake_brand_id'::text,true";

// Called as the actual runtime role. These checks cover effective permissions, including
// grants inherited from PUBLIC, role memberships, and accidental ownership.
export async function verifyRuntimeBoundary(client, expected = {}) {
  const names = tables.map((table) => table.name);
  const identity = (
    await client.query(`
    SELECT current_database() AS database, current_user AS role,
      current_setting('server_version_num')::int AS version,
      has_schema_privilege(current_user,'public','CREATE') AS schema_create,
      has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
      EXISTS (SELECT FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND
        (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR
         r.oid IN (SELECT relowner FROM pg_class WHERE relnamespace='public'::regnamespace))) AS unsafe`)
  ).rows[0];
  if (
    !identity?.database.startsWith('flockletter_') ||
    identity.unsafe ||
    (expected.database && expected.database !== identity.database) ||
    (expected.role && expected.role !== identity.role)
  )
    throw Error(
      'Use a dedicated flockletter_ database and a restricted runtime role, separate from the migration owner.',
    );
  if (identity.schema_create || identity.database_create)
    throw Error('The runtime role must not create schemas or tables.');
  const operations = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  if (identity.version >= 170000) operations.push('MAINTAIN');
  const catalog = await client.query(
    `
    SELECT c.relname AS name,c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced,
      ARRAY(SELECT permission FROM unnest($2::text[]) p(permission)
        WHERE has_table_privilege(current_user,c.oid,p.permission)) AS permissions,
      ARRAY(SELECT permission FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p(permission)
        WHERE has_any_column_privilege(current_user,c.oid,p.permission)) AS column_permissions
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname=ANY($1)`,
    [names, operations],
  );
  const policies = await client.query(
    `
    SELECT tablename,policyname,qual,with_check,
      cmd='ALL' AND permissive='PERMISSIVE' AND roles=ARRAY['public']::name[] AS applies
    FROM pg_policies WHERE schemaname='public' AND tablename=ANY($1)`,
    [names],
  );
  for (const table of tables) {
    const found = catalog.rows.find((row) => row.name === table.name);
    if (!found?.enabled || !found.forced)
      throw Error('The foundation migration and forced tenant policies are required.');
    const active = policies.rows.filter((row) => row.tablename === table.name);
    const expectedPolicy = table.scope === 'workspace' ? workspace : brand;
    const rule = active[0];
    if (
      active.length !== 1 ||
      !rule.applies ||
      normalize(rule.qual) !== expectedPolicy ||
      normalize(rule.with_check) !== expectedPolicy
    )
      throw Error('The workspace and brand policies are required for ' + table.name + '.');
    if (
      found.permissions.length !== table.permissions.length ||
      table.permissions.some((permission) => !found.permissions.includes(permission)) ||
      found.column_permissions.some((permission) => !table.permissions.includes(permission))
    ) {
      if (table.name === 'subscriber_consent_events')
        throw Error('Consent evidence must be append-only for the runtime role.');
      if (table.name === 'workspace_access_events')
        throw Error('Runtime access to operator grants must be read-only.');
      throw Error('Unexpected runtime privileges for ' + table.name + '.');
    }
  }
  // During additive deployments an older web revision can see newer protected
  // tables. It may never have access to a tenant table outside forced RLS.
  const extra = await client.query(
    `SELECT EXISTS(SELECT FROM pg_class c
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') AND NOT (c.relname=ANY($1))
      AND NOT(c.relrowsecurity AND c.relforcerowsecurity)
      AND (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
           has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS unsafe`,
    [names],
  );
  if (extra.rows[0]?.unsafe)
    throw Error('An additional runtime-accessible table is missing forced tenant policies.');
  const functions = await client.query(
    "SELECT has_function_privilege(current_user,'public.flockletter_default_company_id(text)','EXECUTE') AS allowed",
  );
  if (!functions.rows[0]?.allowed) throw Error('The runtime role needs to initialize its default company.');
  const scheduler=(await client.query(`SELECT
    to_regnamespace('flockletter_customer_jobs') IS NOT NULL AS present,
    has_schema_privilege(current_user,'flockletter_customer_jobs','USAGE') AS usage,
    has_schema_privilege(current_user,'flockletter_customer_jobs','CREATE') AS create_schema,
    has_table_privilege(current_user,'flockletter_customer_jobs.scopes','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table_access,
    has_any_column_privilege(current_user,'flockletter_customer_jobs.scopes','SELECT,INSERT,UPDATE,REFERENCES') AS column_access,
    has_schema_privilege(current_user,'flockletter_retention_control','USAGE,CREATE') AS retention_access`)).rows[0];
  if(!scheduler?.present||!scheduler.usage||scheduler.create_schema||scheduler.table_access||scheduler.column_access||scheduler.retention_access)
    throw Error('Customer worker routing and retention control require their restricted private boundaries.');
  const privateTables=await client.query(`SELECT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='flockletter_customer_jobs' AND c.relkind IN ('r','p','v','m','f') AND
    (has_table_privilege(current_user,c.oid,$1) OR
     has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS unsafe`,[operations.join(',')]);
  if(privateTables.rows[0]?.unsafe)throw Error('Private worker capacity and routing tables must not be accessible to runtime credentials.');
  const signatures=['worker_heartbeat(text,uuid)','worker_stop(text,uuid)','worker_liveness(text)','wake(text,timestamp with time zone)','snooze(text,timestamp with time zone)','due_scopes()','record_pass(text,text)','scope_status(text)','claim_provisioning_budget(text,uuid,uuid,integer)','trial_claim(text,text,text,text,integer,integer,text,uuid,text,text,text)','register_support_reply_route(text,uuid,text,text,timestamp with time zone)','resolve_support_reply_route(text)','register_confirmation_route(text,uuid,uuid,text,text,timestamp with time zone)','resolve_confirmation_route(text)'];
  const routines=await client.query(`SELECT p.oid::regprocedure::text signature,p.prosecdef,
    p.proconfig=ARRAY['search_path=pg_catalog']::text[] AS fixed_path,
    p.proowner<>current_user::regrole::oid AS different_owner,
    has_function_privilege(current_user,p.oid,'EXECUTE') AS allowed,
    EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
    FROM pg_proc p WHERE p.oid=ANY(ARRAY(SELECT to_regprocedure('flockletter_customer_jobs.'||s) FROM unnest($1::text[]) s))`,[signatures]);
  if(routines.rowCount!==signatures.length||routines.rows.some(row=>!row.prosecdef||!row.fixed_path||!row.different_owner||!row.allowed||row.public_execute))
    throw Error('Customer worker routines need fixed paths, explicit execution grants and migration ownership.');
  const extraRoutines=await client.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='flockletter_customer_jobs' AND has_function_privilege(current_user,p.oid,'EXECUTE')
 AND NOT(p.oid=ANY(ARRAY(SELECT to_regprocedure('flockletter_customer_jobs.'||s) FROM unnest($1::text[]) s))) LIMIT 1`,[signatures]);
  if(extraRoutines.rowCount)throw Error('Runtime credentials must not execute private operator inventory or erasure routines.');
  const gates=await client.query(`SELECT p.prosecdef,p.proconfig=ARRAY['search_path=pg_catalog']::text[] fixed_path,
 p.proowner<>current_user::regrole::oid different_owner,has_function_privilege(current_user,p.oid,'EXECUTE') allowed,
 EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute
 FROM pg_proc p WHERE p.oid=ANY(ARRAY[to_regprocedure('public.flockletter_restore_blocked()'),to_regprocedure('public.flockletter_retention_blocked(text)'),to_regprocedure('public.flockletter_platform_hold(text)')])`);
  if(gates.rowCount!==3||gates.rows.some(r=>!r.prosecdef||!r.fixed_path||!r.different_owner||!r.allowed||r.public_execute))throw Error('Retention and platform gates need exact fixed-path private authority.');
  const guarded=tables.filter(t=>t.permissions.includes('INSERT')).map(t=>t.name);
  const guards=await client.query(`SELECT c.relname FROM pg_class c JOIN pg_trigger t ON t.tgrelid=c.oid JOIN pg_proc p ON p.oid=t.tgfoid
 WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1) AND t.tgname='flockletter_retention_insert_guard' AND t.tgenabled='A' AND t.tgtype=7
 AND p.oid=to_regprocedure('public.flockletter_retention_insert_guard()') AND p.provolatile='v' AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.proowner<>current_user::regrole::oid
 AND NOT has_function_privilege(current_user,p.oid,'EXECUTE') AND NOT EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')`,[guarded]);
  if(guards.rowCount!==guarded.length)throw Error('Every runtime insert needs the immutable private erasure guard.');
  const privateGuards=await client.query(`SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_trigger t ON t.tgrelid=c.oid WHERE n.nspname||'.'||c.relname=ANY(ARRAY['flockletter_customer_jobs.scopes','flockletter_customer_jobs.support_reply_routes','flockletter_retention_control.platform_records','flockletter_customer_jobs.confirmation_routes']) AND t.tgname='flockletter_retention_insert_guard' AND t.tgenabled='A' AND t.tgtype=7 AND t.tgfoid=to_regprocedure('public.flockletter_retention_insert_guard()')`);
  if(privateGuards.rowCount!==4)throw Error('Private customer routing and operator metadata need erasure guards.');
  return {
    database: identity.database,
    role: identity.role,
    protected_tables: names.length,
    schema_create: false,
    database_create: false,
  };
}
