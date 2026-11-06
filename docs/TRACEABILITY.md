# Flockletter requirement traceability

This matrix maps the proposed requirements in [the SRD](SRD.md) to planned acceptance cases. All cases below are **planned, not run**. Phase 1 contains documentation only; no test code, mock execution or live verification is being claimed.

Later evidence must identify the implementation revision, environment, input scenario, observed result and any remaining external check. Use two synthetic customer workspaces for isolation tests. Keep secrets, personal data and sensitive provider responses out of public evidence.

| Case | Requirements | Planned acceptance result |
| --- | --- | --- |
| FL-AT-001 | FL-PROD-001, FL-PROD-003 | A clean self-hosted setup runs from published source/instructions with user-supplied services, without private owner systems or a Flockletter subscription; license/notices are present. |
| FL-AT-002 | FL-PROD-002, FL-ONB-001, FL-ONB-002 | A new public customer onboards without an invitation. Refreshes and duplicate submissions resume one workspace/subscription. A failed provisioning step has a visible recovery state. |
| FL-AT-003 | FL-PROD-004, FL-BIL-001 | Pricing, UI, API and MCP agree on the versioned plan catalogue, prerequisites and limits; unavailable features are not advertised. |
| FL-AT-004 | FL-ONB-003, FL-ID-001, FL-ID-004 | Verify login/recovery, role changes, last-owner protection, seat limits and revocation. Revoked authority cannot create new or execute pending sends. |
| FL-AT-005 | FL-ID-002, FL-ID-003, FL-OPS-001 | Workspace A cannot read, mutate, export or associate B's records, assets, jobs, billing or engine data through guessed IDs, alternate transports or direct runtime database access. |
| FL-AT-006 | FL-ONB-004, FL-ID-005 | Customer administration cannot reach platform privileges; browser responses omit provider secrets; privileged support actions have scoped authority and a redacted audit trail. |
| FL-AT-007 | FL-BIL-002, FL-BIL-004 | Card entry occurs in the payment-provider flow. Reject foreign customer/price IDs, invalid workspace bindings and duplicate purchase intents; store currency and integer amounts. |
| FL-AT-008 | FL-BIL-003 | In billing test environments, verify success without a browser return, invalid signatures, wrong account/environment, delayed/duplicate/out-of-order events and unknown outcomes. Access follows reconciled provider facts. |
| FL-AT-009 | FL-BIL-005 | Approved upgrade, downgrade, cancellation and payment-failure rules change sending predictably, preserve data and retain necessary billing/unsubscribe/export access. |
| FL-AT-010 | FL-BIL-006 | Before paid launch, record approved markets, terms, business/tax setup and verified provider configuration; existing merchant settings remain unchanged. |
| FL-AT-011 | FL-USG-001, FL-USG-002, FL-USG-003 | Concurrent UI/API/MCP sends cannot exceed allowance; retries settle usage once; bounces, suppressed recipients, real test sends and unknown results follow the documented unit rules. |
| FL-AT-012 | FL-USG-004, FL-OPS-002 | A signup/import/send burst remains within approved aggregate spend, connection and compute budgets; other workspaces receive service; failed provisioning is recoverable. |
| FL-AT-013 | FL-ONB-005, FL-AUD-001, FL-AUD-002 | Subscriber signup/preferences work without a paid login, preserve consent evidence and distinct states, and do not infer consent from purchases or another brand's records. |
| FL-AT-014 | FL-AUD-003, FL-API-003 | Invalid/oversized/mixed imports report gaps before work, produce per-item outcomes, retry without duplicates and preserve suppression; exports remain workspace-scoped. |
| FL-AT-015 | FL-AUD-004, FL-DEL-004, FL-CAM-006 | Unsubscribe or a verified complaint during a queued campaign prevents subsequent submissions. Repeated/out-of-order feedback and reimport cannot undo suppression; no SaaS login is required. |
| FL-AT-016 | FL-AUD-005 | Export/correction/deletion follows the approved retention policy, preserves necessary suppression, and cannot delete or expose another customer's records. |
| FL-AT-017 | FL-CAM-001, FL-OPS-006 | Validate templates, message fields, media limits and malicious uploads/URLs; previews render safely and do not expose private assets. |
| FL-AT-018 | FL-CAM-002, FL-CAM-003 | Preflight reports all blocking gaps. A changed content/sender/audience/timing snapshot invalidates approval; new subscribers are not silently added after scheduling. |
| FL-AT-019 | FL-CAM-004, FL-CAM-005, FL-OPS-003 | Restart and lease/retry tests preserve schedules and operation identity; pause/cancel stops future submissions; ambiguous acceptance enters reconciliation rather than a blind resend. |
| FL-AT-020 | FL-CAM-006, FL-ID-004 | Revoke membership/grant, suspend subscription, exhaust budget or invalidate sender after scheduling; execution stops with the correct visible reason. |
| FL-AT-021 | FL-CAM-007, FL-DEL-004 | Reports distinguish submitted/accepted/delivered and incomplete feedback, respect tracking settings and apply repeated provider events without double counts. |
| FL-AT-022 | FL-DEL-001, FL-DEL-002 | Hosted onboarding includes delivery without customer provider credentials. Verify DNS/sender setup and real provider feedback using approved recipients; loss of verification stops sends. |
| FL-AT-023 | FL-DEL-003, FL-USG-004 | An abusive or high-risk signup/send attempt is bounded or held under the approved policy; payment alone cannot bypass sender trust limits; unaffected tenants remain isolated. |
| FL-AT-024 | FL-DEL-005, FL-ID-003 | Demonstrate that engine APIs, raw-query features, worker retries and alternate send paths cannot bypass tenant, suppression or usage controls. Record unsupported engine behavior as a failed gate. |
| FL-AT-025 | FL-API-001, FL-API-002, FL-API-003 | UI/API/MCP execute equivalent commands with the same results. Read/draft grants cannot send; expired/revoked/foreign grants fail; retries and partial batches remain safe. |
| FL-AT-026 | FL-API-004, FL-API-005, FL-PROD-001 | FFA can prepare a draft from authorized published product data using its grant; photos and commerce settings are unchanged; publication does not send; consent changes reconcile without database joins. |
| FL-AT-027 | FL-OPS-001, FL-OPS-002 | Inventory effective shared-database grants and capacity. Prove no access to existing application records and no workload-budget breach, including rollout overlap and extra customer engines. |
| FL-AT-028 | FL-OPS-004, FL-OPS-005 | Staging uses isolated test credentials and captured/allowlisted mail. Restore into an isolated destination and reconcile provider facts before enabling sends; do not overwrite shared production. |
| FL-AT-029 | FL-OPS-005, FL-OPS-007 | Exercise alerts and recovery against approved numeric targets; collect actual capacity, billing, DNS, provider and isolation evidence before paid public activation. |
| FL-AT-030 | FL-OPS-006 | Complete critical customer flows with keyboard navigation and clear error/status presentation; verify session/origin checks, bounded work and log redaction. |

## Evidence status

The only completed checks in this phase concern documentation structure, references, requirement coverage and public-repository contents. They do not satisfy the implementation acceptance cases above. Add implementation evidence only after coding is authorized and the relevant checks actually run.
