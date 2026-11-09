# Launch policy review packet

**Status: internal review drafts; not published customer agreements or policies in force.** Prepared from repository revision `05992ffa3549df92d6e6d7c80018b8f61902f7c1` on November 9, 2026. No business address, tax registration, provider outcome or legal review is inferred. These files create no runtime route or acceptance flow and activate no sending, billing, automatic support or hosted erasure.

The [SRD](../SRD.md), [decision ledger](../DECISIONS.md) and [production preparation checklist](../implementation/PRODUCTION_LAUNCH_PREPARATION.md) remain authoritative. D-048/049/050 are already accepted; this packet does not ask the owner to accept them again. Draft text must not weaken their limits or existing eligibility/hold controls.

## What exists

| Material | Existing evidence and remaining review |
| --- | --- |
| [Hosted terms draft](TERMS_DRAFT.md) | Consolidates accepted product/commercial facts. Final contractual provisions and factual blanks remain for owner review. |
| [Refund draft](REFUND_DRAFT.md) | Implements the accepted manual-review position in draft wording; no automatic refund or no-refunds rule. |
| [Acceptable-use draft](ACCEPTABLE_USE_DRAFT.md) | Distinguishes existing consent/suppression controls from proposed customer obligations and unresolved trust thresholds. |
| Public privacy/storage notice | Source: [Privacy.tsx](../../src/client/Privacy.tsx), version `flockletter-privacy-v1`, November 9, 2026; public source routes `/privacy`, `/policies/privacy` and `/cookies`. Covers necessary storage, no optional website analytics/advertising, account data, ordinary retention and the D-048 pseudonymous lifetime trial-history exception. Source presence does not verify hosted publication or complete the remaining privacy review. |
| Support disclosure | [Help.tsx](../../src/client/Help.tsx) discloses AI-assisted drafts with human review. [Support controls](../implementation/CUSTOMER_SUPPORT_RETENTION.md) describe separate bounded automation gates. Reconcile approved public wording with the actual enabled behavior before activation. |
| Existing customer price/date acceptance | [SubscriptionLifecycle.tsx](../../src/client/SubscriptionLifecycle.tsx) displays the recurring price and first-charge date and uses a frozen review before trial activation. Final document versions, links and any required agreement evidence need separate review; this packet does not alter that flow. |

The old S53 [design prototype](../design/prototype/screens.js) explicitly labels legal text unfinished. It is not a final agreement.

## Remaining owner facts and decisions

Record private facts privately. Public evidence should reference the verification date, reviewer and outcome without secrets, customer data or unnecessary provider identifiers.

| Item | Missing input or review | Gate and source |
| --- | --- | --- |
| Business/contact facts | Verify the contracting identity and publishable contact details, including the address required by the approved sender/launch policy. Do not infer a home or business address from another application. The intended operator and Colorado DBA confirmation are already recorded. | O-008; FL-BIL-006, FL-AUD-004 |
| Tax treatment | Obtain the actual tax determination, applicable registrations and intended price/tax presentation. US-only SaaS customers and a Colorado DBA do not establish these facts. | O-008; FL-BIL-006; production preparation |
| Final agreements | Review exact terms/refund/privacy/AUP wording, version/effective date, publication and customer acceptance. Contract provisions absent from the accepted ledger remain undecided. | O-006/008; FL-PROD-004, FL-BIL-005/006/007 |
| Sending trust | Approve initial trust limits, measurement windows, complaint/bounce thresholds, review/hold escalation and reinstatement authority; reconcile enforcement with the selected provider. Plan caps do not settle reputation policy. | O-007; FL-DEL-003/008 |
| Data lifecycle | Resolve remaining retention clock/copies, backup expiry, minimal billing/suppression/control records, holds, earlier deletion requests, geography and recovery targets. D-048 is already accepted within its narrow scope. Do not promise every copy is physically erased exactly on day 90. | O-009; FL-AUD-005, FL-OPS-005 |
| Consent/tracking | Review final signup/import permission wording, brand-specific consent and who may enable tracking. Website cookie acceptance grants none of these permissions. | O-010; FL-AUD-002/004, FL-PRV-001 |
| Support | Confirm human handoff coverage, any intended hours/response commitments and approved guidance. Review AI provider data-use, retention and disclosure before enabling it; do not invent a response target. | O-012; FL-SUP-001/002 |

## Verification after decisions

These are factual checks, not repeated approval of accepted policy. Record a private evidence reference, environment, revision, date, reviewer, observed outcome and remaining gap for each row.

| Status | Responsible reviewer | Required evidence |
| --- | --- | --- |
| Open | Operator: billing/provider configuration | Actual Flockletter merchant account/business match, price catalogue, portal behavior and signed events; stable trial configuration and reviewed real history baseline. |
| Open | Operator: storage/retention | Actual storage/provider-copy inventory and protected retention/restore evidence. A disposable drill is not hosted erasure evidence. |
| Open | Primary reviewer: exact copy | Every draft checked against accepted decisions and completed factual review; unresolved terms remain visibly unresolved. |
| Open | Operator and primary reviewer: public surfaces | After exact copy approval, staging links, responsive/keyboard access, displayed versions and price/date/document acceptance evidence. Verify the deployed revision separately. |
| Gated | Action-specific operator | Live billing, customer mail, automatic support and hosted purge remain off until their independent configuration, authorization and evidence gates are satisfied. No draft approval alone activates them. |

Requirement evidence remains in [traceability](../TRACEABILITY.md): particularly FL-AT-009/010/013/015/016/023/028/029/031/035. This packet claims a source audit and documentation review only, not provider verification or legal completeness.

Local Qwen supplied the first owner/operator checklist scaffold. Primary review corrected its retention references (O-009, not O-012), separated D-031's chosen addresses from the separately recorded business/DBA facts, replaced inaccurate requirement mappings and removed repetitive approved-policy summaries. Primary review owns the legal/policy distinctions and the terms, refund and acceptable-use drafts.
