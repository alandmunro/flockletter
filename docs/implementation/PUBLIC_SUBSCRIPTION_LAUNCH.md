# Public Subscription Launch Controls Runbook

## 1. Current State & Constraints
*   **Provider:** Resend Team ($20/mo, 50,000 emails).
*   **Capacity:** 10 domains total (2 active). No upgrades, add-ons, or overages authorized.
*   **Verification Status:** Code and local checks are recorded below. Hosted migration, staging deployment and production activation are pending.

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
4. Production web and dedicated worker must use matching verified settings. General sending requires `FLOCKLETTER_SENDING_POLICY=permission-v1`, `FLOCKLETTER_CUSTOMER_DELIVERY_SCOPE=all` and the existing explicit mailing-approval flag. Billing requires `stripe_live`, the explicit billing-approval flag and `FLOCKLETTER_BILLING_TAX=stripe-automatic`. New domain setup requires `FLOCKLETTER_RESEND_SELF_SERVICE=approved`, a separate provisioning key and a sending key that covers verified customer domains. `FLOCKLETTER_RESEND_APPROVED_MONTHLY_LIMIT=50000` prevents an unapproved account upgrade from raising Flockletter's reserve. Keep Pro enrollment paused.
5. A provider emergency can narrow new mailing back to `tests` (or switch transport off), preserving configured route/feedback credentials and reconciliation of already-submitted work. To stop new paid signup, switch billing off without removing event-receipt credentials or resetting trial history. Keep existing subscriber suppression and durable provider outcomes.
6. Migrations are additive. Do not drop the new ledgers or execute nonexistent down migrations. Roll back to a reviewed compatible code/configuration pair only after inspecting mixed-version queues and recorded outcomes. Do not disable signed webhooks merely to hide errors.
7. Enabling a transport never approves a campaign or submits marketing mail. Use only the specific owner-approved campaign, version and selected confirmed audience for any actual send.

## 8. Verification evidence and open gates

On the preceding revision, local lint, types, build and 137 test files passed: 1,141 tests passed, two existing optional native-engine tests skipped. The Stripe SDK tests substitute HTTP; isolated PostgreSQL tests exercise actual permissions, concurrent admissions, feedback, reset dates, Pro denial, exact trust review, domain ownership, uncertain outcomes, captured setup, provisioning and retention recovery. Local browser checks verified Growth pricing-to-workspace navigation, plan persistence after refresh, captured trial activation, saved profile revision recovery, exact domain review/approval, captured DNS and final verified status. The 390px layout had page width 390px, with no page overflow. These checks use disposable synthetic data and do not establish live sign-in, tax or mail delivery. API contracts were regenerated.

Read-only production inspection found the approved Flockletter prices exclusive with business-use SaaS code `txcd_10103001`, Stripe Tax settings active and one Colorado state registration. The exact Flockletter billing webhook was disabled. A single live non-charge tax estimate for the business’s Castle Rock address returned state `product_exempt` and local `not_collecting`, not evidence that local tax is configured. The owner was asked whether the hosted service is taxable inside Castle Rock. No shared merchant tax defaults or registrations were changed.

Resend account usage confirmed 50,000 monthly capacity, two of ten domains used, no daily provider cap and a billing-anniversary reset. The declined 100,000-email upgrade was closed without purchase. The owner approved the customer-domain provisioning and broader verified-domain sending keys. Resend requires owner email verification before issuance; existing confirmation/retrieval keys stay separate. The existing production transport remains test-only and live billing remains off until release verification.

Still pending: exact hosted migration/helper, staging review, production deployment/configuration, matching customer-domain credentials, enabled billing webhook and signed hosted signup reconciliation, and resolved local taxability. No campaign was submitted by this work.

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
