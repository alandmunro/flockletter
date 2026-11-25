# Flockletter gifting lab

Run the prepaid-credit and claim-on-tap workflows on this computer with synthetic recipients, a simulated clock and two mock providers. The dashboard lets you act as the fixture tenant, recipient or operator. All money is simulated USD. The lab uses Node's built-in SQLite and the repository’s supported Node version.

```sh
npm run lab:gifting
npm run lab:gifting -- --example
npm run lab:gifting:test
```

The first command prints a loopback address and runs the dashboard and retry worker until Ctrl-C. The second runs the 100-recipient reference scenario in a fresh in-memory database and prints the results in cents. The tests use their own disposable databases. Studio and Orchard share a simulated platform funding account and have separate tenant ledgers.

The separate Chrome walkthrough, `node --experimental-sqlite labs/gifting/browser-check.mjs`, verified the actual purchase, reserve, claim, expiry and refund forms at desktop and phone widths. It uses an in-memory database.

## Try the workflow

1. Open Studio and simulate the $550 purchase. Available credit becomes $500. Select 100 recipients, 30 days and five products, then reserve the gifts. The 200 email/SMS fixture rows become 100 offers against $500 of reserved credit.
2. Open a recipient offer twice. The balance and order count change only after pressing **Claim gift**. View the simulated reward and revisit the offer. Both visits refer to the same reward, with a fresh temporary link to the selected catalog.
3. Claim five different offers and advance 30 days. The ledger should show $25 consumed, $475 available and zero reserved. Close the workspace. The refund due is $475 credit plus $47.50 of the original purchase fee. Confirm the simulated refund to record settlement.
4. Use Orchard for another campaign. Set the provider to **outage**, or set settled platform funds to zero, and claim one offer. The recipient sees pending status and the operator sees the reason. Advance beyond expiry, restore funding and healthy service, and watch the worker reconcile. **Timeout** simulates a purchase committed before the response was lost. **Review** waits for operator approval. Both retain the original offer reference.
5. Open a full-purchase dispute before or after a claim. Inspect the scoped evidence and ledger, resolve the dispute, or advance the clock through days 6 and 30. The clock and provider fault controls apply to both synthetic workspaces.

Interactive state lives in the ignored `.local/gifting-lab/v1.sqlite`. Restart the command to recover the ledger, pending claims and mock vendor records. To start fresh, stop the process and move that directory aside. Use `GIFT_LAB_PORT` to choose a port. The directory belongs to this local exercise. The dashboard deliberately allows switching fixture tenants and operator roles. Keep it on loopback.

## Requirements review and test evidence

The [WA-09 specification](https://github.com/alandmunro/flockletter/blob/3a3aaf741d30ee7aa331ba3c5330378f96d3c284/docs/supplemental-requirements/specs/09-tremendous-gifting.md) defines eight build requirements and five acceptance cases. Its [shared contract](https://github.com/alandmunro/flockletter/blob/3a3aaf741d30ee7aa331ba3c5330378f96d3c284/docs/supplemental-requirements/REVIEW.md) assigns person resolution, consent, eligibility, sending and authenticated roles to other work areas. The [original proposal](../../docs/implementation/PROPOSED_TEXTING_AND_GIFTING.md) and [D-063](../../docs/DECISIONS.md) establish prepayment, purchase on claim and rollout sequencing. Reviewed at `93162f86c5b84387e12c613afeedc8edcd4ccf04`. The prior Tremendous sandbox runoff is historical evidence.

| Build and source requirements | Local implementation and observed evidence | Remaining integration or decision |
| --- | --- | --- |
| R01–02 · BIL-3, PRC-5, GFT-4/7/11/12 | AT01 and AT03 verify a signed simulated USD payment, 10% fee, replay by event and purchase ID, atomic reservation and five spends. A repeated launch checks the original campaign terms. Insufficient funds roll back the whole launch. | Stripe test-mode account, price, currency and payment matching. WA-03 must supply eligible canonical people and flag ambiguous address matches. |
| R03–04 · GFT-1/2/3/10/11 | AT02 and AT04 use separate SQLite connections for tap/tap, tap/expiry and webhook/worker races. GET displays the offer. POST commits intent before vendor submission. Restart, timeout, unavailable product, funding shortfall and review retain the reservation. The mock order binds the offer ID, face value and allowed products. | Verify actual order lookup, pending/rejected outcomes, stable external IDs, fresh link generation and event formats in Tremendous sandbox. Delivery and automation attach the same recipient offer. |
| R05 · GFT-5/7/8, PRC-5 | AT01 and AT03 exercise exact expiry, pending closure, verified refund settlement, and duplicate callbacks. Separate tests exercise FIFO allocation across purchases, partial fee rounding and credit surviving a year. | Decide lot allocation, rounding and liability during disputes and closure. Verify partial refunds against the original payment. |
| R06 · GFT-9/10, NTF-2 | The operator sees settled mock funds, open liability, buffer and shortfall across both workspaces. The worker retries pending claims. Tenant view flags credit below $20. | Confirm bank-transfer API capability, settlement and actual alert delivery. Integrate scheduled offers for the seven-day low-credit forecast. Buffer is a fixture setting. |
| R07 · CBK-1–6 | AT03/04 exercise full-purchase disputes, tenant isolation, invalid signatures, held reservations, negative balance, resolution, day-6 suspension and day-30 closure. Scoped evidence includes purchase, ledger and simulated claim dates. Probation loss triggers an operator hold. | Verify partial/out-of-order disputes, concurrent refunds and automatic evidence submission. Connect the account pause to the sending owner. Decide how a repaid deficit is allocated between lots. |
| R08 · IDV-10, CMP-7/8, DSH-3/4/7/9, RET-3 | Eligibility and broker-confirmation fixture gates, upstream probation budget, fixed thank-you template, scoped provider choices, per-person states and purchase totals. Acquisition of a reward is observable. Store redemption is unknown. | Integrate WA-05 eligibility, monthly budget enforcement, send and fee reporting, scoped roles, consent and retention. Establish seven-year accounting retention before hosted use. |
| AT05 · external evidence | This lab uses only mock provider records. | Obtain Stripe test-mode and Tremendous sandbox evidence against the built workflow. The separate live $5 acceptance case and prepaid-credit legal/refund review remain open. |

## Choices to evaluate

- Each offer draws from the oldest available purchase lots first. The ledger is append-only. Each entry inherits the immutable USD denomination of its purchase. Closure prorates each original lot’s fee against its unused face value and rounds half-up to the nearest cent.
- Disputing a full purchase removes its face value from available funds immediately. Existing offers retain their reserved allocations. A claim against disputed credit can create a deficit. The first deficit day starts the pause clock. A won dispute restores the original debit once. A closed account stays closed. Conflicts involving pending refunds or a negative individual lot require review.
- Expiry releases only untouched offers. Pending intents survive campaign expiry, including while the provider reviews an order. Closure persists before calculating refunds. It waits for pending claims and open disputes. An owed refund remains in the ledger balance until the mock provider confirms it.
- The mock payment and reward fixtures sign different event streams with a local test key. The lab verifies the signature, source, workspace and economic identity before applying a fact. SQLite transactions serialize writes and a separate vendor commit allows the tests to interrupt the order/ledger sequence. Testing real payment signatures, provider access, PostgreSQL isolation, hosted recovery and production claims belongs to later integration.
- To extend the exercise, change the canonical lab operations in [lab.mjs](lab.mjs), add a synthetic input in [fixtures.mjs](fixtures.mjs), and bind the resulting behavior to a WA-09 assertion in [lab.test.mjs](lab.test.mjs). [schema.sql](schema.sql) versions the disposable database independently of Flockletter migrations.

The local model drafted the dual-channel contact generator. Primary review simplified its input validation and integrated it. The primary assistant designed and verified ledger behavior, provider simulations, claim handling, dashboard, acceptance cases and the requirements mapping.

## Staging exercise

Sign in as a staging workspace owner and open **Gift lab**. Simulate a purchase, choose the duration and product count, and reserve 100 gifts. Open a recipient link to inspect and claim. Use the timeout control before a claim and the recovery action afterward to exercise provider lookup. Advance the calendar to expire untouched offers, then close the exercise to refund the remaining credit and fee. A claimed recipient can open a fresh five-minute link to the simulated reward. The dispute controls freeze and resolve the fixture payment.

The hosted exercise uses the same SQLite simulation as the local lab. It reconstructs the simulation from a bounded, versioned PostgreSQL event stream per workspace. The existing restricted role and row-level security protect the stream. Each claim intent commits independently before submission. Operator controls use a single simulated purchase and campaign per workspace. The local lab supports additional fault injection and multiple purchase lots. Real Stripe and Tremendous integration, automated provider polling and the live purchase acceptance case remain open.

On staging startup, two reserved synthetic fixture identities exercise the PostgreSQL store. A read-only report at `/api/staging/gifting/evidence` identifies the serving commit, five simulated orders, 95 expirations, spend, refund and isolation result. A restart rechecks the saved journal. Recipient links carry credentials in URL fragments. Release rollback uses the previous compatible application revision. Retain the version-one replay implementation for existing capture records.

## Stripe test mode and Tremendous sandbox on staging

The fixed provider exercise runs on the Flockletter staging service when its Stripe test key, expected Stripe account, and Tremendous sandbox key are configured. Bind `FLOCKLETTER_STRIPE_TEST_KEY`, `FLOCKLETTER_STRIPE_TEST_ACCOUNT` and `TREMENDOUS_SANDBOX_API_KEY` privately. An existing verified staging subscription test key/account pair can also supply Stripe. Store secret values in the approved secret manager and inject them only into the staging service. After saving a binding, deploy the tested revision through the staging workflow.

The service writes an intent before creating a USD 550.00 PaymentIntent, confirms it with Stripe’s test Visa payment method and credits USD 500.00 after retrieving the succeeded payment. Five synthetic recipient claims use link delivery and the Tremendous test balance. The service looks up each order by its original offer ID before submission and verifies the executed order, reward, denomination, recipient and delivery before consuming credit. The fixture advances its own clock 30 days. It refunds the remaining credit and proportional fee to the original test payment, then retrieves the refund and charge to verify settlement.

Read `/api/staging/gifting/providers` for the build revision, progress and verified totals in USD cents. A complete run is durable across restarts. Pending or ambiguous outcomes retain the original operation and provider identities. The route never returns keys, recipient claims, redemption URLs or payment identifiers. The separate `/api/staging/gifting/evidence` report continues to exercise simulated providers.
