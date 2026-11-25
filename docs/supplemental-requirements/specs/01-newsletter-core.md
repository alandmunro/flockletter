# WA-01: Newsletter core and delivery completion

**Status:** Draft build specification for review. Prepared November 23, 2026.

This specification supplements the canonical Flockletter SRD; it does not replace accepted decisions. New design choices below are proposals until recorded in the decision ledger. Read the [review and shared acceptance contract](../REVIEW.md) before implementation.

## Source requirements and evidence

FL-CAM-001–010; FL-DEL-001–009; FL-API-001–005; FL-PROD-001–005

- [README.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/README.md)
- [docs/implementation/PUBLIC_SUBSCRIPTION_LAUNCH.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/PUBLIC_SUBSCRIPTION_LAUNCH.md)
- [docs/TRACEABILITY.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/TRACEABILITY.md)

Evidence baseline: GitHub revision `456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d`. Source review and recorded tests are not a fresh execution or production certification.

## Existing implementation

The repository documents a working editor, editable drafts/import, reviewed campaigns, durable scheduling, per-brand Resend/SES selection, provider feedback and recipient reporting. Newsletter delivery is documented as live; individual acceptance cases and current production behavior need independent evidence.

## Build scope

Close remaining acceptance gaps and regressions in existing workflows; do not replace the newsletter application.

Implement only this area’s owned behavior. Dependencies remain owned by their specifications; use agreed interfaces and test doubles until integration is ready. Do not duplicate identity, financial ledgers or delivery dispatch in this work area.

## Dependencies and interface ownership

WA-02 supplies entitlement and allowance facts; WA-03 supplies recipients and suppression; WA-11 supplies current authority; WA-13 supplies worker/release health.

Own campaign versions, exact audience reviews, immutable provider routes and recipient delivery outcomes. Expose shared preflight, approve, schedule, pause, cancel and report operations. Other work areas may request delivery only through these controls.

## Build requirements

**WA-01-R01.** Inventory each FL-CAM/FL-DEL acceptance case against current implementation, test evidence and hosted evidence; classify unresolved cases individually.

**WA-01-R02.** Preserve original assets and editable drafts through import, save, reopen and rendering. Invalid or unsupported content must produce actionable review findings.

**WA-01-R03.** Bind approval to content, audience, sender, route, timing and limits. Revalidate consent and authority before dispatch; reconcile unknown submissions using the original provider.

**WA-01-R04.** Report queued, accepted, delivered and failed independently. Retain pagination, export and accessible mobile/keyboard flows without claiming inbox receipt from provider acceptance.

## Acceptance scenarios

These are proposed acceptance cases, not passing results. Each case must trace to the applicable source requirements and build requirements above.

**WA-01-AT01.** Save/reopen an imported newsletter with original images; verify HTML and plain text and record remaining Outlook/client evidence separately.

**WA-01-AT02.** Race duplicate approvals, change sender/consent after review, and restart after provider acceptance: no second submission or allowance consumption.

**WA-01-AT03.** Complete an approved hosted customer journey from sender setup through delivery and unsubscribe, recording provider and inbox observations separately.

## Build deliverables

- Versioned schema changes and migration/recovery procedure where needed.
- Canonical domain commands and shared validation, with authorized browser/API/MCP entry points as applicable.
- Worker/provider integration and user-visible pending, failure and recovery states.
- Focused invariant/concurrency/isolation tests and updated source-to-test traceability.
- Staging evidence and operator runbook, including activation, reconciliation and rollback behavior.

## Open decisions

- Confirm the current list of unfinished mail-client and hosted acceptance cases rather than inheriting stale traceability statements.
- Keep Pro enrollment hold and existing provider spending policy unless separately changed.

## Rollout and completion evidence

Promote only a staging-tested revision; record actual web/worker revision and approved-recipient evidence. This work area does not authorize a new campaign.

Complete this area only when its scoped requirements are implemented, the listed acceptance cases have recorded evidence, and remaining external verification or activation is explicitly listed. Record source revision, environment, fixture/approved recipient, observed result, evidence reference and unresolved limitation for every acceptance case. Never mark a live gate passed from a mock.
