# WA-10: Texting billing, dashboards and customer launch

**Status:** Draft build specification for review. Prepared November 23, 2026.

This specification supplements the canonical Flockletter SRD; it does not replace accepted decisions. New design choices below are proposals until recorded in the decision ledger. Read the [review and shared acceptance contract](../REVIEW.md) before implementation.

## Source requirements and evidence

BIL-1/2/4/5; PRC-1–7; PLN-1–5; DSH-1–11; NTF-1–4; WF-4; HST integration

- [docs/implementation/PROPOSED_TEXTING_AND_GIFTING.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/PROPOSED_TEXTING_AND_GIFTING.md)
- [docs/DECISIONS.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/DECISIONS.md)

Evidence baseline: GitHub revision `456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d`. Source review and recorded tests are not a fresh execution or production certification.

## Existing implementation

Core SMS has segment allowances. Newsletter subscriptions already exist. Texting add-on products, setup charging, comprehensive cross-feature results and outside-customer rollout are not established by those implementations.

## Build scope

Build texting commercial entitlements, setup-fee gating, spending caps, notices and unified results; integrate feature-owned facts without duplicating ledgers.

Implement only this area’s owned behavior. Dependencies remain owned by their specifications; use agreed interfaces and test doubles until integration is ready. Do not duplicate identity, financial ledgers or delivery dispatch in this work area.

## Dependencies and interface ownership

WA-02 billing primitives; WA-04 usage; WA-05 registration/tier facts; WA-07/08/09 feature reporting; WA-11 roles; WA-12 notifications; WA-14 offboarding.

Own texting plan agreements, setup-payment status, billing-period allowance and dashboard projections. WA-09 owns gift credit and gift fees; WA-05 owns hosted-page publication and accepted registration policies.

## Build requirements

**WA-10-R01.** Use Text 300/1000/2500 at $19/$39/$79 and setup fees $49/$99 as accepted configurable catalog values; no free texting trial and no automatic text overage.

**WA-10-R02.** Expose verified setup-payment facts before registration costs. Coordinate Standard registration upgrades so new plan price/limit starts only after required approval.

**WA-10-R03.** Implement monthly spending-cap and allowance checks; preserve service-specific cancellation so canceling texting does not cancel newsletters.

**WA-10-R04.** Build date-range overview and campaign/recipient CSV results from authoritative events; include usage/cost, gift credit, coupon and event facts only as those features become available.

**WA-10-R05.** Provide required owner notices and optional member subscriptions; mandatory registration, suspension, dispute and payment alerts cannot be disabled.

**WA-10-R06.** Apply accepted failure/refund/no-tax policies without assuming gift-credit tax treatment has been settled.

## Acceptance scenarios

These are proposed acceptance cases, not passing results. Each case must trace to the applicable source requirements and build requirements above.

**WA-10-AT01.** Concurrent setup payment retries create one charge and unlock one registration; payment return without a verified event unlocks nothing.

**WA-10-AT02.** Exhaust texts and hard cap, change plans, cross renewal and cancel only texting; no extra allowance or newsletter loss.

**WA-10-AT03.** Compare UI/API/MCP/CSV totals to underlying ledgers under delayed events; analysts can view but cannot mutate billing.

**WA-10-AT04.** Pilot 3–5 outside customers only after the documented readiness and human-accepted legal-review gates.

## Build deliverables

- Versioned schema changes and migration/recovery procedure where needed.
- Canonical domain commands and shared validation, with authorized browser/API/MCP entry points as applicable.
- Worker/provider integration and user-visible pending, failure and recovery states.
- Focused invariant/concurrency/isolation tests and updated source-to-test traceability.
- Staging evidence and operator runbook, including activation, reconciliation and rollback behavior.

## Open decisions

- Specify spend-cap period and accounting for fees, reservations and gifts without refusing already funded offers.
- Build a narrow setup-payment contract early for WA-05; full commercial launch remains later.
- Confirm provider catalog, hosted terms and gift-credit tax review before paid activation.

## Rollout and completion evidence

Separate setup-billing staging milestone from full outside-customer launch. Preserve no-overage and existing newsletter agreements.

Complete this area only when its scoped requirements are implemented, the listed acceptance cases have recorded evidence, and remaining external verification or activation is explicitly listed. Record source revision, environment, fixture/approved recipient, observed result, evidence reference and unresolved limitation for every acceptance case. Never mark a live gate passed from a mock.
