# WA-13: Platform operations, settings and release readiness

**Status:** Draft build specification for review. Prepared November 23, 2026.

This specification supplements the canonical Flockletter SRD; it does not replace accepted decisions. New design choices below are proposals until recorded in the decision ledger. Read the [review and shared acceptance contract](../REVIEW.md) before implementation.

## Source requirements and evidence

FL-OPS-001–007; FL-ID-005; ADM-1–6; MON-1–4; SEC-1–8; REL-1–6; CHG-1–4; PLT-1–4

- [docs/implementation/PLATFORM_COMPLETION.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/PLATFORM_COMPLETION.md)
- [docs/implementation/RELEASE_PARITY.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/RELEASE_PARITY.md)
- [docs/implementation/TEXTING_PHASE_2.md](https://github.com/alandmunro/flockletter/blob/456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d/docs/implementation/TEXTING_PHASE_2.md)

Evidence baseline: GitHub revision `456b64fe6aa21b5e2df71ecddbdf34aa0ba0831d`. Source review and recorded tests are not a fresh execution or production certification.

## Existing implementation

Protected operator commands, settings, health snapshots, durable workers, alerts and release tooling exist. Their activation and current continuous monitoring must be verified; sleeping Free staging cannot prove unattended service.

## Build scope

Close operational evidence gaps and extend settings/health/balance monitoring for the new work areas without widening operator or database privileges.

Implement only this area’s owned behavior. Dependencies remain owned by their specifications; use agreed interfaces and test doubles until integration is ready. Do not duplicate identity, financial ledgers or delivery dispatch in this work area.

## Dependencies and interface ownership

WA-11 operator identity; WA-14 restore/erasure contracts. Each feature publishes health reasons and bounded configuration schema.

Own operator settings, versioned changes, audit, integration health, alert dispatch and release evidence. Work areas own domain-specific state and provide safe read/command interfaces.

## Build requirements

**WA-13-R01.** Make required limits configurable within safe bounds, with platform defaults/workspace overrides and old/new/actor/interface audit; missing sensitive settings fail closed.

**WA-13-R02.** Monitor worker liveness, queue lag, webhook failures, registration holds, provider errors and gift funding liability; distinguish configuration from observed health.

**WA-13-R03.** Verify Bitwarden startup loading, account/environment separation, restrictive database roles and no sensitive values in diagnostics.

**WA-13-R04.** Promote immutable tested revisions through staging and production with schema compatibility/recovery evidence; verify both web and worker after deployment.

**WA-13-R05.** Define measured availability, alert and recovery targets and capacity budgets; do not claim continuous monitoring from a sleeping service.

## Acceptance scenarios

These are proposed acceptance cases, not passing results. Each case must trace to the applicable source requirements and build requirements above.

**WA-13-AT01.** Worker crash with provider deploy marked live still raises an application liveness alert.

**WA-13-AT02.** Invalid setting, foreign-workspace access, missing secrets and stale operator assurance refuse safely.

**WA-13-AT03.** Rehearse migration compatibility and rollback/recovery using approved isolated environments; verify actual deployed revision.

**WA-13-AT04.** Inject provider and balance failures and record operator alert delivery and resolution.

## Build deliverables

- Versioned schema changes and migration/recovery procedure where needed.
- Canonical domain commands and shared validation, with authorized browser/API/MCP entry points as applicable.
- Worker/provider integration and user-visible pending, failure and recovery states.
- Focused invariant/concurrency/isolation tests and updated source-to-test traceability.
- Staging evidence and operator runbook, including activation, reconciliation and rollback behavior.

## Open decisions

- Confirm current operator MFA and console configuration using actual settings, not historical notes.
- Assign alert recipient/escalation ownership and capacity budgets before expanding customers.

## Rollout and completion evidence

No new paid service, live flag or secret rotation follows from this document. Reuse the protected release workflow and record configuration facts separately.

Complete this area only when its scoped requirements are implemented, the listed acceptance cases have recorded evidence, and remaining external verification or activation is explicitly listed. Record source revision, environment, fixture/approved recipient, observed result, evidence reference and unresolved limitation for every acceptance case. Never mark a live gate passed from a mock.
