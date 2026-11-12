# Subscription signup and recovery

Applicable requirements: FL-PROD-002, FL-ONB-001/003/004, FL-ID-001/002, FL-BIL-001–004/007/008 and acceptance cases FL-AT-002/007/008/031. D-056 authorizes completing the existing signup journey; it changes no commercial policy or activation gate.

## Customer flow

Each pricing card offers **Choose Starter**, **Choose Growth** or **Choose Pro**. The link carries only a recognized plan ID into account setup. Prices, eligibility and provider references remain server-owned. Selecting a link starts no trial, subscription or payment.

Clerk sign-up, sign-in, organization creation and organization selection retain the internal Subscription destination and chosen plan. If an organization is already selected, the customer continues in that workspace. A new customer names the app workspace and first brand, then reaches Subscription. Clerk remains authoritative for identity and current membership; the URL and local navigation state grant no workspace access.

Subscription reads `customerBilling.status` before offering actions. The selected tier survives refresh. An existing ordinary subscription without a new tier hint starts with its recorded plan. A pending card setup takes precedence over URL hints and locks its original tier until that setup is resolved. Complimentary workspaces retain their assigned service and show no card or purchase actions.

With configured billing, **Verify card with Stripe** opens card-only setup. Card entry stays with Stripe. After returning, the customer chooses **Review trial terms after card setup**. The server verifies the provider-held setup and supplies the exact tier, price, first-charge date, expiry, revision and review hash. Only checking the acceptance box and clicking **Accept and start 14-day trial** submits that agreement. A replacement review clears the checkbox. Subscription eligibility still follows verified provider facts; navigation alone never establishes payment or service access.

All recognized Checkout return/cancel markers lead back to Subscription without starting a billing action. Stripe portal management and selected-plan confirmation also return to `/subscription`. Opening either view does not accept an agreement. Existing uncertain-outcome reconciliation and owner-only `customerBilling.*` commands remain shared by the UI, HTTP API and MCP; no delegated billing permission is introduced.

## Disabled and exercise modes

Production billing remains off until separately authorized and its legal, tax, provider and trial-history gates are satisfied. The off notice permits preparation without offering Stripe actions. Staging exercise controls remain explicitly simulated. FFA's existing complimentary entitlement continues to bypass Stripe and card collection. No sending or billing mode, credential, price, catalogue resource, tax registration or merchant default changes with this code.

## Verification

`tests/subscription-navigation.test.ts` covers recognized/duplicate/unknown plan and return hints, internal-only destinations, operator routing and browser/SSR entry handling. `tests/hosted-signup.test.ts` checks the actual Clerk adapter's redirect props with substituted components; it is not a real new-account login test. Pricing tests check the tier-specific account links. Installed-SDK provider tests check portal return paths and preserve all existing ownership/catalogue/confirmation assertions.

`scripts/prove-subscription-signup.ts` uses disposable PostgreSQL and the real local HTTP onboarding path on desktop and 390px viewports. It verifies workspace creation without billing rows, selection persistence, recorded-plan recovery, a saved card setup overriding a conflicting URL hint, explicit trial acceptance, replacement-review reset, and complimentary/off guards. Stripe status and card-setup replies are substituted for those UI states. It asserts no external requests and no trial-activation or paid-checkout request. This proves interface behavior, not actual Clerk account creation, a new Stripe sandbox transaction or inbox delivery. Existing billing lifecycle integration and provider tests remain required.

Before release, run lint, type checking, the full suite, build, API generation, dependency audit, this browser proof, and the existing customer workflows. Verify the exact staged release and retain captured delivery and exercise billing. Hosted verification must be recorded separately after observation.

## Model contributions

Local Qwen drafted pricing-card links, navigation tests, Clerk adapter tests and this runbook. Primary review added the omitted pricing prop type, replaced invalid HTML-encoded JSON parsing with direct mocked-prop capture, corrected the unknown-path expectation and weak SSR assertions, and clarified account/workspace, card-verification and evidence wording. Primary review owns routing/authority decisions, integration, saved-plan recovery, provider return destinations, browser acceptance criteria and final validation. No token/cost percentage is claimed.
