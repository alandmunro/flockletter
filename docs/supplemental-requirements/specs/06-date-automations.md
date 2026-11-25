# WA-06: Date automations and recurring touchpoints

**Status:** Draft build specification for review. Prepared November 23, 2026.

This specification supplements the canonical Flockletter SRD; it does not replace accepted decisions. New design choices below are proposals until recorded in the decision ledger. Read the [review and shared acceptance contract](../REVIEW.md) before implementation.

## Source requirements and evidence

DATE-1–9; REL-3/7; DATA-2–3; MSG-5/6/8; GFT-1 integration

- [docs/implementation/PROPOSED_TEXTING_AND_GIFTING.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/PROPOSED_TEXTING_AND_GIFTING.md)
- [docs/implementation/TEXTING_PHASE_2.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/TEXTING_PHASE_2.md)
- [migrations/040_texting.sql](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/migrations/040_texting.sql)

Evidence baseline: GitHub revision `456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d`. Source review and recorded tests are not a fresh execution or production certification.

## Existing implementation

Dates are stored and editable. The phase-2 implementation explicitly says nothing sends on those dates. A recurring date-trigger engine is not established by the existing broadcast scheduler.

## Build scope

Build recurring birthday, anniversary and custom-date messaging with preview, cancellation, consent-aware channel selection and durable catch-up.

Implement only this area’s owned behavior. Dependencies remain owned by their specifications; use agreed interfaces and test doubles until integration is ready. Do not duplicate identity, financial ledgers or delivery dispatch in this work area.

## Dependencies and interface ownership

WA-03 dates; WA-04 SMS dispatch; WA-01 email dispatch; WA-11 authority; WA-13 durable workers. Optional gift/coupon attachments use WA-09/08 contracts and can be added after plain messages.

Own automation definitions/revisions, occurrence identity and scheduled occurrence state. Proposed occurrence identity includes workspace, automation, person and occurrence date; final schema must ensure one occurrence across retries and channel fallback.

## Build requirements

**WA-06-R01.** Configure per-date-type template and local send time, enable/disable and expose the next 30 days with cancellable occurrences.

**WA-06-R02.** Repeat annually, omit years merge data when unknown, use February 28 for February 29 in non-leap years, and apply recipient time zones and quiet hours.

**WA-06-R03.** Check current consent at dispatch; use eligible email fallback without creating permission or re-sending an uncertain SMS through email.

**WA-06-R04.** Persist occurrence intent before queueing; catch up after outages only within the configured two-day default window, with no duplicate annual send.

**WA-06-R05.** Freeze attachment/offer identity across channels and define revision behavior for future occurrences without altering already submitted work.

## Acceptance scenarios

These are proposed acceptance cases, not passing results. Each case must trace to the applicable source requirements and build requirements above.

**WA-06-AT01.** Use a controlled clock across year boundaries, leap years, daylight-saving changes and missing years/time zones.

**WA-06-AT02.** Race two workers and restart after dispatch; one occurrence produces one authorized delivery operation per selected channel policy.

**WA-06-AT03.** Change consent, date, automation revision or cancellation after preview; dispatch reflects the defined current rules.

**WA-06-AT04.** Run plain-message automations unattended for 30 days in the owner’s workspaces and record incidents, missed occurrences and recovery.

## Build deliverables

- Versioned schema changes and migration/recovery procedure where needed.
- Canonical domain commands and shared validation, with authorized browser/API/MCP entry points as applicable.
- Worker/provider integration and user-visible pending, failure and recovery states.
- Focused invariant/concurrency/isolation tests and updated source-to-test traceability.
- Staging evidence and operator runbook, including activation, reconciliation and rollback behavior.

## Open decisions

- Decide fallback timing and whether known delivery failure, not just missing SMS eligibility, can trigger email.
- Define timezone fallback and behavior when a date/template changes after an occurrence is queued; record these as implementation decisions.

## Rollout and completion evidence

Deterministic clock tests precede hosted observation. The accepted 30-day gate is a launch-sequencing gate; local time travel is not equivalent evidence.

Complete this area only when its scoped requirements are implemented, the listed acceptance cases have recorded evidence, and remaining external verification or activation is explicitly listed. Record source revision, environment, fixture/approved recipient, observed result, evidence reference and unresolved limitation for every acceptance case. Never mark a live gate passed from a mock.
