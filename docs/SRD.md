# Flockletter software requirements

Version 0.1. Draft for product review. Updated November 6, 2026.

Flockletter is an open-source mailing SaaS for businesses that want to build permission-based audiences and send newsletters and announcements. The hosted service includes delivery and subscription management. Frosty Flamingo Apparel is the first intended customer; the product must operate independently for other businesses and for self-hosters.

The owner has approved the product identity, public repository, open self-service signup, included hosted delivery and AGPLv3. See [accepted decisions](DECISIONS.md). Requirements marked SHALL describe the proposed release-one contract; they are not a statement of existing functionality or authorization to implement it. Phase 1 permits documentation only. The owner must authorize implementation separately.

## Product outcomes

The first release should let a legitimate business create an account, understand its plan and limits, verify its sender, import an authorized audience, prepare and preview a campaign, and send or schedule it without routine operator assistance. Customers should be able to understand delivery results and manage billing themselves.

FFA should use these same customer capabilities through its administration UI and MCP. A successful product announcement must not change its commerce settings, product photography or fulfillment behavior. Other customers must receive equivalent isolation and control.

Success requires both the ordinary flow and failure handling: a payment redirect cannot grant access, a retry cannot create a second campaign, an unsubscribe must stop subsequent dispatch, and one customer's import or account failure must not expose another customer's records.

## Terms and people

| Term | Meaning |
| --- | --- |
| Workspace | One business customer's isolated account, also called a tenant. |
| Workspace owner | An authenticated member authorized to administer that business, its members and billing. |
| Editor or analyst | Proposed member roles for campaign work or reporting; exact capabilities are O-013. |
| Platform operator | A separately authorized Flockletter operator responsible for service operation and exceptional support. |
| Subscriber | A recipient with recorded mailing preferences and consent; not a SaaS login or paid subscription. |
| Hosted subscription | The business's recurring service plan, independent of subscriber consent. |
| Mailing engine | The component preparing and dispatching campaigns; Listmonk is the proposed initial implementation. |
| Delivery provider | The external service accepting outbound mail and returning delivery, bounce and complaint facts. |

## Release scope

Release one proposes public product/pricing pages; account signup and login; customer and platform administration; three fixed hosted subscription tiers; verified senders; subscriber import/export and forms; lists, basic segments, templates and media; previews, test sends, immediate and scheduled broadcasts; delivery reporting; and equivalent API/MCP operations. Account provisioning and included delivery must work for a new customer as well as FFA.

The following are deferred: discussion lists and inbound mailboxes; running a general-purpose public SMTP relay; SMS or push; branching customer journeys; abandoned-cart automation; AI-generated campaigns; purchased audience acquisition; agency resale; bespoke enterprise contracts; and automatic usage-overage billing. A feature offered by an upstream engine is not automatically part of Flockletter's public product.

## Product and open-source requirements

**FL-PROD-001 — Independent product.** Flockletter SHALL own its workspace, identity mappings, billing references and operational records. Its operation and self-hosted setup SHALL NOT require another application's database, credentials, source repository or private services.

**FL-PROD-002 — Open signup.** The hosted product SHALL allow public self-service account creation and workspace onboarding. Ordinary eligible customers SHALL NOT require an invitation or manual provisioning. Verification, risk holds and capacity delays SHALL have explicit reasons and recovery steps; open signup does not imply unrestricted sending.

**FL-PROD-003 — Public and portable source.** Original application, administration, API, MCP, billing and operational code SHALL be published under AGPLv3 with necessary build and deployment instructions. A self-hosted mode SHALL work with user-supplied infrastructure and delivery configuration without a Flockletter subscription. Private keys and customer data SHALL NOT be included.

**FL-PROD-004 — Commercial clarity.** Public pricing and onboarding SHALL explain included delivery, relevant limits, billing period, cancellation terms and sending prerequisites. Unimplemented features, guaranteed inbox placement and unmeasured service levels SHALL NOT be advertised as available.

## Customer journeys and administration

**FL-ONB-001 — Guided onboarding.** After signup, customers SHALL see durable progress for identity verification, workspace creation, plan/payment, sender setup and first campaign. Refreshes and retries SHALL resume existing work rather than create duplicate workspaces, subscriptions or sender registrations.

**FL-ONB-002 — Separate account states.** Provisioning, subscription, sender readiness and sending eligibility SHALL be represented separately. A paid account with an unverified domain SHALL receive sender-setup guidance rather than a false ready state. Provisioning failure after payment SHALL enter a visible recovery process under the approved commercial policy.

**FL-ONB-003 — Self-service billing and team management.** Authorized owners SHALL manage billing, invite/remove members and review plan usage. Ownership transfer SHALL preserve an accountable owner. Invitations and membership changes SHALL not create access to another workspace or silently exceed seat allowances.

**FL-ONB-004 — Consistent administration.** Customer UI, platform UI and API/MCP views SHALL show the same authoritative status, limits and blocked-action reasons. Customer administration SHALL expose only the active workspace. Platform support access SHALL be explicitly authorized and audited.

**FL-ONB-005 — Subscriber independence.** Newsletter signup, preference updates and unsubscribe SHALL not require a paid account or SaaS login. FFA shopping identities and purchases SHALL not establish Flockletter operator access or marketing consent.

## Identity and workspace isolation

**FL-ID-001 — Verified identity.** Use a reviewed authentication implementation with verified account ownership, recovery, session revocation and secure session handling. Customer and platform-operator authority SHALL be distinguishable and enforced on the server. Platform operator MFA is the proposed minimum. Authentication selection is O-003.

**FL-ID-002 — Server-derived workspace.** Resolve workspace access from authenticated membership or a valid delegated grant. A workspace ID supplied in a URL, body, header, upload or job SHALL never be sufficient authority. Enforce the boundary on every record lookup, action, export, asset and provider reference.

**FL-ID-003 — Layered data isolation.** Customer-owned application records SHALL carry workspace identity; uniqueness, references and database policies SHALL prevent cross-workspace associations. Runtime database identities SHALL not bypass that policy. P-002 separately proposes an isolated engine/database per customer; engine lists and tags SHALL not substitute for an approved customer-isolation design.

**FL-ID-004 — Capabilities and revocation.** Define separate view, edit, import/export, send/schedule, member administration and billing capabilities. Revoked memberships or grants SHALL reject new commands and prevent unexecuted authorized sends until reauthorized. Backend jobs SHALL revalidate the relevant sending authority and workspace state before dispatch.

**FL-ID-005 — Secret and operator boundaries.** Delivery credentials, billing keys and engine administrator tokens SHALL remain server-side. A tenant administrator SHALL not receive platform or engine-superuser credentials. Privileged support actions SHALL record actor, workspace, reason and outcome without recording secrets or message bodies unnecessarily.

## Hosted plans and billing

**FL-BIL-001 — One plan catalogue.** Three hosted tiers are the proposed baseline. Prices, currencies, allowances, enabled features and effective versions SHALL come from one server-owned catalogue used by UI, API, MCP and workers. Exact values and names require O-001; no allowance is unlimited by omission.

**FL-BIL-002 — Provider-held card details.** Use Stripe Billing with hosted Checkout and a customer billing portal as the proposed integration. Flockletter SHALL not collect or store raw card numbers or security codes. Store provider identifiers scoped to the Flockletter account and environment, not credentials or cross-application customer lookups.

**FL-BIL-003 — Verified payment lifecycle.** Signed, account/environment-checked provider events SHALL establish payment and subscription facts through a durable, deduplicated inbox. Handle renewals, failures, plan changes, cancellations and applicable refund/dispute/fraud events. Reconcile delayed, duplicate, out-of-order and unknown outcomes. A success-page visit SHALL never grant paid access. See [Stripe subscription events](https://docs.stripe.com/billing/subscriptions/webhooks).

**FL-BIL-004 — Money and purchase integrity.** Represent money as integer minor units with currency. Select allowed prices server-side and bind Checkout and portal sessions to the authorized workspace. Record stable operation keys before external mutations. Reject a price, customer or subscription belonging to another product, account or environment.

**FL-BIL-005 — Predictable access changes.** Document when upgrades, downgrades, trials, cancellations and payment failures affect sending. Retain essential billing, consent/unsubscribe and approved export access during sending suspension. Never silently delete excess contacts or members on downgrade. Exact grace, refund and proration behavior requires O-006.

**FL-BIL-006 — Paid-launch prerequisites.** Before accepting public paid subscriptions, approve the business identity, supported markets, terms and applicable tax registrations/configuration. If Stripe Tax is used, verify registrations and tax behavior rather than assuming a switch establishes collection. Keep Flockletter's setup separate from existing merchant configurations.

## Usage and cost control

**FL-USG-001 — Explicit units.** Define each allowance in customer-facing terms. Proposed send unit: one logical recipient-message accepted by the delivery provider, including later bounces, counted once. A recipient suppressed before submission or a rejected validation attempt does not consume that unit. Test messages sent to real recipients do; local captured mail does not. Contact, seat, domain and period definitions remain O-001.

**FL-USG-002 — Atomic reservation.** Reserve required allowance before accepting send work, with concurrency protection across UI, API and MCP. Settle reservations from observed outcomes, retaining unresolved reservations until reconciliation. Retrying a command or provider event SHALL not reset usage, charge it twice or bypass a cap.

**FL-USG-003 — Visible limits.** Display used, reserved and remaining allowance with the reset boundary. Block or pause work that cannot fit the current allowance and explain the available remedy. No automatic overage charge is proposed for release one. Enforcement SHALL occur server-side before provider spending.

**FL-USG-004 — Platform exposure.** Bound aggregate provisioning, delivery, media and compute spending separately from per-customer entitlements. Rate-limit signup, imports and sends; apply fair work scheduling so one customer cannot monopolize the shared service. Budget exhaustion or provider throttling SHALL produce a durable, visible state.

## Audiences and consent

**FL-AUD-001 — Subscriber lifecycle.** Support scoped lists, subscriber attributes and basic segments. Keep subscription, unconfirmed, unsubscribed, hard-bounce and complaint states distinct. Normalize and deduplicate addresses under a documented policy; do not merge unrelated mailboxes using guessed provider-specific alias rules.

**FL-AUD-002 — Evidence and forms.** Record consent source, time, purpose and relevant confirmation/version evidence. Provide signup and preference forms with abuse controls. A purchase, uploaded file or another brand's contact record alone SHALL not be treated as consent. Double opt-in and tracking defaults require O-010.

**FL-AUD-003 — Imports and exports.** Imports SHALL support a preflight summary, field mapping, size/row limits, duplicate/invalid-row reporting and an explicit permission-to-contact declaration. Process large work asynchronously and scope exports to authorized members. Retries SHALL not duplicate subscribers; reimport SHALL not erase suppression or consent history.

**FL-AUD-004 — Effective unsubscribe.** Provide a visible unsubscribe option and supported one-click unsubscribe handling for marketing mail. Persist the suppression before confirming success; recheck it before every future submission. Public unsubscribe endpoints SHALL be scoped, tamper-resistant and independent of paid access. Marketing content SHALL include the sender identity and disclosures required by the approved launch policy. See [mail sender guidance](https://support.google.com/mail/answer/81126).

**FL-AUD-005 — Data lifecycle.** Define export, correction, account deletion and retention behavior for subscriber, campaign, billing, audit and suppression records. Retain only what the approved policy requires, explain exceptions, and avoid re-enabling delivery after deleting unnecessary personal details. Data must not cross between customers or brands without valid authority and consent.

## Campaign creation and delivery

**FL-CAM-001 — Authoring.** Provide reusable templates, accessible editing, subject/from/reply-to fields, plain-text alternatives, preview and bounded media management. Validate message content and uploads, including active content, unsafe URLs and unsupported formats. Do not expose private attachment or engine-storage paths through public messages.

**FL-CAM-002 — Complete preflight.** Before requesting a send, report sender readiness, audience and exclusion counts, content errors, subscription access, consent/suppression checks, rate/usage limits and provider readiness. Missing critical checks SHALL block dispatch; a successful preview alone SHALL not imply delivery eligibility.

**FL-CAM-003 — Reviewed send intent.** An authorized send or schedule command SHALL identify the reviewed campaign version, sender, recipient snapshot, timing and maximum count. Changes to those inputs invalidate that authorization. Scheduling freezes the recipient set; later eligibility checks may remove recipients but SHALL not silently add new ones. UI and MCP SHALL expose the same review and confirmation semantics.

**FL-CAM-004 — Durable lifecycle.** Persist draft, scheduled, preparing, sending, paused, completed, canceled and failed/reconciliation states as appropriate. Restarting processes SHALL not lose work or duplicate the schedule. Pause/cancel stops future provider submissions; the UI SHALL explain that already accepted messages cannot be recalled.

**FL-CAM-005 — Recipient outcome integrity.** Assign stable campaign-recipient operation keys and persist dispatch intent. Reconcile ambiguous provider acceptance before retrying. Do not claim exactly-once delivery when a provider cannot establish it; show an unresolved state and a safe recovery path instead of blindly resending.

**FL-CAM-006 — Eligibility at execution.** Immediately before provider submission, recheck workspace/subscription eligibility, send authority, sender verification, current suppression and remaining reserved budget. Expired, revoked or invalid work SHALL stop with an actionable reason. Marketing jobs SHALL not be used for unrelated retail fulfillment or payment operations.

**FL-CAM-007 — Honest reporting.** Separate queued, submitted, provider-accepted, delivered, bounced, complained and unsubscribed outcomes. Explain that open/click measurements can be incomplete or affected by client behavior. Respect tracking configuration and retention; show freshness and incomplete provider feedback rather than fabricated success.

## Included delivery and abuse controls

**FL-DEL-001 — Managed delivery.** The standard hosted subscription SHALL include outbound delivery through a selected provider. Customers SHALL not need provider credentials. Self-hosters may configure their own delivery connection. Provider selection must establish real production access, costs, rate limits, feedback and tenant attribution before launch.

**FL-DEL-002 — Verified sending identity.** Guide customers through domain ownership and sender setup; verify the required SPF, DKIM, DMARC and return-path configuration for the selected provider and policy. Require verified sending identity before external campaigns. Revocation or loss of eligibility SHALL block future submission without silently switching to another customer's sender.

**FL-DEL-003 — Trust and reputation.** Open signup SHALL include verification, initial sending limits, rate controls and risk-based suspension/review. A payment alone SHALL not authorize arbitrary bulk mail. Define acceptable use and complaint/bounce responses before launch. Apply holds to affected workspaces and prevent reputation spillover as far as the selected provider's architecture supports.

**FL-DEL-004 — Authenticated feedback.** Verify delivery webhooks using provider-supported authentication, deduplicate them and resolve the owning workspace from trusted mappings. Missing authentication requires authoritative reconciliation before changing eligibility. Complaints and hard bounces SHALL suppress future applicable mail; repeated or out-of-order feedback SHALL not undo suppression.

**FL-DEL-005 — Transport-independent enforcement.** All actual sends SHALL pass through the approved usage, suppression and provider controls, including engine retries and direct API paths. Before implementation, validate where Listmonk can enforce these checks; treat missing adapter/hooks as a design gap requiring review. Do not expose an unguarded engine send endpoint behind a billing-aware dashboard.

## API MCP and FFA integration

**FL-API-001 — Shared commands.** UI, HTTP API and MCP SHALL call canonical domain operations with the same validation, permissions, state transitions, operation keys and audit records. No transport SHALL grant broader access or permit side effects through a nominally read-only command.

**FL-API-002 — Delegated grants.** Define workspace-scoped, revocable credentials with distinct read, draft, import/export, asset and send/schedule capabilities. Credential issuance, storage, rotation and consent SHALL be reviewed before implementation. Backend authority SHALL not be inferred from a tool prompt, uploaded document or arbitrary callback URL.

**FL-API-003 — Practical campaign workflow.** Provide inspect/preflight, draft, audience selection, media/template management, preview/test, send/schedule and status/report operations. Return blocking gaps together before expensive preparation. Support batch operations with per-item results and safe retry behavior; do not make customers repeat successful items after partial failures.

**FL-API-004 — FFA integration.** FFA SHALL be an ordinary isolated customer workspace. Its integration may create a campaign draft from approved published product data and authorized photo references. It SHALL NOT alter product photography, catalog content, prices, availability, checkout, payments or manufacturing settings. Publishing a product SHALL not automatically send a marketing campaign.

**FL-API-005 — Independent permissions and consent.** FFA integration SHALL use an explicitly scoped Flockletter grant; an existing commerce/catalog grant is not newsletter-send authority. Transfer only authorized data and consent changes. Define one authoritative preference/suppression path and reconciliation behavior before integration, without cross-application database joins.

## Data hosting and service operation

The proposed topology is a standalone SaaS portal/API with durable control jobs, a protected mailing engine per customer, a delivery provider and a logical Flockletter application database. Existing PostgreSQL hardware may host these databases. The FFA admin entry point uses the SaaS integration; other businesses use the independent Flockletter dashboard. Exact process layout and authentication provider remain open.

**FL-OPS-001 — Shared infrastructure boundaries.** Use dedicated logical databases and restricted runtime/migration identities. Inspect effective privileges, including inherited grants, rather than relying on role names. No Flockletter runtime SHALL access another application's business records or own its schema. Existing shared roles/settings SHALL not be changed without the applicable separate authorization.

**FL-OPS-002 — Capacity before activation.** Establish connection, CPU, memory, disk, query, import and worker budgets including deployment overlap and per-customer engines. Measure the existing host's headroom before activation. A new signup SHALL not allocate unbounded paid resources; provisioning requires bounded durable work and recorded outcomes. Define an extraction path to dedicated infrastructure.

**FL-OPS-003 — Durable operations.** Persist external intents, queue leases, attempts and reconciliation state. Migrations SHALL run under guarded release authority, separate from routine runtime privileges. Critical configuration omissions SHALL fail closed. Credentials and operational data SHALL not depend on an ephemeral application filesystem.

**FL-OPS-004 — Environment separation.** Local and CI tests SHALL use disposable data. Staging SHALL use isolated billing test environments, credentials, logical databases and captured mail or a fixed approved recipient allowlist. Production customer lists and delivery credentials SHALL not be copied into ordinary previews. Code deployment and live campaign sending are separate authorizations.

**FL-OPS-005 — Recovery and monitoring.** Monitor onboarding failures, queue lag, payment-event processing, provider feedback, send usage, abuse indicators and shared resource budgets. Define numeric alert, retention and recovery targets before service commitments. Test a tenant/logical-database restore into an isolated destination without overwriting the shared live instance; reconcile external facts before restarting sends.

**FL-OPS-006 — Browser and operational safety.** Apply secure session/origin checks, least privilege, bounded uploads and imports, signed/scoped asset access, dependency review and redacted logs. Core customer flows SHALL support keyboard use, clear validation and accessible status messages. Review storage, mail rendering and provider callbacks as untrusted boundaries.

**FL-OPS-007 — Public delivery readiness.** Before enabling paid public operation, demonstrate account isolation, billing lifecycle, provider/DNS setup, suppression, capacity, recovery and operator response using the planned acceptance cases. Document remaining gaps honestly. A passing mock is not proof of live provider behavior or deliverability.

## Three proposed hosted tiers

All tiers include the core consent, suppression, secure access, billing visibility and permitted export controls. Hosted limits may differ while the source for all tiers remains open.

| Working name | Proposed emphasis | Values still required |
| --- | --- | --- |
| Starter | One business brand; essential newsletters and reports | Price, contacts, sends, seats, sender domains and support scope |
| Growth | More volume and team collaboration | Price, allowances, approval workflow scope and reporting differences |
| Pro | Larger allowances and expanded operational support | Price, allowances, multi-brand boundaries and support commitments |

Price each tier against delivery at full included usage, engine/provisioning compute, database/storage, authentication, billing fees, abuse reserves and support. No advertised price or numeric capacity is approved in draft 0.1. See O-001 through O-013 in [decisions](DECISIONS.md).

## Records and authority

Conceptual records include workspace, membership, delegated grant, sender domain, subscriber/consent, list/segment, template/media, campaign/version, recipient dispatch, subscription, usage reservation/ledger, provider mapping, job/inbox and audit. This is a requirements inventory, not a database schema or migration.

Flockletter's application database owns access, limits, intended operations and audit. Stripe owns payment/subscription facts; the delivery provider owns its acceptance and delivery facts. The engine owns its campaign execution facts behind the adapter. Document the field-level ownership and synchronization contract before implementation so two systems cannot independently overwrite consent or usage.

## Verification and phase gates

The [traceability matrix](TRACEABILITY.md) maps every requirement to a planned acceptance case. No test evidence exists in phase 1. For later implementation, verify unit/domain invariants, real database isolation/concurrency, provider contracts and end-to-end browser/API/MCP parity with focused tests appropriate to the change.

Before starting a dependent workstream, resolve the relevant open decisions and record its requirement IDs, adapter contracts and test plan. Before staged acceptance, use two synthetic customer workspaces, not just FFA, to test isolation and failure paths. External mail checks must use only approved recipients. Billing checks must use test environments until separately authorized.

The [phase 1 review](PHASE_1.md) defines the documentation completion gate. Approval of the SRD alone does not deploy a service or send messages. No application build is authorized by this document.

## References

See [source references](SOURCES.md) for public upstream documentation and the limits of what it establishes. Existing private application designs inform only the reviewed-reuse process described in [reuse review](REUSE_REVIEW.md); their code and infrastructure details are not published here.
