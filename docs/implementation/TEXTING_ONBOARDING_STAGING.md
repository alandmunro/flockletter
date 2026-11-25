# Self-service texting in staging

D-065 authorizes the staging implementation of the EIN-based US business enrollment. WA-05 and the WA-10 setup-payment contract cover the staged flow. Broader release evidence is tracked in [WA-05](../supplemental-requirements/specs/05-sms-onboarding.md) and [D-063/D-065](../DECISIONS.md).

## Practice enrollment

1. Use a synthetic staging workspace with permission to manage its company. Under Audience, enable a Flockletter public sign-up page for a brand in the company. Turn on the mobile number field in Texting settings.
2. Under **Texting → Set up business texting**, save fictional business and contact details. Use a matching business website, policy URL, terms URL and email domain. Review the generated campaign examples.
3. Request each practice verification code and enter the code displayed for that channel. Exercise the setup payment, then submit the enrollment. In capture mode, the worker advances the mock brand and campaign through signed callbacks. The campaign must be approved before the worker requests a number.
4. Reload or open the workspace in another tab to verify the saved progress. A different workspace owner attempting the same synthetic EIN goes to review. The operator's workspace-scoped Texting controls can return a held enrollment for correction.
5. Set the required sending and probation settings at workspace scope for a test. For the first broadcast, use a campaign example and fictional opted-in recipients. Observe that the remainder waits for the first cohort to deliver and for its observation interval to pass. An unsuccessful cohort pauses pending delivery. Probation exits after both the minimum age and delivered-broadcast threshold, or an audited operator decision.
6. To exercise the failure path, finish all signup confirmations and review the first broadcast. In the same workspace's operator page, confirm the carrier is mock, then choose **Fail next text** once. Confirm the reviewed broadcast as owner. After the observation interval, check **First broadcast** on the operator page. The first cohort should show a failed carrier attempt and the remaining texts should show pending under probation with zero carrier attempts.

With mock texting, staging defaults to `FLOCKLETTER_TEXTING_ONBOARDING=capture`. Use `off` to pause self-service. For loopback development, explicitly select `FLOCKLETTER_TEXTING=mock` and `FLOCKLETTER_TEXTING_ONBOARDING=capture`.

An isolated Stripe sandbox can use `FLOCKLETTER_TEXTING_ONBOARDING=stripe_test` with the test account, secret key and endpoint signing secret in `FLOCKLETTER_TEXTING_SETUP_STRIPE_ACCOUNT`, `FLOCKLETTER_TEXTING_SETUP_STRIPE_KEY` and `FLOCKLETTER_TEXTING_SETUP_STRIPE_WEBHOOK`. Configure Checkout session completion and asynchronous payment success events for `/api/v1/texting/stripe-setup-events`. Return to Texting to refresh the saved payment. Resolve expired or mismatched sessions in the sandbox before starting a new payment attempt. Staging capture can run without Stripe credentials.

## Carrier readiness

For a future live release, set up Twilio Event Streams for the appropriate subaccount and confirm the account token and the exact destination `/api/v1/texting/twilio/carrier-events`. A newly purchased live number remains reserved until a signed registration-success event matches its owning account, Messaging Service and phone number. A lost purchase response is reconciled by lookup. Attachment resumes using the saved provider number SID. Long-running registration and provider ambiguity require operator review.

Live per-workspace account provisioning and business verification, approved handling of identity documents, carrier acceptance of domainless pages and same-EIN DBAs, sole-proprietor OTP, and campaign resubmission access remain production pilot work. Record FL-AT-045 carrier approval and opted-in delivery before a live owner pilot.

## Evidence

On November 25, 2026, the fresh Juniper and Alder synthetic workspaces each submitted a registration to the mock carrier on hosted staging at `83cdf5c85fdc529bcdbad96fff93ab8e4e6f19b5`. With Texting left open, each **Companies and numbers** row advanced from **Provisioning** through **Brand pending** and **Campaign pending** to **Approved**, then showed its own mock number and **Ready to send**. Juniper reached approval about 23 seconds after submission and Alder about 28 seconds. Both runs used the worker's own responses throughout, with no page reload or manual status refresh. [Staging deployment](https://github.com/alandmunro/flockletter/actions/runs/45679350263)

For WA-05-R04, three fictional subscribers in each workspace opted in through its hosted signup form and confirmed by replying YES through the mock carrier. Both owners reviewed an approved campaign example for three recipients and three segments.

- **Juniper, first broadcast.** The owner confirmed the send at 19:25:41 UTC on `83cdf5c`. The operator view showed `canary`, and the usage meter rose by one segment during observation. Staging switched to `4b85917` at 19:26:17 UTC during the wait. After the interval, the meter showed all three broadcast segments used and zero in progress. The operator view showed `active`, confirming release of the remaining two texts under probation. The three signup confirmation segments were already on the meter before the broadcast. The workspace's temporary test settings were restored after verification.
- **Alder, first broadcast.** The owner reviewed three confirmed recipients and three segments. The broadcast is awaiting a mock carrier failure on its first cohort. The operator page's timeout simulation eventually delivers and cannot establish the failed-cohort hold.

The PostgreSQL integration tests exercise two isolated synthetic workspaces, mismatched identities, repeated payment and submission requests, signed event deduplication, delayed number readiness and a failed canary through the existing worker. Stripe tests use signed fixtures and a simulated Checkout response. Report hosted readiness and any provider sandbox exercise separately. [Registration tests](../../tests/texting-onboarding.test.ts)
