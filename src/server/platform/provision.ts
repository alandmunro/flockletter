/** Reviewed SQL only; no credentials are created or printed by this module. */
export function operatorRoleGrants(database:string,role:string){
 if(!/^flockletter_[a-z0-9_]+$/.test(database)||!/^flockletter_[a-z0-9_]+_operator$/.test(role))throw Error('Use exact Flockletter database and separate operator role.');
 return `ALTER ROLE "${role}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
REVOKE ALL ON DATABASE "${database}" FROM "${role}";
GRANT CONNECT ON DATABASE "${database}" TO "${role}";
${operatorObjectGrants(role)}`;
}
/** Apply as the migration object owner, not the privileged database/role administrator. */
export function operatorObjectGrants(role:string){
 if(!/^flockletter_[a-z0-9_]+_operator$/.test(role))throw Error('Use a separate Flockletter operator role.');
 return `REVOKE ALL ON SCHEMA public,flockletter_customer_jobs,flockletter_retention_control FROM "${role}";
REVOKE ALL ON ALL TABLES IN SCHEMA public,flockletter_customer_jobs,flockletter_retention_control FROM "${role}";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public,flockletter_customer_jobs,flockletter_retention_control FROM "${role}";
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public,flockletter_customer_jobs,flockletter_retention_control FROM "${role}";
GRANT USAGE ON SCHEMA flockletter_retention_control TO "${role}";
GRANT SELECT,INSERT,UPDATE ON flockletter_retention_control.platform_records TO "${role}";
GRANT EXECUTE ON FUNCTION flockletter_retention_control.expire_platform_inbox() TO "${role}";`;
}
