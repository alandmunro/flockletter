# WA-03: Audience, subscriber signup and date data

**Status:** Draft build specification for review. Prepared November 23, 2026.

This specification supplements the canonical Flockletter SRD; it does not replace accepted decisions. New design choices below are proposals until recorded in the decision ledger. Read the [review and shared acceptance contract](../REVIEW.md) before implementation.

## Source requirements and evidence

FL-AUD-001–004/020; FL-BRD-001–002; FL-SMS-005–007; SUB-1–9; IMP-1–6; DATA-1–2

- [docs/SRD.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/SRD.md)
- [src/server/subscribers/people.ts](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/src/server/subscribers/people.ts)
- [migrations/041_audience_people.sql](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/migrations/041_audience_people.sql)
- [docs/implementation/SIGNUP_EMBED.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/SIGNUP_EMBED.md)

Evidence baseline: GitHub revision `456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d`. Source review and recorded tests are not a fresh execution or production certification.

## Existing implementation

Branded hosted forms, consent, import/export, combined email/text people, optional contact dates and embedded signup have source and test evidence. Embedded signup has local evidence only in traceability.

## Build scope

Complete hosted/embed verification and audit full phone/date import and identity-merge behavior; provide a stable audience/date interface for automation.

Implement only this area’s owned behavior. Dependencies remain owned by their specifications; use agreed interfaces and test doubles until integration is ready. Do not duplicate identity, financial ledgers or delivery dispatch in this work area.

## Dependencies and interface ownership

WA-04 owns SMS consent confirmation and STOP state. WA-11 supplies member scopes. WA-06 consumes dates and channel eligibility.

Own subscriber/person links, contact dates, source evidence and channel-specific status. Offer workspace-scoped recipient/date queries and mutation commands; never infer SMS consent from email consent or a merge.

## Build requirements

**WA-03-R01.** Preserve separate email and SMS status while displaying a person once; deterministic email/phone matching must not combine different workspaces or overwrite opt-outs.

**WA-03-R02.** Validate date types and optional years; retain external CRM IDs without implementing a CRM bridge.

**WA-03-R03.** Audit import mappings for phone, names, birthday and anniversary and report added/updated/skipped/rejected records; confirmation requests remain distinct from consent.

**WA-03-R04.** Verify embedded forms remain Flockletter-origin forms framed only by the allowed brand domain, with the same consent and submission rules and no personal data in resize messages.

## Acceptance scenarios

These are proposed acceptance cases, not passing results. Each case must trace to the applicable source requirements and build requirements above.

**WA-03-AT01.** Import duplicate email/phone combinations, conflicting identities and suppressed records; ambiguous merges must be surfaced rather than silently authorized.

**WA-03-AT02.** Save birthday without year, edit/remove a date, and read it through the automation-facing interface.

**WA-03-AT03.** Exercise hosted and allowed-domain embedded forms in real desktop/mobile browsers; refuse another domain and preserve confirmation behavior.

## Build deliverables

- Versioned schema changes and migration/recovery procedure where needed.
- Canonical domain commands and shared validation, with authorized browser/API/MCP entry points as applicable.
- Worker/provider integration and user-visible pending, failure and recovery states.
- Focused invariant/concurrency/isolation tests and updated source-to-test traceability.
- Staging evidence and operator runbook, including activation, reconciliation and rollback behavior.

## Open decisions

- Define handling of ambiguous email-versus-phone matches before adding new merge behavior.
- Use D-064 framing rules to resolve earlier blanket tenant-site form wording; do not create a second external consent collector.

## Rollout and completion evidence

Record staging and hosted form evidence separately from local tests; do not turn synthetic consent records into production eligibility.

Complete this area only when its scoped requirements are implemented, the listed acceptance cases have recorded evidence, and remaining external verification or activation is explicitly listed. Record source revision, environment, fixture/approved recipient, observed result, evidence reference and unresolved limitation for every acceptance case. Never mark a live gate passed from a mock.
