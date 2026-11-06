# Foundation verification

November 6, 2026 · application revision `3d6e24dc70d297be39ba0267f44c8d2313359897` on `codex/foundation-workflow`. Later documentation/workflow-only updates do not change the tested application.

This records a campaign-preparation foundation, not completion of all release-one requirements. Tests use fictional organizations and no external email, payment or production operations.

## Completed verification

- Lint, strict TypeScript checking and the production bundle build pass locally and in [GitHub CI on Ubuntu 24.04 / Node 24](https://github.com/alandmunro/flockletter/actions/runs/42308161993). Local execution used macOS / Node 26.
- 65 tests pass: 22 plan/form contract cases and 43 integration/security/configuration cases. The latter run using a real disposable PostgreSQL 18 instance and a restricted runtime role. Coverage includes forced tenant policies, foreign references, empty-context reads, concurrent draft creation/version conflicts, operation-key conflicts, mixed/oversized image batches, preservation of original bytes, private asset access, safe previews, all upfront setup gaps, per-brand credentials, token hash storage, expiry/revocation, current membership checks and disabled sends.
- A real MCP SDK client initializes, lists tools and calls the bridge; the bridge calls an actual local HTTP server and PostgreSQL. The MCP transport in this contract test is in-memory. This proves protocol/command parity, not a remote OAuth deployment or third-party host connection.
- The Clerk adapter compiles against inspected current SDK contracts. Authorization tests inject synthetic membership/session facts; actual Clerk login methods and real revocation remain external checks.
- A browser created the fictional Alpine Paper workspace, uploaded a valid original image together with a deliberately invalid file, saw the valid file remain saved, authored a campaign, saved version 2 and reviewed its HTML and plain-text controls. A reload retained the workspace, original image and draft. The preview displayed all four delivery prerequisite groups without claiming a send.
- Desktop and 390-pixel phone layouts were inspected. No document overflow was observed, all primary form fields are labelled, and the original 1475 × 1067 software logo loads in the upper-right header. The iframe uses an empty sandbox permission list. No browser console errors were recorded during the flow. This is a focused accessibility check, not a comprehensive accessibility certification.
- The dependency audit reports no known vulnerabilities after overriding the development-only minimatch dependency to the fixed 11.0.1 release. Lint passes with that override.

Browser evidence: [desktop overview](screenshots/overview-desktop.png), [phone overview](screenshots/overview-phone.png), [saved campaign preview](screenshots/campaign-preview.png). The solid-color campaign image is an intentionally synthetic test fixture, not an FFA product photo.

## Requirement coverage and limits

| Cases | Foundation evidence | Still outside this evidence |
| --- | --- | --- |
| FL-AT-001/003 | Independent source, local setup, canonical plan data, unchanged logo | Full hosted/self-hosted mailing release |
| FL-AT-002/004 | Idempotent workspace initialization, verified-auth adapter, current-owner enforcement | Real Clerk signup/social login, recovery, team roles and invitations |
| FL-AT-005/006 | Real RLS, tenant/brand checks, hashed/revocable grants, redacted audit | Activated shared-host grants and platform support workflows |
| FL-AT-017/018 | Bounded decoded images, safe versioned preview, all gaps before preparation | Recipient snapshots, send approval and execution |
| FL-AT-025 | UI/HTTP/MCP canonical commands, stable retries, scoped grants, real HTTP/MCP contract | Remote OAuth MCP and actual external host acceptance |
| FL-AT-028/030 | Isolated local fixtures, browser forms/layout, fail-closed hosted configuration | Authenticated staging, recovery and production readiness |

## Review findings resolved

An oversized base64 string exposed stack exhaustion in a repeated-group validation regex. Size checks and canonical decode/round-trip validation replaced it, with regression coverage. Concurrent edits now reject the losing expected version. The local form draft's HTTP-link guidance was corrected to match the HTTPS-only server contract. The initial MCP retry assertion compared JSON property order; it now compares the decoded result because PostgreSQL JSONB does not preserve object key order.

## Render setup deployment

[Staging setup page](https://flockletter-staging.onrender.com) is live on the Free web-service plan. Deploy `dep-dbn5lbegekts738v63mg` reached `live` at 2026-11-06 22:55:25 UTC for application commit `3d6e24dc70d297be39ba0267f44c8d2313359897`. Automatic deploys are off.

Observed after deployment: `/healthz` returned 200; `/readyz` returned 503 with `database_not_configured`, `clerk_not_configured` and `service_not_ready`; an attempted workspace API request returned 503 `setup_required`. The browser showed the setup explanation, loaded the unchanged logo, had no horizontal overflow and recorded no console errors. [Screenshot](screenshots/staging-setup.png).

This is successful deployment of the gated setup page, **not successful authenticated staging acceptance**. The working preparation flow was exercised locally with a real disposable database and synthetic identity. FFA/Cadence services were neither resumed nor modified.

## External verification remaining

The Flockletter staging Clerk application/keys and a dedicated restricted database connection are not available yet. Until those are supplied securely and migrated, the hosted setup page must remain gated, `/readyz` must return 503 and authenticated workflows cannot be marked passed. Shared PostgreSQL capacity/effective grants, four real login methods, engine dispatch, delivery, billing and paid/public activation have not been verified. No production service was changed.

## Actual model contributions

- Local model: drafted `CampaignFields.tsx`; the primary assistant reviewed it, corrected HTTPS guidance and customer-facing labels, and integrated it. Also drafted the plan and form-contract tests in `tests/contracts.test.ts`; chat removed a redundant full-object assertion, clarified that batch schema tests cover structure rather than image validity, and verified the result. Also drafted the local setup documentation; chat removed repetition and corrected a claim that setup gaps were resolved—the application reports those gaps. The reviewed setup/check instructions were incorporated into the README.
- Primary assistant in chat: architecture, authentication and scoped access, PostgreSQL/RLS/migrations, canonical command service, upload/preview safeguards, HTTP/MCP adapters, integration tests, application coordination, remaining UI/style, provider review, staging plan and final verification.
- A local stylesheet task was stopped after about 20 minutes with no returned draft. Chat authored that file to avoid holding up the build. No token/cost percentage is claimed.
