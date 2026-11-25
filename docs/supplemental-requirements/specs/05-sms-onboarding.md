# WA-05: Self-service SMS onboarding, identity and probation

**Status:** Draft build specification for review. Prepared November 23, 2026.

This specification supplements the canonical Flockletter SRD; it does not replace accepted decisions. New design choices below are proposals until recorded in the decision ledger. Read the [review and shared acceptance contract](../REVIEW.md) before implementation.

## Source requirements and evidence

ONB-1–10; IDV-1–11; REG-2–6; CMP-1–6; HST-1–4; PLT-2; D-063

- [docs/implementation/PROPOSED_TEXTING_AND_GIFTING.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/PROPOSED_TEXTING_AND_GIFTING.md)
- [docs/implementation/TEXTING_PHASE_2.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/TEXTING_PHASE_2.md)

Evidence baseline: GitHub revision `456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d`. Source review and recorded tests are not a fresh execution or production certification.

## Existing implementation

Operator-run durable registration is available. The phase-2 specification excludes self-service identity checks, probation and customer onboarding. Current live filing uses operator-authored business wording.

## Build scope

Build customer enrollment and progress, business validation, identity/risk review, vertical templates, recovery and probation around the existing registration service.

Implement only this area’s owned behavior. Dependencies remain owned by their specifications; use agreed interfaces and test doubles until integration is ready. Do not duplicate identity, financial ledgers or delivery dispatch in this work area.

## Dependencies and interface ownership

WA-04 registration; WA-10 verified setup-payment facts; WA-11 owner authorization; WA-13 operator review/settings. Hosted business-page publishing contract belongs here; WA-10 owns commercial acceptance.

Own enrollment revision, business/DBA identity evidence, registration progress, accepted policy versions and probation state. Export eligibility/reason codes to SMS and gifting. Setup payment must be verified before a chargeable registration call.

## Build requirements

**WA-05-R01.** Provide resumable in-app enrollment with business details, per-vertical sample templates, validation and plain-language carrier rejection recovery.

**WA-05-R02.** Implement domain/business-phone verification, payer comparison, EIN ownership constraints, protected evidence upload and a bounded operator review queue.

**WA-05-R03.** Support the specified sole-proprietor path with its provider verification; current EIN-only adapter refusal is not completion of ONB-9.

**WA-05-R04.** Implement probation, canary release, automatic pause/suspension and audited operator override using private configurable thresholds, never public hard-coded fraud values.

**WA-05-R05.** Publish tenant-accepted business/privacy/SMS pages with version history; treat carrier acceptance of domainless pages and DBA paths as external verification gates.

## Acceptance scenarios

These are proposed acceptance cases, not passing results. Each case must trace to the applicable source requirements and build requirements above.

**WA-05-AT01.** Resume after timeout at every registration step without duplicate resource purchase or duplicate setup charge.

**WA-05-AT02.** Reject conflicting EIN ownership, wrong-workspace evidence and unverifiable payer identity; review resolution is audited.

**WA-05-AT03.** Probation expires only after both time and delivery criteria; a canary failure prevents remaining sends.

**WA-05-AT04.** Register the owner’s remaining businesses through the normal customer flow without hidden operator workarounds, recording carrier results.

## Build deliverables

- Versioned schema changes and migration/recovery procedure where needed.
- Canonical domain commands and shared validation, with authorized browser/API/MCP entry points as applicable.
- Worker/provider integration and user-visible pending, failure and recovery states.
- Focused invariant/concurrency/isolation tests and updated source-to-test traceability.
- Staging evidence and operator runbook, including activation, reconciliation and rollback behavior.

## Open decisions

- Obtain private threshold values and approved handling/retention of identity documents.
- Verify Twilio DBA, sole-proprietor and hosted-page compatibility before promising those routes.
- Resolve phase-3 dependency on setup billing, although the broad billing rollout is listed in phase 6.

## Rollout and completion evidence

Mock and staging first; customer self-service registration activates only after contracts, fees and carrier behavior are verified. Existing phase-2 owner-only live scope remains until explicitly expanded.

Complete this area only when its scoped requirements are implemented, the listed acceptance cases have recorded evidence, and remaining external verification or activation is explicitly listed. Record source revision, environment, fixture/approved recipient, observed result, evidence reference and unresolved limitation for every acceptance case. Never mark a live gate passed from a mock.
