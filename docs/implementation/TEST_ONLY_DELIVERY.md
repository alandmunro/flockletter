# Test-only delivery preparation

Applicable requirements: FL-CAM-002/003/005/006/010, FL-DEL-002/004/005/008, FL-USG-001/002/005, FL-API-001/003 and FL-OPS-003/004/007. D-052 authorizes building this scope; activation and a specific external message remain separately approved.

## What the scope restricts

`FLOCKLETTER_CUSTOMER_DELIVERY_SCOPE=tests` narrows the existing delivery workflow to D-047's separately reviewed, immediate, one-confirmed-contact tests. The transport remains `off`, `capture` or `ses`. The default scope `all` preserves the prior behavior and still requires ordinary campaign approval and the live-activation flag for SES. Invalid scopes fail startup.

In test-only scope the canonical service refuses broadcast reviews and approvals, including one-recipient broadcasts. A paused broadcast cannot resume. The worker blocks previously queued/prepared broadcasts before a new submission and releases unaccepted reservations. Previously submitted uncertain outcomes still reconcile against the original operation; scope changes never authorize resending them. SES additionally rejects a missing or broadcast envelope purpose, even if its subject starts with `[TEST]`. Purpose comes from the immutable server review.

The five approved tests per workspace per UTC day, frozen campaign/recipient/sender, allowance accounting, current membership and grant checks, consent/suppression, same-day dispatch admission and ambiguous-outcome safeguards are unchanged. Scope does not create a subscriber, a complimentary entitlement or permission to send. The UI disables broadcast audience, schedule, review, approval and resume controls while retaining the draft selector, one-recipient tests, cancellation and reconciliation. Workspace setup, Operations, preflight, HTTP and MCP expose the same scope.

## Staging rehearsal

Keep staging on Free, its isolated database and development Clerk. Use existing `capture` and billing/audience exercise settings with `FLOCKLETTER_CUSTOMER_DELIVERY_SCOPE=tests`. No external mail credential or activation flag is needed for capture. Exercise a confirmed synthetic contact through saved draft, test preflight, review, exact approval, captured message and refresh recovery. Verify broadcast actions fail through direct HTTP/MCP as well as the browser. A capture is not inbox delivery.

## Preparation for the first real inbox test

Before changing any external mode, gather all gaps through `workspace.preflight`, `operations.status` and the exact `delivery.preflight` with `purpose: test` and the known same-brand subscriber ID:

1. Identify the actual FFA workspace, brand and authorized operator; record the accepted complimentary Growth grant through its existing audited operation. Do not infer the grant from a name/domain or create duplicate workspaces.
2. Configure and verify the existing production renderer, worker and restricted SES route/credentials, tenant, sender identity, configuration set, signed feedback and unsubscribe signer. Maintain per-workspace/brand isolation. Verify SES production access and current quotas/plan; this scope does not bypass sandbox-exit or public-delivery readiness requirements.
3. Establish one genuinely confirmed, consent-eligible test contact. Captured staging confirmation cannot establish production consent. Real confirmation delivery retains its own provider/activation checks.
4. Prepare the saved letter with subject, meaningful plain text, original images and legal sender/footer. Present the exact recipient, sender, saved revision and immediate timing before approval.
5. Only after separate test-activation approval, configure both production web and worker with `FLOCKLETTER_CUSTOMER_DELIVERY=ses`, `FLOCKLETTER_CUSTOMER_DELIVERY_SCOPE=tests`, `FLOCKLETTER_TEST_MAILING_APPROVED=true`, and keep `FLOCKLETTER_LIVE_MAILING_APPROVED=false`. Keep live billing off. Ordinary SES mappings, private-engine settings and credentials must already be verified. The tests flag alone cannot activate `all` scope; a broad-mail flag alone cannot activate test-only scope.
6. Use `delivery.reviewTest` then `delivery.approveTest` for the approved one-recipient snapshot. Observe provider acceptance, authenticated delivery feedback and actual inbox receipt separately. Check unsubscribe and resulting suppression before broad activation. No fresh operation may conceal an uncertain outcome.

`/api/config` and `/readyz` retain `sendingEnabled=false` for test-only SES and expose `testSendingEnabled=true`; this means the test transport is configured, not that any message is eligible or delivered. `delivery.status` additionally exposes `scope`, `broadcastsEnabled` and the separate test-transport flag. Operations uses the same distinction. With delivery off, both external-send flags stay false. Code promotion alone changes no mode or approval flag.

## Rollback and evidence

Disable transport to stop new external sends, or retain `tests` scope to keep broadcasts blocked. Do not roll back to code that lacks the scope check while leaving the test-activation flag/SES configuration installed. Retain original operation keys, reservations and signed feedback for uncertain outcomes. Never erase provider facts or reset daily admissions to make a retry succeed.

Validation and deployment results are recorded after running checks. The local model drafted the pure scope notice, its SSR test and the disposable-database test scaffold. Chat corrected duplicated contract types, wrong imports, a false status expectation, an assertion that could not observe capture submission, and the test-file extension; chat owns the policy, shared enforcement, API/MCP/admin integration, activation guards, independent reconciliation/transport tests and final review. No live-provider or inbox success is claimed by local tests.

Local validation on November 10 passed lint, type checking, production build and 121 test files (972 passing cases; two existing gated native checks skipped). The desktop and 390px browser proof passed with `capture` plus `tests` scope: broadcast review/audience/schedule controls were disabled, the explicit single-recipient review/approval completed, a lost acknowledgment reused its operation key, photos and draft remained unchanged, and refresh restored the saved test. Independent database cases cover narrowed-scope approval/resume/worker denial, reservation release, canonical MCP denial and reconciliation of an already-submitted broadcast without another send. Provider tests intercept the SES SDK; they prove the request boundary and activation checks, not an AWS send. Staging deployment and real-inbox checks remain separate observations.
