# WA-09: Tremendous gifting and prepaid credit

**Status:** Draft build specification for review. Prepared November 23, 2026.

This specification supplements the canonical Flockletter SRD; it does not replace accepted decisions. New design choices below are proposals until recorded in the decision ledger. Read the [review and shared acceptance contract](../REVIEW.md) before implementation.

## Source requirements and evidence

GFT-1–12; BIL-3; PRC-5; CBK-1–6; IDV-10; CMP-7/8; DSH-3/4/7/9; NTF-2; RET-3

- [docs/implementation/PROPOSED_TEXTING_AND_GIFTING.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/PROPOSED_TEXTING_AND_GIFTING.md)
- [docs/DECISIONS.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/DECISIONS.md)

Evidence baseline: GitHub revision `456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d`. Source review and recorded tests are not a fresh execution or production certification.

[Run the local gifting lab](../../../labs/gifting/README.md) to exercise WA-09 with synthetic workspaces, inspect the requirements mapping and reproduce the mock acceptance results.

## Existing implementation

Tremendous was selected and the separate November 16 sandbox runoff passed core ordering/choice/retry checks. No Flockletter credit ledger, claim workflow or production gift acceptance was established. The runoff build guide predates prepaid-credit and variable-expiry requirements.

## Build scope

Build the complete prepaid-credit and claim-on-tap feature, including failure recovery, disputes, refunds and tenant/operator visibility.

Implement only this area’s owned behavior. Dependencies remain owned by their specifications; use agreed interfaces and test doubles until integration is ready. Do not duplicate identity, financial ledgers or delivery dispatch in this work area.

## Dependencies and interface ownership

WA-05 eligibility/probation; WA-02 verified Stripe integration primitives; WA-03 deduplicated recipients; WA-01/04 delivery; WA-06 automated attachment; WA-11 authority; WA-13/14 operations and retention. Manual campaign gifts can be built without waiting for date automation, but rollout order remains an explicit decision.

Own gift-credit purchases, append-only ledger, reservations, offer identity, provider order/reward references, refunds/disputes and gift results. Proposed shared identity is one offer per canonical recipient/campaign, reused across SMS/email. Money uses integer minor units and explicit currency.

## Build requirements

**WA-09-R01.** Credit purchases charge a 10% fee: $55 buys $50 credit. Only verified Stripe facts credit the ledger; duplicate callbacks never credit twice. Do not bill the tenant again on Claim.

**WA-09-R02.** Atomically reserve full face value for all deduplicated recipients before campaign start; show available/reserved/total and reject insufficient funding without partial hidden launch.

**WA-09-R03.** Offer a single brand or 5–10 validated products. GET only displays; intentional POST records durable claim intent and uses the offer ID as Tremendous external reference.

**WA-09-R04.** Handle concurrent taps and uncertain purchases through durable state and lookup-first reconciliation; keep reservations during unknown outcomes. Regenerate provider links when revisiting; never log tokens or redemption URLs.

**WA-09-R05.** Apply tenant-selected 15/30/60-day expiry and return unused reservations once. Unused credit does not expire; closure refunds remaining credit plus corresponding unused purchase fee.

**WA-09-R06.** Keep platform funding at open-offer liability plus configurable buffer; verify bank-transfer API support and settlement before implementing automatic top-ups. Outage or insufficient platform balance preserves the claim and alerts the operator.

**WA-09-R07.** Process signed deduplicated provider events and Stripe disputes; freeze disputed credit, handle spent-credit negative balances, pauses and day-6/day-30 recovery. Gather scoped dispute evidence.

**WA-09-R08.** Enforce gift eligibility and broker confirmation, thank-you wording, provider-hosted brand presentation and reports that distinguish purchased/claimed from store redemption.

## Acceptance scenarios

These are proposed acceptance cases, not passing results. Each case must trace to the applicable source requirements and build requirements above.

**WA-09-AT01.** Purchase $500 credit for $550, reserve 100 gifts of $5, claim five and expire 95: $25 consumed, $475 available, zero reserved; refund of that unused credit includes $47.50 attributable fee, subject to verified payment/refund facts.

**WA-09-AT02.** Race SMS and email claims, expire versus claim, and webhook versus reconciliation: one provider order and one ledger consumption, with no overspend.

**WA-09-AT03.** Timeout after provider commit and duplicate payment/dispute/refund callbacks recover without repeating financial effects.

**WA-09-AT04.** Verify cross-workspace isolation, scanner-safe GET, invalid signatures, insufficient platform funds, pending review and unavailable products.

**WA-09-AT05.** Complete sandbox and Stripe test-mode evidence, then the separately approved live $5 gift bought and claimed end to end.

## Build deliverables

- Versioned schema changes and migration/recovery procedure where needed.
- Canonical domain commands and shared validation, with authorized browser/API/MCP entry points as applicable.
- Worker/provider integration and user-visible pending, failure and recovery states.
- Focused invariant/concurrency/isolation tests and updated source-to-test traceability.
- Staging evidence and operator runbook, including activation, reconciliation and rollback behavior.

## Open decisions

- Resolve credit purchase lots, partial refund/fee rounding and dispute allocation when some credit is reserved; freezing must not silently invalidate a fully funded promised offer.
- Reconcile pending-review expiry and account closure with unknown purchases before returning funds.
- Verify Tremendous balance/top-up API, settlement timing, production approval behavior and product catalog; sandbox runoff did not prove these.
- Complete the specified prepaid-credit legal/refund review; this packet makes no legal or tax determination.

## Rollout and completion evidence

Use sandbox and Stripe test mode independently. Follow the accepted rollout gates unless a later decision changes sequencing; live gifting and customer charging require verified provider/account readiness.

Complete this area only when its scoped requirements are implemented, the listed acceptance cases have recorded evidence, and remaining external verification or activation is explicitly listed. Record source revision, environment, fixture/approved recipient, observed result, evidence reference and unresolved limitation for every acceptance case. Never mark a live gate passed from a mock.
