# Production launch preparation

Applicable requirements: FL-PROD-004, FL-ONB-002/004, FL-BIL-002–008, FL-DEL-001–008 and FL-OPS-001–007. Production setup authorization does not establish legal facts, signed card acceptance or verified external outcomes. The application can open an isolated preparation workspace while live integrations remain off.

## Environment-correct customer information

The customer shell and pricing pages use the server-reported environment for presentation. Production does not inherit the staging label or a promise that signup starts a paid trial. Unknown/unavailable configuration uses neutral preparation copy. Published prices remain the accepted $15/$25/$39 monthly USD catalogue, explicitly shown for review with service activation checked in the workspace. No pricing-page button purchases a plan or activates a trial.

Presentation never grants eligibility. Subscription and Delivery remain authoritative for the current workspace's provider configuration, protected trial checks, verified facts, sender readiness and blocked reasons. API/MCP continue through those same server operations. Existing captured workflows remain explicitly labelled; simulator checks never establish real customer delivery. Operations no longer claims every deployment uses a sleeping free staging worker.

## Stripe configuration checklist

Before enabling live billing, select the Flockletter merchant account and verify:

- `APP_ENV=production`, `FLOCKLETTER_CUSTOMER_BILLING=stripe_live`, `FLOCKLETTER_LIVE_BILLING_APPROVED=true`.
- `FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT`: the selected `acct_` reference; the adapter retrieves and compares the actual account.
- `FLOCKLETTER_CUSTOMER_STRIPE_KEY`: a dedicated matching live key, stored only in the protected service configuration.
- `FLOCKLETTER_CUSTOMER_STRIPE_WEBHOOK`: signing secret for `/api/v1/customer-billing/stripe-events`.
- `FLOCKLETTER_CUSTOMER_STRIPE_CARD_CONFIG`: a card-enabled `pmc_` payment-method configuration.
- `FLOCKLETTER_CUSTOMER_STARTER_PRICE`, `FLOCKLETTER_CUSTOMER_GROWTH_PRICE`, `FLOCKLETTER_CUSTOMER_PRO_PRICE`: three distinct active, live, USD monthly licensed/per-unit prices at 1500/2500/3900 minor units, quantity one.
- Authenticated feedback for Checkout completion/expiry, subscription changes, paid/failed invoices, refunds, disputes and early fraud warnings; replay and unknown-outcome reconciliation remain required.
- The selected Billing Portal's actual upgrade, downgrade and cancellation behavior. A portal session alone does not establish those commercial policies.

New trial setup additionally requires `FLOCKLETTER_TRIAL_HMAC_KEY`, `FLOCKLETTER_TRIAL_POLICY_ID`, positive `FLOCKLETTER_TRIAL_POLICY_VERSION`, the separately approved `FLOCKLETTER_TRIAL_RETENTION_APPROVED=true`, and `FLOCKLETTER_TRIAL_HISTORY_BASELINE=verified-empty` or `reviewed-backfill` after real history review. The minimal lifetime claim exception is still a policy decision; a fresh key cannot erase history or bypass it.

## Bounded verification before any charge

Account, price and endpoint inspection can establish configuration without accepting a payment. The application's new-trial Checkout uses **setup mode only**: it creates no subscription or charge. It remains gated by the private eligibility registry and its approved retention policy. Actual card entry may require issuer verification and owner participation. Do not weaken the registry to obtain a demonstration.

Recurring trial activation is a separate current-owner action after the verified card setup. It requires exact price, first-charge date, revision and acceptance. A redirect or webhook cannot create that agreement. A real charge, live recurring commitment or refund requires its own applicable authorization and evidence; a successful synthetic test is not live verification.

## Proposed owner decisions, not accepted production policy

The current exercise behavior offers a concrete starting point:

| Topic | Proposed starting policy |
| --- | --- |
| Plans | Monthly-only USD $15/$25/$39; existing pooled limits; no automatic overages or annual discounts. |
| Trial | One company, brand and user; two campaigns; 250 contacts and 500 total recipient messages; 14 days after exact acceptance, card required. |
| Changes | Immediate prorated upgrade only after the selected portal's behavior is verified; downgrade and cancellation at period end. |
| Failed payment | Suspend sending on day six and close service on day thirty, retaining essential billing, suppression and approved data access. |
| Refunds | Human review; no automatic refund promise or new guaranteed exchange/credit benefit. |
| Sending trust | Verified sender and confirmed recipients; hard bounces/complaints immediately suppress the matching recipient. Start with a bounded FFA pilot and explicit review/hold escalation before general external sending. Numeric workspace/account reputation thresholds still need an accepted operational policy and matching enforcement. |
| FFA | Operator-issued complimentary entitlement bypasses Stripe/card only; sender, consent, quotas and suppression still apply. Assigned tier and exact pilot recipients require recorded selection. |

The owner must supply factual business/tax configuration: the selected Stripe merchant account and legal billing entity, applicable registrations and tax obligations, whether prices are tax-exclusive, and the approved terms/refund/privacy documents. US-only SaaS customers and a Colorado DBA do not establish sales-tax obligations or registrations. The current billing adapter does not itself configure Stripe Tax, automatic-tax collection or tax-address/ID collection; do not advertise those as verified or silently turn them on.

Production OAuth separately needs the actual provider-owned Google, Apple and Microsoft client/configuration values and approved domains/redirects. The accepted login-method list is not proof those production credentials exist. Email-code sign-in, account linking/recovery and operator MFA need actual hosted verification.

## Validation and model work

Focused tests cover all supported environments, malicious/unknown environment values, unchanged accepted prices, neutral configuration-failure copy and production preparation without staging/live-payment claims. Browser checks cover both production configuration and unavailable configuration on the pricing page; these use a disposable server and do not assert live Stripe or OAuth operation.

The local model drafted the copy map and focused-test scaffold. Chat corrected an inherited-property lookup edge case, a weak test assertion and typing, then integrated server-owned environment flow, reviewed all launch boundaries and performed validation.
