# WA-14: Retention, offboarding and recovery

**Status:** Draft build specification for review. Prepared November 23, 2026.

This specification supplements the canonical Flockletter SRD; it does not replace accepted decisions. New design choices below are proposals until recorded in the decision ledger. Read the [review and shared acceptance contract](../REVIEW.md) before implementation.

## Source requirements and evidence

FL-AUD-005; FL-OPS-004/005; OFF-1–5; RET-1–3; PRV-1–4; GFT-8; D-048/049

- [docs/implementation/HOSTED_RETENTION.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/HOSTED_RETENTION.md)
- [docs/implementation/PLATFORM_COMPLETION.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/PLATFORM_COMPLETION.md)
- [docs/implementation/TEXTING_PHASE_2.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/TEXTING_PHASE_2.md)

Evidence baseline: GitHub revision `456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d`. Source review and recorded tests are not a fresh execution or production certification.

## Existing implementation

Protected retention planning/execution and restore safeguards have implementations and disposable-data tests. Hosted activation is separate. Texting notes explicitly identify missing private route/account cleanup.

## Build scope

Extend the inventory and executor for texting/gift records and provider resources; reconcile the distinct data-retention exceptions and financial liabilities before customer offboarding.

Implement only this area’s owned behavior. Dependencies remain owned by their specifications; use agreed interfaces and test doubles until integration is ready. Do not duplicate identity, financial ledgers or delivery dispatch in this work area.

## Dependencies and interface ownership

WA-02/10 service cancellation; WA-04 Twilio resources; WA-09 credit/refunds; WA-11 authority; WA-13 restricted roles/recovery.

Own effective offboarding lifecycle, retained-data inventory, export availability, deletion receipts and restore quarantine. Feature services own financial/provider settlement; erasure consumes their durable completion facts.

## Build requirements

**WA-14-R01.** Cancel unsubmitted sends/automations and open offers under the applicable service cancellation rules; texting-only cancellation preserves newsletters.

**WA-14-R02.** Provide the specified export/reactivation interval, then release numbers/campaigns/subaccounts through durable provider operations; reconcile unknown release outcomes.

**WA-14-R03.** Add private texting routes, account mappings and short-name records to executor inventory and role grants together.

**WA-14-R04.** Apply reviewed schedules for message bodies, consent/audit records, gift/billing ledger and the narrow lifetime trial-history exception; never treat generic 90-day purge as authority to erase everything.

**WA-14-R05.** Settle outstanding/unknown gift purchases and refunds before deleting necessary financial references; retained records must be minimized and isolated.

**WA-14-R06.** Restore into isolation and reconcile erasure/suppression/provider facts before any send or financial operation resumes.

## Acceptance scenarios

These are proposed acceptance cases, not passing results. Each case must trace to the applicable source requirements and build requirements above.

**WA-14-AT01.** Offboard a workspace with open offers, an uncertain gift purchase and a pending refund; no double return, lost liability or premature purge.

**WA-14-AT02.** Delete disposable public/private texting data and confirm no redirect/account mapping remains; another workspace is unaffected.

**WA-14-AT03.** Restore an older backup after suppression/erasure and prove no resurrected send or duplicate refund.

**WA-14-AT04.** Check retention clocks and exceptions with controlled time, signed inventory and least-privilege executor tests.

## Build deliverables

- Versioned schema changes and migration/recovery procedure where needed.
- Canonical domain commands and shared validation, with authorized browser/API/MCP entry points as applicable.
- Worker/provider integration and user-visible pending, failure and recovery states.
- Focused invariant/concurrency/isolation tests and updated source-to-test traceability.
- Staging evidence and operator runbook, including activation, reconciliation and rollback behavior.

## Open decisions

- Resolve effective-date differences between newsletter renewal cancellation and immediate texting stop.
- Approve the precise record inventory, retention basis and legal-hold behavior; source defaults are not a new legal determination.
- Specify recovery behavior for pending disputes and refundable credit on closure.

## Rollout and completion evidence

Exercise only disposable data until the protected hosted-erasure prerequisites are met; no destructive action is authorized by this review packet.

Complete this area only when its scoped requirements are implemented, the listed acceptance cases have recorded evidence, and remaining external verification or activation is explicitly listed. Record source revision, environment, fixture/approved recipient, observed result, evidence reference and unresolved limitation for every acceptance case. Never mark a live gate passed from a mock.
