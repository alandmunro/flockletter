# WA-07: Events, invitations, RSVP and reminders

**Status:** Draft build specification for review. Prepared November 23, 2026.

This specification supplements the canonical Flockletter SRD; it does not replace accepted decisions. New design choices below are proposals until recorded in the decision ledger. Read the [review and shared acceptance contract](../REVIEW.md) before implementation.

## Source requirements and evidence

EVT-1–3; DSH-1/6/9–11; CON-1–6; SEC-7; DATA-3

- [docs/implementation/PROPOSED_TEXTING_AND_GIFTING.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/PROPOSED_TEXTING_AND_GIFTING.md)
- [docs/implementation/TEXTING_PHASE_2.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/TEXTING_PHASE_2.md)

Evidence baseline: GitHub revision `456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d`. Source review and recorded tests are not a fresh execution or production certification.

## Existing implementation

The source requirements describe events; phase 2 excludes them. No event implementation was established in the review.

## Build scope

Build event authoring, scoped invitations, recipient RSVP pages, capacity handling, reminders and results.

Implement only this area’s owned behavior. Dependencies remain owned by their specifications; use agreed interfaces and test doubles until integration is ready. Do not duplicate identity, financial ledgers or delivery dispatch in this work area.

## Dependencies and interface ownership

WA-03 recipients; WA-01/04 delivery; WA-11 permissions; WA-13 workers; WA-10 aggregate results contract. WA-06 scheduling primitives may be reused without coupling event ownership to date automations.

Own events, invitation identity, RSVP state and reminder schedules. Publish invited/yes/no/no-reply facts; RSVP alone must not establish marketing consent.

## Build requirements

**WA-07-R01.** Create and edit event name/date/place/capacity, select an authorized audience and review invitations before sending.

**WA-07-R02.** Provide scoped hosted RSVP links with idempotent updates and separate optional SMS opt-in using existing confirmation.

**WA-07-R03.** Enforce capacity atomically; show a clear full/canceled state and preserve the RSVP history.

**WA-07-R04.** Send reminders only through eligible delivery paths and cancel unsubmitted reminders when the event or invitation is canceled.

## Acceptance scenarios

These are proposed acceptance cases, not passing results. Each case must trace to the applicable source requirements and build requirements above.

**WA-07-AT01.** Concurrent final-seat RSVPs cannot exceed capacity; duplicate submissions do not consume seats twice.

**WA-07-AT02.** Forwarded/guessed tokens cannot expose another event or unrelated personal data; opt-in remains pending until confirmed.

**WA-07-AT03.** Cancel/reschedule before a reminder dispatch and verify no stale reminder; reports/CSV agree with RSVP records.

## Build deliverables

- Versioned schema changes and migration/recovery procedure where needed.
- Canonical domain commands and shared validation, with authorized browser/API/MCP entry points as applicable.
- Worker/provider integration and user-visible pending, failure and recovery states.
- Focused invariant/concurrency/isolation tests and updated source-to-test traceability.
- Staging evidence and operator runbook, including activation, reconciliation and rollback behavior.

## Open decisions

- Define whether capacity is reserved on invitation or affirmative RSVP; proposed default is affirmative RSVP, subject to review.
- Decide guest counts, response-change cutoff and cancellation notification behavior; waitlists are not implied scope.

## Rollout and completion evidence

Release behind an explicit feature setting after hosted RSVP and approved-recipient reminder evidence; events do not block technical development of gifting.

Complete this area only when its scoped requirements are implemented, the listed acceptance cases have recorded evidence, and remaining external verification or activation is explicitly listed. Record source revision, environment, fixture/approved recipient, observed result, evidence reference and unresolved limitation for every acceptance case. Never mark a live gate passed from a mock.
