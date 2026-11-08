# Foundation verification

November 6–7, 2026 (Mountain time) · staging branch `codex/foundation-workflow`. Initial local browser checks used `3d6e24d`, hosted signup passed on `b2bd70a`, and the authenticated database-backed workspace passed on `ab2f053`. The campaign and original image persisted across deployment of `b623487`. [Staged application CI](https://github.com/alandmunro/flockletter/actions/runs/42383563916)

This records a campaign-preparation foundation, not completion of all release-one requirements. Tests use fictional organizations and no external email, payment or production operations.

## Completed verification

- Lint, strict TypeScript checking, the tests and the production bundle passed on macOS and in [GitHub CI on Ubuntu 24.04 / Node 24 for the hosted sign-in build](https://github.com/alandmunro/flockletter/actions/runs/42331440426).
- The hosted sign-in build passed 75 tests. These include 22 plan/form contracts, 43 foundation integration and configuration cases, eight allowed-origin cases and two staging provisioning cases. The provisioning cases use disposable PostgreSQL 18 with a non-superuser administrator and exercise isolated database preparation, repeat activation, runtime privileges, seven forced row-level policies and safe error output. The foundation cases cover foreign references, empty-context reads, concurrent draft/version conflicts, original asset bytes, partial image batches, safe previews, per-brand tokens, current membership, revocation and disabled sends.
- Two additional HTTP regressions check the exact script, connection, frame and worker sources with and without a configured Clerk application. All 77 tests, lint, strict type checking and the production build passed with these cases.
- Nine browser-client regression cases cover one bounded renewal, identical command bodies, revoked sessions, denied membership, unavailable or unchanged refreshed tokens, a second rejection and a network failure with an unknown outcome. The complete 86-test suite, lint, type checking and production build passed.
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
| FL-AT-002/004 | Self-service staging signup, Google sign-in and refreshed session, Clerk development email-code sign-in, test organizations and workspace initialization | Apple and Microsoft callbacks, delivery of a Clerk verification code to a real mailbox, recovery, team roles and invitations |
| FL-AT-005/006 | Forced RLS, restricted shared-host runtime grants, two separate hosted organization views, hashed/revocable grants and redacted audit in the contract suite | Hosted membership revocation and platform support workflows |
| FL-AT-017/018 | Bounded decoded images, safe versioned preview, all gaps before preparation | Recipient snapshots, send approval and execution |
| FL-AT-025 | UI/HTTP/MCP canonical commands, stable retries, scoped grants, real HTTP/MCP contract | Remote OAuth MCP and actual external host acceptance |
| FL-AT-028/030 | Hosted private HTTPS sign-in, workspace writes, campaign preview and reload, gated sending, isolated local fixtures and browser forms/layout | Recovery and production readiness |

## Review findings resolved

An oversized base64 string exposed stack exhaustion in a repeated-group validation regex. Size checks and canonical decode/round-trip validation replaced it, with regression coverage. Concurrent edits now reject the losing expected version. The local form draft's HTTP-link guidance was corrected to match the HTTPS-only server contract. The initial MCP retry assertion compared JSON property order; it now compares the decoded result because PostgreSQL JSONB does not preserve object key order.

## Hosted staging

The subsequent PR #2 implementation adds separately gated first-party subscriber intake. Its staging database proof, captured email contract, admin UI and remaining live-provider gates are recorded in the [intake verification](SUBSCRIBER_INTAKE_OPERATIONS.md#november-7-staging-proof).

The separate Oregon web service has manual deploys. The initial gated deployment reached `live` on November 6 at 22:55 UTC. Render deployed the hosted sign-in revision `ef08d78` on November 7 at 02:55 UTC. The custom hostname resolves to the staging service, and Render issued its TLS certificate. [Staging website](https://flockletter.frostyflamingosoftware.com)

- A synthetic user completed Clerk passwordless email-code sign-in over the private HTTPS route and created a staging organization. Refreshing the Flockletter page retained the session and displayed the signed-in workspace setup status. This exercise used Clerk's development verification code.
- The first automated new-account attempt was blocked. Review found missing Clerk Protect and Cloudflare challenge sources in the browser policy. Revision `b2bd70a` reached Render `live` at 03:14 UTC on November 7. With protections enabled, a fresh synthetic customer signed up through the public staging hostname, verified the development email code, created a second organization and retained the session after refresh. The original private session also survived the update. [Clerk browser policy requirements](https://clerk.com/docs/guides/secure/best-practices/csp-headers)
- Before credentials were installed, `/readyz` returned HTTP 503 and workspace operations returned `setup_required`. [Initial setup screenshot](screenshots/staging-setup.png)
- On November 7 the release process activated the two dedicated roles and migrated `flockletter_staging`. It checked effective runtime access in three other database catalogs and verified seven tables with forced row-level security. The runtime role lacks database and schema creation privileges. The backend key and restricted runtime connection are on the web service. The migration credential is in an unlinked release group.
- The Free-plan deployment reached `live` at 14:16 UTC. Both the private HTTPS entry point and the canonical staging hostname returned HTTP 200 from `/readyz` with an empty gap list and sending disabled. Render's health check now uses this endpoint.
- Two Clerk organizations created independent workspaces and first brands. In the first workspace a mixed upload retained the original PNG and rejected the invalid image. The owner saved a campaign at version 2, previewed its content and original image, refreshed the browser, reopened the draft and verified its title, version and selected image. The second workspace showed an empty campaign list. The first owner also signed out and completed a new development email-code login on the private URL, returning to the saved workspace. [Reopened staging campaign](screenshots/staging-saved-campaign.png)
- An upload after an idle period initially returned `sign_in_required`. A page refresh succeeded. The browser client now refreshes the Clerk token once following that specific rejection, while binding the retry to the same session and organization and preserving the request body and operation key. The updated service reached `live` at 14:52 UTC on November 7. Both the workspace and the version-two campaign with its selected original image reopened after the service restart.
- Google sign-in returned to authenticated Flockletter workspace onboarding and survived a second refresh on the canonical staging hostname.
- The Apple attempt started on the private staging URL. Its callback returned to Clerk's hosted sign-in form about 41 minutes later. Clerk recorded `oauth_callback.failed` with provider `oauth_apple` and reason `state_token_expired`. The private app showed its sign-in form when reopened. A fresh end-to-end attempt awaits the account owner.
- Microsoft reached its official account sign-in page. The owner deferred the login, so its authenticated callback and refresh remain unverified.
- A separate mailbox sent one uniquely labeled message to the Flockletter alias and one to the support alias. Both arrived in the destination Gmail Inbox with the original recipient and matching test reference. This verifies inbound forwarding for each address.

## External verification remaining

Apple and Microsoft authenticated callbacks, Clerk verification-code delivery to a real inbox, outbound sender verification, hosted membership and delegated-token revocation, disaster recovery and paid activation remain open. Engine dispatch and billing have separate release gates.

## Actual model contributions

- Local model: drafted `CampaignFields.tsx`; the primary assistant reviewed it, corrected HTTPS guidance and customer-facing labels, and integrated it. Also drafted the plan and form-contract tests in `tests/contracts.test.ts`; chat removed a redundant full-object assertion, clarified that batch schema tests cover structure rather than image validity, and verified the result. Also drafted the local setup documentation; chat removed repetition and corrected a claim that setup gaps were resolved—the application reports those gaps. The reviewed setup/check instructions were incorporated into the README.
- Primary assistant in chat: architecture, authentication and scoped access, PostgreSQL/RLS/migrations, canonical command service, upload/preview safeguards, HTTP/MCP adapters, integration tests, application coordination, remaining UI/style, provider review, staging plan and final verification.
- A local stylesheet task was stopped after about 20 minutes with no returned draft. Chat authored that file to avoid holding up the build. No token/cost percentage is claimed.
- For hosted staging, the local model drafted the eight origin tests, the owner decision notes and a sign-in evidence summary. Chat verified the tests, corrected the support-forwarding assumption against the actual routing table and edited the evidence to distinguish sign-in from new-account signup. Chat handled the permission decisions, database bootstrap, proxy, provider setup, Clerk browser policy, two focused HTTP regression tests and live browser checks.
- For credential activation, the local model drafted the database and support-routing verification note. Chat reviewed it against the release output and clarified that the runtime lacks creation privileges. Chat configured Clerk, Render and Cloudflare, implemented the bounded session refresh and verified the authenticated workspace, image upload, campaign preview and persistence after restart.
- For the social sign-in and forwarding checks, the local model drafted the evidence note. Chat performed the provider and mailbox tests, checked the results and edited the note to distinguish the addressed aliases from the destination Inbox.

## November 7 staging campaign and workspace verification

Flockletter PR #7 added captured campaign rehearsal, public plan limits and the isolated billing adapter. On hosted staging a signed-in synthetic owner prepared the “First snow at the trailhead” subject, attached the original test image and captured one reviewed message. Its version and captured content survived refresh. The Listmonk integration test captured one confirmed fictional recipient and excluded the pending subscriber. [Campaign checks](https://github.com/alandmunro/flockletter/actions/runs/42418233060)

Workspace tests cover Clerk owner, editor and viewer journeys on real HTTP/PostgreSQL with synthetic membership, group-selected campaign snapshots after group deletion, lost confirmations, duplicate work, explicit date selection, opt-outs after review, test-only Stripe restart with archived evidence, and a 90-day retention preview. Native Chrome also submitted the marketing opt-out form with JavaScript disabled. A disposable two-database Docker restore rejected a stale subscriber snapshot and accepted a fresh snapshot that preserved the opt-out. The local Qwen model produced a support draft based on the three approved prices. Sensitive categories return a human handoff. [Workspace operations](WORKSPACE_OPERATIONS.md)

## Newsletter Studio

FL-AT-017/036 have automated proof for a saved Studio revision across the browser, HTTP, MCP and PostgreSQL. Tests cover two workspaces, scoped original assets, rejected unknown blocks, retained earlier content, recovery from a lost acknowledgment, stale approvals and frozen captures. The self-hosted build includes the dependency inventory and notices. [Studio workflow](NEWSLETTER_STUDIO.md) · [Engine proof](LISTMONK_CAPTURE.md#newsletter-studio-revisions) · [Staging PR](https://github.com/alandmunro/flockletter/pull/11)

| Client or renderer | Observed result |
| --- | --- |
| WebKit, 900 and 390 pixel viewports | One original PNG filled the 552-pixel body and two 268-pixel desktop columns. Ignoring image styles preserved the desktop fit. On the phone-width preview, all three images filled the available 358 pixels and the columns stacked in reading order. The preview made no external requests. |
| Gmail web, received message | An authorized self-test reached the test inbox. All three placements decoded at the original 480 × 180 resolution, displayed at 552, 268 and 268 pixels, and retained their separate alternative text. The collection button kept its destination. The received plaintext and HTML matched the fixture after line-ending normalization. All three image references used the one original PNG, verified by SHA-256. |
| Outlook | Actual client rendering is pending access to a signed-in test mailbox. The downloadable synthetic message can be opened there without another delivery. |
| Gmail phone app, received message | The owner opened the same self-test on their phone and confirmed that the two smaller photos stacked vertically, the collection button was visible and the message fit without sideways scrolling. |

## Scheduled staging delivery worker

The worker integration suite uses disposable PostgreSQL, HTTP and the MCP SDK. It checks a future schedule, an opt-out before dispatch (zero attempts), timeout followed by one receipt, concurrent workers, crash recovery, original image bytes, cancellation while a receipt is unresolved, changed drafts, missing reservations and cross-tenant access. A separate real Listmonk 6.2.0 loopback run scheduled two synthetic recipients; one was excluded, and one accepted submission produced exactly one authenticated messenger callback after a lost acknowledgment. Neither path contacted an external email provider. [Worker coverage](../../tests/staging-delivery-worker.test.ts) · [Engine proof](LISTMONK_CAPTURE.md)

The same 10 worker integration cases and 2 scheduler cases passed on the Flockletter Render staging host in an isolated database with the web service’s environment credentials removed. GitHub also ran the [pinned Listmonk container](https://github.com/alandmunro/flockletter/actions/runs/42432727774/job/128584934927) and the [restore drill](https://github.com/alandmunro/flockletter/actions/runs/42432727783/job/128584935114).

Local Qwen drafted the dashboard outcome display, recording-provider scaffold and messenger assertions. Chat corrected the attempt count for skipped recipients, accessibility labels, fixture assumptions and MIME checksum validation; it designed the durable claim/reconciliation, reviewed the implementation and ran the staging checks. No token or cost attribution is estimated.
# November 8 staging verification

[PR 19](https://github.com/alandmunro/flockletter/pull/19) passed the Linux checks, private Listmonk exercise and isolated database restore. Commit `2342a06` deployed to the existing free staging web service. Both staging origins reported healthy, with external campaign sending disabled.

In the signed-in verification workspace, a three-row CSV produced one new pending contact, one duplicate and one skipped address outside the reserved test domain. Opening the new contact showed its CSV row and no recorded subscriber consent. The Team screen read one member and zero invitations from staging Clerk. The Workspace panel calculated the Starter comparison and identified the missing SES binding and credentials while reporting the staging worker ready. This check did not send mail, start a Stripe trial or enroll a real subscriber.

## D-043: remaining integrations, November8

Built the separate operator surface, native/automated support, protected cross-workspace trial enrollment and hosted retention/recovery integrations. Multiple restricted-role PostgreSQL tests and exact HTTP/MCP authorization tests cover case expiry/revocation, same-case policy previews, immutable request keys, private namespace permission drift, unknown external outcomes and the erasure/write race. Source and acceptance details are in [platform completion](PLATFORM_COMPLETION.md), [trial protection](TRIAL_ABUSE.md), and [hosted retention](HOSTED_RETENTION.md).

The new normal browser journey opens a workspace-only operator case, drafts/reviews the exact support answer, records captured delivery and fits a390px screen. Existing seven customer workflows also pass normal desktop/mobile journeys with disposable data. [Desktop capture](evidence/platform-operator-desktop.png) · [Phone capture](evidence/platform-operator-mobile.png). Captures contain synthetic data.

Local Qwen drafts were used for fixture/test scaffolding, support UI presentation, retention types and playbook notes; chat corrected invalid imports/types, overly broad assertions and misleading capture/authority wording. Architecture, money/security decisions, implementation integration and all final review remain in chat. Percentages are not inferred from unmeasured token usage.

Live Stripe, Resend, AWS Object Lock/engine-disposal and hosted customer erasure checks remain activation work. No real customer email, charge, deletion or production release is represented by these captured/disposable tests. Staging release result is recorded after the reviewed merge/deployment.

Final local release checks: **88 test files,561 passing tests and2 explicitly gated engine tests**; lint, TypeScript and production build passed. Enabling the real private engine separately passed all5 engine tests, including both gated checks. Dependency audit found zero vulnerabilities; the locked Studio notice/build check passed. Both desktop/mobile operator and seven customer-workflow browser journeys passed.

The first D-043 hosted release merged through PR22 as `6fe47b0de448c5165de2b94e8924e51b87a73084` and became live in Render deploy `dep-dboeco15efls73dkievg`. Migrations were applied only to `flockletter_staging` using its existing restricted release roles; runtime permission/guard verification passed. `/readyz` returned200 with no gaps and sending disabled. `/api/config` reported staging, platform capture and captured/exercise customer workflows. A foreign-origin operator request returned403. The actual Clerk-signed owner control room loaded and stayed signed in after refresh; no business workspace was initialized merely to test credentials. The public staging site remains on the free plan.

Live native email acceptance still needs one authorized receiving-provider verification: Resend's current API reference documents provider-computed `authentication.dmarc`, while its OpenAPI document currently omits the field. The adapter treats missing/null/non-pass proof as quarantine and never trusts raw `Authentication-Results` headers. [API reference](https://resend.com/docs/api-reference/emails/retrieve-received-email) · [official OpenAPI](https://github.com/resend/resend-openapi/blob/main/resend.yaml). Outbound Reply-To is derived from the stored participant-bound thread, not customer input.
