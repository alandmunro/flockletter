# Public Subscription Launch Controls Runbook

## 1. Current State & Constraints
*   **Provider:** Resend Team ($20/mo, 50,000 emails).
*   **Capacity:** 10 domains total (2 active). No upgrades, add-ons, or overages authorized.
*   **Verification status:** Migrations 035–037 and the application-role check passed on hosted staging. The first hosted trial rehearsal and its release blocker are recorded below. Production activation is a separate gate.

## 2. Subscription & Pricing
*   **Offerings:** Starter ($15), Growth ($25) remain offered, subject to actual launch verification. Pro ($39/100k) catalogue unchanged but **new enrollment paused**.
*   **Logic:** `publicSubscriptionOffers.pro === false`.
*   **Notice:** "Pro enrollment is paused while delivery capacity remains on the current plan. Existing service management remains available."

## 3. Sending Trust & Limits
*   **Phases:** `new` → `established` → `full`.
*   **Admissions (UTC Day):**
    *   `new`: 2,500 recipients after service and sender verification.
    *   `established`: 5,000 recipients. Requires: Age ≥7 days + 100 verified deliveries + Operator review.
    *   `full`: Plan limits. Requires: Age ≥14 days + 500 verified deliveries + Operator review.
*   **Rate Limits:** Resend accepts at most four new submissions per second across workspaces. Other routes use their own pace. A limited restart after an incident admits at most 100 recipients per UTC day.

## 4. Safety Triggers & Holds
*   **Complaints:** Any complaint pauses sending (`sending_reputation_hold`).
*   **Bounces:**
    *   Warning: 1% rate with ≥100 sample size.
    *   Pause: ≥2% over 24h/7 days OR <100 sample size with ≥2 bounces.
*   **Provider Usage:**
    *   Warning: 40,000 emails used.
    *   Pause: 45,000 emails used (Resend limit 50,000).
    *   Reset: Based on actual provider timestamp.
*   **Unknown Outcomes:** Reconcile only; no blind resends.

## 5. Sender Setup & Provisioning
*   **Keys:** Separate provisioning key for setup vs sending/retrieval.
*   **Flow:** Verified ownership (TXT) → Review (`senderSetup.review`) → Approve (`senderSetup.approve`) → Process/DNS (`senderSetup.process`).
*   **Constraints:**
    *   `captured` mode is non-prod only.
    *   No automatic domain adoption after unknown create states.
    *   `senderSetup.approve` never changes provider plan or enables mailing directly; it authorizes the setup state.

## 6. Architecture & Access
*   **Unified Interface:** Customer/Admin UI, API, and MCP share the same command definitions (`senderSetup.*`).
*   **Migrations:** `035`, `036` and `037` require protected migration role. Full boundary validation enforced. No credentials in docs or runtime migration permissions.
*   **Billing:** Live tax/billing webhooks must be externally verified before billing activation.

## 7. Safe release and rollback

1. Apply 035–037 through the protected release runner with the matching isolated migrator/runtime pair; check exact source fingerprint, target identity and runtime boundaries. Do not add migration/operator credentials to web or customer workers.
2. Staging stays Free and uses exercise billing, capture delivery with `FLOCKLETTER_CUSTOMER_DELIVERY_SCOPE=all` for the broadcast rehearsal and `FLOCKLETTER_RESEND_SELF_SERVICE=capture`; these DNS records are unusable examples. Verify UI/API/MCP behavior and current original campaign assets.
3. Verify the real Stripe account, catalogue, exclusive SaaS code, tax address collection and jurisdiction calculations, enabled exact webhook, protected lifetime trial registry/history baseline and sandbox billing lifecycle. Do not infer taxability from a license or zero estimate.
4. Production web and dedicated worker must use matching verified settings. General sending requires `FLOCKLETTER_SENDING_POLICY=permission-v1`, `FLOCKLETTER_CUSTOMER_DELIVERY_SCOPE=all` and the existing explicit mailing-approval flag. Billing requires `stripe_live`, the explicit billing-approval flag and an explicit `FLOCKLETTER_BILLING_TAX=stripe-automatic` or D-062 temporary `off` policy. Follow [the no-collection runbook](NO_TAX_COLLECTION.md) before changing policy. New domain setup requires `FLOCKLETTER_RESEND_SELF_SERVICE=approved`, a separate provisioning key and a sending key that covers verified customer domains. `FLOCKLETTER_RESEND_APPROVED_MONTHLY_LIMIT=50000` prevents an unapproved account upgrade from raising Flockletter's reserve. Keep Pro enrollment paused.
5. A provider emergency can narrow new mailing back to `tests` (or switch transport off), preserving configured route/feedback credentials and reconciliation of already-submitted work. To stop new paid signup, switch billing off without removing event-receipt credentials or resetting trial history. Keep existing subscriber suppression and durable provider outcomes.
6. Migrations are additive. Do not drop the new ledgers or execute nonexistent down migrations. Roll back to a reviewed compatible code/configuration pair only after inspecting mixed-version queues and recorded outcomes. Do not disable signed webhooks merely to hide errors.
7. Enabling a transport never approves a campaign or submits marketing mail. Use only the specific owner-approved campaign, version and selected confirmed audience for any actual send.

## 8. Verification evidence and open gates

On the preceding revision, local lint, types, build and 137 test files passed: 1,141 tests passed, two existing optional native-engine tests skipped. The Stripe SDK tests substitute HTTP; isolated PostgreSQL tests exercise actual permissions, concurrent admissions, feedback, reset dates, Pro denial, exact trust review, domain ownership, uncertain outcomes, captured setup, provisioning and retention recovery. Local browser checks verified Growth pricing-to-workspace navigation, plan persistence after refresh, captured trial activation, saved profile revision recovery, exact domain review/approval, captured DNS and final verified status. The 390px layout had page width 390px, with no page overflow. These checks use disposable synthetic data and do not establish live sign-in, tax or mail delivery. API contracts were regenerated.

Read-only production inspection found the approved Flockletter prices exclusive with business-use SaaS code `txcd_10103001`, Stripe Tax settings active and one Colorado state registration. The exact Flockletter billing webhook was disabled. A single live non-charge tax estimate for the business’s Castle Rock address returned state `product_exempt` and local `not_collecting`, not evidence that local tax is configured. The owner was asked whether the hosted service is taxable inside Castle Rock. No shared merchant tax defaults or registrations were changed.

Resend account usage confirmed 50,000 monthly capacity, two of ten domains used, no daily provider cap and a billing-anniversary reset. The declined 100,000-email upgrade was closed without purchase. The owner approved the customer-domain provisioning and broader verified-domain sending keys. Resend requires owner email verification before issuance; existing confirmation/retrieval keys stay separate. The existing production transport remains test-only and live billing remains off until release verification.

At this point in the local rehearsal, hosted checks had not started. See the dated hosted results below for subsequent evidence.

## 9. Model contributions

The local model drafted the customer trust notice, operator review controls, sender setup presentation, UI SSR tests and this runbook. Primary review corrected JSX/typing, safe rendering, held limited-restart controls, incorrect self-closing-button test expressions, uncertainty guidance, bounce equality and unsupported rollout/rollback claims. A separate local inventory patch confused private tables with the public runtime-table count and omitted new routes/functions; it was discarded and completed in primary review. Chat owns security/money decisions, SQL, integration, provider inspection, regression design, validation and release review. No token/cost percentage was measured.

## First-session acceptance

The card-backed Starter and Growth trials each allow 2,500 contacts and 2,500 recipient emails over fourteen days. One full 2,500-person send consumes the email allowance. A real test message consumes one unit too. Confirmed contacts require current, brand-specific permission. A source attestation is recorded separately from mailbox verification.

In the Stripe test account, a card-only Checkout completed and stored a US billing address. A missing test merchant head-office address initially blocked automatic tax. After entering the approved business address in test settings, Stripe created a fourteen-day Starter trial with automatic tax, a zero-dollar invoice and the saved card. The test subscription was canceled and read back as canceled. The initial test tax calculation returned `not_collecting` before configuring test registrations. This exercises Stripe directly. A hosted signup through Clerk, app webhook verification, production configuration and approved inbox evidence are distinct.

A fresh disposable trial imported 2,500 certified addresses, queued exactly 2,500 unique recipients in 61.32 seconds from synthetic sign-in, and recorded the first capture at 61.72 seconds. Repeating approval reserved one campaign. A separate volume run omitted transport pacing after that first receipt and settled all 2,500 exactly once in 110.75 seconds from the start. Clerk, DNS and delivery were simulated. In a separate paced test, the actual scheduler submitted 40 unique recipients with a photo in 10.04 seconds to a synthetic transport. The shared limit of four Resend submissions per second budgets about 4 minutes 10 seconds for 1,000 recipients and 10 minutes 25 seconds for 2,500 before provider delays or other workspace traffic. DNS propagation and inbox delivery have independent timing.

The full local check passed 1,160 tests across 138 files, with two optional native-engine checks skipped. Lint, type checking, the production build, contract generation and the desktop/390px signup and sender-setup browser exercises passed. The native private renderer and hosted services have separate release checks.

In Stripe test mode, matching Colorado state and Castle Rock home-rule registrations were then activated. The Castle Rock line-item calculation for the approved business SaaS code returned `product_exempt` for the city, county and state. This supersedes the earlier registration-only diagnosis. The [Town ordinance](https://www.crgov.com/ArchiveCenter/ViewFile/Item/2759) includes standardized software in the local tax base and the [Town lists a 4.2% rate](https://www.crgov.com/1676/Revenue-Sales-Tax). For a typical nonexempt in-town business use of the standard software, these sources point to a different city result. Resolve that discrepancy for this bundled service before collecting live subscriptions; keep the shared production merchant's tax settings intact. Compare itemized city-level calculations with an in-town customer and a customer outside town, and retain the [state's separate guidance](https://tax.colorado.gov/sales-use-tax-topics-computer-software).

With the actual pinned private Listmonk renderer and a simulated Resend endpoint, the scheduler rendered and recorded 40 unique photo-bearing messages. From cold startup, the first submission took 1.86 seconds and the last took 11.82 seconds. The four-per-second admission limit dominated warm rendering. This validation used disposable infrastructure.

A second Stripe test used the public Castle Rock Town Hall address and contrasted two $15 items in the same calculation. The city returned zero for business SaaS and 63 cents for the tangible-goods control. This isolates the discrepancy to product treatment. No production registration or price was changed.

GitHub's broader customer browser journey caught an accessibility bug in the default-filled signup consent textarea. Associating its label separately from the editable value preserves its accessible name as the customer edits it. The corrected seven-workflow and media/confirmation browser journeys passed locally.

The 1,000-recipient paced benchmark used the actual private Listmonk renderer, a photo attachment on every message, the production scheduler and PostgreSQL admission limits. From a queued campaign the first simulated provider submission took 0.91 seconds and the last took 4 minutes 42.80 seconds. It recorded exactly 1,000 distinct destinations, 1,000 submissions and zero duplicate attempts. Clerk and the provider were simulated. A separate read-only Stripe live inventory found zero subscriptions in any status at the three Flockletter prices and zero subscriptions with Flockletter workspace metadata. The internal database trial-history check still belongs to the protected release.

The mobile test history journey exposed a redundant refresh of unrelated campaign, segment and broadcast lists that exhausted the API read budget. Test actions now refresh the affected delivery status and test history; the existing API rate limit is retained. The desktop and mobile one-recipient exercise verifies this request scope and restores the saved test after reload.

### Hosted rehearsal · November 13, 2026 (UTC)

The Free staging website served `622903a` and passed its readiness check after the protected release applied 035–037 and verified the restricted runtime role. Render's checkout sits under a group-writable ancestor. On the private helper, copy the exact source and dependencies to an owner-private temporary directory, remove group/other write access on the copy, and verify the source fingerprint there. Do not relax the release check or change permissions on Render's shared directory.

A fresh Clerk development test customer chose Growth, created a separate organization, workspace and brand, and remained signed in after a refresh. Exercise billing recorded a fourteen-day trial with **2,500 available** contacts and recipient emails. That allowance is not a contact count or a delivery receipt. The customer saved a sender profile, verified the simulated provider domain and saved newsletter version 2. No live DNS, card or recipient was used.

The CSV preview counted 2,500 unique valid addresses. Committing them timed out while inserting consent evidence. The customer saw a retry message and the brand showed zero confirmed contacts. This is a failed hosted import on this revision; the local benchmark above does not supersede it. Repeat the same batch and verify the exact recipient count, evidence and capture before promotion. Stripe Tax support has the SaaS/tangible comparison; no determination or change to production tax settings has been recorded.

### Staging CSV timeout and recovery

On November 13, staging canceled the consent-evidence insert for a 2,500-contact exercise. The runtime has a ten-second limit per SQL statement. On a fresh PostgreSQL 18.6 fixture, the foreign-key check chose the email index, searched by workspace and brand and filtered on subscriber ID. The first full signup and confirmation statements took 146 ms and 376 ms on the local Mac. Their foreign-key checks accounted for 124 ms and 355 ms.

Flockletter now writes up to 100 contacts or evidence records per statement within the original locked transaction. On the same schema, a separate local run completed the signup and confirmation records in 25 statements each, with maximum durations of 11 ms and 20 ms, respectively. A canceled request rolls back the contacts, both consent events and the operation receipt together. Retry with the same operation key. After a successful retry, verify the 2,500 confirmed people, both records of permission per person and the single import receipt. Hosted timing and campaign delivery require their own checks. [Regression test](../../tests/optional-confirmation.test.ts)
