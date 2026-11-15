# Delivery diagnosis and test-only recovery

Applies to FL-ONB-004, FL-ID-002/004/005, FL-CAM-003/005/010, FL-DEL-002/004/005/007 and FL-API-001/003. The owner requested investigation, regression coverage and an unmerged pull request; no deployment, activation or migration is part of this work.

## Observed production conditions

On November 12, 2026 (Mountain time), the authorized customer session and workspace did not expose the requested version-six campaign or a test group. Its saved campaign list exposed one earlier version-two pilot. Do not substitute that pilot, recreate the requested message, infer a group from a contact list, or cross workspace boundaries to obtain a send.

The production release was `f2a16fd5dbac277757c51a0447897924ef1d73c6`. Readiness passed. The selected brand and default transport were Resend, test-only scope was enabled, sender/provider checks were current, and service access was complimentary Growth. The dedicated worker had a fresh heartbeat, recent queue pass, no recorded failure and zero queued/unknown delivery work in the inspected workspace. Sampled application and worker logs showed healthy startup, without a campaign-specific error. Those observations do not prove another workspace contains or lacks the requested campaign.

Operations explicitly reported `broadcasts_disabled`: test-only scope permits separate one-contact reviews. A named group, even one named Test, uses the broadcast path. A test request with a group/schedule is rejected by the shared input contract. AWS sandbox/production access cannot explain a Resend submission; AWS was not selected. No production campaign request or email was submitted during this investigation. Exact target-specific approval, preflight and provider facts remain unverified until the real campaign and recipient references are available.

## Changes

`delivery.status` now returns the server-derived environment, workspace and observation time, plus selected-brand route presence and renderer configuration. These are the same observations used by the UI, API and MCP. They carry no key, endpoint credential, private audience directory or cross-workspace lookup. Existing brand access checks remain binding. Missing-route guidance names the actual selected service and distinguishes configuration from current sender/provider verification.

Delivery displays these facts in a collapsed support-details view alongside the selected saved campaign ID/version. Test-only mode explicitly labels the broadcast audience selector unused; it never defaults that selector into a test recipient. Group restrictions explain the valid one-contact path and shared five-approval UTC-day policy.

The client preserves validated server error codes/status while retaining the existing authentication-refresh boundary. Delivery uses known codes for actionable missing-campaign/workspace, stale-version, group, quota and original-operation recovery guidance. Unknown outcomes never recommend a new send. No change to review snapshots, consent, suppression, provider submission, operation keys, accounting or worker retry policy is included.

## Verification and release limits

Isolated database tests cover missing Resend binding, not-ready sender and successful readiness recovery without a submission; missing campaign without a review; and the same status through MCP with foreign-brand refusal. Existing adversarial tests cover version changes, pending/uncertain duplicate refusal, revocation and test-only broadcast rejection. Browser proof exercises desktop/390px support context plus the captured one-contact lost-acknowledgment/recovery path. These tests do not claim a production send of the requested campaign.

Run lint, typecheck, full tests, build, generated API consistency, dependency audit and the existing captured test-send browser proof. Record results on the PR after observation. Do not merge, deploy or change Render/AWS settings automatically. Once the actual saved version and intended confirmed contacts are identified, inspect their exact original history before a review/approval. A recovery of uncertain work must use its original operation; an accepted email cannot be recalled or safely duplicated.

Local verification passed lint, typecheck, all 137 test files (1,119 passed; two existing gated skips), production build, API regeneration and dependency audit with zero reported vulnerabilities. Desktop/390px captured test-send proof passed with support-context assertions and lost-acknowledgment recovery. One existing assertion was updated from generic selected-brand wording to the actual named-provider readiness message. No hosted deployment or requested production campaign delivery is claimed.

## Model contributions

Local Qwen summarized the test path and drafted the support-details component and SSR scaffold. Primary review removed an incorrect dependency on subscription eligibility for missing-draft guidance, added safe campaign-title rendering, corrected fabricated test fields/imports/props and replaced weak assertions. Primary owns source/production evidence distinctions, access/scope decisions, shared contract and server/client integration, safe error recovery and verification. The separate approved sending-policy/Pro workstream remains paused for this investigation.
