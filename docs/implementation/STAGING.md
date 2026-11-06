# Staging setup and acceptance

Use a separate Flockletter web service in the existing Render workspace, Oregon region. The first setup preview uses the Free plan and the implementation branch with automatic deployment off. It has no database or provider credentials until separately configured. No FFA or Cadence services need to be resumed for this independent foundation, and no existing settings or photos are changed.

The setup page is deployed at [flockletter-staging.onrender.com](https://flockletter-staging.onrender.com). Its [Render service](https://dashboard.render.com/web/srv-dbn5lb6gekts738v63ag) is the destination for Flockletter-only configuration. See the verification record for the exact application revision and observed gates.

## Service configuration

Build: `npm ci --include=dev && npm run build`.

Start: `npm start`.

Nonsecret settings: `APP_ENV=staging`, `HOST=0.0.0.0`, `NODE_VERSION=24`, `LOCAL_TEST_IDENTITY=false`, and `APP_ORIGIN` equal to the exact HTTPS staging origin. Render supplies `PORT`. Do not set production mode or copy a local `.env` into the service. The application explicitly refuses synthetic identity on a hosted service.

The setup preview can serve a clear setup page and `/healthz` while credentials are absent. `/readyz` must return **503 with setup gaps**, and every `/api/v1` operation must remain unavailable. A Render `live` deploy in this state proves that the build and process work; it does **not** prove authenticated staging readiness. Configure the operational HTTP health check as `/readyz` only after completing setup. Do not relabel `/healthz` as an authenticated acceptance check.

## Required isolated configuration

Set secrets in Render's Environment screen, not in source control or chat:

| Setting | Required value |
| --- | --- |
| `CLERK_PUBLISHABLE_KEY` | The Flockletter staging Clerk application's publishable key |
| `CLERK_SECRET_KEY` | That same staging application's backend secret |
| `DATABASE_URL` | Restricted runtime role in a dedicated `flockletter_staging` logical database; TLS where required |

Configure Clerk Organizations and Google, Apple, Microsoft and email verification-code login in the Flockletter instance. Only current `org:admin` members receive foundation authority. Use two synthetic organizations for acceptance. Do not reuse another application's identities, production keys or customer membership.

Create the dedicated logical database and migration/runtime identities through an authorized database administration path. Before shared-host activation, inspect database storage, connections, memory/CPU and effective inherited grants; preserve existing applications' roles/settings. The runtime must have CONNECT/USAGE and DML on Flockletter tables only, no schema/database CREATE, role ownership, superuser or BYPASSRLS authority, and no role membership that grants those privileges. Revoke default PUBLIC privileges on the new logical database. It must not connect to other application databases. Keep the migration credential outside the running web service.

Apply `npm run db:migrate` using `MIGRATION_DATABASE_URL` and `RUNTIME_DATABASE_ROLE` from a protected release environment. This runs the idempotent foundation schema under a migration lock. It does not create database roles or change shared host grants. Then deploy with only the restricted `DATABASE_URL`. Startup verifies the dedicated database name, role privileges and forced row-level policies. A failed check must be fixed, not bypassed.

## Acceptance after configuration

1. Deploy the exact reviewed commit; wait for that deploy to become live. Require `/readyz` to return 200 with no gaps and sending disabled.
2. Verify the four real Clerk login methods, organization selection and owner authorization; a token from another Clerk application must fail. Remove a test membership and confirm that both its session and delegated connection lose access.
3. In two synthetic organizations, create a first brand/draft, upload original test images with a deliberately bad file, preview a saved version, then reload and confirm persistence. Try foreign IDs and stale updates.
4. Issue a minimal test connection, exercise the documented MCP preparation flow, revoke it and confirm rejection. Keep secrets out of screenshots and logs.
5. Verify no send/test/billing route and no production credentials. Check desktop/phone navigation and the original logo. Restart the web process and verify stored drafts/images remain intact.

The local test suite already exercises real database isolation and the HTTP/MCP path. Its injected identity provider is not a live Clerk check. No email, Stripe purchase, engine provisioning or production deployment is part of foundation acceptance.

## Missing setup handoff

Collect these together when independent work is complete: the Flockletter staging Clerk application/configuration; a restricted connection for its isolated logical database plus an authorized migration path; and any required DNS/social-provider configuration. They are specific configuration data, not a request to reapprove routine implementation. The existing authorization to resume FFA staging remains available if a later FFA integration needs it.
