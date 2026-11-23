# WA-04: Core SMS completion and live acceptance

**Status:** Draft build specification for review. Prepared November 23, 2026.

This specification supplements the canonical Flockletter SRD; it does not replace accepted decisions. New design choices below are proposals until recorded in the decision ledger. Read the [review and shared acceptance contract](../REVIEW.md) before implementation.

## Source requirements and evidence

FL-SMS-001–015; CON-1–6; MSG-1–8; INB-1–6; PAC-1–3; NUM-1–5; WF-1–6

- [docs/implementation/TEXTING_PHASE_2.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/TEXTING_PHASE_2.md)
- [src/shared/texting.ts](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/src/shared/texting.ts)
- [src/server/texting/service.ts](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/src/server/texting/service.ts)
- [tests/texting.test.ts](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/tests/texting.test.ts)

Evidence baseline: GitHub revision `456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d`. Source review and recorded tests are not a fresh execution or production certification.

## Existing implementation

Core sending, operator registration, consent, scheduling, short links, settings and Twilio adapters are implemented and mock-tested. Dated notes record live filing and rejection/resubmission work; no completed live-text acceptance result was found. The summary waiting-for-keys text is stale.

## Build scope

Finish documented gaps: inbound email forwarding, editor browser access, tenant narrowing of quiet hours/frequency, and live registration/send acceptance. Audit the broader number-quality and owner-only large-send requirements not established by the phase-2 checklist.

Implement only this area’s owned behavior. Dependencies remain owned by their specifications; use agreed interfaces and test doubles until integration is ready. Do not duplicate identity, financial ledgers or delivery dispatch in this work area.

## Dependencies and interface ownership

WA-03 audience; WA-11 capabilities; WA-13 credentials/monitoring. Coordinate private route cleanup with WA-14. WA-05 reuses registration; WA-06 requests sends.

Own SMS drafts, reviewed recipient snapshots, segment reservations, durable attempts, carrier mappings, consent callbacks and delivery outcomes. All callers use the same admission/dispatch path; no automation-specific Twilio bypass.

## Build requirements

**WA-04-R01.** Wire ordinary inbound replies to the tenant notification email with durable intent and recovery; captured forwarding must never be reported as real email delivery.

**WA-04-R02.** Expose permitted SMS browser actions to editors with an explicit send grant, while keeping analysts read-only and owner-only actions restricted.

**WA-04-R03.** Implement tenant narrowing of quiet hours and contact frequency within operator bounds; audit changes across interfaces.

**WA-04-R04.** Verify number-quality controls, temporary-failure threshold, line-type lookup policy/cost and large-send owner restriction; distinguish phase-2 implementation from later requirements.

**WA-04-R05.** Complete live startup, account-correct signature verification, registration state polling, confirmed opt-in, approved send and STOP/START recovery; retain lookup-first handling of uncertain provider mutations.

## Acceptance scenarios

These are proposed acceptance cases, not passing results. Each case must trace to the applicable source requirements and build requirements above.

**WA-04-AT01.** One inbound callback delivered repeatedly yields one stored reply and one forwarded email intent; provider timeout is reconciled.

**WA-04-AT02.** Editor without send grant cannot send via browser/API/MCP; granting/revoking it takes effect on queued work.

**WA-04-AT03.** Restart after an uncertain send, enforce quiet hours/segment limits, and prove no duplicate submission in two synthetic workspaces.

**WA-04-AT04.** Record the owner-authorized campaign approval, opted-in phone, provider receipt and actual delivered text for FL-AT-045.

## Build deliverables

- Versioned schema changes and migration/recovery procedure where needed.
- Canonical domain commands and shared validation, with authorized browser/API/MCP entry points as applicable.
- Worker/provider integration and user-visible pending, failure and recovery states.
- Focused invariant/concurrency/isolation tests and updated source-to-test traceability.
- Staging evidence and operator runbook, including activation, reconciliation and rollback behavior.

## Open decisions

- Re-read current carrier status and runtime configuration; missing repository evidence does not prove current carrier failure.
- Confirm subaccount auth-token ownership and any required provider approvals; do not reproduce secret values in evidence.

## Rollout and completion evidence

Preserve the approved-recipient allowlist until a later rollout decision changes it. Live filing costs and sending use existing explicit authority and exact operator controls.

Complete this area only when its scoped requirements are implemented, the listed acceptance cases have recorded evidence, and remaining external verification or activation is explicitly listed. Record source revision, environment, fixture/approved recipient, observed result, evidence reference and unresolved limitation for every acceptance case. Never mark a live gate passed from a mock.
