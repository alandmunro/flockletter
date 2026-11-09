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

New trial setup additionally requires `FLOCKLETTER_TRIAL_HMAC_KEY`, `FLOCKLETTER_TRIAL_POLICY_ID`, positive `FLOCKLETTER_TRIAL_POLICY_VERSION`, the separately approved `FLOCKLETTER_TRIAL_RETENTION_APPROVED=true`, and `FLOCKLETTER_TRIAL_HISTORY_BASELINE=verified-empty` or `reviewed-backfill` after real history review. D-048 accepts the minimal lifetime claim exception; a fresh key cannot erase history or establish the baseline. This policy record does not set a flag, install a key or assert those factual checks are complete.

## Bounded verification before any charge

Account, price and endpoint inspection can establish configuration without accepting a payment. The application's new-trial Checkout uses **setup mode only**: it creates no subscription or charge. It remains gated by the private eligibility registry and its approved retention policy. Actual card entry may require issuer verification and owner participation. Do not weaken the registry to obtain a demonstration.

Recurring trial activation is a separate current-owner action after the verified card setup. It requires exact price, first-charge date, revision and acceptance. A redirect or webhook cannot create that agreement. A real charge, live recurring commitment or refund requires its own applicable authorization and evidence; a successful synthetic test is not live verification.

## Accepted defaults and remaining launch evidence

On November 9 the owner accepted D-048/049/050. The table distinguishes that policy from factual setup and release checks; no mode, agreement, payment or entitlement is activated by recording it.

| Topic | Policy and remaining condition |
| --- | --- |
| Plans | Existing accepted USD $15/$25/$39 monthly catalogue and pooled limits remain. No annual product, discount or overage charge is activated by this update. |
| Trial | D-049 accepts one company, brand and user, two campaigns, 250 active contacts and 500 total recipient emails across the complete 14-day trial. Card setup and the customer’s exact recurring price/date acceptance remain required. |
| Changes | D-049 accepts immediate prorated upgrades only after selected provider/portal behavior is verified; downgrade/cancellation apply at renewal/current service end. Paid allowances use UTC calendar months without resetting consumed usage on plan changes or retries. |
| Failed payment | D-049 accepts suspension on day six and closure on day thirty from the first failure, retaining essential billing, suppression and approved data access. Repeated failures do not reset the clock. |
| Refunds | D-049 accepts manual review; no automatic refund promise or authorization of an individual refund. |
| Sending trust | Verified sender and confirmed recipients; hard bounces/complaints immediately suppress the matching recipient. Start with a bounded FFA pilot and explicit review/hold escalation before general external sending. Numeric workspace/account reputation thresholds still need an accepted operational policy and matching enforcement. |
| FFA | D-050 selects Growth at 100% complimentary service: 5 campaigns, 5,000 active contacts/per-campaign recipients, 25,000 recipient emails per UTC month, 3 users/companies/brands, pooled across the subscription. Actual issuance requires the verified FFA workspace and authorized operator with effective date/reason/audit; exact pilot recipients and sending controls remain separate. |
| Trial record exception | D-048 accepts only indefinite minimal keyed HMAC owner/card/workspace eligibility history plus necessary metadata beyond ordinary 90-day tenant purge. It is pseudonymous personal data, not anonymous data. Stable key/policy configuration, real history baseline, accurate disclosure and protected retention evidence remain required. |

The remaining factual business/tax checks include the selected Flockletter Stripe merchant account and its match to the approved legal business identity, applicable registrations and tax obligations, whether prices are tax-exclusive, and accurate approved/published terms/refund/privacy documents. Signed-in Resend/AWS/Stripe access permits the authorized setup work but does not establish these facts, actual limits/readiness, a trial-history baseline or customer agreement. Billing/retention policy approval is not approval of an alert destination or transport. US-only SaaS customers and a Colorado DBA do not establish sales-tax obligations or registrations. The current billing adapter does not itself configure Stripe Tax, automatic-tax collection or tax-address/ID collection; do not advertise those as verified or silently turn them on.

Production OAuth separately needs the actual provider-owned Google, Apple and Microsoft client/configuration values and approved domains/redirects. The accepted login-method list is not proof those production credentials exist. Email-code sign-in, account linking/recovery and operator MFA need actual hosted verification.

## Validation and model work

Focused tests cover all supported environments, malicious/unknown environment values, unchanged accepted prices, neutral configuration-failure copy and production preparation without staging/live-payment claims. Browser checks cover both production configuration and unavailable configuration on the pricing page; these use a disposable server and do not assert live Stripe or OAuth operation.

The local model drafted the copy map and focused-test scaffold. Chat corrected an inherited-property lookup edge case, a weak test assertion and typing, then integrated server-owned environment flow, reviewed all launch boundaries and performed validation.
