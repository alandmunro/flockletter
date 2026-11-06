# Flockletter source references

Public references reviewed for the phase 1 proposal on November 6, 2026. Provider documentation can change; recheck the selected version and account capabilities before implementation. References establish documented interfaces, not a deployed integration, security certification or a capacity measurement.

| Reference | What it informs | Limit |
| --- | --- | --- |
| [Listmonk APIs](https://listmonk.app/docs/apis/apis/) | Dashboard functionality is exposed through JSON HTTP APIs, supporting an adapter approach. | API availability does not prove quota enforcement on internal send/retry paths. |
| [Listmonk roles and permissions](https://listmonk.app/docs/roles-and-permissions/) | List and feature permissions, including permissions that override list-level restrictions. | These controls do not establish the proposed business-customer boundary without design and testing. |
| [Listmonk bounce processing](https://listmonk.app/docs/bounces/) | Bounce feedback interfaces and configuration. | The chosen provider's signatures, complaint handling and tenant mappings still need validation. |
| [Stripe subscription integration](https://docs.stripe.com/billing/subscriptions/build-subscriptions) | Billing integration with hosted payment collection. | No account, price, payment or subscription is created by this specification. |
| [Stripe Customer Portal](https://docs.stripe.com/customer-management) | Customer-managed payment details, invoices and supported subscription actions. | Actual actions depend on the subscription and portal configuration. |
| [Stripe subscription events](https://docs.stripe.com/billing/subscriptions/webhooks) | Asynchronous billing events and verification requirements. | A browser return is not evidence of payment; local access policies remain product decisions. |
| [Stripe trial documentation](https://docs.stripe.com/billing/subscriptions/trials) | Trial lifecycle and the distinction between current trial-offer APIs and subscription free-trial periods. | Integration availability differs by API and Checkout flow; select a supported card-required flow before implementation rather than assuming every trial feature is generally available. |
| [Stripe recurring-payment taxes](https://docs.stripe.com/billing/taxes/collect-taxes) | Tax integration planning. | Registration, market and collection choices require separate determination before paid launch. |
| [Clerk Google connection](https://clerk.com/docs/guides/configure/auth-strategies/social-connections/google) | Google signup/sign-in and separate development/production configuration. | Development credentials do not verify the final production connection or account-linking policy. |
| [Clerk Apple connection](https://clerk.com/docs/guides/configure/auth-strategies/social-connections/apple) | Apple sign-in, developer-account configuration and private-relay setup. | Provider selection does not create the required production application configuration or verify relay delivery. |
| [Render PostgreSQL databases](https://render.com/docs/postgresql-creating-connecting#adding-multiple-databases-to-a-single-instance) | Multiple logical databases can share a PostgreSQL instance. | This does not establish spare capacity, effective role isolation or independent recovery. |
| [GNU AGPLv3](https://www.gnu.org/licenses/agpl-3.0.html) | Selected source license and network-source obligations. | Reused material requires its own provenance and compatibility review. |
| [Google email sender guidelines](https://support.google.com/mail/answer/81126) | Sender authentication, transport, unsubscribe and reputation requirements relevant to delivery design. | Other recipients/providers have their own rules; correct configuration does not guarantee inbox placement. |

Private application source is not reproduced or linked as a public dependency. Candidate patterns and the review needed before code reuse are described in [the reuse inventory](REUSE_REVIEW.md).

Pricing evidence for the accepted catalogue and planning assumptions is recorded in [the cost model](COST_MODEL.md), including Render, SES, Clerk memberships, Stripe Billing/processing and dated paid-plan comparisons. Vendor rates are not spending authorization or live integration evidence. Cadence visual styling is adapted only for the owner-authorized prototype; its provenance and scope are described in [the design system](design/DESIGN_SYSTEM.md).
