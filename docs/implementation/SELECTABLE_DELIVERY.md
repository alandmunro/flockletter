# Selectable AWS SES and Resend delivery

## Behavior
*   **Provider Selection:** Workspace owners select the email provider (SES or Resend) via the Delivery screen. The `delivery.providers` command reads it; `delivery.selectProvider` records the revisioned choice in protected brand-scoped storage.
*   **Revision Control:** Provider selection changes require the current revision and operation key. Changing the provider invalidates unsubmitted reviews, requiring a fresh review cycle.
*   **No Automatic Fallback:** API errors or timeouts do not trigger failover to another provider.
*   **Modes:**
    *   `off`: No external sends.
    *   `capture`: No external sends; retains internal records only.
    *   `ses` / `resend`: External delivery via the selected provider.
*   **Compatibility:** Default SES configuration remains compatible with existing setups. No general sending or billing activation is authorized by this code change alone.
*   **Reconciliation:** Authenticated facts are reconciled only via the original route/provider used for the send.
*   **Idempotency:** Durable intents and stable per-recipient idempotency keys are enforced. Unknown outcomes remain marked as uncertain.
*   **Content Integrity:** Original image bytes are preserved, CID attachments are maintained, and required unsubscribe headers/links and postal footers are included.

## Prerequisites/Gaps Upfront
*   **Migration:** Migration `033` must be applied before deploying code.
*   **Resend Eligibility:** Verify current Resend policy, account eligibility, plan capacity, and customer platform suitability before external activation.
*   **Resend Configuration:** Distinct sending/retrieval credentials must be configured for Resend. A verified owned domain is required. Tracking must be disabled. An authenticated feedback endpoint must be established.
*   **SES Configuration:** The `productionAccess` gate remains active for SES.
*   **Provider-Readiness Checks:** These are observations, not send authorizations. They are provider-specific and do not imply AWS-specific approval for Resend.
*   **Test-Only Scope:** Scope tests remain independent of the provider; five approved test requests per workspace per UTC day limit is unchanged.

## Staging Verification
*   **Data Isolation:** Use isolated staging data.
*   **Mocked Contracts:** Provider contract tests are mocked and explicitly do not prove live Resend functionality.
*   **Capture Mode:** Verify that `capture` mode retains no external sends.
*   **Provider Selection Flow:** Test the selection of SES and Resend via the Delivery screen, ensuring revision and operation key requirements are enforced. External adapters remain production-only; the staging site stays in capture mode. The selectable-external flow is exercised in an isolated local application with substituted provider ports, not real credentials.
*   **Invalidation Logic:** Verify that switching providers invalidates unsubmitted reviews and prevents duplication or movement of unknown/already-submitted attempts.

## Production Activation Checklist
*   **Configuration:** Set `FLOCKLETTER_CUSTOMER_DELIVERY` to `ses` or `resend`.
*   **Scope:** Set `FLOCKLETTER_CUSTOMER_DELIVERY_SCOPE` to `all` or `tests`.
*   **Approvals:** For `tests`, require only the separately approved test flag and keep the broadcast flag false; for `all`, require separate broadcast activation. This change enables neither.
*   **Server Allowlists:** Confirm server config allowlists providers/routes correctly.
*   **Client Constraints:** Verify client supplies only the enum (`ses`/`resend`) and never keys or endpoints.
*   **Resend Pre-Checks:** Confirm Resend domain verification, credential isolation, and feedback endpoint authentication are live.
*   **SES Pre-Checks:** Confirm SES production access gate status is valid for the target accounts.

## Rollback
*   **Disable Delivery:** Set `FLOCKLETTER_CUSTOMER_DELIVERY` to `off`.
*   **Data Retention:** Retain receipt and reconciliation data.
*   **Schema Warning:** Do not roll back the database schema blindly; migration `033` preserves existing records and expands the mode constraint and should remain unless specific data corruption is identified.

## Evidence Boundaries
*   **No Live Proof:** Staging tests do not constitute live Resend proof.
*   **Readiness vs. Authorization:** Provider readiness checks are observations and do not authorize sending.
*   **No Automatic Failover Evidence:** Logs must show that errors/timeouts did not result in provider switching.
*   **Reconciliation Scope:** Evidence of reconciliation is limited to the original route/provider used for each attempt.

## Exact configuration and access

Applicable requirements: FL-DEL-001–009, FL-CAM-003/005/006/010, FL-ID-002/004/005, FL-USG-001/002/005, FL-API-001–003 and FL-OPS-001/003/004/006/007. D-055 accepts both services and implementation; live verification remains separate.

`FLOCKLETTER_CUSTOMER_DELIVERY=ses|resend` chooses the default external service; `off` and `capture` retain their existing meaning. A per-brand saved choice overrides only an external default. Existing SES environments require no Resend configuration. To offer both, configure both services on the matching web/worker. Changing a choice requires `expectedRevision` and a stable `operationKey`; even switching away and back invalidates an older review. Migration 033 freezes stored provider routing at the database boundary and includes forced brand RLS, restricted runtime grants and erasure/restore guards.

| Setting | Purpose |
| --- | --- |
| `FLOCKLETTER_CUSTOMER_RESEND_KEY` | Dedicated newsletter sending key; provider `sending_access`, restricted to the approved sender domain |
| `FLOCKLETTER_CUSTOMER_RESEND_RETRIEVE_KEY` | Distinct Flockletter newsletter inspection/retrieval credential; provider `full_access`, **not** technically read-only; code uses fixed GET endpoints only |
| `FLOCKLETTER_CUSTOMER_RESEND_WEBHOOK_SECRET` | Signing secret for `/api/v1/customer-delivery/resend-events` |
| `FLOCKLETTER_CUSTOMER_RESEND_BINDINGS` | JSON array (1–20) of server-owned `{workspaceId,brandId,from,domainId,webhookId,region}`; initial supported Resend region `us-east-1` |

The adapter reads the exact domain and webhook IDs, requires verified sending, disabled open/click tracking, the fixed callback URL and matching signing secret with all six sent/delivered/bounced/complained/failed/delivery-delayed events. Unknown or unavailable reads block new sends. Distinct workspace domains prevent cross-workspace identity reuse; a shared provider account still has shared reputation, rate and suspension risks. Inspect the actual account, sending-key restrictions, plan/domain capacity and platform terms before activation. Domain verification alone cannot prove quota, reputation isolation, inbox placement or a live feedback round trip. No AWS production-access requirement applies to Resend, but its own controls remain.

New permission `delivery:configure` plus `read` exposes `delivery_providers` and `delivery_selectProvider` in MCP. Existing grants do not gain it. The issuing user must still be the current workspace owner; exact brand scope, expiry, revocation and durable operation checks apply. This permission does not grant campaign sending or other administration. The ordinary owner session can use the same commands over HTTP. Owner-only billing/member controls stay unchanged.

Resend requests rebuild one destination and platform-owned headers/tags. Original checked CID bytes are base64 attachments; HTML/plain text, postal footer and unsubscribe capability come from the approved stored payload. Stable `flockletter-customer/<recipient-operation>` idempotency keys are not used as permission to repeat an uncertain POST: Resend expires its idempotency window. Unknown acceptance without an email ID waits for signed feedback; a known ID is retrieved only on the original provider. Signed events are independently matched to a retrieved receipt, server route, submitted intent, recipient digest and provider fingerprint before settlement/suppression. Late feedback remains valid after a selection change or transport-off; neither event tags nor client input can choose an arbitrary workspace.

The reviewed local-model drafts supplied the runbook scaffold, selector component and transport/UI test scaffolds. Primary review corrected an inaccurate persistence description, access/scope and activation wording, stale component results, UI retry behavior, test typing and misleading test names. Architecture, migration and grant boundaries, provider transport/routing, signed feedback, state-machine integration and independent integration/adversarial tests were handled here.

## Verification record

November 12, 2026: lint, TypeScript, production build and the full 131-file suite passed (1,067 passing cases, two existing gated native cases skipped). Eleven focused selection/database/MCP/runtime-transition cases passed, alongside the existing fourteen customer-runtime cases, after adding the explicit MCP, disabled-guard and Resend-only/late-SES-feedback checks. The desktop and 390px browser proof passed persisted selection, one-revision same-key retry after a lost acknowledgment, refresh recovery, blocked broadcasts and zero submitted deliveries, using real disposable PostgreSQL and substituted provider ports. Original-image bytes and exact headers are asserted by transport contracts; feedback tests cover signature/staleness/size, independent retrieval, route/recipient mismatch, replay conflict and monotonic suppression. The restore drill inventories and removes the new provider-selection table and retains the neighbor workspace.

No hosted migration or deployment, Resend credential installation, provider account/plan verification or real inbox test was performed. Those are remaining rollout checks, not proven by mocked contracts. Existing production photos, commerce settings, sending modes and billing were untouched.

### Production pilot follow-up, November 12

The later owner-authorized setup installed the separate newsletter credentials and signed endpoint, verified the sending domain with tracking off, and deployed migration 033. The owner subsequently requested live billing and Resend sending. This is activation authorization, not evidence that the separate legal/tax, trust-policy and provider-verification prerequisites are complete. The production brand and default transport were switched to Resend while retaining test-only scope and billing off; staging remained captured. The actual account reports a 50,000-email monthly API allowance and disabled paid overages. That covers the initial complimentary Growth pilot, not every full-tier or multi-workspace scenario.

One previously approved pilot message reached the designated inbox. Its real retrieved receipt returned `cc: null` and `bcc: null`, unlike the initial empty-array fixtures. This caused authenticated feedback to return retryable `delivery_feedback_pending` even though provider acceptance and inbox receipt succeeded. Normalize only missing/null/empty additional-recipient lists to empty arrays, and continue rejecting nonempty or malformed lists. Signature checks, independent retrieval, exact sender/recipient, frozen route and original submitted-operation bindings remain required. Regression coverage exercises both the schema and signed feedback/suppression with nullable fields. Retry the original provider event after staging-first deployment; do not submit another email to recover this feedback.

General campaigns remain blocked until the open trust-policy/enforcement and provider acceptance/feedback/pause/recovery evidence gates are satisfied. Paid signup separately requires FL-BIL-006's business, agreement and tax checks. An approved business/tax license alone does not state the service's tax treatment. Actual fixed-event replay and deployment outcomes must be recorded separately after observation.

Browser captures contain fictional local data and substituted provider-readiness results: [desktop](evidence/selectable-delivery/desktop.png), [phone](evidence/selectable-delivery/phone.png). They show the implemented controls; they do not show a production Resend connection.
