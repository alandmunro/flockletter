# Flockletter supplemental requirements review

Prepared November 23, 2026. **Status: draft for review; documentation work authorized.**

This packet divides completion of Flockletter into independently specified work areas. It separates existing implementation, missing development, external verification and activation. It is supplemental review material; its proposals have not been incorporated into the canonical SRD or accepted decision ledger.

The owner selected Tremendous as the gifting implementation. That selection does not imply that earlier work areas are complete. This packet does not change live configuration, buy services, send messages, charge customers or authorize destructive operations.

## Authority and review baseline

Source baseline: `alandmunro/flockletter` revision `456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d`. The linked specifications use immutable source links. Before implementation, compare this baseline with current main and refresh affected status statements.

- [Canonical SRD](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/SRD.md)
- [Decision ledger](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/DECISIONS.md)
- [Accepted texting and gifting requirements](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/PROPOSED_TEXTING_AND_GIFTING.md)
- [Traceability and evidence](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/TRACEABILITY.md)
- [Texting implementation and dated follow-ups](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/TEXTING_PHASE_2.md)

The SRD remains canonical and accepted decisions resolve conflicts. The broader texting document supplies later-phase requirements even where they are not yet promoted to FL-prefixed IDs. `WA-xx`, `WA-xx-Rxx` and `WA-xx-ATxx` are supplemental work-area, build and acceptance identifiers, not replacements for canonical requirement IDs. Ranges in a specification identify its relevant source family, not a claim to fully implement every item in that family.

Evidence is a source-and-documentation review with targeted code/test references, not an exhaustive code audit, a new test run or a fresh production inspection. Statements such as “not established” mean the review found no sufficient implementation or completion evidence; they do not prove code is absent everywhere.

## Work-area register

| Work area | Independent build specification |
| --- | --- |
| WA-01 | [Newsletter core and delivery completion](specs/01-newsletter-core.md) |
| WA-02 | [Newsletter subscriptions and entitlement completion](specs/02-newsletter-billing.md) |
| WA-03 | [Audience, subscriber signup and date data](specs/03-audience-signup.md) |
| WA-04 | [Core SMS completion and live acceptance](specs/04-sms-core.md) |
| WA-05 | [Self-service SMS onboarding, identity and probation](specs/05-sms-onboarding.md) |
| WA-06 | [Date automations and recurring touchpoints](specs/06-date-automations.md) |
| WA-07 | [Events, invitations, RSVP and reminders](specs/07-events-rsvp.md) |
| WA-08 | [Coupons and staff redemption](specs/08-coupons.md) |
| WA-09 | [Tremendous gifting and prepaid credit](specs/09-tremendous-gifting.md) |
| WA-10 | [Texting billing, dashboards and customer launch](specs/10-texting-commercial.md) |
| WA-11 | [Team lifecycle and shared authorization](specs/11-team-access.md) |
| WA-12 | [Support and tenant notifications](specs/12-support-notifications.md) |
| WA-13 | [Platform operations, settings and release readiness](specs/13-platform-operations.md) |
| WA-14 | [Retention, offboarding and recovery](specs/14-retention-offboarding.md) |

## Current build-versus-completion assessment

| Areas | Existing implementation | Remaining work and evidence |
| --- | --- | --- |
| WA-01/02 | Substantial newsletter and subscription implementation; production activation documented | Reconcile outstanding acceptance cases with latest hosted/provider evidence; preserve current commercial policies |
| WA-03 | Hosted/embedded forms, audience records and date storage | Hosted embed proof, identity/import edge-case audit and stable automation interfaces |
| WA-04 | Core SMS and operator registration, local/mock staging evidence and later real filing work | Known feature gaps, carrier approval/delivery evidence and complete phase-2 acceptance |
| WA-05 | Registration primitives available | Customer enrollment, identity checks, probation, templates, review queue and setup-payment integration |
| WA-06 | Contact date storage available | Recurring automation engine and 30-day unattended evidence |
| WA-07/08 | Requirements present | Event/RSVP and coupon workflows and results |
| WA-09 | Vendor decision and external sandbox runoff | Full Flockletter prepaid-credit, claim, refund and dispute implementation |
| WA-10 | Newsletter billing and basic SMS allowance primitives available | Texting products/setup fees, cap policy, cross-feature results and commercial pilot |
| WA-11/12/13/14 | Team, support, operator and retention foundations implemented | Current activation assessment, external evidence, feature extensions and known cleanup gaps |

Do not use a single “done percentage.” For each area report four independent states: **implementation**, **local/staging acceptance**, **external/provider acceptance**, and **production activation**. “Documented live” is not equivalent to all acceptance cases passing.

## Recommended build sequence and independent work

The accepted rollout is core SMS → self-service onboarding → automation/events/coupons → gifting → outside customers. Its gates remain the approved campaign and delivered opted-in text, successful self-service registration of the owner's remaining businesses, 30 days of unattended automations, one live gift end to end, and the accepted pilot/legal/provider conditions.

Proposed engineering sequence for review:

1. **Baseline and SMS completion:** WA-04, supported by WA-03/11/13/14. Refresh status evidence; close inbound forwarding, role access and private cleanup gaps. Keep WA-01/02 regression acceptance current.
2. **Onboarding foundation:** WA-05 plus the narrow setup-payment slice of WA-10 and notification slice of WA-12. Self-service registration cannot charge carrier fees before verified setup payment.
3. **Recurring engagement:** WA-06 using shared contact and delivery interfaces. WA-07 and WA-08 are independently buildable once those interfaces are stable. Begin the unattended observation only when the real automation deployment is ready.
4. **Gifting:** WA-09 can develop sandbox provider and ledger components while other work proceeds. Integrate eligibility from WA-05, optional automated attachments from WA-06, and results from WA-10. Live rollout retains its accepted sequence until a recorded owner decision changes it.
5. **Commercial completion:** complete WA-10 and the cross-cutting production evidence from WA-11–14 before the outside-customer pilot.

“Independent” means a bounded implementation/review package with owned data, commands and acceptance cases. It does not mean permission to bypass shared identity, payments, consent or rollout gates. Test doubles permit development before a dependency is deployed; final integration needs actual contract evidence.

Events and coupons are not technical prerequisites for Tremendous. Likewise a manual gift campaign does not technically require recurring automation. Advancing either live gifting route ahead of the accepted rollout is a sequencing proposal that must be recorded explicitly, rather than silently calling earlier phases complete.

## Shared implementation and acceptance contract

Every area must:

- Use the canonical command layer for browser, HTTP and MCP, with explicitly scoped permissions. A new feature never widens existing delegated grants implicitly.
- Derive workspace authority server-side and enforce isolation in records, queries, workers, callbacks, exports and provider mappings. Use two synthetic workspaces for isolation evidence.
- Record stable durable intent before external mutations; reconcile unknown outcomes before retrying. An API timeout must not erase financial or delivery liability.
- Preserve separate consent per channel and current suppression. Payment, RSVP, import, an existing contact or a gift claim does not create marketing consent.
- Use integer minor units with currency and authoritative provider facts for money; browser returns do not prove payment. Only WA-09 owns gift-credit accounting.
- Use versioned migrations, restricted runtime roles, defined recovery and tested shared-interface contracts. Prefer existing provider/service patterns over duplicate infrastructure.
- Keep secrets, private fraud thresholds, personal data and redemption/claim tokens out of published artifacts and general logs. Environment/provider readiness is checked independently.
- Provide deliberate loading, pending, blocked, failed, retry and recovered UI states; verify keyboard and mobile flows. Reports must name what was actually observed.
- Record focused tests and source requirement mappings; separate local mocks, real database tests, staging, provider sandbox and approved production evidence.
- Keep numerical operational limits in validated operator settings where the accepted requirements require it, while retaining hard safety bounds in code.

An area can be **implementation complete / activation pending**. Its release evidence must not be labeled complete while required external checks are still unresolved.

## Interface and ownership register

| Shared contract | Owner | Consumers | Required invariants |
| --- | --- | --- | --- |
| Person/date/channel eligibility | WA-03 with WA-04 SMS consent | WA-01/06/07/08/09 | Workspace-bound, no inferred consent, explicit ambiguous matches |
| Newsletter dispatch/outcomes | WA-01 | WA-06/07/08/09 | Exact reviewed intent, frozen provider route, lookup-only unknown recovery |
| SMS registration/dispatch/outcomes | WA-04 | WA-05/06/07/08/09 | Carrier readiness, consent, pacing, segments and idempotent local operations |
| Newsletter entitlement/provider payment primitives | WA-02 | WA-05/09/10/11 | Account/environment-bound facts, separate product agreements |
| Setup-payment and texting entitlement | WA-10 | WA-05/04 | Payment verified before carrier cost; no automatic overage |
| Identity/probation eligibility | WA-05 | WA-04/09/10 | Explicit holds, private thresholds, auditable operator override |
| Gift offer and credit ledger | WA-09 | WA-06/10/12/14 | One cross-channel offer, atomic reservation, one consumption, refund liability retained |
| Feature result events | Each owning feature | WA-10 | Stable event identity, deduplication, honest event time and incomplete states |
| Team/member authority | WA-11 | All customer areas | Current membership, revocation and least privilege |
| Tenant notification intent | WA-12 | WA-04/05/09/10 | Dedupe, preferences, mandatory alerts and bounded transport |
| Settings/health/release evidence | WA-13 | All areas | Audited bounded changes, observed liveness, exact deployed revision |
| Retention/closure completion | WA-14 with feature owners | WA-02/04/09/10 | No financial/provider uncertainty discarded; no resurrected work after restore |

Before dependent implementation, document each actual command/event schema, authorization scope, operation key, owner of truth, revision rules, timeout/unknown behavior and error codes in the owning area. These conceptual contracts deliberately do not pretend to be existing API names.

## Review decisions and requirement conflicts

| ID | Decision or correction | Proposed disposition / effect |
| --- | --- | --- |
| REVIEW-01 | Old runoff guide charges gifts on claim and fixes expiry at 60 days | Superseded by accepted prepaid credit, 10% purchase fee and tenant-selected 15/30/60-day offers; use WA-09 |
| REVIEW-02 | Texting summary says missing keys; later entries record keys, startup fixes and a real campaign filing | Reconcile dated evidence before implementation; do not assume the carrier gate is passed or still waiting for keys |
| REVIEW-03 | Phase 3 needs setup fees; broad billing is placed in phase 6 | Build the minimum WA-10 setup-payment contract with WA-05; keep full customer billing/pilot later |
| REVIEW-04 | Earlier wording prohibits tenant-site forms; D-064 permits an embedded Flockletter form | Preserve allowed framing with Flockletter-origin consent handling; no external consent endpoint |
| REVIEW-05 | Gifting could be developed before events/coupons | Independent sandbox development is useful; any change to live rollout ordering needs a recorded decision |
| REVIEW-06 | Already reserved credit may later be disputed; claims are promised funding | Resolve frozen-credit allocation and platform exposure explicitly before live prepaid gifts |
| REVIEW-07 | Newsletter cancellation and texting offboarding use different effective times | Specify service-specific lifecycle and preserve remaining newsletter access |
| REVIEW-08 | General 90-day purge coexists with 24-month message, five-year consent/audit, seven-year ledger and lifetime minimal trial records | Produce an exact retained-data inventory and approved precedence in WA-14; do not apply one blanket deletion rule |
| REVIEW-09 | Tremendous bank-transfer top-up automation is specified but not runoff-tested | Verify API availability, settlement, permissions and failure recovery before implementing automatic funding |
| REVIEW-10 | Existing implemented support/team/operator features may still be disabled | Inspect current production state before deciding new engineering is required; historical off-state is not fresh evidence |

Detailed open decisions are kept in each area specification. New scope such as a coupon staff-authentication mechanism or an event capacity policy is explicitly proposed, not retroactively attributed to the accepted SRD.

## Review-to-build handoff

For each work area, create a bounded implementation plan/PR that references its WA IDs and canonical source requirements. Update the Flockletter decision ledger for accepted sequencing or policy changes, promote later-phase requirements into stable SRD IDs where appropriate, and add real traceability rows. Do not mark all later phases authorized merely because this packet has been written.

Start each build with a source-to-test matrix:

| Source ID | WA build requirement | Existing implementation | Change needed | Acceptance case | Evidence/environment | Remaining gate |
| --- | --- | --- | --- | --- | --- | --- |
| To populate from the area specification | WA-xx-Rxx | Exact source reference or not established | Bounded change | WA-xx-ATxx | Actual result or not run | Explicit unresolved dependency |

At completion, report what changed, what was reused, tests actually run, provider facts actually observed, production activation status and unfinished dependencies. Retain the reviewed revision so future work can distinguish new changes from this baseline.

## Authorship and validation

The primary assistant authored and reviewed this packet. A mechanical template draft was requested through the configured local model, but the local service was unavailable and returned no draft. No local-model output was applied. Product scope, financial state, authorization and acceptance decisions remained with the primary assistant.

Validation of this packet covers file/link integrity, work-area IDs, specification sections and referenced source IDs. It does not run the application or establish feature completion.
