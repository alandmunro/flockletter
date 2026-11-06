# Foundation verification

November 6, 2026 · implementation branch `codex/foundation-workflow`.

This records a campaign-preparation foundation, not completion of all release-one requirements. Tests use fictional organizations and no external email, payment or production operations.

## Completed locally

- Lint, strict TypeScript checking and the production bundle build pass.
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

## External verification remaining

The Flockletter staging Clerk application/keys and a dedicated restricted database connection are not available yet. Until those are supplied securely and migrated, the hosted setup page must remain gated, `/readyz` must return 503 and authenticated workflows cannot be marked passed. Shared PostgreSQL capacity/effective grants, four real login methods, engine dispatch, delivery, billing and paid/public activation have not been verified. No production service was changed.

## Actual model contributions

- Local model: drafted `CampaignFields.tsx`; the primary assistant reviewed it, corrected HTTPS guidance and customer-facing labels, and integrated it. Also drafted the plan and form-contract tests in `tests/contracts.test.ts`; chat removed a redundant full-object assertion, clarified that batch schema tests cover structure rather than image validity, and verified the result. A factual setup-document draft was assigned separately.
- Primary assistant in chat: architecture, authentication and scoped access, PostgreSQL/RLS/migrations, canonical command service, upload/preview safeguards, HTTP/MCP adapters, integration tests, application coordination, remaining UI/style, provider review, staging plan and final verification.
- A local stylesheet task was stopped after about 20 minutes with no returned draft. Chat authored that file to avoid holding up the build. No token/cost percentage is claimed.
