export const productionDatabase='flockletter_production';
const migrator='flockletter_production_migrator',marker='Flockletter production foundation';
export const productionRestrictedRoles={operator:'flockletter_production_operator',planner:'flockletter_production_retention_planner',executor:'flockletter_production_retention_executor'} as const;
export type ProductionRestrictedRole=keyof typeof productionRestrictedRoles;

function selectedRole(kind:ProductionRestrictedRole):string {
 if(!Object.hasOwn(productionRestrictedRoles,kind))throw Error('Choose a restricted production role.');
 return productionRestrictedRoles[kind];
}

function context(phase:'database'|'objects'):string {
 const actor=phase==='database'
  ? "current_user::regrole::oid<>(SELECT datdba FROM pg_database WHERE datname=current_database())"
  : `current_user<>'${migrator}' OR (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user) IS DISTINCT FROM '${marker}'`;
 return `PERFORM pg_advisory_xact_lock(hashtext('flockletter:production:restricted-roles'));
 IF current_database()<>'${productionDatabase}' OR (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()) IS DISTINCT FROM '${marker}' THEN
 RAISE EXCEPTION 'production_database_marker_required'; END IF;
 IF ${actor} THEN RAISE EXCEPTION 'production_release_identity_required'; END IF;`;
}

function inactive(role:string):string {
 return `IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='${role}' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolinherit AND shobj_description(oid,'pg_authid')='${marker}') THEN
 RAISE EXCEPTION 'inactive_restricted_operator_marker_required'; END IF;
 IF EXISTS(SELECT FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='${role}')) OR
 EXISTS(SELECT FROM pg_stat_activity WHERE usesysid=(SELECT oid FROM pg_roles WHERE rolname='${role}')) OR
 EXISTS(SELECT FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname='${role}')) OR
 EXISTS(SELECT FROM pg_namespace WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname='${role}')) OR
 EXISTS(SELECT FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname='${role}')) OR
 EXISTS(SELECT FROM pg_proc WHERE proowner=(SELECT oid FROM pg_roles WHERE rolname='${role}')) THEN
 RAISE EXCEPTION 'operator_ownership_or_membership_refused'; END IF;`;
}

/** Transaction body for exact marked identities. Identifiers come only from the fixed allowlist. */
export function productionRestrictedRoleGuard(kind:ProductionRestrictedRole,phase:'database'|'objects'):string {
 if(phase!=='database'&&phase!=='objects')throw Error('Choose database or objects phase.');
 return `DO $guard$ BEGIN\n${context(phase)}\n${inactive(selectedRole(kind))}\nEND $guard$;`;
}

/** SQL only. No credential creation/rotation and no LOGIN activation, including on replay. */
export function productionRestrictedRoleCreationSql(kind:ProductionRestrictedRole):string {
 const role=selectedRole(kind);
 return `-- Apply as the marked production database owner with CREATEROLE. No credentials or LOGIN activation.\nBEGIN;\nDO $role$ BEGIN
 ${context('database')}
 IF NOT (SELECT rolcreaterole FROM pg_roles WHERE rolname=current_user) THEN RAISE EXCEPTION 'production_role_administrator_required'; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='${role}') THEN
 CREATE ROLE "${role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
 COMMENT ON ROLE "${role}" IS '${marker}';
 END IF;
 ${inactive(role)}
 END $role$;\nCOMMIT;\n`;
}
