# Foundation verification

November 6, 2026 (Mountain time) · staging branch `codex/foundation-workflow`. The initial local browser campaign checks used application revision `3d6e24d`. Private hosted sign-in passed on `ef08d78`. New-account signup, organization setup and sign-in persistence passed on staging revision `b2bd70a`. [Staged revision and CI](https://github.com/alandmunro/flockletter/actions/runs/42333005851)

This records a campaign-preparation foundation, not completion of all release-one requirements. Tests use fictional organizations and no external email, payment or production operations.

## Completed verification

- Lint, strict TypeScript checking, the tests and the production bundle passed on macOS and in [GitHub CI on Ubuntu 24.04 / Node 24 for the hosted sign-in build](https://github.com/alandmunro/flockletter/actions/runs/42331440426).
- The hosted sign-in build passed 75 tests. These include 22 plan/form contracts, 43 foundation integration and configuration cases, eight allowed-origin cases and two staging provisioning cases. The provisioning cases use disposable PostgreSQL 18 with a non-superuser administrator and exercise isolated database preparation, repeat activation, runtime privileges, seven forced row-level policies and safe error output. The foundation cases cover foreign references, empty-context reads, concurrent draft/version conflicts, original asset bytes, partial image batches, safe previews, per-brand tokens, current membership, revocation and disabled sends.
- Two additional HTTP regressions check the exact script, connection, frame and worker sources with and without a configured Clerk application. All 77 tests, lint, strict type checking and the production build passed with these cases.
- A real MCP SDK client initializes, lists tools and calls the bridge; the bridge calls an actual local HTTP server and PostgreSQL. The MCP transport in this contract test is in-memory. This proves protocol/command parity, not a remote OAuth deployment or third-party host connection.
- The Clerk adapter tests inject synthetic membership and session facts. A separate hosted browser test verified passwordless sign-in, organization creation and session persistence against the actual Flockletter development instance.
- A browser created the fictional Alpine Paper workspace, uploaded a valid original image together with a deliberately invalid file, saw the valid file remain saved, authored a campaign, saved version 2 and reviewed its HTML and plain-text controls. A reload retained the workspace, original image and draft. The preview displayed all four delivery prerequisite groups without claiming a send.
- Desktop and 390-pixel phone layouts were inspected. No document overflow was observed, all primary form fields are labelled, and the original 1475 × 1067 software logo loads in the upper-right header. The iframe uses an empty sandbox permission list. No browser console errors were recorded during the flow. This is a focused accessibility check, not a comprehensive accessibility certification.
- The dependency audit reports no known vulnerabilities after overriding the development-only minimatch dependency to the fixed 11.0.1 release. Lint passes with that override.

Browser evidence: [desktop overview](screenshots/overview-desktop.png), [phone overview](screenshots/overview-phone.png), [saved campaign preview](screenshots/campaign-preview.png). The solid-color campaign image is an intentionally synthetic test fixture, not an FFA product photo.

## Requirement coverage and limits

| Cases | Foundation evidence | Still outside this evidence |
| --- | --- | --- |
| FL-AT-001/003 | Independent source, local setup, canonical plan data, unchanged logo | Full hosted/self-hosted mailing release |
| FL-AT-002/004 | Idempotent workspace initialization in disposable PostgreSQL, self-service staging signup, hosted Clerk email-code sign-in, test organizations and refreshed sessions | Actual mailbox and social login, recovery, team roles and invitations |
| FL-AT-005/006 | Real RLS, tenant/brand checks, hashed/revocable grants, redacted audit | Activated shared-host grants and platform support workflows |
| FL-AT-017/018 | Bounded decoded images, safe versioned preview, all gaps before preparation | Recipient snapshots, send approval and execution |
| FL-AT-025 | UI/HTTP/MCP canonical commands, stable retries, scoped grants, real HTTP/MCP contract | Remote OAuth MCP and actual external host acceptance |
| FL-AT-028/030 | Isolated local fixtures, browser forms/layout, gated workspace API, hosted private HTTPS sign-in | Authenticated hosted database workflow, recovery and production readiness |

## Review findings resolved

An oversized base64 string exposed stack exhaustion in a repeated-group validation regex. Size checks and canonical decode/round-trip validation replaced it, with regression coverage. Concurrent edits now reject the losing expected version. The local form draft's HTTP-link guidance was corrected to match the HTTPS-only server contract. The initial MCP retry assertion compared JSON property order; it now compares the decoded result because PostgreSQL JSONB does not preserve object key order.

## Hosted staging

The separate Oregon web service has manual deploys. The initial gated deployment reached `live` on November 6 at 22:55 UTC. Render deployed the hosted sign-in revision `ef08d78` on November 7 at 02:55 UTC. The custom hostname resolves to the staging service, and Render issued its TLS certificate. [Staging website](https://flockletter.frostyflamingosoftware.com)

- A synthetic user completed Clerk passwordless email-code sign-in over the private HTTPS route and created a staging organization. Refreshing the Flockletter page retained the session and displayed the signed-in workspace setup status. This exercise used Clerk's development verification code.
- The first automated new-account attempt was blocked. Review found missing Clerk Protect and Cloudflare challenge sources in the browser policy. Revision `b2bd70a` reached Render `live` at 03:14 UTC on November 7. With protections enabled, a fresh synthetic customer signed up through the public staging hostname, verified the development email code, created a second organization and retained the session after refresh. The original private session also survived the update. Google, Apple and Microsoft appeared as available choices. Interactive social sign-in and actual mailbox delivery still need testing. [Clerk browser policy requirements](https://clerk.com/docs/guides/secure/best-practices/csp-headers)
- A private database inspection confirmed connection headroom. The operator created `flockletter_staging` on the existing staging instance with connections disabled and removed public database privileges. Runtime and migration access have separate destinations. The web service has its publishable key and editable entries for its backend key and runtime connection.
- `/healthz` returned HTTP 200. `/readyz` returned HTTP 503 with `database_not_configured`, `clerk_not_configured` and `service_not_ready`, and reported sending disabled. A workspace API call returned `setup_required`. The initial empty-configuration view is archived in the [setup screenshot](screenshots/staging-setup.png).
- Cloudflare showed an active forwarding rule for the requested Flockletter sender address. This verifies inbound routing configuration. Outbound sender verification and receipt of forwarded mail still need separate checks.

## External verification remaining

The staging operator still needs to activate the dedicated database roles, migrate the database and install the restricted runtime connection and Clerk backend key. Hosted database writes, cross-organization isolation, revocation and restart persistence remain open. The campaign preparation flow was verified on disposable PostgreSQL. Engine dispatch, billing and production activation remain outside this deployment.

## Actual model contributions

- Local model: drafted `CampaignFields.tsx`; the primary assistant reviewed it, corrected HTTPS guidance and customer-facing labels, and integrated it. Also drafted the plan and form-contract tests in `tests/contracts.test.ts`; chat removed a redundant full-object assertion, clarified that batch schema tests cover structure rather than image validity, and verified the result. Also drafted the local setup documentation; chat removed repetition and corrected a claim that setup gaps were resolved—the application reports those gaps. The reviewed setup/check instructions were incorporated into the README.
- Primary assistant in chat: architecture, authentication and scoped access, PostgreSQL/RLS/migrations, canonical command service, upload/preview safeguards, HTTP/MCP adapters, integration tests, application coordination, remaining UI/style, provider review, staging plan and final verification.
- A local stylesheet task was stopped after about 20 minutes with no returned draft. Chat authored that file to avoid holding up the build. No token/cost percentage is claimed.
- For hosted staging, the local model drafted the eight origin tests, the owner decision notes and a sign-in evidence summary. Chat verified the tests, corrected the support-forwarding assumption against the actual routing table and edited the evidence to distinguish sign-in from new-account signup. Chat handled the permission decisions, database bootstrap, proxy, provider setup, Clerk browser policy, two focused HTTP regression tests and live browser checks.
