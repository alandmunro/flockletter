#!/bin/sh
set -eu
case "${FLOCKLETTER_DATABASE:-}" in flockletter_demo|flockletter_restore) ;; *) exit 1 ;; esac
[ "$POSTGRES_USER" = flockletter_bootstrap ] || exit 1
export PGPASSWORD="$(cat /run/secrets/bootstrap)"
export DB_MIGRATOR_PASSWORD="$(cat /run/secrets/migrator)"
export DB_RUNTIME_PASSWORD="$(cat /run/secrets/runtime)"
[ "$DB_MIGRATOR_PASSWORD" != "$DB_RUNTIME_PASSWORD" ] || exit 1
psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres <<'SQL'
\getenv db FLOCKLETTER_DATABASE
\getenv migrator_password DB_MIGRATOR_PASSWORD
\getenv runtime_password DB_RUNTIME_PASSWORD
CREATE ROLE flockletter_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 3 PASSWORD :'migrator_password';
CREATE ROLE flockletter_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 12 PASSWORD :'runtime_password';
CREATE DATABASE :"db" TEMPLATE template0 ENCODING 'UTF8';
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO flockletter_migrator,flockletter_runtime;
REVOKE ALL ON DATABASE postgres,template1 FROM PUBLIC;
SQL
psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$FLOCKLETTER_DATABASE" <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE,CREATE ON SCHEMA public TO flockletter_migrator WITH GRANT OPTION;
GRANT USAGE ON SCHEMA public TO flockletter_runtime;
-- Prepare fixed private namespaces without granting database CREATE to either app role.
CREATE SCHEMA flockletter_customer_jobs;
CREATE SCHEMA flockletter_retention_control;
REVOKE ALL ON SCHEMA flockletter_customer_jobs,flockletter_retention_control FROM PUBLIC;
GRANT USAGE,CREATE ON SCHEMA flockletter_customer_jobs,flockletter_retention_control TO flockletter_migrator WITH GRANT OPTION;
SQL
if [ "${FLOCKLETTER_DISPOSABLE_FIXTURE:-}" = "1" ]; then
  psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$FLOCKLETTER_DATABASE" <<'SQL'
\getenv db FLOCKLETTER_DATABASE
COMMENT ON DATABASE :"db" IS 'Flockletter disposable restore fixture';
SQL
fi
