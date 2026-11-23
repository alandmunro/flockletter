# WA-12: Support and tenant notifications

**Status:** Draft build specification for review. Prepared November 23, 2026.

This specification supplements the canonical Flockletter SRD; it does not replace accepted decisions. New design choices below are proposals until recorded in the decision ledger. Read the [review and shared acceptance contract](../REVIEW.md) before implementation.

## Source requirements and evidence

FL-SUP-001/002; NTF-1–4; MON-3/4; INB-4 transport integration

- [docs/implementation/CUSTOMER_SUPPORT_RETENTION.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/CUSTOMER_SUPPORT_RETENTION.md)
- [docs/implementation/PLATFORM_COMPLETION.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/PLATFORM_COMPLETION.md)
- [README.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/README.md)

Evidence baseline: GitHub revision `456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d`. Source review and recorded tests are not a fresh execution or production certification.

## Existing implementation

Support conversations, signed intake, bounded automation policies and captured replies exist. Live support transport/automation readiness is distinct and older records list support off.

## Build scope

Finish support activation evidence and build reliable tenant notifications for registration, gifts, payments and campaigns.

Implement only this area’s owned behavior. Dependencies remain owned by their specifications; use agreed interfaces and test doubles until integration is ready. Do not duplicate identity, financial ledgers or delivery dispatch in this work area.

## Dependencies and interface ownership

WA-11 authority; WA-13 durable transport/alerts; WA-04 owns inbound SMS forwarding intent; WA-05/09/10 publish lifecycle events.

Own support conversations, human escalation, approved answer policies, notification preferences and delivery receipts. Incoming email and AI output never authorize account or financial mutations.

## Build requirements

**WA-12-R01.** Finish actual inbox/reply transport and bounded approved-guidance automation with clear human escalation for billing, privacy, security and uncertain requests.

**WA-12-R02.** Consume stable feature event IDs; create durable notification intent and dedupe repeated lifecycle events.

**WA-12-R03.** Support owner and member notification preferences with required-alert exclusions and in-app/email outcomes.

**WA-12-R04.** Keep message bodies and personal data out of general audit/alert logs; do not give support automation billing or gift-refund authority.

## Acceptance scenarios

These are proposed acceptance cases, not passing results. Each case must trace to the applicable source requirements and build requirements above.

**WA-12-AT01.** Duplicate lifecycle events create one notification; uncertain delivery reconciles without blind resend.

**WA-12-AT02.** Malicious inbound instructions and spoofed sender identity cannot change accounts or trigger refunds.

**WA-12-AT03.** Disable optional notices and verify mandatory notices remain; cross-workspace ticket/token access is refused.

## Build deliverables

- Versioned schema changes and migration/recovery procedure where needed.
- Canonical domain commands and shared validation, with authorized browser/API/MCP entry points as applicable.
- Worker/provider integration and user-visible pending, failure and recovery states.
- Focused invariant/concurrency/isolation tests and updated source-to-test traceability.
- Staging evidence and operator runbook, including activation, reconciliation and rollback behavior.

## Open decisions

- Confirm approved AI provider/public guidance, escalation owner and response commitments.
- Define notification freshness expectations and distinguish provider acceptance from email receipt.

## Rollout and completion evidence

Captured support and synthetic notices first; activate actual inbox and automatic replies separately after approved-recipient evidence.

Complete this area only when its scoped requirements are implemented, the listed acceptance cases have recorded evidence, and remaining external verification or activation is explicitly listed. Record source revision, environment, fixture/approved recipient, observed result, evidence reference and unresolved limitation for every acceptance case. Never mark a live gate passed from a mock.
