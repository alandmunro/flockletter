# Flockletter — First-Party Subscriber Intake for FFA

**Status:** Flockletter implementation authorized November 7 under D-032. See the [operator runbook and acceptance evidence](SUBSCRIBER_INTAKE_OPERATIONS.md) for verified environments and remaining release gates.
**Owner:** Flockletter  
**Dependency:** Foundation PR #1 (`codex/foundation-workflow`)  
**Consumer:** Frosty Flamingo Apparel (FFA), proposed FFA PR #181  
**Requirements:** FL-AUD-001..004, FL-API-002/005, FL-DEL-003..005, FL-OPS-007  
**Goal:** Accept opt-in newsletter signups from FFA without storing a second contact/subscriber row in the FFA Postgres database.

## Executive decision

Flockletter owns the authoritative **subscriber identity, consent evidence, confirmation lifecycle, suppression, and preference data** for each brand. FFA owns only its newsletter form and a server-side submit proxy. No FFA subscriber table, customer-profile sync, email-bearing job queue, or order-to-marketing auto-enrollment.

Build a small **audience intake vertical slice** before campaign sending. Allow real first-party subscriptions only once durable storage, brand-scoped authorization, abuse protections and functional confirmation delivery are verified. Leave sending campaigns, paid self-service account activation, subscriber exports and purchased-list workflows disabled.

## Foundation integration

Use foundation PR #1's Express HTTP server, Clerk-backed organization/workspace identity, scoped expiring connections, `Database.tenant(workspaceId)` transaction with forced row-level security, and centralized errors/limits. Do **not** use FFA's database, Clerk app, Stripe, transactional Resend configuration or provider credentials.

Extend connection capabilities with `subscriber:signup` and an owner-authorized connection setup path. The token must be brand-scoped and must **not** confer `read`, `draft:write`, `assets:write`, export, send, preference administration, or billing rights. Validate workspace, brand scope, current issuer authorization, expiry and revocation on **every request**. Existing tokens must not silently acquire this capability; no existing connection default scopes should expand.

Foundation currently has no subscriber schema or live delivery path. This workstream adds both as separately gated components, never an anonymous public database writer.

## Proposed API

`POST /api/v1/brands/:brandId/subscriber-signups` — server-to-server only, HTTPS in staging/production.

Headers:
- `Authorization: Bearer flk_...` with scoped `subscriber:signup` credential
- `Content-Type: application/json`
- `Idempotency-Key: <opaque 16-128 character value>`

Payload (v1):

```json
{
  "email": "shopper@example.com",
  "purpose": "ffa_product_marketing",
  "consentAffirmed": true,
  "consentVersion": "ffa-newsletter-v1",
  "consentText": "Email me product launches, promotions, and occasional updates from Frosty Flamingo Apparel. I can unsubscribe anytime.",
  "source": "storefront-footer",
  "sourceDomain": "frostyflamingoapparel.com"
}
```

**Authority rules:** Only a verified, brand-scoped FFA server credential may call this endpoint; the token identifies workspace and permitted brand. It must not take workspace ID, brand ID, verified consent, `occurredAt`, or privileged status from an anonymous browser directly. Server timestamp is the authoritative intake time. FFA is an authorized first-party collection client that attests affirmative consent; the FFA public endpoint independently enforces the unchecked box. The consent text/version should be approved by the brand owner and checked against the configured current consent policy, not arbitrary attacker-provided copy. Permit a short allowlist of source identifiers and the exact FFA storefront origin configured for the brand. Reject mismatches.

Validation:
- Email canonicalization: trim exterior whitespace and normalize the domain case; follow a documented conservative mailbox-local-part policy (do not guess Gmail-style dot/plus equivalence).
- Maximum UTF-8 request body 8 KiB; length and format validation; strict fields.
- Require `consentAffirmed: true`; reject empty/unknown consent version/purpose/source.
- Brand belongs to authenticated tenant; no cross-tenant or cross-brand write.
- Idempotency key scoped to `workspace+brand+credential+operation`, with request digest; same key + same request replays stored outcome, same key + changed data yields conflict.
- Rate limits per credential, brand and controlled trusted client information; bounded pending-confirmation issuance per email, plus anomaly/abuse limits. Protect against confirmation email bombing.

Non-enumerating response for first-time, pending, already subscribed and suppressed records:

```json
{
  "status": "pending_confirmation",
  "message": "If this address can be subscribed, check your inbox for a confirmation email."
}
```

Return `202` only after durable DB commit of the intent and any needed confirmation job. The public response cannot disclose subscriber existence, confirmation state, suppression or whether an email was queued. Use consistent timing as practical. `400/422` validation errors, `401/403` credential errors, `404` brand unavailable, `409` idempotency conflict, `429` rate limit and `503` intake disabled/unready. Avoid echoing addresses, provider errors, token, request body or PII.

### Protocol ownership

- FFA -> Flockletter uses the operation above. Browser never receives Flockletter credentials.
- Flockletter -> FFA **no** contact sync callback is required.
- FFA may later use a separate **read-only aggregate** metrics credential, not contact exports.
- If adding a canonical command `subscriber.signup` for parity with existing HTTP/MCP, preserve same authorization and eligibility and never expose subscriber-creation to a general draft/read credential. It may be safer to keep this narrow intake HTTP operation separate from interactive MCP command listings until the permission model is tested.

## Storage model — Flockletter-only, migration 002

Add tenant-isolated tables protected with **ENABLE + FORCE ROW LEVEL SECURITY**, same `app.workspace_id` policy and restricted runtime role as foundation.

**`subscribers`**: `workspace_id`, `id` UUID, `brand_id` UUID, `email_normalized` (private), `state` enum/check (`pending`, `confirmed`, `unsubscribed`, `hard_bounced`, `complained`), created/updated/confirmed timestamps. Unique (`workspace_id, brand_id, email_normalized`). Retain minimum viable attributes.

**`subscriber_consent_events`**: append-only event ID, subscriber ref, brand, event `signup_requested | confirmed | unsubscribed | resubscribed | suppressed`, policy/version/text digest, allowed source, recorded timestamp, safe evidence fields. No secret tokens or full request dumps.

**`subscriber_confirmation_tokens`**: per brand/subscriber secret **hash**, expiry, consumption timestamp, issued timestamp and bounded attempts. Store only the digest; use CSPRNG tokens, short expiration and single use, confirm via brand-specific HTTPS endpoint. Tokens are not included in telemetry.

**`subscriber_outbox`**: durable id, workspace/brand, subscriber ID, template/purpose, state `pending | leased | delivered_to_provider | failed`, attempt count, retry scheduling, provider operation ID and error category only. No raw email in logs or queue payloads; worker fetches subscriber within scoped transaction. Claimed jobs must honor tenant context and verified brand ownership; avoid global service reads bypassing RLS.

**`subscriber_signup_operations`**: durable idempotency record keyed by workspace+brand+connection+operation key; request digest, sanitized response, timestamps. Unique constraint prevents double issue on retries.

Use composite foreign keys so cross-tenant and cross-brand references cannot silently occur. The existing `operations` table may be reused only if its key and retention policy can safely support this flow; otherwise choose a dedicated bounded intake table. Update `Database.verifyBoundary()` and migration privileges/role grants so missing RLS fails readiness. Audit retention/deletion policy must preserve necessary suppression proof without gratuitous personal data.

## State machine

```text
new address --affirmed signup--> pending --valid confirmation--> confirmed
pending --expired link--> pending (bounded resend flow)
confirmed --unsubscribe--> unsubscribed
confirmed --hard bounce--> hard_bounced
confirmed --spam complaint--> complained
unsubscribed --new signup--> no silent reactivation; explicit confirmation + approved policy
hard_bounced/complained --new signup--> remain suppressed pending controlled remediation
```

- No marketing campaign can send to `pending`, `unsubscribed`, `hard_bounced` or `complained`.
- Old links cannot confirm a different address or brand, cannot be reused, and cannot undo newer unsubscribe/suppression events.
- Duplicates are idempotent and do not erase historical evidence or overwrite a previously stronger suppression state.
- Existing unsubscribed addresses can enter a brand-approved reconfirmation process, but only after a new explicit consent action and suppression policy permits it. Complaints/hard bounces never silently re-enable.

## Double opt-in delivery and confirmation

Add provider-independent confirmation-dispatch adapter with a captured/local test mode and a separately approved live provider; FFA's Resend transactional API is **not** implicitly shared. On intake, atomically persist subscriber state + consent event + outbox job, then return 202. Confirmation worker retries provider failures with exponential backoff/jitter and unknown-outcome reconciliation, controls rate limits and retains a visible operator failure state.

Use signed or random secret confirmation URLs at Flockletter's verified HTTPS origin with CSRF-safe one-time confirmation semantics. GET may show the confirmation page; mutation should occur only on an explicit confirmation action to avoid link-scanner auto-opt-in. Completion records confirmed_at and immutable consent evidence. Never enable send eligibility just because provider accepted confirmation email.

Since delivery provider and acceptable-use policy remain unresolved in Flockletter, **do not enable public FFA collection until an authorized provider and tested confirmation path exist**. Local capture alone is not live acceptance.

## Monitoring and administrative controls

- Brand-level intake enable/disable flag defaults **off**; independent from campaign sending.
- Role-scoped owner controls for issuing/revoking the FFA intake credential. Test token revocation and membership revocation against fresh requests.
- Minimal metrics: accepted, rejected, duplicate/replay acknowledged internally, confirmation queued/accepted, confirmations, failures, 429s; never label a pending signup as confirmed.
- No raw email, normalized email, bearer token, token hash, user-agent, or consent text in logs/traces/provider diagnostics.
- Alert on sustained outbox backlog and provider 5xx; bounded retry and dead-letter/operator recovery runbook.
- Independent staging vs production brand and credentials; never use FFA production lists for staging tests.
- Design for privacy export/delete within Flockletter; preserve minimal suppression state as allowed by policy.

## File-level implementation map (after foundation PR #1)

1. `src/shared/contracts.ts`: dedicated `subscriber:signup` capability; strict schema and stable API contract. Ensure scoped connections can grant it explicitly and no pre-existing token gains it.
2. `src/server/app.ts`: authenticated and rate-limited route. Authenticate before body parsing; explicit 8 KiB JSON limit; consistent error mapping.
3. `src/server/auth.ts`: verify per-token intake scope and selected brand, expiry, revocation, current issuer membership.
4. `src/server/service.ts`: transactional signup/duplicate/suppression policy and atomic outbox enqueue; direct send never occurs in HTTP request.
5. `src/server/db.ts`: verify tenant RLS on new tables.
6. `migrations/002_subscriber_intake.sql`: tables, constraints, indexes, RLS, restricted grants, additive migration and rollback/runbook.
7. `src/server/subscribers/`: suggested isolated module for validation, state machine and confirmation handling.
8. `src/server/confirmation/`: provider-neutral outbox worker and adapter (captured in tests).
9. `docs/api/openapi.json` generated from authoritative contracts; update generator rather than hand-editing generated output.
10. `tests/`: database, HTTP, anti-enumeration, concurrency/idempotency, confirmation and security tests.
11. `docs/TRACEABILITY.md`, `docs/implementation/`: requirement evidence and real-vs-simulated verification.
12. `docs/DECISIONS.md` + `AGENTS.md`: record scope authorization and accepted design while preserving production/live-send gate.

## Acceptance tests (blocking)

| ID | Test |
|---|---|
| FI-001 | A newly confirmed FFA brand-scoped intake credential writes exactly one pending subscriber and consent event in Flockletter Postgres. |
| FI-002 | FFA does not need any subscriber table; no FFA runtime or database access from Flockletter. |
| FI-003 | Same operation key + identical request returns same 202 result; changed request yields 409; concurrent duplicate addresses yield one contact. |
| FI-004 | Unknown, pending, confirmed and suppressed addresses return indistinguishable public 202 responses and do not leak status. |
| FI-005 | False/absent consent, invalid email, unapproved purpose, source or consent version are rejected safely. |
| FI-006 | Cross-tenant and cross-brand intake denied, including attempts against direct SQL with restricted runtime role. |
| FI-007 | Read/draft/asset-only connection denied; expired, revoked, or issuer-withdrawn intake token denied. |
| FI-008 | Confirmation outbox entry is transactional; API crash/worker retry cannot create lost subscriber or duplicate confirmation sends without reconciled outcome. |
| FI-009 | Double-opt-in link expires, is single use and cannot be triggered by a GET link scanner or wrong brand. |
| FI-010 | Pending cannot be included in marketing sends; unsubscribe, bounce and complaint states remain suppressed through repeat imports/signup. |
| FI-011 | Missing live provider/brand gate produces unready response rather than falsely acknowledging public signups. |
| FI-012 | 429, bad JSON, oversized bodies, outage and timing variations do not expose PII or disrupt unrelated workspace operations. |
| FI-013 | Tests verify no emails/confirmation secrets in application logs, traces or errors. |
| FI-014 | Run lint, typecheck, full unit and real-Postgres test suite, build, generated OpenAPI parity, and staging contract test with FFA before release. |
| FI-015 | Production activation remains blocked pending explicit approval, DNS/sender verification, acceptable-use/complaint policy, hosted DB readiness and a live confirmation email test. |

## Cross-repo delivery order

**A.** Merge/rebase foundation PR #1.  
**B.** Build Flockletter intake storage, RLS, scope, API and captured confirmation tests.  
**C.** Configure live confirmation provider independently and verify one real staging confirmation end-to-end.  
**D.** Implement FFA PR #181 form and server proxy with scoped token.  
**E.** Verify staging together (new signup, duplicate, confirm, unsubscribe, failure); enable with feature flag and production gate after owner approval.

## Explicit out-of-scope

Campaign sending and audience export; purchased lists; auto-opt-in from orders; campaign analytics; checkout integrations; FFA contact replication; paid self-service account activation; any production changes. These require separate authorization and acceptance.
