# Staging setup and acceptance

The Flockletter staging web service runs in the existing Render workspace, Oregon region. It uses the Free plan and the implementation branch with automatic deployment off. Its Clerk development application, staging database and release secrets belong to Flockletter.

The setup page is deployed at [flockletter-staging.onrender.com](https://flockletter-staging.onrender.com). Its [Render service](https://dashboard.render.com/web/srv-dbn5lb6gekts738v63ag) is the destination for Flockletter-only configuration. See the verification record for the exact application revision and observed gates.

## Service configuration

Build: `npm ci --include=dev && npm run build`.

Start: `npm start`.

Nonsecret settings: `APP_ENV=staging`, `HOST=0.0.0.0`, `NODE_VERSION=24`, `LOCAL_TEST_IDENTITY=false`, and `APP_ORIGIN` equal to the exact HTTPS staging origin. Render supplies `PORT`. Do not set production mode or copy a local `.env` into the service. The application explicitly refuses synthetic identity on a hosted service.

The publishable Clerk key enables hosted sign-in, organization setup and session persistence. If the backend key or runtime database connection is missing, a signed-in user sees the remaining workspace setup status. `/healthz` checks whether the process is running. `/readyz` returns HTTP 503 with the outstanding gaps and the workspace API returns `setup_required`. After activating both backend credentials, require HTTP 200 from `/readyz` and a successful authenticated workspace operation before switching the operational health check to `/readyz`.

## Required isolated configuration

Set secrets in Render's Environment screen, not in source control or chat:

| Setting | Required value |
| --- | --- |
| `CLERK_PUBLISHABLE_KEY` | The Flockletter staging Clerk application's publishable key |
| `CLERK_SECRET_KEY` | That same staging application's backend secret |
| `DATABASE_URL` | Restricted runtime role in a dedicated `flockletter_staging` logical database; TLS where required |

Configure Clerk Organizations and Google, Apple, Microsoft and email verification-code login in the Flockletter instance. Only current `org:admin` members receive foundation authority. Use two synthetic organizations for acceptance. Do not reuse another application's identities, production keys or customer membership.

Create the dedicated logical database and migration/runtime identities through an authorized database administration path. Before shared-host activation, inspect database storage, connections, memory/CPU and effective inherited grants; preserve existing applications' roles/settings. The runtime must have CONNECT/USAGE and DML on Flockletter tables only, no schema/database CREATE, role ownership, superuser or BYPASSRLS authority, and no role membership that grants those privileges. Revoke default PUBLIC privileges on the new logical database. Configure the runtime to connect only to the Flockletter database. If the shared cluster grants CONNECT through PUBLIC, inspect the runtime role’s effective foreign table, sequence, schema and privileged-function access through the catalogs before activation. Keep the migration credential outside the running web service.

Apply `npm run db:migrate` using `MIGRATION_DATABASE_URL` and `RUNTIME_DATABASE_ROLE` from a protected release environment. This runs the idempotent foundation schema under a migration lock. It does not create database roles or change shared host grants. Then deploy with only the restricted `DATABASE_URL`. Startup verifies the dedicated database name, role privileges and forced row-level policies. A failed check must be fixed, not bypassed.

## Acceptance after configuration

1. Deploy the exact reviewed commit; wait for that deploy to become live. Require `/readyz` to return 200 with no gaps and sending disabled.
2. Verify the four real Clerk login methods, organization selection and owner authorization; a token from another Clerk application must fail. Remove a test membership and confirm that both its session and delegated connection lose access.
3. In two synthetic organizations, create a first brand/draft, upload original test images with a deliberately bad file, preview a saved version, then reload and confirm persistence. Try foreign IDs and stale updates.
4. Issue a minimal test connection, exercise the documented MCP preparation flow, revoke it and confirm rejection. Keep secrets out of screenshots and logs.
5. Verify no send/test/billing route and no production credentials. Check desktop/phone navigation and the original logo. Restart the web process and verify stored drafts/images remain intact.

The local test suite already exercises real database isolation and the HTTP/MCP path. Its injected identity provider is not a live Clerk check. No email, Stripe purchase, engine provisioning or production deployment is part of foundation acceptance.

## Operator bootstrap and private URL

Run `scripts/provision-staging.mjs` from a private release process on the existing staging database network. Disable terminal echo and supply the administration connection, exact host and source database as one JSON line on standard input using `adminUrl`, `expectedHost` and `expectedSource`. Keep the cluster administrator connection out of web service settings.

1. Run `inspect` to check the staging host, permissions, database and role ownership markers, and connection headroom.
2. Run `prepare` to create the dedicated logical database with connections disabled and remove public database privileges. This step can finish before any application credentials are issued.
3. Run `apply` with distinct 32-byte random hex values for `runtimePassword` and `migratorPassword`. It inspects accessible foreign catalogs for effective application grants, migrates the dedicated database, and checks the resulting runtime role and seven forced row-level policies. Reuse the same role secrets on a retry.
4. Store the restricted runtime connection and the Flockletter Clerk development backend key on the staging web service. Keep the migrator connection in the unlinked release environment group. Follow the authenticated acceptance steps above.

The selected custom hostname is `flockletter.frostyflamingosoftware.com`. Set `APP_ORIGIN` to the canonical staging origin and `APP_ADDITIONAL_ORIGINS` to any other approved exact HTTPS origins. The browser origin check and Clerk session validator share this list. The local synthetic identity supports only its loopback origin.

For a private Tailscale entry point, run `node scripts/tailnet-proxy.mjs` on the operator host with `FLOCKLETTER_STAGING_ORIGIN`, `FLOCKLETTER_TAILNET_ORIGIN` and an optional `FLOCKLETTER_PROXY_PORT` (default 4311). Point a dedicated Tailscale Serve HTTPS port at that loopback port. Use the private origin in the staging allowlist and verify `/healthz`, `/readyz`, and sign-in through the actual private URL. The proxy forwards requests to its configured HTTPS staging service and keeps the original browser origin for authentication.
