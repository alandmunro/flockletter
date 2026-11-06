# Flockletter UI user stories

Design review version 2 · Proposed UI behavior, not implementation test evidence. Each screen has a stable story and requirement mapping. Read [the eight end-to-end walkthroughs](WALKTHROUGHS.md) first for a customer-oriented tour.

The canonical requirements remain [the SRD](../SRD.md). A displayed example date, sample role, mock status or provider handoff does not approve an unresolved policy. All real external operations need later implementation and verification.

<a id="fl-st-001"></a>
## FL-ST-001 — Understand the service and audience

**Role:** Visitor. **Screen:** [S01 — A little letter. A lasting connection.](https://flockletter-design-review.alandmunro.chatgpt.site/#home). [Screenshot](screenshots/S01-home.jpg).

As a visitor, I want to understand the service and audience, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Read the offer.
2. Explore the plans.
3. Start the sample signup.

**Expected outcome:** Clear expectations about included delivery and finite allowances.
**Failure and recovery:** Unavailable features are not advertised as available.
**Requirements:** FL-PROD-004.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-002"></a>
## FL-ST-002 — Choose a plan with understandable limits

**Role:** Visitor. **Screen:** [S02 — A plan for your kind of business.](https://flockletter-design-review.alandmunro.chatgpt.site/#pricing). [Screenshot](screenshots/S02-pricing.jpg).

As a visitor, I want to choose a plan with understandable limits, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Compare all three plans.
2. Read shared allowances and trial limits.
3. Choose a sample plan.

**Expected outcome:** The selected monthly price follows into the trial summary.
**Failure and recovery:** Explain that 20 Tier 3 campaigns still share 100,000 emails.
**Requirements:** FL-BIL-001, FL-USG-001, FL-BIL-007.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-003"></a>
## FL-ST-003 — Create an account through Clerk

**Role:** New customer. **Screen:** [S03 — Make room for your flock.](https://flockletter-design-review.alandmunro.chatgpt.site/#signup). [Screenshot](screenshots/S03-signup.jpg).

As a new customer, I want to create an account through Clerk, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Choose Google, Apple, Microsoft or email with a one-time verification code.
2. Complete the provider step or sample email-code verification.
3. Continue to workspace setup.

**Expected outcome:** An authenticated identity can begin onboarding; it does not yet authorize sending.
**Failure and recovery:** An existing account returns to sign-in without creating another workspace.
**Requirements:** FL-ID-001, FL-ONB-001.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-004"></a>
## FL-ST-004 — Sign in and return to an authorized workspace

**Role:** Returning member. **Screen:** [S04 — Welcome back.](https://flockletter-design-review.alandmunro.chatgpt.site/#signin). [Screenshot](screenshots/S04-signin.jpg).

As a returning member, I want to sign in and return to an authorized workspace, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Choose Google, Apple, Microsoft or email with a one-time verification code.
2. Complete the provider step or sample email-code verification.
3. Open the active workspace.

**Expected outcome:** Clerk login and membership identify the workspaces the user may access.
**Failure and recovery:** Expired or revoked sessions return to sign-in with a safe recovery route.
**Requirements:** FL-ID-001, FL-ID-002.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-005"></a>
## FL-ST-005 — Verify or recover a login

**Role:** Account holder. **Screen:** [S05 — A quick check, then you’re in.](https://flockletter-design-review.alandmunro.chatgpt.site/#verify-recover). [Screenshot](screenshots/S05-verify-recover.jpg).

As a account holder, I want to verify or recover a login, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review the masked destination.
2. Use the sample verification code.
3. Resume the prior step.

**Expected outcome:** The user returns to the interrupted account flow.
**Failure and recovery:** Expired codes and lost access offer resend/recovery without exposing account existence.
**Requirements:** FL-ID-001, FL-ONB-001.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-006"></a>
## FL-ST-006 — Join the intended workspace

**Role:** Invited teammate. **Screen:** [S06 — You’ve been invited to the flock.](https://flockletter-design-review.alandmunro.chatgpt.site/#invitation). [Screenshot](screenshots/S06-invitation.jpg).

As a invited teammate, I want to join the intended workspace, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review workspace and proposed role.
2. Sign in with the invited identity through Clerk.
3. Accept the sample invitation.

**Expected outcome:** Clerk membership is established for the correct workspace.
**Failure and recovery:** Expired invitations, a mismatched identity or a full seat allowance explain the next step.
**Requirements:** FL-ONB-003, FL-ID-004, FL-USG-006.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-007"></a>
## FL-ST-007 — Set up the business workspace

**Role:** Workspace owner. **Screen:** [S07 — Let’s give your workspace a name.](https://flockletter-design-review.alandmunro.chatgpt.site/#workspace-onboarding). [Screenshot](screenshots/S07-workspace-onboarding.jpg).

As a workspace owner, I want to set up the business workspace, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Enter the sample workspace and business details.
2. Confirm US business eligibility.
3. Continue to the selected trial.

**Expected outcome:** Workspace creation resumes safely if interrupted.
**Failure and recovery:** A provisioning or identity problem preserves progress and offers recovery.
**Requirements:** FL-ONB-001, FL-PROD-002, FL-BIL-006.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-008"></a>
## FL-ST-008 — Understand the trial and payment handoff

**Role:** Workspace owner. **Screen:** [S08 — Your first 14 days, clearly laid out.](https://flockletter-design-review.alandmunro.chatgpt.site/#trial-checkout). [Screenshot](screenshots/S08-trial-checkout.jpg).

As a workspace owner, I want to understand the trial and payment handoff, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review recurring price and trial allowance.
2. Continue to the Stripe-hosted mock payment step.
3. See pending confirmation before activation.

**Expected outcome:** The trial becomes eligible only after verified provider confirmation in the future product.
**Failure and recovery:** An abandoned or failed card setup resumes here without sending eligibility.
**Requirements:** FL-BIL-002, FL-BIL-003, FL-BIL-007.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-009"></a>
## FL-ST-009 — Understand setup status without repeating signup

**Role:** Workspace owner. **Screen:** [S09 — We’re preparing your workspace.](https://flockletter-design-review.alandmunro.chatgpt.site/#provisioning). [Screenshot](screenshots/S09-provisioning.jpg).

As a workspace owner, I want to understand setup status without repeating signup, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review separate identity, billing and service statuses.
2. Wait or safely retry the failed step.
3. Resume onboarding.

**Expected outcome:** Setup is presented separately from sender and payment readiness.
**Failure and recovery:** A failed service step gets one recoverable status and support link, not another charge.
**Requirements:** FL-ONB-001, FL-ONB-002, FL-OPS-003.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-010"></a>
## FL-ST-010 — Complete sender, audience and campaign setup

**Role:** Workspace owner. **Screen:** [S10 — Your first letter starts here.](https://flockletter-design-review.alandmunro.chatgpt.site/#onboarding). [Screenshot](screenshots/S10-onboarding.jpg).

As a workspace owner, I want to complete sender, audience and campaign setup, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review the checklist.
2. Resolve the next incomplete item.
3. Return to the checklist or dashboard.

**Expected outcome:** The user sees exactly what still prevents a first send.
**Failure and recovery:** A green billing status never hides an unverified sender or missing consent.
**Requirements:** FL-ONB-001, FL-ONB-002, FL-CAM-002.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-011"></a>
## FL-ST-011 — See what needs attention and continue work

**Role:** Workspace member. **Screen:** [S11 — Good morning, Avery.](https://flockletter-design-review.alandmunro.chatgpt.site/#dashboard). [Screenshot](screenshots/S11-dashboard.jpg).

As a workspace member, I want to see what needs attention and continue work, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review the active workspace and shared usage.
2. Open a recent campaign.
3. Continue the next recommended task.

**Expected outcome:** The dashboard directs the user to useful work without overstating delivery.
**Failure and recovery:** An empty account shows onboarding; a hold shows its reason and remedy.
**Requirements:** FL-ONB-004, FL-USG-003, FL-CAM-007.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-012"></a>
## FL-ST-012 — Switch accounts without mixing data

**Role:** Member of multiple workspaces. **Screen:** [S12 — The right place for every team.](https://flockletter-design-review.alandmunro.chatgpt.site/#workspaces). [Screenshot](screenshots/S12-workspaces.jpg).

As a member of multiple workspaces, I want to switch accounts without mixing data, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review memberships supplied by Clerk.
2. Choose the intended sample workspace.
3. Confirm the new workspace context.

**Expected outcome:** The selected workspace governs every following view.
**Failure and recovery:** Revoked membership removes access; switching never carries a foreign draft or audience.
**Requirements:** FL-ID-001, FL-ID-002.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-013"></a>
## FL-ST-013 — Organize companies and sending brands

**Role:** Workspace owner. **Screen:** [S13 — Your companies & brands.](https://flockletter-design-review.alandmunro.chatgpt.site/#companies). [Screenshot](screenshots/S13-companies.jpg).

As a workspace owner, I want to organize companies and sending brands, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review the pooled company and brand counts.
2. Create or open a sample brand.
3. Assign the brand to its company.

**Expected outcome:** Each brand retains its own identity and consent within shared allowances.
**Failure and recovery:** A full allowance prompts a plan review; no brand is silently removed on downgrade.
**Requirements:** FL-USG-006, FL-BIL-005.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-014"></a>
## FL-ST-014 — Maintain the brand’s sending details

**Role:** Authorized brand editor. **Screen:** [S14 — A familiar name in the inbox.](https://flockletter-design-review.alandmunro.chatgpt.site/#brand-settings). [Screenshot](screenshots/S14-brand-settings.jpg).

As a authorized brand editor, I want to maintain the brand’s sending details, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Set the sample name, reply-to and mailing address.
2. Review confirmation and tracking defaults.
3. Save the sample changes.

**Expected outcome:** The brand presents consistent identity with double opt-in on and tracking off.
**Failure and recovery:** Unverified senders remain blocked; changing a reviewed campaign input requires review again.
**Requirements:** FL-AUD-002, FL-DEL-002, FL-CAM-003.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-015"></a>
## FL-ST-015 — Verify the sending domain

**Role:** Workspace owner. **Screen:** [S15 — A trusted place to send from.](https://flockletter-design-review.alandmunro.chatgpt.site/#sender-dns). [Screenshot](screenshots/S15-sender-dns.jpg).

As a workspace owner, I want to verify the sending domain, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review sample DNS records.
2. Share setup steps with the domain administrator.
3. Recheck the simulated verification result.

**Expected outcome:** Sender readiness is visible independently of payment and provisioning.
**Failure and recovery:** Pending or invalid records identify the exact missing step and keep sends blocked.
**Requirements:** FL-DEL-002, FL-CAM-002.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-016"></a>
## FL-ST-016 — Find contacts and understand send eligibility

**Role:** Audience manager. **Screen:** [S16 — People who want to hear from you.](https://flockletter-design-review.alandmunro.chatgpt.site/#contacts). [Screenshot](screenshots/S16-contacts.jpg).

As a audience manager, I want to find contacts and understand send eligibility, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Search the fictional contact list.
2. Filter by confirmation or suppression status.
3. Open a record or start an import.

**Expected outcome:** Contact status and consent can be understood without treating all stored addresses as sendable.
**Failure and recovery:** An empty audience offers signup forms or an import with consent checks.
**Requirements:** FL-AUD-001, FL-AUD-002, FL-USG-001.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-017"></a>
## FL-ST-017 — Prepare a contact import safely

**Role:** Audience manager. **Screen:** [S17 — Bring your audience with you.](https://flockletter-design-review.alandmunro.chatgpt.site/#import-mapping). [Screenshot](screenshots/S17-import-mapping.jpg).

As a audience manager, I want to prepare a contact import safely, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Load the provided sample CSV.
2. Map fields to Flockletter attributes.
3. Choose a brand/list and declare permission to contact.

**Expected outcome:** The next view previews valid rows, duplicates and consent gaps.
**Failure and recovery:** Missing evidence, invalid columns or oversized files stop the import with repair instructions.
**Requirements:** FL-AUD-003, FL-API-003.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-018"></a>
## FL-ST-018 — Review and track import results

**Role:** Audience manager. **Screen:** [S18 — A clear picture before importing.](https://flockletter-design-review.alandmunro.chatgpt.site/#import-review). [Screenshot](screenshots/S18-import-review.jpg).

As a audience manager, I want to review and track import results, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Read the preflight counts.
2. Exclude invalid or suppressed records.
3. Start and inspect the simulated import result.

**Expected outcome:** Per-row outcomes preserve consent and suppression and support safe retry.
**Failure and recovery:** Partial errors are shown separately; retries cannot restore unsubscribed contacts.
**Requirements:** FL-AUD-003, FL-USG-003.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-019"></a>
## FL-ST-019 — Understand why a contact can or cannot receive a campaign

**Role:** Audience manager. **Screen:** [S19 — One person. A clear history.](https://flockletter-design-review.alandmunro.chatgpt.site/#subscriber). [Screenshot](screenshots/S19-subscriber.jpg).

As a audience manager, I want to understand why a contact can or cannot receive a campaign, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review brand-specific consent.
2. Inspect confirmation and suppression history.
3. Edit an allowed attribute or request an export.

**Expected outcome:** Consent evidence remains distinct from editable contact information.
**Failure and recovery:** A suppressed state cannot be cleared by a simple reimport or profile edit.
**Requirements:** FL-AUD-001, FL-AUD-002, FL-AUD-004.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-020"></a>
## FL-ST-020 — Choose a relevant audience without mixing brand consent

**Role:** Campaign editor. **Screen:** [S20 — A more thoughtful audience.](https://flockletter-design-review.alandmunro.chatgpt.site/#lists). [Screenshot](screenshots/S20-lists.jpg).

As a campaign editor, I want to choose a relevant audience without mixing brand consent, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Create a sample list or segment.
2. Review filter conditions and eligible count.
3. Use it in a campaign.

**Expected outcome:** A segment helps target contacts who have consented for the active brand.
**Failure and recovery:** An empty or cross-brand segment has an explanation and cannot silently expand the send.
**Requirements:** FL-AUD-001, FL-CAM-003.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-021"></a>
## FL-ST-021 — Offer a clear permission-based signup

**Role:** Brand editor. **Screen:** [S21 — An invitation worth accepting.](https://flockletter-design-review.alandmunro.chatgpt.site/#signup-form). [Screenshot](screenshots/S21-signup-form.jpg).

As a brand editor, I want to offer a clear permission-based signup, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Edit the invitation and stated purpose.
2. Preview the form and confirmation step.
3. Review the sample embed instructions.

**Expected outcome:** The form makes brand, purpose and double opt-in clear.
**Failure and recovery:** Validation errors are accessible; no subscriber login or purchase is required.
**Requirements:** FL-AUD-002, FL-ONB-005.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-022"></a>
## FL-ST-022 — Find and manage campaigns

**Role:** Campaign editor. **Screen:** [S22 — Letters with something to say.](https://flockletter-design-review.alandmunro.chatgpt.site/#campaigns). [Screenshot](screenshots/S22-campaigns.jpg).

As a campaign editor, I want to find and manage campaigns, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Filter by campaign status.
2. Open a draft or duplicate a past campaign.
3. Start a new sample draft.

**Expected outcome:** Drafts and deliberate resends have distinct lifecycle and accounting.
**Failure and recovery:** Paused or unresolved work opens its recovery view instead of a blind resend.
**Requirements:** FL-CAM-004, FL-USG-005.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-023"></a>
## FL-ST-023 — Choose a reusable newsletter layout

**Role:** Campaign editor. **Screen:** [S23 — A good place to begin.](https://flockletter-design-review.alandmunro.chatgpt.site/#templates). [Screenshot](screenshots/S23-templates.jpg).

As a campaign editor, I want to choose a reusable newsletter layout, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Preview a template.
2. Choose the purpose that fits.
3. Open the sample editor.

**Expected outcome:** The template provides a starting structure with an unsubscribe footer.
**Failure and recovery:** Saved templates remain scoped to the workspace and brand context.
**Requirements:** FL-CAM-001.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-024"></a>
## FL-ST-024 — Select accessible campaign media

**Role:** Brand editor. **Screen:** [S24 — Your brand, ready to share.](https://flockletter-design-review.alandmunro.chatgpt.site/#media). [Screenshot](screenshots/S24-media.jpg).

As a brand editor, I want to select accessible campaign media, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Browse sample illustration assets.
2. Inspect descriptions and ownership.
3. Insert a sample into the draft.

**Expected outcome:** Only authorized assets and safe public message references are used.
**Failure and recovery:** Rejected formats and missing rights have a clear repair state; private paths never appear.
**Requirements:** FL-CAM-001, FL-API-004.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-025"></a>
## FL-ST-025 — Prepare a newsletter with accessible content

**Role:** Campaign editor. **Screen:** [S25 — A note for the season ahead.](https://flockletter-design-review.alandmunro.chatgpt.site/#campaign-editor). [Screenshot](screenshots/S25-campaign-editor.jpg).

As a campaign editor, I want to prepare a newsletter with accessible content, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Edit subject, preview text and content.
2. Review the required footer and plain-text version.
3. Save the sample draft and choose recipients.

**Expected outcome:** A versioned draft is ready for preview and preflight, not yet authorized to send.
**Failure and recovery:** Missing fields or invalid content explain exactly what needs correction.
**Requirements:** FL-CAM-001, FL-CAM-003.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-026"></a>
## FL-ST-026 — Select eligible recipients for one brand

**Role:** Campaign editor. **Screen:** [S26 — Who should receive this letter?](https://flockletter-design-review.alandmunro.chatgpt.site/#campaign-audience). [Screenshot](screenshots/S26-campaign-audience.jpg).

As a campaign editor, I want to select eligible recipients for one brand, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Choose a list or segment.
2. Inspect duplicate, unconfirmed and suppressed exclusions.
3. Continue with the reviewed eligible count.

**Expected outcome:** A known recipient snapshot is reviewed before authorization.
**Failure and recovery:** A quota overflow or consent gap blocks the send with a remedy.
**Requirements:** FL-CAM-002, FL-CAM-003, FL-USG-002.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-027"></a>
## FL-ST-027 — Preview and request a bounded test

**Role:** Campaign editor. **Screen:** [S27 — See it as your readers will.](https://flockletter-design-review.alandmunro.chatgpt.site/#preview-test). [Screenshot](screenshots/S27-preview-test.jpg).

As a campaign editor, I want to preview and request a bounded test, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Switch preview formats.
2. Review the sample test recipient and allowance impact.
3. Simulate the test and proceed to preflight.

**Expected outcome:** Previewing is free of send effects; real tests will consume recipient allowance.
**Failure and recovery:** A failed test does not imply the campaign was sent or is ready.
**Requirements:** FL-CAM-001, FL-USG-001.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-028"></a>
## FL-ST-028 — Identify all launch gaps together

**Role:** Authorized sender. **Screen:** [S28 — A final check, all in one place.](https://flockletter-design-review.alandmunro.chatgpt.site/#preflight). [Screenshot](screenshots/S28-preflight.jpg).

As a authorized sender, I want to identify all launch gaps together, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review sender, content, audience, access and allowance checks.
2. Follow a blocker to its source.
3. Continue only when the sample checks are ready.

**Expected outcome:** The review uses the same intended checks as future API/MCP workflows.
**Failure and recovery:** Critical failures stay visible together; a preview or payment cannot override them.
**Requirements:** FL-CAM-002, FL-API-003.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-029"></a>
## FL-ST-029 — Authorize a specific send or schedule

**Role:** Authorized sender. **Screen:** [S29 — Ready when you are.](https://flockletter-design-review.alandmunro.chatgpt.site/#review-schedule). [Screenshot](screenshots/S29-review-schedule.jpg).

As a authorized sender, I want to authorize a specific send or schedule, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review the frozen content and audience summary.
2. Select now or an explicit time zone and date.
3. Confirm the sample send intent.

**Expected outcome:** Authorization binds the reviewed inputs; this prototype only navigates to sample progress.
**Failure and recovery:** Any changed input requires renewed review; scheduling rechecks eligibility at execution.
**Requirements:** FL-CAM-003, FL-CAM-006, FL-USG-005.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-030"></a>
## FL-ST-030 — Monitor, pause or recover a campaign

**Role:** Authorized sender. **Screen:** [S30 — Your letter is on its way.](https://flockletter-design-review.alandmunro.chatgpt.site/#send-progress). [Screenshot](screenshots/S30-send-progress.jpg).

As a authorized sender, I want to monitor, pause or recover a campaign, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review accepted and remaining recipients.
2. Pause or cancel future sample submissions.
3. Open completed or uncertain-outcome details.

**Expected outcome:** Progress distinguishes provider acceptance from confirmed delivery.
**Failure and recovery:** Unknown provider outcomes remain in reconciliation; already accepted messages cannot be recalled.
**Requirements:** FL-CAM-004, FL-CAM-005.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-031"></a>
## FL-ST-031 — Review honest campaign results

**Role:** Analyst. **Screen:** [S31 — The story after the send.](https://flockletter-design-review.alandmunro.chatgpt.site/#reports). [Screenshot](screenshots/S31-reports.jpg).

As a analyst, I want to review honest campaign results, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Inspect accepted, delivered, bounce and complaint counts.
2. Check feedback freshness and tracking settings.
3. Export the sample report.

**Expected outcome:** Metrics explain their units and missing feedback; tracking-off metrics stay unavailable.
**Failure and recovery:** Delayed feedback is labeled incomplete rather than fabricated as success.
**Requirements:** FL-CAM-007, FL-DEL-004.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-032"></a>
## FL-ST-032 — Manage membership through Clerk

**Role:** Workspace owner. **Screen:** [S32 — Good work, shared.](https://flockletter-design-review.alandmunro.chatgpt.site/#team). [Screenshot](screenshots/S32-team.jpg).

As a workspace owner, I want to manage membership through Clerk, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review active members and pending invitations.
2. Prepare an invitation within the seat allowance.
3. Inspect an existing member’s access.

**Expected outcome:** Clerk owns membership and invitations; the plan governs the seat allowance.
**Failure and recovery:** A full plan or last-owner removal offers a remedy and does not silently remove access.
**Requirements:** FL-ONB-003, FL-ID-001, FL-USG-006.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-033"></a>
## FL-ST-033 — Assign capabilities to an existing Clerk member

**Role:** Workspace owner. **Screen:** [S33 — The right access for the job.](https://flockletter-design-review.alandmunro.chatgpt.site/#member-permissions). [Screenshot](screenshots/S33-member-permissions.jpg).

As a workspace owner, I want to assign capabilities to an existing Clerk member, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review the proposed role and brand scope.
2. Grant only the necessary capabilities.
3. Review the sample change.

**Expected outcome:** Brand access narrows an existing membership; editing never implies send permission.
**Failure and recovery:** Revocation stops pending unauthorized actions; the last accountable owner is protected.
**Requirements:** FL-ID-004, FL-USG-006.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-034"></a>
## FL-ST-034 — Manage personal identity and account security

**Role:** Account holder. **Screen:** [S34 — Your account, in your hands.](https://flockletter-design-review.alandmunro.chatgpt.site/#account-security). [Screenshot](screenshots/S34-account-security.jpg).

As a account holder, I want to manage personal identity and account security, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review connected sign-in methods.
2. Inspect active sessions.
3. Open the simulated Clerk account management step.

**Expected outcome:** Personal identity controls are separate from subscription and brand settings.
**Failure and recovery:** Revoked sessions require sign-in again; identity recovery remains Clerk-controlled.
**Requirements:** FL-ID-001, FL-ID-004.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-035"></a>
## FL-ST-035 — Understand charges and remaining allowance

**Role:** Workspace owner. **Screen:** [S35 — Your plan, without surprises.](https://flockletter-design-review.alandmunro.chatgpt.site/#billing). [Screenshot](screenshots/S35-billing.jpg).

As a workspace owner, I want to understand charges and remaining allowance, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review current plan, used and reserved usage.
2. Inspect renewal and invoice history.
3. Open a plan or payment-method change.

**Expected outcome:** The user can distinguish consumed, reserved and remaining allowance.
**Failure and recovery:** A complimentary view shows no fabricated paid invoice or Stripe requirement.
**Requirements:** FL-BIL-001, FL-BIL-008, FL-USG-003.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-036"></a>
## FL-ST-036 — Review an upgrade or downgrade

**Role:** Workspace owner. **Screen:** [S36 — A plan that fits what’s next.](https://flockletter-design-review.alandmunro.chatgpt.site/#plan-change). [Screenshot](screenshots/S36-plan-change.jpg).

As a workspace owner, I want to review an upgrade or downgrade, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Compare approved monthly prices and limits.
2. Check current usage and member/brand counts.
3. Review the proposed effective-date summary.

**Expected outcome:** Plan changes preserve already consumed usage and require verified billing eligibility.
**Failure and recovery:** A downgrade with excess members or contacts has a remediation path, not deletion.
**Requirements:** FL-BIL-005, FL-USG-006.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-037"></a>
## FL-ST-037 — Recover from a failed payment

**Role:** Workspace owner. **Screen:** [S37 — Let’s get billing back on track.](https://flockletter-design-review.alandmunro.chatgpt.site/#payment-recovery). [Screenshot](screenshots/S37-payment-recovery.jpg).

As a workspace owner, I want to recover from a failed payment, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Read the billing status and proposed timeline.
2. Open the Stripe-hosted payment-method flow.
3. Wait for verified confirmation.

**Expected outcome:** Recovered billing can restore eligible access while separate sender or abuse holds remain.
**Failure and recovery:** A browser return does not establish success; essential unsubscribe and billing access remain.
**Requirements:** FL-BIL-003, FL-BIL-005.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-038"></a>
## FL-ST-038 — Cancel or request data export/deletion with clarity

**Role:** Workspace owner. **Screen:** [S38 — Leave on your terms.](https://flockletter-design-review.alandmunro.chatgpt.site/#cancellation). [Screenshot](screenshots/S38-cancellation.jpg).

As a workspace owner, I want to cancel or request data export/deletion with clarity, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review the proposed service-end date.
2. Request an authorized export or review deletion.
3. Confirm the sample cancellation.

**Expected outcome:** The future service stops renewals and displays the effective end and retention policy.
**Failure and recovery:** Backup/record exceptions and exact retention clock remain policy review items.
**Requirements:** FL-BIL-005, FL-AUD-005.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-039"></a>
## FL-ST-039 — Inspect and manage integration grants

**Role:** Workspace owner. **Screen:** [S39 — Connect with intention.](https://flockletter-design-review.alandmunro.chatgpt.site/#integrations). [Screenshot](screenshots/S39-integrations.jpg).

As a workspace owner, I want to inspect and manage integration grants, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review connected tools and their scopes.
2. Prepare a sample delegated grant.
3. Review or revoke an existing grant.

**Expected outcome:** UI and MCP share the same planned permissions and send review.
**Failure and recovery:** Draft access cannot send; revocation prevents new and pending unauthorized work.
**Requirements:** FL-API-001, FL-API-002, FL-API-005.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-040"></a>
## FL-ST-040 — Approve a narrowly scoped tool connection

**Role:** Workspace owner. **Screen:** [S40 — Review this connection.](https://flockletter-design-review.alandmunro.chatgpt.site/#access-consent). [Screenshot](screenshots/S40-access-consent.jpg).

As a workspace owner, I want to approve a narrowly scoped tool connection, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Verify the requesting tool and destination.
2. Review capabilities and active workspace.
3. Allow or deny the sample request.

**Expected outcome:** A scoped grant is understandable and can later be revoked.
**Failure and recovery:** Unrecognized requests, missing authority or excess requested scopes can be declined.
**Requirements:** FL-API-002, FL-ID-004.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-041"></a>
## FL-ST-041 — Review attributable operational activity

**Role:** Workspace owner. **Screen:** [S41 — A clear record of what changed.](https://flockletter-design-review.alandmunro.chatgpt.site/#activity). [Screenshot](screenshots/S41-activity.jpg).

As a workspace owner, I want to review attributable operational activity, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Filter events by actor or action.
2. Inspect an event’s sample details.
3. Follow its related campaign or setting.

**Expected outcome:** The activity record provides actor, scope and outcome without exposing secrets.
**Failure and recovery:** Partial or unresolved operations are shown honestly, with a recovery link.
**Requirements:** FL-ID-005, FL-ONB-004.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-042"></a>
## FL-ST-042 — Ask for help and follow the reply

**Role:** Workspace member. **Screen:** [S42 — A little help goes a long way.](https://flockletter-design-review.alandmunro.chatgpt.site/#support). [Screenshot](screenshots/S42-support.jpg).

As a workspace member, I want to ask for help and follow the reply, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Choose a topic and describe the issue.
2. Review the sample email conversation.
3. Request human review when needed.

**Expected outcome:** Automated replies identify themselves and use approved guidance.
**Failure and recovery:** Billing disputes, security, privacy and uncertain issues escalate; AI cannot change entitlements.
**Requirements:** FL-SUP-001, FL-SUP-002.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-043"></a>
## FL-ST-043 — Subscribe to a specific brand without a SaaS account

**Role:** Newsletter reader. **Screen:** [S43 — Letters for a slower kind of season.](https://flockletter-design-review.alandmunro.chatgpt.site/#subscribe). [Screenshot](screenshots/S43-subscribe.jpg).

As a newsletter reader, I want to subscribe to a specific brand without a SaaS account, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Read the brand and stated purpose.
2. Enter the sample email and explicit consent.
3. Submit and see the confirmation instruction.

**Expected outcome:** The address is unconfirmed until the confirmation step succeeds.
**Failure and recovery:** Invalid addresses and rate limits explain recovery without requiring login or purchase.
**Requirements:** FL-ONB-005, FL-AUD-002.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-044"></a>
## FL-ST-044 — Complete double opt-in

**Role:** Newsletter reader. **Screen:** [S44 — One more step to join the list.](https://flockletter-design-review.alandmunro.chatgpt.site/#confirmation). [Screenshot](screenshots/S44-confirmation.jpg).

As a newsletter reader, I want to complete double opt-in, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Read the confirmation-email instruction.
2. Open the sample confirmation-link state.
3. See a confirmed subscription.

**Expected outcome:** Consent evidence is recorded before the address becomes eligible in the future service.
**Failure and recovery:** Expired or reused links offer a safe resend path and never silently re-enable suppression.
**Requirements:** FL-AUD-002.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-045"></a>
## FL-ST-045 — Manage brand-specific preferences without login

**Role:** Newsletter reader. **Screen:** [S45 — Make these letters your own.](https://flockletter-design-review.alandmunro.chatgpt.site/#preferences). [Screenshot](screenshots/S45-preferences.jpg).

As a newsletter reader, I want to manage brand-specific preferences without login, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review the current brand and mailing purpose.
2. Choose permitted preferences.
3. Save the sample change or unsubscribe.

**Expected outcome:** Preferences remain scoped to the brand and do not grant consent elsewhere.
**Failure and recovery:** Expired scoped links lead to safe recovery; no paid account is required.
**Requirements:** FL-ONB-005, FL-AUD-004.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-046"></a>
## FL-ST-046 — Stop future marketing mail reliably

**Role:** Newsletter reader. **Screen:** [S46 — You’re off the list.](https://flockletter-design-review.alandmunro.chatgpt.site/#unsubscribe). [Screenshot](screenshots/S46-unsubscribe.jpg).

As a newsletter reader, I want to stop future marketing mail reliably, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Open the scoped unsubscribe route.
2. See confirmation only after the future service persists suppression.
3. Return to permitted preference controls if desired.

**Expected outcome:** Applicable future submissions stop, even during a suspended customer account.
**Failure and recovery:** A persistence failure shows a retry state instead of falsely confirming unsubscribe.
**Requirements:** FL-AUD-004, FL-CAM-006.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-047"></a>
## FL-ST-047 — Recover an expired subscription-management link

**Role:** Newsletter reader. **Screen:** [S47 — This link needs a fresh start.](https://flockletter-design-review.alandmunro.chatgpt.site/#expired-link). [Screenshot](screenshots/S47-expired-link.jpg).

As a newsletter reader, I want to recover an expired subscription-management link, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review the nonrevealing explanation.
2. Request a new scoped link for the sample address.
3. See a neutral confirmation.

**Expected outcome:** The future product sends a recovery route only when appropriate.
**Failure and recovery:** The response does not disclose another person’s subscription or expose credentials.
**Requirements:** FL-ONB-005, FL-OPS-006.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-048"></a>
## FL-ST-048 — Identify service issues without browsing customer content

**Role:** Platform operator. **Screen:** [S48 — A healthy service. A clearer day.](https://flockletter-design-review.alandmunro.chatgpt.site/#platform). [Screenshot](screenshots/S48-platform.jpg).

As a platform operator, I want to identify service issues without browsing customer content, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review provisioning, delivery and spend signals.
2. Open an affected workspace.
3. Choose the appropriate recovery workflow.

**Expected outcome:** Operational visibility remains separate from customer membership and message content.
**Failure and recovery:** A platform role requires verified Clerk identity and separate privileges.
**Requirements:** FL-ID-005, FL-OPS-005.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-049"></a>
## FL-ST-049 — Diagnose an affected workspace within authorized scope

**Role:** Platform operator. **Screen:** [S49 — One workspace, understood.](https://flockletter-design-review.alandmunro.chatgpt.site/#platform-workspace). [Screenshot](screenshots/S49-platform-workspace.jpg).

As a platform operator, I want to diagnose an affected workspace within authorized scope, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Review separate billing, sender and provisioning statuses.
2. Record the support purpose.
3. Inspect the relevant job or hold.

**Expected outcome:** Support access is explicit and audited, without default access to mailing lists or message bodies.
**Failure and recovery:** An unsupported mutation is blocked and an unknown external outcome requires reconciliation.
**Requirements:** FL-ID-005, FL-ONB-002, FL-OPS-003.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-050"></a>
## FL-ST-050 — Handle an escalated support or delivery issue

**Role:** Authorized platform operator. **Screen:** [S50 — A person for the important moments.](https://flockletter-design-review.alandmunro.chatgpt.site/#support-review). [Screenshot](screenshots/S50-support-review.jpg).

As a authorized platform operator, I want to handle an escalated support or delivery issue, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Read the redacted case summary.
2. Inspect the hold reason and approved evidence.
3. Record a proposed human decision.

**Expected outcome:** AI replies cannot resolve financial, security or eligibility decisions.
**Failure and recovery:** Missing authority or evidence keeps the hold in place; thresholds remain a policy gate.
**Requirements:** FL-SUP-002, FL-DEL-003.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-051"></a>
## FL-ST-051 — Monitor shared exposure and provider health

**Role:** Platform operator. **Screen:** [S51 — Know where the pressure is.](https://flockletter-design-review.alandmunro.chatgpt.site/#platform-health). [Screenshot](screenshots/S51-platform-health.jpg).

As a platform operator, I want to monitor shared exposure and provider health, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Inspect queue, feedback freshness and spend indicators.
2. Review affected workspaces and fair scheduling.
3. Open the recovery action for a blocked job.

**Expected outcome:** Capacity and unknown provider outcomes have explicit, durable states.
**Failure and recovery:** Example chart values are illustrative; real numeric service targets remain undecided.
**Requirements:** FL-USG-004, FL-OPS-002, FL-OPS-005.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-052"></a>
## FL-ST-052 — Review an audited complimentary customer grant

**Role:** Authorized platform operator. **Screen:** [S52 — Complimentary, with a clear record.](https://flockletter-design-review.alandmunro.chatgpt.site/#complimentary). [Screenshot](screenshots/S52-complimentary.jpg).

As a authorized platform operator, I want to review an audited complimentary customer grant, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Verify the intended workspace and assigned plan.
2. Record reason and effective dates.
3. Review the proposed grant or revocation.

**Expected outcome:** The FFA entitlement bypasses Stripe and cards while preserving quotas and sender controls.
**Failure and recovery:** An account name cannot claim the exception; FFA’s actual tier and grant lifecycle remain undecided.
**Requirements:** FL-BIL-008, FL-API-004.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-053"></a>
## FL-ST-053 — Review commercial and privacy information

**Role:** Visitor or customer. **Screen:** [S53 — Clear terms. Thoughtful defaults.](https://flockletter-design-review.alandmunro.chatgpt.site/#policies). [Screenshot](screenshots/S53-policies.jpg).

As a visitor or customer, I want to review commercial and privacy information, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Read the accepted commercial terms summary.
2. Inspect privacy defaults and pending policy details.
3. Return to the plan or support flow.

**Expected outcome:** The user can distinguish approved product decisions from unfinished legal text.
**Failure and recovery:** The preview never presents draft terms as a completed agreement or permits a binding acceptance.
**Requirements:** FL-PROD-004, FL-BIL-006, FL-AUD-005.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

<a id="fl-st-054"></a>
## FL-ST-054 — Recover access without exposing another workspace

**Role:** Workspace member. **Screen:** [S54 — Let’s get you to the right place.](https://flockletter-design-review.alandmunro.chatgpt.site/#access-help). [Screenshot](screenshots/S54-access-help.jpg).

As a workspace member, I want to recover access without exposing another workspace, so I can proceed with clear information and appropriate control.

**Walkthrough**

1. Read the neutral access explanation.
2. Sign in again or choose an authorized workspace.
3. Ask an owner or support for help when needed.

**Expected outcome:** Recovery does not reveal another workspace or bypass Clerk membership.
**Failure and recovery:** A stale link, expired session or revoked membership cannot grant access to protected data.
**Requirements:** FL-ID-001, FL-ID-002, FL-ID-004.

**Design acceptance:** the user can identify the active context, the primary action and its consequences; the displayed recovery path explains the blocked or failed state. Provider actions are explicitly simulated. No real financial, authentication, permission or email outcome is claimed.

