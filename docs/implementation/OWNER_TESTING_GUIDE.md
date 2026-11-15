# Owner staging walkthrough

Open https://flockletter.frostyflamingosoftware.com and sign in with Clerk. This is the staging service. Its new workflows are explicitly labeled captured exercises. They save real application records, but do not send external email, charge a card, change real Clerk memberships, provision AWS resources or erase hosted data.

Use a test workspace and disposable contact addresses. Keep your original photos. The free staging service can sleep; allow it to open, then refresh if needed. Its queues run while the service is awake. Continuous scheduling needs the separately configured worker.

## Before preparing a campaign

Review Subscription, the brand’s Audience setup, and Operations. The API/MCP `workspace.preflight` operation lists setup gaps before collecting content or photos. A workspace can prepare drafts before service activation. Creating a workspace does not start a trial.

## 1. Subscription

Select a plan, affirm the simulated card control and start the captured trial. Expect `trialing`, fourteen days, one company/brand/user, at most 2,500 active contacts and 2,500 total recipient emails for the trial. These are trial limits even when you choose Growth or Pro.

Use the captured successful-payment control to exercise an active paid plan. Growth then provides five campaigns, 5,000 contacts and 25,000 total monthly recipient emails, shared across its companies and brands. Try changing plans and reviewing the saved remaining allowance. No real card details are needed or accepted by the captured payment controls.

## 2. Audience

Choose your brand. Save its purpose, consent text, policy version and source domain. Open its public signup page, enter a disposable address and affirm the consent checkbox. Return to the owner view to inspect the captured confirmation. Follow its confirmation page and explicitly confirm, or use the labeled owner exercise control.

For CSV, preview the file, choose its email column, describe the permission source and affirm permission before importing. Imports create pending contacts. Confirm only the contacts needed for the exercise. Duplicate imports preserve existing records and stronger unsubscribe, complaint or bounce states. Saved import results can be recovered after a refresh.

## 3. Campaigns and Delivery

Create a campaign, use a template or your own content, attach your original photos and save it. Preview its desktop and phone layouts.

In Delivery, choose that saved campaign. Set a future local time if testing scheduling, then review its exact saved version and confirmed audience. Approve the captured delivery. Refresh its results or request processing. Open a captured email to inspect its original images, plain text and unsubscribe control.

For scheduled work, try Pause future submissions and Resume unchanged delivery. The original audience and allowance remain held. Cancel stops future submissions while preserving any uncertain outcome for reconciliation. Changes to a reviewed draft or sender require a fresh review.

Optionally capture a hard bounce or complaint. This suppresses the staging contact for later campaigns, so use disposable addresses. Captured delivery outcomes do not prove that an email reached an inbox.

Save the brand’s Sender identity and footer, including its postal address, before exercising sender infrastructure. These details become part of a fresh campaign review. External sending additionally needs current domain ownership and provider verification.

## 4. Team

Use the labeled exercise controls to invite and accept a fictional member, remove a member, or exercise ownership transfer. Check finite seat limits before and after a plan change. Captured team scenarios do not create a Clerk account, grant sign-in access or change real workspace memberships. The existing Clerk member and brand-access directory remains separate and authoritative for actual access.

## 5. Support

Create a question in Support. Prepare a reply, inspect its provenance, edit it if needed, then approve the exact saved reply and process its capture. The conversation and captured reply remain available after refresh. Sensitive requests require human handling. Approved guidance is labeled separately from an AI-assisted draft.

## 6. Operations and sender setup

Open Operations and review the configured modes, queue counts, saved worker pass and setup gaps. Run saved jobs to process a bounded pass.

In Sender infrastructure, select the brand with a saved sender profile. Review its exact plan, approve the captured setup and process it. Expect a captured result with `.invalid` DNS examples and no verified live AWS route. These examples must not be installed in DNS. Changed profiles invalidate earlier plans; unknown provider outcomes require reconciliation, and cancelling keeps their evidence.

## 7. Cancellation and retention — last

Do this after the other exercises because advancing the captured clock changes that workspace’s eligibility. Cancel its service in Subscription and advance its exercise clock by 120 days. Open Data & privacy and review the current inventory after the recorded service end and ninety-day retention period.

Try a hold and release, request review of the exact inventory, then capture the exercise outcome. Expect **Records deleted: 0** and an intact workspace. This does not authorize or perform a real hosted purge. A separately privileged executor, protected checkpoint and operator authorization are required for real erasure.

## Evidence and remaining activation gates

The automated browser proof follows these normal screens on desktop and a 390-pixel phone viewport. It uses disposable PostgreSQL, the normal API and labeled captured providers. [Browser proof](CUSTOMER_BROWSER_PROOF.md)

Real provider delivery, dedicated Stripe acceptance, real Clerk lifecycle changes, AI reply policy, protected hosted erasure and production capacity still need their external acceptance/configuration steps. [Environment gates](CUSTOMER_ENVIRONMENTS.md)
