# Seven customer workflows: release evidence

D-042 authorizes the November 8 staging implementation. The seven areas share the canonical command service, verified workspace authority, forced row-level policies and durable operation keys. This evidence distinguishes captured provider outcomes from external verification.

| Area | Requirement and acceptance coverage | Evidence |
| --- | --- | --- |
| Campaign delivery | FL-CAM-002–007, FL-DEL-004–006; FL-AT-018–025/038 | Immutable content, sender, audience and original-image snapshots; current consent/authority/allowance checks; scheduling, pause/resume/cancel, uncertain-outcome reconciliation and segregated signed feedback. Delivery, pause, SES and private-engine suites. |
| Subscription lifecycle | FL-BIL-001–008, FL-USG-001–006; FL-AT-003/006–011/031–034 | Accepted price/cap catalogue, card-required captured trial, plan changes, failed payment, cancellation, expired checkout recovery and zero-trial paid rejoin. Durable Stripe adapter with verified provider facts; no browser payment authority. |
| Audience onboarding | FL-AUD-001–004, FL-API-003; FL-AT-013–015/025 | Native public forms, double opt-in, bounded real-domain imports, per-row outcomes and suppression preservation. Tests cover same-origin native navigation, revoked MCP grants and workspace isolation. |
| Team administration | FL-ID-001–004; FL-AT-004/020/034 | Durable invitations, acceptance observations, removal and ownership transfer with current Clerk authority and seat checks. Captured membership does not grant an actual login. |
| Support | FL-SUP-001/002; FL-AT-035 | Durable inbox, provenance, reviewed reply snapshots, capture, handoff and bounded authenticated integration. No automatic financial, privilege or campaign actions. |
| Retention | FL-AUD-005, FL-OPS-005; FL-AT-016/028 | Verified service-end clock, inventory, holds, zero-delete captured requests, separate privileged executor, immutable erasure receipts and restore quarantine. Runtime cannot delete underlying tenant data or read private control tables. |
| Infrastructure and operations | FL-DEL-001/008, FL-OPS-001–007; FL-AT-022/024/027–030/037/038 | Scope-discovery scheduler, bounded private engine pool, production settings checks, sender provisioning plan, nine guarded AWS steps and zero-default capacity ledger. Free staging exercises use captured resources and `.invalid` DNS examples. |

The browser proof (`scripts/prove-customer-workflows.ts`) uses the normal UI with disposable PostgreSQL and two authority domains. It walks trial/payment, native signup/confirmation, duplicate and suppressed imports, original-image campaign review/capture, member invitation, reviewed support reply, infrastructure capture and retention. Desktop and phone views are checked. The private engine test independently runs pinned Listmonk with isolated engine databases and original image bytes.

Hosted staging rollout must separately record its immutable commit, migration result, CI result, deployment and signed-in walkthrough. Local tests do not establish those facts.

## External activation gates

Captured staging does not send mail, charge cards, invite real members, provision AWS resources or erase hosted data. Real provider acceptance, account and sender verification, cross-workspace trial-abuse policy, continuous worker hosting, support operator authorization and protected purge/checkpoint configuration remain public-activation gates. Support ingress currently accepts an authenticated normalized envelope; a native provider webhook is not assumed to be configured. Sleeping free staging is not a continuous scheduler.

## Model contributions

The local Qwen model drafted subscription usage, import results, support history, retention inventory, operations and infrastructure UI; deterministic resource names; numerous provider/runtime/UI test scaffolds; browser harness boilerplate; and documentation drafts. Chat reviewed every draft and owned architecture, isolation, authorization, billing and provider decisions, durable integration, final UI behavior and acceptance review. Incorrect limit/date assumptions, invented commands/imports and weak test assumptions were corrected. Delivery and sender UI drafts were replaced after review; three early requests produced no usable draft before the local adapter was improved. No token-share percentage is claimed.

The local command's optional mechanical mode now uses the installed model's verified non-thinking template, preserves its sampling defaults and enforces a maximum of two simultaneous requests. Machine-specific configuration and raw rejected drafts are outside the public repository.
