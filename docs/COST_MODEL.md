# Flockletter launch pricing and cost model

Updated November 6, 2026. Plan prices, recipient limits, trial limits and Clerk-owned hosted memberships are accepted owner decisions D-024–D-026. Dollar amounts below are USD. Infrastructure sizing, provider activation and spending are not authorized by this planning document.

## Accepted catalogue

| Item | Tier 1 | Tier 2 | Tier 3 |
| --- | ---: | ---: | ---: |
| Monthly subscription | $15 | $25 | $39 |
| Price in cents | 1500 | 2500 | 3900 |
| Active contacts / maximum recipients per campaign | 2,500 | 5,000 | 10,000 |
| Campaigns per month | 2 | 5 | 20 |
| Recipient emails per month | 5,000 | 25,000 | 100,000 |
| Companies / total brands | 1 / 1 | 3 / 3 | 5 / 5 |
| Users | 1 | 3 | Unlimited |

Allowances are pooled across the subscription. All limits apply together. One campaign to 2,500 addresses uses one campaign slot and 2,500 recipient emails. Duplicate list memberships do not create additional contacts; separate brand consent still applies. Sending the same address one email from each of two brands consumes two emails. Real test emails also consume allowance.

Tier 3 can send ten full-audience campaigns to 10,000 contacts or twenty targeted campaigns averaging 5,000 recipients within its 100,000-email ceiling. It does not include twenty full-audience sends. No automatic overage billing is in the MVP.

The card-required trial is 14 days with 250 active contacts and 500 total recipient emails across the complete trial. Trial campaign/seat/company/brand limits and the transition to paid usage are unresolved; no unlimited entitlement is implied. FFA's separately issued complimentary entitlement bypasses Stripe/card and is not a trial. Its assigned tier remains unresolved.

## Direct cost assumptions at full allowance

| Component per paid workspace per month | Tier 1 | Tier 2 | Tier 3 |
| --- | ---: | ---: | ---: |
| Delivery budget at $0.20 per 1,000 recipient emails | $1.00 | $5.00 | $20.00 |
| Separate Render mailing-service assumption | $7.00 | $7.00 | $7.00 |
| Stripe processing plus Billing, rounded to cents | $0.84 | $1.20 | $1.70 |
| Small operating reserve | $1.00 | $1.00 | $1.00 |
| **Estimated direct costs** | **$9.84** | **$14.20** | **$29.70** |
| **Contribution toward shared costs and overhead** | **$5.16** | **$10.80** | **$9.30** |

Arithmetic uses integer cents or exact decimal calculations. Payment assumption: standard domestic card processing at 2.9% + $0.30 plus Stripe Billing at 0.7%, producing 3.6% + $0.30 per successful monthly payment. This excludes other products, taxes, international-card/currency costs, disputes, refunds and failed-payment economics. [Stripe payments](https://stripe.com/pricing), [Stripe Billing](https://stripe.com/billing/pricing).

Delivery is budgeted conservatively at $0.20/1,000. SES currently lists $0.10/1,000 outbound emails under à la carte or $0.16/1,000 under Essentials, with applicable data/other charges. New-account defaults and optional features affect the actual bill. The planning budget is not an SES quote or provider selection; production approval, feedback, tenant attribution, reputation and quota design remain open. Dedicated-IP services and paid higher-tier features are not included. [SES pricing](https://aws.amazon.com/ses/pricing/).

The $7 mailing service is a per-subscription compute assumption for the proposed isolated Listmonk engine, not per brand and not a measured capacity guarantee. Import volume, engine memory, database connections, concurrency, storage, rollout overlap and sender throughput must be tested before activation. A failed fit requires a revised architecture/cost review, not silently weakened isolation. [Render pricing](https://render.com/pricing).

## Shared monthly planning budget with Clerk memberships

| Shared item | Approximate monthly allowance |
| --- | ---: |
| Production portal/worker, database capacity/storage and workspace plan | $80 |
| Separate staging capacity | $30 |
| Clerk base authentication allowance | $25 |
| Clerk Enhanced B2B for unlimited organization members | $100 |
| Complimentary FFA allowance and miscellaneous capacity | $15 |
| **Rounded shared planning budget** | **$250** |

Clerk is the accepted authority for all hosted logins and workspace memberships. The cheaper alternative of custom workspace memberships is not selected. At the reviewed rates, standard Clerk Organizations supports up to 20 members per organization; Enhanced B2B is $100/month on monthly billing and permits unlimited members. It includes 100 monthly retained organizations, then additional usage charges; authentication usage and other add-ons can also increase costs. Subscribers receiving newsletters are not Clerk login users. Recheck provider terms before implementation and purchase. [Clerk pricing](https://clerk.com/pricing).

The shared Render allowance is a planning envelope, not a statement that every resource must be newly purchased or that an existing database has spare capacity. It assumes roughly $25 web compute, $7 worker, $19 database compute, $3 storage and $25 workspace-plan capacity, rounded to $80; staging is rounded to $30. Existing-app bills must not be reclassified as Flockletter direct costs. Validate actual incremental capacity before deciding topology. No private resource identifiers or account credentials are published here.

At a modeled paying-customer mix of 60% Tier 1, 30% Tier 2 and 10% Tier 3, all consuming their full email allowance, weighted contribution is about $7.266 per workspace monthly. $250 / $7.266 rounds up to **35 paying workspaces** for infrastructure break-even. A 21/10/4 mix at 35 customers yields about $253.56 in contribution. This is not total business profitability: development, substantial human support, trial acquisition volume, taxes, refunds/disputes and larger capacity upgrades are outside this estimate. The $1 direct reserve does not fund unlimited support.

FFA contributes no subscription revenue and still consumes compute/delivery. A first-customer-only pilot must be owner-funded. A broader launch budget must separately bound aggregate trial provisioning and sending, reserve capacity, and provider spending before signup opens.

## Competitor evidence and limits

Monthly USD calculator values reviewed November 6, 2026, without annual or promotional discounts:

| Paid plan | 2,500 contacts | 5,000 contacts | 10,000 contacts |
| --- | ---: | ---: | ---: |
| Flockletter accepted prices | $15 | $25 | $39 |
| [EmailOctopus Pro](https://emailoctopus.com/pricing) | $20 | $31.50 | $44.50 |
| [Sender Standard](https://www.sender.net/pricing/) | $27 | $39 | $69 |
| [MailerLite Comfort](https://www.mailerlite.com/pricing) | $33 | $49 | $89 |

Contact counts alone are not a complete equivalence. These providers may include more monthly sends, automations and other features; EmailOctopus and Sender also offer free plans at 2,500 contacts. Do not advertise universal lowest pricing or feature parity. Recheck current pricing and matching allowances before publishing a comparative marketing claim.

## Unresolved cost and policy gates

- Final delivery provider, account approval, reputation architecture and any dedicated-IP requirement.
- Measured Render capacity, connection limits, storage ceilings and actual launch funding.
- Billing anchors/rollover, cumulative active-contact counting, pending-invitation seat counting and trial-to-paid accounting.
- Trial campaign/seat/company/brand caps and explicit test-send recipient/rate limits.
- Annual billing/discount, refunds and final proration/failed-payment policy.
- AI support provider, response limits, human escalation and its operating budget.

These gaps are visible in the SRD and design artifacts. They must be resolved before dependent implementation; the accepted numeric plan prices are not reopened by displaying these remaining gates.
