# Billing provider preparation

Implements the configuration and renewal-projection portions of FL-BIL-001/003/004/005/007, FL-ONB-004 and FL-OPS-004/007 under D-046 and D-049. These checks create no customer, Checkout, subscription, payment or provider resource. Live billing remains independently gated.

## Dedicated catalogue and portal

Use one dedicated Flockletter subscription product with the three accepted monthly USD prices: Starter 1500, Growth 2500 and Pro 3900 minor units. Product metadata must contain `fl_application=flockletter`; each price must contain that application tag and its exact `fl_plan=starter|growth|pro`. Prices must be active, monthly, licensed, per-unit, quantity one and in the selected account/environment. Existing application products, prices, account defaults and branding must not be edited or reused.

This is a deliberate exception to the general recommendation of separate products for separate plans. Stripe's [portal configuration guide](https://docs.stripe.com/customer-management/configure-portal) limits end-of-period downgrades to prices on the **same product**. Three products would fail the owner's accepted renewal-downgrade policy even if all amounts matched. Flockletter's own catalogue and Subscription UI retain the distinct tier names, prices and allowances. Before activation, verify the actual hosted portal's plan/price presentation as well as upgrade/downgrade timing in the sandbox; product structure alone is not evidence of that result.

`FLOCKLETTER_CUSTOMER_STRIPE_PORTAL_CONFIG` is required for configured Stripe billing. The runtime explicitly uses this nondefault `bpc_` configuration rather than the merchant's default portal. It verifies the dedicated catalogue and portal policy before creating a portal session. The accepted configuration has:

- Flockletter application metadata, the exact application return URL, and no shareable portal login page.
- Card updates bound to the dedicated payment-method configuration and visible invoice history. Customer-profile editing stays disabled while tax/contact policy is unresolved.
- Cancellation at period end with no cancellation proration; subscription pause remains disabled.
- Price changes only, with no quantity changes or promotion-code entry. The one product exposes exactly the three configured prices.
- An unchanged billing-cycle anchor, immediate upgrade proration/invoicing, renewal scheduling for decreasing item amounts, and `continue_trial` on trial updates. The default that ends trials on a price change is rejected.

The runtime verifies Flockletter price/product tags before creating a paid checkout or trial subscription. A same-amount price from another application is insufficient.

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
