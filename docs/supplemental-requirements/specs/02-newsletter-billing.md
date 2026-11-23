# WA-02: Newsletter subscriptions and entitlement completion

**Status:** Draft build specification for review. Prepared November 23, 2026.

This specification supplements the canonical Flockletter SRD; it does not replace accepted decisions. New design choices below are proposals until recorded in the decision ledger. Read the [review and shared acceptance contract](../REVIEW.md) before implementation.

## Source requirements and evidence

FL-BIL-001–008; FL-USG-001–006; FL-ONB-001–004; D-049/050/060/062

- [docs/implementation/CUSTOMER_BILLING.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/CUSTOMER_BILLING.md)
- [docs/implementation/PUBLIC_SUBSCRIPTION_LAUNCH.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/PUBLIC_SUBSCRIPTION_LAUNCH.md)
- [docs/TRACEABILITY.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/TRACEABILITY.md)

Evidence baseline: GitHub revision `456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d`. Source review and recorded tests are not a fresh execution or production certification.

## Existing implementation

Subscription signup, card-backed trial, lifecycle recovery, trial-abuse controls, complimentary access and usage enforcement have implementations. Production Stripe mode is documented, but activation is not proof of every lifecycle acceptance case.

## Build scope

Audit and finish existing subscription acceptance; expose dependable entitlement facts to add-on work without making gift purchases subscription overages.

Implement only this area’s owned behavior. Dependencies remain owned by their specifications; use agreed interfaces and test doubles until integration is ready. Do not duplicate identity, financial ledgers or delivery dispatch in this work area.

## Dependencies and interface ownership

WA-11 identity and current ownership; WA-13 signed webhook/worker operations; WA-14 retention exceptions. WA-10 consumes entitlement integration contracts.

Own newsletter subscription state, immutable price/date agreements, trial eligibility, complimentary entitlements and newsletter allowance reservations. Export read-only eligibility and reason codes; WA-10 owns texting products and WA-09 owns gift credit.

## Build requirements

**WA-02-R01.** Verify current catalog, trial caps, pooled allowances and Pro enrollment hold across UI/API/MCP and provider requests.

**WA-02-R02.** Keep browser redirects non-authoritative; apply signed account/environment-bound billing facts exactly once with delayed-event reconciliation.

**WA-02-R03.** Exercise upgrade, renewal-effective downgrade/cancellation, failed-payment day-6/day-30 handling and recovery without resetting consumed usage.

**WA-02-R04.** Preserve explicit no-tax-collection policy for applicable agreements, FFA complimentary independence and essential export/consent access during suspension.

## Acceptance scenarios

These are proposed acceptance cases, not passing results. Each case must trace to the applicable source requirements and build requirements above.

**WA-02-AT01.** Duplicate/out-of-order provider events and a lost Checkout response produce one entitlement transition.

**WA-02-AT02.** Cross-workspace customer or price references are refused; concurrent last-slot admission cannot exceed allowance.

**WA-02-AT03.** Test clock renewal, failure, cancellation and recovery in Stripe test mode, then link separately recorded hosted acceptance evidence.

## Build deliverables

- Versioned schema changes and migration/recovery procedure where needed.
- Canonical domain commands and shared validation, with authorized browser/API/MCP entry points as applicable.
- Worker/provider integration and user-visible pending, failure and recovery states.
- Focused invariant/concurrency/isolation tests and updated source-to-test traceability.
- Staging evidence and operator runbook, including activation, reconciliation and rollback behavior.

## Open decisions

- Confirm outstanding provider lifecycle evidence and current agreement versions.
- Resolve new add-on integration points without changing existing merchant-wide settings or old agreements.

## Rollout and completion evidence

Use Stripe test mode and disposable customers for completion tests; live charges and changes to customer agreements remain separately controlled.

Complete this area only when its scoped requirements are implemented, the listed acceptance cases have recorded evidence, and remaining external verification or activation is explicitly listed. Record source revision, environment, fixture/approved recipient, observed result, evidence reference and unresolved limitation for every acceptance case. Never mark a live gate passed from a mock.
