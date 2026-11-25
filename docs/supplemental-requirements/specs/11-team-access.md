# WA-11: Team lifecycle and shared authorization

**Status:** Draft build specification for review. Prepared November 23, 2026.

This specification supplements the canonical Flockletter SRD; it does not replace accepted decisions. New design choices below are proposals until recorded in the decision ledger. Read the [review and shared acceptance contract](../REVIEW.md) before implementation.

## Source requirements and evidence

FL-ID-001–005; FL-ONB-003/004; FL-USG-006; FL-API-001/002; WF-1/5

- [docs/implementation/CUSTOMER_AUDIENCE_TEAM.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/CUSTOMER_AUDIENCE_TEAM.md)
- [docs/implementation/TEAM_ACCESS.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/TEAM_ACCESS.md)
- [docs/TRACEABILITY.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/TRACEABILITY.md)

Evidence baseline: GitHub revision `456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d`. Source review and recorded tests are not a fresh execution or production certification.

## Existing implementation

Team lifecycle commands, scoped permissions and Clerk adapter have implementation and captured evidence. Older production records list team lifecycle off; current activation and real membership verification need inspection.

## Build scope

Finish hosted invite/remove/transfer acceptance and consistent role access across all new work areas.

Implement only this area’s owned behavior. Dependencies remain owned by their specifications; use agreed interfaces and test doubles until integration is ready. Do not duplicate identity, financial ledgers or delivery dispatch in this work area.

## Dependencies and interface ownership

WA-02 seat entitlement; WA-13 hosted identity/runtime verification. All customer work areas consume these capabilities rather than inventing their own membership system.

Clerk remains authoritative for login/membership. Own narrower application capabilities and scoped grants, with current-membership checks and revocation. Publish a reviewed role/action matrix including gift configuration, purchases, refunds and reports.

## Build requirements

**WA-11-R01.** Verify invitations, acceptance, removal, last-owner protection and ownership transfer against real provider facts; preserve durable intent and uncertain-outcome reconciliation.

**WA-11-R02.** Apply owner/editor/analyst roles and explicit sending grants consistently in browser/API/MCP and workers.

**WA-11-R03.** Enforce pooled seat and brand limits; never silently widen existing connection scopes when adding gifting or texting commands.

**WA-11-R04.** Keep platform operator authority separate from workspace ownership and require the current operator assurance policy.

## Acceptance scenarios

These are proposed acceptance cases, not passing results. Each case must trace to the applicable source requirements and build requirements above.

**WA-11-AT01.** Race final seat/last owner actions; provider timeout must not issue duplicate invitations or abandon ownership.

**WA-11-AT02.** Revoke a user or connection after work is queued; unsubmitted actions fail current authorization.

**WA-11-AT03.** Verify each work area’s role matrix across browser, API and MCP with two workspaces.

## Build deliverables

- Versioned schema changes and migration/recovery procedure where needed.
- Canonical domain commands and shared validation, with authorized browser/API/MCP entry points as applicable.
- Worker/provider integration and user-visible pending, failure and recovery states.
- Focused invariant/concurrency/isolation tests and updated source-to-test traceability.
- Staging evidence and operator runbook, including activation, reconciliation and rollback behavior.

## Open decisions

- Finalize new gift purchase/refund/configuration capabilities and delegation bounds before financial commands are exposed.
- Inspect current production mode and Clerk configuration rather than treating old off-state documentation as current fact.

## Rollout and completion evidence

Use captured tests then approved real membership exercises; record actual role revocation and invitation outcomes separately.

Complete this area only when its scoped requirements are implemented, the listed acceptance cases have recorded evidence, and remaining external verification or activation is explicitly listed. Record source revision, environment, fixture/approved recipient, observed result, evidence reference and unresolved limitation for every acceptance case. Never mark a live gate passed from a mock.
