# WA-08: Coupons and staff redemption

**Status:** Draft build specification for review. Prepared November 23, 2026.

This specification supplements the canonical Flockletter SRD; it does not replace accepted decisions. New design choices below are proposals until recorded in the decision ledger. Read the [review and shared acceptance contract](../REVIEW.md) before implementation.

## Source requirements and evidence

CPN-1–5; DSH-1/5/9–11; SEC-7; REL-5

- [docs/implementation/PROPOSED_TEXTING_AND_GIFTING.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/PROPOSED_TEXTING_AND_GIFTING.md)
- [docs/implementation/TEXTING_PHASE_2.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/TEXTING_PHASE_2.md)

Evidence baseline: GitHub revision `456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d`. Source review and recorded tests are not a fresh execution or production certification.

## Existing implementation

Coupon behavior is specified but excluded from phase 2; no implemented coupon workflow was established.

## Build scope

Build tenant offers, unique recipient coupon pages, one-time staff redemption and reporting without payment or gift-credit logic.

Implement only this area’s owned behavior. Dependencies remain owned by their specifications; use agreed interfaces and test doubles until integration is ready. Do not duplicate identity, financial ledgers or delivery dispatch in this work area.

## Dependencies and interface ownership

WA-03 recipients; WA-01/04 delivery; WA-06 optional birthday attachment; WA-11 authority; WA-10 aggregate reporting.

Own coupon definition/revision, recipient issue record, view and redemption facts. Return a Flockletter page link to the shared delivery layer. No Tremendous or point-of-sale dependency.

## Build requirements

**WA-08-R01.** Create description, expiry and optional terms; attach an immutable coupon reference to a broadcast or automation.

**WA-08-R02.** Issue a unique recipient code/link and display offer, expiry and unambiguous redemption state.

**WA-08-R03.** Opening or previewing does not redeem. Staff intentionally activate the Redeem action, which atomically records the first redemption and timestamp.

**WA-08-R04.** Report sent, viewed and redeemed separately; scanning a link is not proof a customer viewed the coupon.

## Acceptance scenarios

These are proposed acceptance cases, not passing results. Each case must trace to the applicable source requirements and build requirements above.

**WA-08-AT01.** Two concurrent redemption submissions produce one receipt; retry shows the original result.

**WA-08-AT02.** Expired/canceled offers cannot redeem; unknown or cross-workspace links do not disclose records.

**WA-08-AT03.** Broadcast and automation retries preserve coupon identity; CSV and UI counts agree.

## Build deliverables

- Versioned schema changes and migration/recovery procedure where needed.
- Canonical domain commands and shared validation, with authorized browser/API/MCP entry points as applicable.
- Worker/provider integration and user-visible pending, failure and recovery states.
- Focused invariant/concurrency/isolation tests and updated source-to-test traceability.
- Staging evidence and operator runbook, including activation, reconciliation and rollback behavior.

## Open decisions

- Specify the staff-intent safeguard: the accepted phone-button design does not establish staff authentication or fraud-proof redemption.
- Define view measurement and exclusions for automated scanners before advertising viewed counts.

## Rollout and completion evidence

Test hosted redemption with disposable coupons; retain no-POS scope. Coupon completion is a documented rollout item, not a Tremendous API prerequisite.

Complete this area only when its scoped requirements are implemented, the listed acceptance cases have recorded evidence, and remaining external verification or activation is explicitly listed. Record source revision, environment, fixture/approved recipient, observed result, evidence reference and unresolved limitation for every acceptance case. Never mark a live gate passed from a mock.
