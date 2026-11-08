# Self-hosted preparation and recovery

Run Flockletter as an independent local preparation workspace with Docker, Docker Compose and a supported Node release (22.12 through 26). The Compose project serves the public app on a loopback port. Its web service receives the restricted Flockletter runtime database credential and, if supplied, the operator's own Clerk keys. The migration credential belongs to a separate one-off service. The database container uses its own bootstrap credential to create those two restricted roles.

The built image serves the [Studio dependency inventory](../../public/studio-dependencies.json) and [copyright notices](../../public/studio-notices.txt) at the corresponding root URLs. Distribute both files with custom web bundles. [Editor provenance](STUDIO_LICENSES.md)

## Start a clean installation

From the repository root:

```sh
node selfhost/secrets.mjs
docker compose -f selfhost/compose.yaml up -d --build --wait web
```

Open the app at [the loopback address](http://127.0.0.1:4310/). The default database stays on the project's internal network. A worker or provider for live mail and Stripe is outside this package. The clean container builds the checked-in application using the public lockfile. The official Node and PostgreSQL image references are pinned by multi-architecture digest in the Dockerfile and Compose file.

The public pages work with blank Clerk files, and `/readyz` reports the missing account configuration. To enable Clerk sign-in, enter the publishable and backend keys for your own Clerk application into `selfhost/.state/clerk-public` and `selfhost/.state/clerk-secret`. The two files are mounted only in the web service. Make them owner-writable while editing, then read-only inside the private state directory. Configure the same loopback origin in your Clerk development application and recreate the web container with `docker compose -f selfhost/compose.yaml up -d --force-recreate --wait web`. Set `FLOCKLETTER_WEB_PORT` consistently for a different host port. The synthetic demo below requires no Clerk account.

`selfhost/secrets.mjs` generates fresh credentials in a private directory with file permissions that let the assigned non-root container read its individual mount. Rerunning the command verifies existing credentials. Keep the directory with the installation's backups. PostgreSQL reads its bootstrap credentials on the first startup of the volume. Use `docker compose -f selfhost/compose.yaml down` to stop the application and retain its database.

Fresh bootstrap now prepares the fixed `flockletter_customer_jobs` and `flockletter_retention_control` private schemas under bootstrap ownership, granting the existing migrator only `USAGE` and `CREATE WITH GRANT OPTION`. The runtime role receives no database `CREATE` permission, accesses scheduler functions solely through reviewed migrations, and retains no direct access to underlying private tables or retention controls. For existing installations, operators must prepare these fixed schemas with the same restricted grants before running migrations.

## Try the synthetic owner flow

This separate project runs the web process on the host's actual loopback interface so the existing loopback identity check applies to every request. Use it for disposable local demonstrations.

```sh
npm ci
npm run build
export FLOCKLETTER_STATE_DIR="$(pwd)/selfhost/.state-loopback"
node selfhost/secrets.mjs "$FLOCKLETTER_STATE_DIR"
docker compose -p flockletter-loopback-demo -f selfhost/compose.yaml -f selfhost/loopback.yaml up -d --wait db
docker compose -p flockletter-loopback-demo -f selfhost/compose.yaml -f selfhost/loopback.yaml build migrate
docker compose -p flockletter-loopback-demo -f selfhost/compose.yaml -f selfhost/loopback.yaml run --rm --no-deps migrate
node selfhost/demo-run.mjs
```

Open [the demo workspace](http://127.0.0.1:4311/), name the workspace and first brand, then create a campaign draft. The demo can save, preview and reopen drafts. Its launcher passes only the restricted loopback runtime connection, serves the built public assets, and avoids loading the repository's private `.env`. The override publishes its database only at `127.0.0.1:55473`. Use `FLOCKLETTER_DEMO_WEB_PORT` and `FLOCKLETTER_DEMO_DB_PORT` for alternative loopback ports. Stop the web process with Ctrl-C.

## Run the isolated restore drill

```sh
node selfhost/restore-drill.mjs
```

The drill requires a local Unix-socket Docker context. It creates a unique Compose project with two separate PostgreSQL servers, role secrets and volumes. `DOCKER_CONTEXT` selects an existing local engine. If Compose is installed as a separate executable, `FLOCKLETTER_COMPOSE_BIN` may point to that executable.

The `Self-host restore drill` GitHub workflow runs the same command on Ubuntu 24.04 for pull requests and updates to staging and main. It also supports a manual run. Docker's official registry provides Linux amd64 and arm64 variants for both pinned image digests. [CI workflow](../../.github/workflows/selfhost.yml)

1. The source contains two fictional workspaces, their consent events and a recorded unsubscribe. The runner verifies the local web service, restricted runtime roles and disabled campaign delivery.
2. PostgreSQL's `pg_dump` exports only the marked `flockletter_demo` logical database to a private temporary archive. `pg_restore` loads it into the separately marked `flockletter_restore` database in one transaction. The archive retains table owners, effective grants and row-level policies.
3. Before accepting the restore, the checker compares both workspaces' contacts, consent history and suppression states with the source. It verifies empty unscoped reads, rejects a cross-workspace write, and checks for queued confirmation jobs.
4. The source records a later opt-out. The original restore fails the consent comparison. The script then restores a fresh authoritative snapshot and verifies the later opt-out. A stale recipient list cannot pass the check.
5. The runner removes its own containers, volumes, temporary archive and role-secret directory. Each run uses a newly named project.

This Docker exercise compares logical recovery with the available source. A [second disposable drill](RETENTION_DRILL.md) restores with the source offline using a separately sealed checkpoint of workspace erasures and later suppressions. Production recovery needs independently protected checkpoint storage, recovery targets and a restore plan for attached services.

## Verification

On November 7, 2026, the digest-pinned images built and ran on an isolated local ARM64 Docker engine. A fresh native loopback demo created a synthetic workspace, saved a campaign and reopened it after a browser refresh. The Docker recovery drill accepted matching snapshots, refused a stale snapshot after an unsubscribe, and verified the newer opt-out and tenant isolation after recovery. Hosted Clerk, real email and payments were outside this exercise.
