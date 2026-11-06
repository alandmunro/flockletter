# Flockletter product decisions

Updated November 6, 2026. Accepted decisions below reflect the owner's instructions. Proposed choices are review items, not implementation authority. No runtime implementation or infrastructure activation is authorized.

## Accepted decisions

| ID | Decision | Basis |
| --- | --- | --- |
| D-001 | Name the product Flockletter and the GitHub repository `flockletter`. | Owner selected the name and repository slug. |
| D-002 | Make `alandmunro/flockletter` public from the start. | Explicit repository instruction. |
| D-003 | Define an independent mailing SaaS with Frosty Flamingo Apparel as the first intended customer, while permitting other customers. | Owner's SaaS direction and first-customer scope. |
| D-004 | Phase 1 covers product definition, the SRD and supporting planning documents only. | Owner: no building yet. |
| D-005 | The eventual hosted product offers open self-service signup. | Owner selected open signup over invited pilots. |
| D-006 | Hosted subscriptions include email delivery. Customers do not have to bring a delivery provider for the standard hosted service. | Owner selected included delivery. |
| D-007 | Use AGPLv3 for Flockletter's original material, expressed as AGPL-3.0-only in this repository. Preserve upstream licenses. | Owner selected AGPLv3. |
| D-008 | Plan for reuse of existing hosting capacity where isolation and capacity checks permit it. | Owner's shared-infrastructure direction; no capacity or account changes are approved by this decision. |

Open signup describes the intended launched product. The public documentation repository does not currently provide signup, a paid service or email delivery.

## Proposed baseline

These choices shape SRD draft 0.1 and remain subject to owner review.

| ID | Proposal | Reason and consequence |
| --- | --- | --- |
| P-001 | Use Listmonk behind an engine adapter. | Reuse campaign functionality while keeping SaaS accounts, billing, access and usage enforcement in Flockletter. Pin and review a supported release before implementation. |
| P-002 | Isolate each hosted customer's mailing engine and its database. | Avoid treating Listmonk lists as customer boundaries. This has per-customer resource and provisioning costs that must fit the price model. |
| P-003 | Use a separate SaaS application database on the shared PostgreSQL instance, with tenant-scoped access and database enforcement for customer-owned records. | The control application needs memberships, subscription state, usage, jobs and audit independently of mailing-engine storage. |
| P-004 | Use Stripe Billing, hosted Checkout and the Customer Portal for fixed subscriptions. | Reduce custom payment handling. Use separate Flockletter resource mappings, credentials and verified event handling. No existing merchant settings or subscriptions are changed. |
| P-005 | Start with three hosted tiers, provisionally Starter, Growth and Pro. | Differentiate capacity, team allowances and operational features. Prices and numeric allowances are not decided. |
| P-006 | Serve FFA's Mailings entry point through a small integration with the independent SaaS. | Reuse reviewed UI components and public APIs without a runtime dependency on private commerce code. Separate sending processes from shopping requests. |
| P-007 | Start with scheduled broadcasts and permission-based audiences. | Branching customer journeys, abandoned-cart automation and additional messaging channels are later work. |
| P-008 | Keep hosted product code and self-hosting capabilities open source. | Self-hosters do not need the owner's private systems or a Flockletter subscription; they provide their own infrastructure and delivery connection. |

## Decisions still needed

| ID | Decision to resolve | Proposed starting point | Needed before |
| --- | --- | --- | --- |
| O-001 | Tier prices, currency, contact/send/seat/domain allowances, feature differences and commercial margin | Three fixed plans with clear included allowances; no automatic overage charges in the first release | Billing and quota implementation |
| O-002 | Delivery provider and per-customer reputation isolation | A provider supporting verified domains, signed feedback, tenant attribution, documented rate limits and delivery cost reporting | Delivery implementation |
| O-003 | Authentication implementation and self-hosted option | Provider-backed identity with MFA for platform operators; no dependency on another application's identity records | Identity implementation |
| O-004 | Engine version, isolation shape, provisioning strategy and compute budget | P-001/P-002, assessed at one customer and a defined small launch cohort | Engine implementation |
| O-005 | Exact hosting topology and ownership of any extracted UI components | Shared database server with restricted logical databases; independently deployable SaaS and mail engine | Deployment design |
| O-006 | Trial, refunds, cancellation, proration and failed-payment grace policy | No assumed free trial; self-service cancellation; preserve data and unsubscribe access during sending suspension | Billing implementation and terms |
| O-007 | Sender onboarding, initial trust limits, escalation and acceptable-use policy | Open signup with verified identity/domain, bounded sending and risk-based review of exceptions | Sending implementation |
| O-008 | Primary launch countries, business identity, legal documents and tax registrations | Choose explicitly before paid public launch; configure Stripe Tax where applicable | Public paid launch |
| O-009 | Data residency, retention, deletion, backup coverage and recovery targets | Minimum necessary data, separate logical recovery and a documented exit path | Data-lifecycle implementation |
| O-010 | Tracking defaults, double opt-in policy and signup-form consent presentation | Tracking off and double opt-in on as review defaults; no claim that these alone establish legal compliance | Subscriber and analytics implementation |
| O-011 | FFA integration contract and account treatment | FFA uses the same workspace and permission paths as other customers; explicitly choose a paid or recorded internal plan | FFA integration implementation |
| O-012 | Expected launch load, response-time targets and support commitments | Measure before promising service levels; include shared-database and per-engine connection costs | Capacity acceptance and commercial publication |
| O-013 | Exact initial role/capability matrix and approval policy | Owner, editor, analyst and separate platform operator; send permission explicitly granted | Authorization implementation |

The owner can resolve these incrementally. Missing decisions must be exposed before dependent implementation starts; they are not defaults that an agent may silently fill during deployment.

## Change record

| Date | Change |
| --- | --- |
| 2026-11-06 | Established the product name, public-repository scope and phase 1 boundary; recorded open signup, included delivery and AGPLv3 choices; created the first draft requirements and review gates. |
