# Billing provider preparation

Implements the configuration and renewal-projection portions of FL-BIL-001/003/004/005/007, FL-ONB-004 and FL-OPS-004/007 under D-046 and D-049. These checks create no customer, Checkout, subscription, payment or provider resource. Live billing remains independently gated.

## Dedicated catalogue and portal

Use one dedicated Flockletter subscription product with the three accepted monthly USD prices: Starter 1500, Growth 2500 and Pro 3900 minor units. Product metadata must contain `fl_application=flockletter`; each price must contain that application tag and its exact `fl_plan=starter|growth|pro`. Prices must be active, monthly, licensed, per-unit, quantity one and in the selected account/environment. Existing application products, prices, account defaults and branding must not be edited or reused.

This is a deliberate exception to the general recommendation of separate products for separate plans. Stripe's [portal configuration guide](https://docs.stripe.com/customer-management/configure-portal) limits end-of-period downgrades to prices on the **same product**. Three products would fail the owner's accepted renewal-downgrade policy even if all amounts matched. Flockletter's own catalogue and Subscription UI retain the distinct tier names, prices and allowances. Before activation, verify the actual hosted portal's plan/price presentation as well as upgrade/downgrade timing in the sandbox; product structure alone is not evidence of that result.

`FLOCKLETTER_CUSTOMER_STRIPE_PORTAL_CONFIG` is required for configured Stripe billing. The runtime explicitly uses this nondefault `bpc_` configuration rather than the merchant's default portal. It verifies the dedicated catalogue and portal policy before creating a portal session. It is the management profile; price changes use the three additional `FLOCKLETTER_CUSTOMER_STARTER_PORTAL_CONFIG`, `FLOCKLETTER_CUSTOMER_GROWTH_PORTAL_CONFIG` and `FLOCKLETTER_CUSTOMER_PRO_PORTAL_CONFIG` profiles. All four references must be distinct and nondefault. The common accepted policy has:

- Flockletter application metadata, the exact application return URL, and no shareable portal login page.
- Card updates bound to the dedicated payment-method configuration and visible invoice history. Customer-profile editing stays disabled while tax/contact policy is unresolved.
- Cancellation at period end with no cancellation proration; subscription pause remains disabled.
- Price changes only, with no quantity changes or promotion-code entry. Each destination profile exposes exactly one selected price on the shared product; the management profile exposes no price changes.
- Each destination profile has an unchanged billing-cycle anchor, immediate upgrade proration/invoicing, renewal scheduling for decreasing item amounts, and `continue_trial` on trial updates. Its metadata additionally binds `fl_plan` to the selected tier. The management profile disables subscription updates. The default that ends trials on a price change is rejected.

The runtime verifies Flockletter price/product tags before creating a paid checkout or trial subscription. A same-amount price from another application is insufficient.

## Sandbox-discovered compatibility correction

The actual Stripe sandbox rejected the original all-three-prices portal: each product's configured prices must have unique billing intervals. All accepted Flockletter tiers are monthly, so the prior single-profile fixture described an impossible configuration. A single-destination profile was then created successfully and read back with the installed policy. Keep the shared product for renewal downgrade compatibility, and use one management profile plus three destination profiles. This corrects the integration shape without changing D-049's commercial policy.

The customer chooses a tier in Subscription, then uses **Review selected plan with Stripe**. `customerBilling.portal` accepts an optional server-validated `plan`; UI, API and MCP share this operation. The existing general management button supplies no plan and cannot change price. Destination selection is part of the durable operation hash; changing it on an uncertain retry is rejected. Opening either portal grants no service and creates no subscription. Actual customer confirmation and verified provider facts still control any plan change.

Retrieve portal configurations with `features.subscription_update.products` expanded; Stripe omits this list otherwise. The inspector checks all four profiles, and runtime checks the selected profile before issuing its session. No shared merchant default is changed. The sandbox's successful resource creation/readback verifies API compatibility, not a real card, proration invoice, renewal transition or live readiness. Those acceptance checks remain gated.

## Read-only inspection while billing is off

Configure the dedicated account/key/card/portal/price settings privately, then run:

```sh
node --import tsx scripts/inspect-customer-billing.ts
```

The operator command works with `FLOCKLETTER_CUSTOMER_BILLING=off`; it does not construct the customer runtime or require the live activation flag. It derives key mode from the supported application environment and rejects wrong-mode keys, malformed references, repeated price IDs and noncanonical HTTPS origins before network access. Prefer an appropriately restricted key with the necessary read permissions. Never put real keys in source, command arguments or public evidence.

The result contains only `verified`, `live` and named checks (`account`, `catalogue`, `payment_methods`, `portal`, `webhook`) with pass/fail/unavailable states. It prints no account/customer references, keys, raw provider errors or signing secrets. A merchant mismatch stops further inspection. An incomplete webhook listing remains unverified rather than assuming absence. Exit zero means all read-only configuration checks passed; it does not activate service or prove an actual card, invoice or portal transition.

The endpoint must match the canonical origin plus `/api/v1/customer-billing/stripe-events`, be enabled in the expected mode, and subscribe to the exact `billingProviderEvents` set. This includes Checkout, subscription lifecycle, invoice, refund/dispute/fraud and subscription-schedule lifecycle events. The webhook signing secret stays separately installed; this read-only listing cannot prove it matches.

## Renewal facts and reconciliation

Authoritative subscription snapshots now retrieve their bound schedule and project the immediate next renewal downgrade. Schedule, customer, subscription and environment must agree; current phase/item, catalogue IDs, quantity and period boundaries must be unambiguous. Only a strictly cheaper recognized next plan at the current renewal boundary becomes `pendingPlan`. Actual next-price facts are checked separately. Unsupported/foreign/gapped schedules fail verification.

The normal signed-event path stores this fact in `pending_plan`, shared by UI, API/MCP and scheduled-delivery capacity checks. A released schedule clears the pending downgrade after authoritative retrieval. Schedule events resolve through first-class provider references, never metadata alone. The current tier remains until renewal; existing conservative future allowance checks apply the verified lower limit. No new migration, trial refresh or usage reset is introduced.

## External setup still required

The configured business merchant account and matching sandbox were identified. Their existence does not establish a Flockletter catalogue, dedicated portal, endpoint, signing secret, key permissions or working payment lifecycle. Stripe's product-creation tool requires the owner's actual sales-tax/VAT/GST answer before products can be created; do not assume an answer or reuse another application's tax settings. The final business/address/tax facts and exact legal documents remain in the [review packet](../legal/README.md).

After those facts are available, prepare Flockletter-only resources, inspect them with billing off, and exercise card setup, exact price/date acceptance, paid transition, proration, renewal downgrade, timely cancellation, failure/recovery, signed events and uncertain-outcome reconciliation in the sandbox. Keep the real trial-history baseline separate from empty test data. Public billing activation remains a later explicit action.

## Evidence and model work

The intercepted installed-SDK tests and disposable PostgreSQL tests cover configuration reads/redaction, foreign resources, dedicated portal binding, schedule ownership, renewal limits, schedule release/replay and existing billing lifecycles. They make no real Stripe calls and are not live payment evidence. The rejoin concurrency test now verifies whichever operation actually wins the database race rather than assuming the first submitted promise wins.

Local Qwen drafted bounded SDK fixtures and schedule tests; chat corrected amounts, imports, incomplete provider types and unsafe mutation dispatch, then reviewed all assertions. Chat owns the billing policy, provider validation, database integration, catalog compatibility decision and final verification. The [worker liveness record](WORKER_LIVENESS.md) and [legal review packet](../legal/README.md) describe their separate contributions.

Local integrated verification on November 9 passed lint, type checking, all 112 test files (846 passed, two existing gated native checks skipped), production build, API regeneration without a generated diff and the dependency audit with zero reported vulnerabilities. The initial concurrent rejoin test exposed an existing race-order assumption, corrected to verify the recorded winning operation. Hosted staging, actual provider resources and real payment behavior must be recorded separately after observation.

The targeted-profile correction passed lint, type checking, all 113 test files (864 passed; two existing native gated checks skipped), production build, API generation and dependency audit (zero reported vulnerabilities). Desktop/390px customer browser journeys also passed, including the selected-tier request versus general management. The local model drafted the focused portal-predicate tests in 128 seconds; chat corrected import paths, invented SDK fields, enum values and fixture typing, then verified every assertion. Chat implemented/reviewed the money and authority boundaries, actual provider setup/readback and UI/API/MCP integration. Actual sandbox profiles were additionally passed through the application predicate using their expanded provider responses; this is configuration evidence, not payment lifecycle acceptance.


## Real sandbox compatibility checks

FL-BIL-001/003/004/005/007 and FL-AT-007/008/009/031: the real sandbox exposed two additional provider differences. Managed Payments was enabled by the account default and rejected setup-only Checkout. Flockletter now explicitly sets `managed_payments.enabled=false` on its own setup and subscription Checkout requests, leaving merchant defaults and other applications unchanged. This does not enable tax collection or approve a merchant-of-record change.

A normal portal session with a single destination profile displayed only the current plan and no usable destination choice. Selected-plan sessions now use Stripe's [subscription-update confirmation flow](https://docs.stripe.com/customer-management/portal-deep-links). The server passes its recorded subscription binding; the adapter retrieves the actual subscription and verifies its customer, mode, single item, recognized current price, eligible status and absence of an attached schedule before supplying the exact item and destination price. The durable selected-plan hash additionally binds the subscription. General management preserves its existing hash and flow. A pending schedule must be resolved through billing management before another plan request; it is never silently overwritten.

Observed with synthetic customers and a disposable local Flockletter database against the real Stripe sandbox: setup-only Checkout completed with a test card; authenticated SetupIntent/card ownership and exact trial review were verified; no subscription existed before explicit acceptance; repeated acceptance created one trial; the application granted access only after processing an actual provider event. The isolated handler safely replayed that event and the adapter rejected an invalid signature. Locally generated test signatures around actual event payloads are application evidence, not proof of public Stripe delivery.

The actual hosted confirmation preserved the trial end date while changing the selected recurring price. A test controller deliberately ended only that synthetic trial early and observed a paid 2500-minor-unit invoice. A subsequent hosted Growth-to-Pro confirmation displayed a 2500 credit and 3900 charge; Stripe produced a paid 1400 invoice without moving the renewal boundary. Hosted downgrade confirmation scheduled Starter at renewal, while authoritative application reconciliation retained Pro with pending Starter. This verifies scheduling, not a month-later renewal transition. No actual customer was charged, no mail was sent, and no shared merchant default was changed.

Full local validation passed lint, type checking, 113 test files (872 passed; two existing gated native checks skipped), production build, unchanged API generation and dependency audit with zero reported vulnerabilities. Local Qwen drafted the sandbox checklist and provider-guard test scaffold. Chat corrected the checklist's setup proof, exact acceptance, timing and policy distinctions; removed a duplicated test fixture, corrected the current-plan and missing-subscription cases, and added fail-closed status coverage. Chat owns provider/financial decisions, credential boundaries, implementation, integration and review. Hosted delivery, time-advanced renewal/failure recovery and production credential readiness require their separate evidence; this entry does not declare paid-launch readiness.
