# Eight ways through Flockletter

Design review version 2 · November 6, 2026. [Open the Sites prototype](https://flockletter-design-review.alandmunro.chatgpt.site/#dashboard) · [Screen catalogue](SCREENS.md) · [Detailed user stories](USER_STORIES.md).

Start with one journey at a time. Use the prototype’s **All screens** menu to jump to a referenced ID and **User story** for that screen’s rationale and recovery requirements. The flows below are proposed customer experiences for review, not instructions for an available live service.

The signup journey uses the 14-day trial example (250 active contacts / 500 total recipient emails). Audience, campaign, team and billing journeys use a separate populated **paid Tier 2** example (5,000 contacts / 25,000 emails / 5 campaigns / 3 users). Moving between these screen fixtures does not upgrade a trial, change billing or import data. The preview is a linked set of screen states, not a persistent application simulator.

Clerk owns every hosted login and workspace membership. Google, Apple, Microsoft and email with a one-time verification code are the accepted launch options. Customer MFA, account linking and recovery safeguards remain under review. Subscriber preferences and unsubscribe do not require a login. The role matrix, usage anchors, trial campaign/team limits, exact billing adaptation, retention exceptions and FFA’s assigned tier remain open decisions.

> All walkthroughs are nonproduction design simulations using fictional Alpine Paper Co. / example.com data. Preview navigation is not a performed side effect; no live authentication, payments, emails, imports, or infrastructure occurs.

## 1. Signup, trial, and domain verification

**Role:** New customer / workspace owner.

1. **S01 Home** — press “Find your plan →”.
2. **S02 Pricing** — compare tiers and press “Start a 14-day trial →” for Tier 2, $25/month.
3. **S03 Signup** — choose “Continue with Google”, “Continue with Apple” or “Continue with Microsoft”; these buttons simulate the completed provider handoff and proceed to workspace setup. To inspect the email route, enter the fictional avery@example.com address and press “Continue with email →”. No password is requested.
4. **S05 Verify-recover (email route)** — enter 123456 in “Sample verification code”, then press “Verify & continue →”; an incorrect sample code stays on this screen. Use “Resend code” or “Show expired code” to inspect recovery examples. No email is sent and no real identity is verified.
5. **S07 Workspace onboarding** — enter “Workspace name” and “Company name”, select location/time zone, check “My business is based in the United States.”, and press “Continue to trial →”.
6. **S08 Trial checkout** — review 14 days, 250 contacts, and 500 emails; press “Change plan” or “Continue to Stripe preview →”.
7. **S09 Provisioning** — review identity/billing/service statuses; press “View sample ready state →” or “Show provisioning failure”.
8. **S10 Onboarding** — open the incomplete “Sending domain” item via its “Open →” control.
9. **S15 Sender DNS** — review DKIM/SPF/DMARC rows; press “Recheck sample records” or “Copy sample instructions”.

**Outcome:** Simulated identity, trial summary, provisioning, and sender readiness are separated; no real account, card charge, or DNS verification occurs.  
**Required recovery behavior (future product):** Expired code, abandoned checkout, or failed provisioning returns to the interrupted step with support; trial campaign cap remains undecided.

Returning members use **S04 Sign-in**, with the same four methods. The email-code route returns to the sample dashboard after the sample code is accepted; signup continues to workspace setup. **S34 Account security** lists all four methods and keeps membership, billing and send authority separate.

## 2. Consent-based audience import

**Role:** Audience manager in an already-paid Tier 2 example. The 1,000-row import below is not a trial import; a trial is capped at 250 active contacts.

1. **S16 Contacts** — use the search field and “Status” select to inspect consent context before import.
2. **S17 Import mapping** — press “Use sample file”, map columns using the “Map to” selects, check “I have permission to contact these people for this brand and purpose.”, select brand/list, and press “Review import →”.
3. **S18 Import review** — read Ready/Already present/Needs attention counts; press “Import sample audience →” or “Review row-error sample”.

**Outcome:** Simulated preflight shows 942 ready, 38 present, and 20 attention rows, with a projected 3,428 / 5,000 active-contact total; no contacts are imported.  
**Required recovery behavior (future product):** Invalid emails, duplicates, and suppressed records are excluded; retries cannot restore unsubscribed contacts, and missing evidence or oversized files stop with repair instructions.

## 3. Campaign creation through report

**Role:** Campaign editor / authorized sender in the populated, paid Tier 2 example. The 2,340-recipient campaign exceeds the trial allowance and must not be treated as part of trial onboarding.

1. **S22 Campaigns** — use search or press “Browse templates”.
2. **S23 Templates** — preview a layout and press “Use this template →”.
3. **S25 Campaign editor** — edit Subject, Preview text, From name, Reply-to, and Brand; press “Save sample draft”, then “Choose recipients →”.
4. **S26 Audience selection** — choose a list/segment, check “Confirmed subscribers only”, review eligible count and allowance, then press “Preview this letter →”.
5. **S27 Preview and test** — switch Desktop/Mobile/Plain text; enter avery@example.com in “Sample test recipient”; press “Simulate test email” and “Run preflight →”.
6. **S28 Preflight** — review readiness checks; use “Show blocking gaps” if needed, then press “Review & schedule →”.
7. **S29 Review and schedule** — review the frozen summary, choose Send now or Schedule, set date/time/time zone, check “I reviewed this content, sender, recipient count and timing.”, then press “Review sample send confirmation →”.
8. **S30 Send progress** — review accepted/pending/delivered; use “Pause future submissions”, “Cancel remaining”, or “Show reconciliation state”; press “See completed report →”.
9. **S31 Reports** — inspect accepted/delivered/bounced/awaiting counts; press “Review report export sample”.

**Outcome:** Preview, simulated test, and scheduled progress are navigation states; no provider submission, delivery, or real report data occurs. Tracking-off metrics remain unavailable.  
**Required recovery behavior (future product):** Quota overflow or consent gaps block sending; unknown provider outcomes remain in reconciliation, and already accepted messages cannot be recalled.

## 4. Clerk team and permissions

**Role:** Workspace owner / invited teammate.

1. **S32 Team** — review “3 of 3 members” and press “Invite a teammate”. The sample is full: review Tier 3 or an authorized membership change before a real invitation. “Inspect invitation design” opens a separate review example; it does not bypass the seat limit.
2. **S06 Invitation** — review workspace, invited email, and proposed Editor role; press “Sign in & accept sample invite”, “Show expired invitation”, or “Use a different account”.
3. **S04 Signin** — choose a Clerk sign-in method or enter email and press “Continue →”.
4. **S12 Workspace switcher** — review Clerk-supplied workspaces; press “Continue here →” or “Preview workspace switch”.
5. **S32 Team** — inspect a member’s access and press “Review →”.
6. **S33 Member permissions** — select Proposed role and Brand scope; review “View campaigns & audience”, “Edit drafts”, “Send & schedule” (off), “Manage billing”, and “Manage members”; press “Review permission changes” or “Review removal”.

**Outcome:** Simulated Clerk membership and brand-scoped permissions are shown; no real invitation, membership, or permission is created. The final role/capability mapping remains a proposed design.  
**Required recovery behavior (future product):** Expired invitations, mismatched identity, full Tier 2 seat allowance, or last-owner removal show a remedy; revocation stops pending unauthorized actions.

## 5. Billing change, recovery, cancellation

**Role:** Workspace owner.

1. **S35 Billing** — review Tier 2, usage, and invoices; press “Change plan”, “Payment method preview”, or “Cancel or export”.
2. **S36 Plan change** — compare plans; press “Review upgrade summary” for Tier 3 or use “Review workspace counts” in the downgrade preview.
3. **S37 Payment recovery** — review Past due state; press “Open Stripe recovery preview” or “Contact support”.
4. **S35 Billing** — return to the separate active-billing example and press “Cancel or export” to continue. This navigation does not prove that a payment recovered or a plan changed.
5. **S38 Cancellation** — review service end, 90-day retention display, and export/deletion controls; press “Review sample cancellation”, “Keep my plan”, “Review export request”, or “Review deletion request”.

**Outcome:** Simulated billing, plan-change, and cancellation states only; Stripe holds cards in the real product, while this preview creates no charge, renewal stop, export, or deletion.  
**Required recovery behavior (future product):** Browser return does not prove payment success; wait for verified confirmation. Downgrade excess counts require remediation, not silent deletion; proposed day-6 suspension/day-30 closure and retention clock remain policy review items.

## 6. Subscriber preferences

**Role:** Newsletter reader without a SaaS account.

1. **S43 Subscribe** — read brand/purpose, enter reader@example.com in “Email address”, check the consent checkbox, and press “Join the sample list →”.
2. **S44 Confirmation** — read the inbox instruction; press “Preview confirmed state”, “Resend sample confirmation”, or “Expired link example”.
3. **S45 Preferences** — choose “Seasonal notes” and “Shop updates”; press “Save sample preferences” or “Unsubscribe from this brand”.
4. **S46 Unsubscribe** — view the successful-state design; press “Show save-failure state” to inspect recovery.
5. **S47 Expired link** — enter the sample address and press “Request a sample link”.

**Outcome:** Simulated double opt-in, brand-scoped preferences, and unsubscribe state; no email is sent or suppression persisted.  
**Required recovery behavior (future product):** Invalid addresses/rate limits explain recovery without login/purchase; expired/reused links offer safe resend without disclosing another subscription; persistence failure shows retry rather than false confirmation.

## 7. MCP permission grant

**Role:** Workspace owner reviewing a delegated tool connection.

1. **S39 Integrations and grants** — review connected tools; press “+ Connect a tool” or “Review revocation”.
2. **S40 Delegated access consent** — verify the requesting tool and destination; review “Read workspace content” and “Create and edit drafts”; leave “Import or export audience” and “Send and schedule” not selected; press “Deny” or “Allow sample selection”.
3. **S39 Integrations and grants** — return to the sample connection list and press “Review revocation”. Grant creation and persistence are not implemented.

**Outcome:** Demonstration only; no credential, token, MCP grant, or permission is created. Draft access cannot send; sending/scheduling require separate explicit permissions and the same reviewed campaign intent.  
**Required recovery behavior (future product):** Unrecognized requests, missing authority, or excess requested scopes can be declined; revocation prevents new and pending unauthorized work.

## 8. Operator review and complimentary FFA grant

**Role:** Authorized platform operator / support operator.

1. **S48 Platform overview** — review attention queue and reserved emails; press “Delivery & capacity” or an affected workspace’s “Review →”.
2. **S49 Platform workspace detail** — review Clerk membership, billing eligibility, mailing service, and sender readiness; enter “Reason for scoped support access”; press “Record sample diagnostic review”.
3. **S50 Operator support/hold review** — read the redacted case summary and hold reason; enter “Review reason” and operator note; press “Save sample review note” or “Inspect proposed hold decision”.
4. **S51 Platform delivery/usage health** — inspect queue age, feedback freshness, and provider unknowns; press “Review affected workspace →”.
5. **S52 Complimentary entitlement** — review the FFA exception; enter intended customer, select “Choose an approved tier before activation” or a sample Tier option, reason, and effective date; press “Review sample grant record”.

**Outcome:** Simulated operator diagnostics and FFA entitlement review; no live support mutation, hold change, delivery action, or FFA grant is created. No real FFA products, images, or entitlements are imported.  
**Required recovery behavior (future product):** Missing authority/evidence keeps a hold in place; unsupported mutations are blocked and unknown external outcomes require reconciliation. FFA’s actual tier/lifecycle remains undecided, but the exception bypasses Stripe/card while quotas and sender controls still apply.
