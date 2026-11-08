# Flockletter software requirements

Version 0.6. Release requirements with an authorized foundation workstream. Updated November 7, 2026. D-040 records the preferred delivery provider for evaluation.

Flockletter is an open-source mailing SaaS for small retailers and general small businesses that want to build permission-based audiences and send newsletters and announcements. Large enterprises are outside its target market. The hosted service includes delivery and subscription management. Frosty Flamingo Apparel is the first intended customer, with complimentary service; the product must operate independently for other businesses and for self-hosters.

The owner has selected open self-service signup, included delivery, three tiers, a 14-day card-required trial, Clerk for all hosted logins and workspace memberships, Listmonk, Stripe, Render hosting and AGPLv3. The accepted launch sign-in options are Google, Apple, Microsoft, and email with a one-time verification code. Additional accepted policies and unresolved details are recorded in [decisions](DECISIONS.md). Requirements marked SHALL describe the proposed release-one contract; they are not a statement of existing functionality or authorization to implement it. D-030 now authorizes the bounded foundation in [the implementation plan](implementation/FOUNDATION.md) and staging verification. The prior mockups remain design artifacts. Implementation authorization does not claim completion of the full release or authorize production, live mailing or paid activation.

## Product outcomes

The later D-044 authorizes Flockletter production and staging code parity. It supersedes the earlier staging-only deployment scope above; provider activation, policy decisions and live verification remain separate requirements. See the [release checklist](implementation/RELEASE_PARITY.md).

The first release should let a legitimate business create an account, understand its plan and limits, verify its sender, import an authorized audience, prepare and preview a campaign, and send or schedule it without routine operator assistance. Customers should be able to understand delivery results and manage billing themselves.

FFA should use these same customer capabilities through its administration UI and MCP. A successful product announcement must not change its commerce settings, product photography or fulfillment behavior. Other customers must receive equivalent isolation and control.

Success requires both the ordinary flow and failure handling: a payment redirect cannot grant access, a retry cannot create a second campaign, an unsubscribe must stop subsequent dispatch, and one customer's import or account failure must not expose another customer's records.

## Terms and people

| Term | Meaning |
| --- | --- |
| Workspace | A customer's isolated account, also called a tenant. One subscription or complimentary entitlement covers its permitted companies and brands with shared allowances. |
| Company | A business entity managed within an account; company count and brand count are distinct allowances. |
| Brand | A named sending identity with its own sender, audience purpose, consent and assets. A company may own more than one brand; exact membership rules are O-013. |
| Workspace owner | An authenticated member authorized to administer the account, its members and billing. |
| Editor or analyst | Proposed member roles for campaign work or reporting; exact capabilities are O-013. |
| Platform operator | A separately authorized Flockletter operator responsible for service operation and exceptional support. |
| Subscriber | A recipient with recorded mailing preferences and consent; not a SaaS login or paid subscription. |
| Hosted subscription | The customer's recurring paid service plan, independent of subscriber consent. A recorded complimentary entitlement is a separate source of service access. |
| Campaign | A reviewed newsletter or announcement sent or scheduled to a defined audience. Campaign allowance and individual recipient-message allowance are separate units. |
| Mailing engine | The component preparing and dispatching campaigns; Listmonk is selected, subject to adapter validation. |
| Delivery provider | The external service accepting outbound mail and returning delivery, bounce and complaint facts. |

## Release scope

Release one is an MVP. It proposes public product/pricing pages; account signup and login; customer and platform administration; three hosted tiers; verified senders; subscriber import/export and confirmation forms; lists, basic segments, a Flockletter-branded visual Newsletter Studio with templates and media; previews, test sends, immediate and scheduled broadcasts; basic delivery reporting; email support with AI replies; and equivalent API/MCP operations. Account provisioning and included delivery must work for a new paying customer as well as complimentary FFA.

The following are deferred: discussion lists and inbound mailboxes; running a general-purpose public SMTP relay; SMS or push; branching customer journeys; abandoned-cart automation; AI-generated campaigns; purchased audience acquisition; agency resale; bespoke enterprise contracts; and automatic usage-overage billing. A feature offered by an upstream engine is not automatically part of Flockletter's public product.

## Product and open-source requirements

**FL-PROD-001 — Independent product.** Flockletter SHALL own its workspace, identity mappings, billing references and operational records. Its operation and self-hosted setup SHALL NOT require another application's database, credentials, source repository or private services.

**FL-PROD-002 — Open signup.** The hosted product SHALL allow public self-service account creation and workspace onboarding. Ordinary eligible customers SHALL NOT require an invitation or manual provisioning. Verification, risk holds and capacity delays SHALL have explicit reasons and recovery steps; open signup does not imply unrestricted sending.

**FL-PROD-003 — Public and portable source.** Original application, administration, API, MCP, billing and operational code SHALL be published under AGPLv3 with necessary build and deployment instructions. A self-hosted mode SHALL work with user-supplied infrastructure and delivery configuration without a Flockletter subscription. Private keys and customer data SHALL NOT be included.

**FL-PROD-004 — Commercial clarity.** Public pricing and onboarding SHALL explain included delivery, relevant limits, billing period, cancellation terms and sending prerequisites. Unimplemented features, guaranteed inbox placement and unmeasured service levels SHALL NOT be advertised as available.

**FL-PROD-005 — Third-party editor licensing and customer branding.** A visual editor integrated into Flockletter SHALL permit commercial SaaS use, modification, Flockletter branding and independent self-hosting under its actual installed license and dependency terms. The preferred candidate is Resend's `@react-email/editor` (published as MIT-licensed), not the separately maintained `react-email-editor` wrapper for Unlayer. Before incorporating a specific version, verify its distributed license and all transitive licenses, bundled assets, trademark/branding rules and external-service dependencies; preserve required upstream copyright and permission notices in distributed source and third-party notice material. Keep Flockletter's original code AGPL-3.0-only. Under the candidate MIT terms, no React Email logo, attribution footer or "powered by" message is required in the customer-facing editor or outbound newsletters; this does not waive retained copyright notices in distributed copies or independent obligations for imported assets, fonts, templates or other software. Record the final version and license evidence before implementation.

The pricing objective is inexpensive service below major competitors and most smaller competitors for comparable use. The owner approved monthly USD prices of $15, $25 and $39 and the recipient limits below after a cost review. Competitor comparisons must disclose different send allowances, features and free plans; no universal cheapest-service claim is approved. [Cost assumptions](COST_MODEL.md) are planning estimates, not measured operating costs or permission to purchase services.

## Customer journeys and administration

**FL-ONB-001 — Guided onboarding.** After signup, customers SHALL see durable progress for identity verification, workspace creation, plan/payment, sender setup and first campaign. Refreshes and retries SHALL resume existing work rather than create duplicate workspaces, subscriptions or sender registrations.

**FL-ONB-002 — Separate account states.** Provisioning, subscription, sender readiness and sending eligibility SHALL be represented separately. A paid account with an unverified domain SHALL receive sender-setup guidance rather than a false ready state. Provisioning failure after payment SHALL enter a visible recovery process under the approved commercial policy.

**FL-ONB-003 — Self-service billing and team management.** Authorized owners SHALL manage billing, invite/remove members and review plan usage. Ownership transfer SHALL preserve an accountable owner. Invitations and membership changes SHALL not create access to another workspace or silently exceed seat allowances.

**FL-ONB-004 — Consistent administration.** Customer UI, platform UI and API/MCP views SHALL show the same authoritative status, limits and blocked-action reasons. Customer administration SHALL expose only the active workspace. Platform support access SHALL be explicitly authorized and audited.

**FL-ONB-005 — Subscriber independence.** Newsletter signup, preference updates and unsubscribe SHALL not require a paid account or SaaS login. FFA shopping identities and purchases SHALL not establish Flockletter operator access or marketing consent.

## Identity and workspace isolation

**FL-ID-001 — Verified identity.** All hosted user authentication, including customer and platform-operator logins, SHALL use Clerk. The launch methods are Google, Apple, Microsoft, and email with a one-time verification code. Support verified account ownership, recovery, session revocation and secure session handling. Clerk Organizations SHALL be authoritative for hosted workspace membership and invitations; Flockletter SHALL NOT create a competing membership identity service. Company/brand capability records may narrow access inside an existing Clerk membership. Membership changes must be verified and reconciled, and revoked authority must not survive a stale local projection. Clerk membership does not establish paid access or send permission. Subscriber signup/preferences/unsubscribe remain login-free under FL-ONB-005. Use Flockletter-owned configuration rather than another application's identities or credentials. Customer and platform-operator authority SHALL be distinguishable and enforced on the server. Platform operator MFA is the proposed minimum. The four launch methods are accepted in D-028; password-based login and additional social providers are outside the launch selection. Production OAuth and email-code configuration, account linking, recovery safeguards and customer MFA are O-003; social login alone grants no workspace or sending authority.

**FL-ID-002 — Server-derived workspace.** Resolve workspace access from authenticated membership or a valid delegated grant. A workspace ID supplied in a URL, body, header, upload or job SHALL never be sufficient authority. Enforce the boundary on every record lookup, action, export, asset and provider reference.

**FL-ID-003 — Layered data isolation.** Customer-owned application records SHALL carry workspace identity; uniqueness, references and database policies SHALL prevent cross-workspace associations. Runtime database identities SHALL not bypass that policy. P-002 separately proposes an isolated engine/database per customer; engine lists and tags SHALL not substitute for an approved customer-isolation design.

**FL-ID-004 — Capabilities and revocation.** Define separate view, edit, import/export, send/schedule, member administration and billing capabilities. Revoked memberships or grants SHALL reject new commands and prevent unexecuted authorized sends until reauthorized. Backend jobs SHALL revalidate the relevant sending authority and workspace state before dispatch.

**FL-ID-005 — Secret and operator boundaries.** Delivery credentials, billing keys and engine administrator tokens SHALL remain server-side. A tenant administrator SHALL not receive platform or engine-superuser credentials. Privileged support actions SHALL record actor, workspace, reason and outcome without recording secrets or message bodies unnecessarily.

## Hosted plans and billing

**FL-BIL-001 — One plan catalogue.** The three hosted tiers SHALL use one server-owned catalogue for prices, currencies, allowances, enabled features and effective versions, shared by UI, API, MCP and workers. The tier table below distinguishes accepted values from open ones. Tier 3 users are explicitly unlimited; other missing values SHALL NOT become unlimited by omission. Changing a plan SHALL not reset already consumed usage.

**FL-BIL-002 — Provider-held card details.** Stripe is selected for ordinary hosted subscriptions; Billing, hosted Checkout and a customer billing portal are the proposed integration. Flockletter SHALL not collect or store raw card numbers or security codes. Store provider identifiers scoped to the Flockletter account and environment, not credentials or cross-application customer lookups. Complimentary accounts use FL-BIL-008.

**FL-BIL-003 — Verified payment lifecycle.** Signed, account/environment-checked provider events SHALL establish payment and subscription facts through a durable, deduplicated inbox. Handle renewals, failures, plan changes, cancellations and applicable refund/dispute/fraud events. Reconcile delayed, duplicate, out-of-order and unknown outcomes. A success-page visit SHALL never grant paid access. See [Stripe subscription events](https://docs.stripe.com/billing/subscriptions/webhooks).

**FL-BIL-004 — Money and purchase integrity.** Represent money as integer minor units with currency. Select allowed prices server-side and bind Checkout and portal sessions to the authorized workspace. Record stable operation keys before external mutations. Reject a price, customer or subscription belonging to another product, account or environment.

**FL-BIL-005 — Predictable access changes.** Document when upgrades, downgrades, trials, cancellations and payment failures affect sending. Retain essential billing, consent/unsubscribe and approved export access during sending suspension. Never silently delete excess contacts or members on downgrade. Exact grace, refund and proration behavior requires O-006.

**FL-BIL-006 — Paid-launch prerequisites.** Before accepting public paid subscriptions, approve the business identity, supported markets, terms and applicable tax registrations/configuration. If Stripe Tax is used, verify registrations and tax behavior rather than assuming a switch establishes collection. Keep Flockletter's setup separate from existing merchant configurations.

The selected launch market is US customers and the intended operator is Frosty Flamingo Software, LLC. The owner confirmed on November 6, 2026 that the Colorado DBA registration for Flockletter is complete. US-only sales do not decide subscriber geography or provider data residency. O-008/O-009 cover those definitions and the remaining legal, privacy and tax work.

**FL-BIL-007 — Card-required trial.** Ordinary hosted signup SHALL require a successfully established provider-held payment method before trial activation. The trial lasts 14 days, with the charge date, selected recurring price and cancellation path disclosed before acceptance. Proposed behavior: cancel before trial end to avoid the first charge, retain trial access until its end, and enter the ordinary failed-payment process if the first charge fails. A partial signup may resume onboarding but SHALL not obtain sending access. The trial SHALL cap active contacts at 250 and total recipient emails at 500 across the complete 14-day trial, shared across its companies and brands; real test emails consume that email allowance. Repeated signup, plan changes or workspace/brand changes SHALL NOT refresh the trial allowance. Trial campaign count, member/company/brand limits and transition to paid allowances remain O-006; they must be settled before implementation and are not unlimited by omission. FFA's explicit complimentary grant is the exception.

**FL-BIL-008 — Complimentary customer entitlement.** Support FFA as a customer with a recorded 100% complimentary entitlement and no Stripe customer, subscription, Checkout or card requirement for that entitlement. An authorized platform operator SHALL record the workspace, assigned tier/allowances, reason, effective date and grant/revocation history. Customer input, email domain or a claimed FFA name SHALL never activate the exception. UI, API, MCP and workers SHALL use the same entitlement checks as paid accounts; consent, sender verification, quotas and abuse holds still apply. Display complimentary status without inventing a paid invoice or payment success. FFA's tier and grant lifecycle are O-011.

### Proposed billing behavior

The owner requested policies similar to the existing SaaS. The following is the explicit Flockletter adaptation for review under O-006. Its money rules are independent of the complimentary account path.

| Event | Proposed behavior |
| --- | --- |
| Ordinary trial | Card required during signup; 14 days free; first recurring payment due when the trial ends, with no charge after timely trial cancellation. |
| Upgrade | Apply higher limits after confirmed billing eligibility; prorate the price difference immediately. Usage already consumed remains counted. |
| Downgrade | Take effect at renewal. Check users, companies, brands and contact limits before scheduling and again at the effective date; present a remediation path without silently deleting data or members. |
| Customer cancellation | Keep paid access through the paid period, or trial access through trial end. Stop future renewals and show the effective service-end date. |
| Failed payment | Start a visible past-due state at the first failure; suspend campaign submissions and other paid mutations on day 6; close ordinary workspace access on day 30. Repeated failures do not restart the clock. Trial abuse holds may stop sends sooner. |
| Recovery | Successful payment before closure restores eligible access; after closure, use an authorized support recovery process before the purge deadline. A payment never clears a separate abuse or sender hold. |
| Essential access | Maintain public unsubscribe and minimal suppression even during suspension/closure. Provide the authorized customer a documented billing, export and deletion route during the retention window. |
| Retention | Purge canceled-account data after 90 days; proposed clock starts at effective service end. The nonpayment clock and backup/record exceptions must be finalized under O-009 before implementation. |
| Still open | Refund rules, annual billing/discount, trial campaign/seat/company/brand limits and paid transition, allowance reset behavior and exact sending eligibility while past due. No existing product's prices, overage model or discount program transfer automatically. |

## Usage and cost control

**FL-USG-001 — Explicit units.** Define campaigns per month, recipients per campaign, stored contacts, total recipient-messages per month, users, companies, brands and sender domains separately. Campaign and recipient allowances SHALL be shared across all companies and brands on the subscription. Recipient and total-delivery limits SHALL be finite in every tier; campaign counts alone do not bound costs or abuse. Proposed send unit: one logical recipient-message accepted by the delivery provider, including later bounces, counted once. Suppression before submission or rejected validation does not consume that unit. Real test messages do; local captured mail does not. Accepted numeric recipient/contact limits are in the tier table. One contact means one unique active marketing-eligible email address across the subscription; duplicate list memberships do not multiply the contact count, and brand consent remains separate. Sending to the same address from two brands consumes two recipient emails. Cumulative-period contact counting, suppressed/inactive storage ceilings, seat/domain definitions and period boundaries remain O-001; no unbounded storage entitlement is implied.

**FL-USG-002 — Atomic reservation.** Reserve required allowance before accepting send work, with concurrency protection across UI, API and MCP. Settle reservations from observed outcomes, retaining unresolved reservations until reconciliation. Retrying a command or provider event SHALL not reset usage, charge it twice or bypass a cap.

**FL-USG-003 — Visible limits.** Display used, reserved and remaining allowance with the reset boundary. Block or pause work that cannot fit the current allowance and explain the available remedy. No automatic overage charge is proposed for release one. Enforcement SHALL occur server-side before provider spending.

**FL-USG-004 — Platform exposure.** Bound aggregate provisioning, delivery, media and compute spending separately from per-customer entitlements. Rate-limit signup, imports and sends; apply fair work scheduling so one customer cannot monopolize the shared service. Budget exhaustion or provider throttling SHALL produce a durable, visible state.

**FL-USG-005 — Campaign accounting.** Reserve a campaign slot for the intended sending period when accepting scheduled or immediate work. Proposed accounting: consume it at the first accepted recipient submission, release it if canceled before any submission, and keep an unresolved reservation until its outcome is reconciled. A retry/resume of the same campaign consumes no new slot; a deliberate resend or copied launch consumes another. A draft/preview consumes no slot. Test sends SHALL have separate approved recipient/rate/volume bounds so they cannot act as unmetered campaigns. O-001/O-006 must settle monthly anchors, trial transition, future-period reservations and these counting rules before implementation.

**FL-USG-006 — Company brand and member limits.** Enforce the accepted tier allowances on creation, invitations, activation and plan changes. Count members consistently across companies without silently granting every member access to every company or brand. Preserve sender, audience, consent and reporting boundaries; one brand's contacts do not establish permission for another brand. Tier 3 SHALL have no plan seat cap or per-seat charge, while account verification and protective rate controls still apply. Unlimited users does not mean unlimited mail, brands or provisioning. Exact seat counting and role scopes remain O-001/O-013.

## Audiences and consent

**FL-AUD-001 — Subscriber lifecycle.** Support scoped lists, subscriber attributes and basic segments. Keep subscription, unconfirmed, unsubscribed, hard-bounce and complaint states distinct. Normalize and deduplicate addresses under a documented policy; do not merge unrelated mailboxes using guessed provider-specific alias rules.

The first owner workflow covers brand selection, exact-address lookup, status filters, paged consent history and unsubscribe. A separately granted assistant connection can obtain totals for selected brands. Campaign preflight reports current confirmed and excluded counts. [D-033 and verification](implementation/AUDIENCE.md)

**FL-AUD-002 — Evidence and forms.** Record consent source, time, purpose and relevant confirmation/version evidence. Subscriber signup forms SHALL default to double opt-in: confirmation is required before a new signup becomes send-eligible. Open and click tracking SHALL default off until an authorized customer enables it under the approved policy. Provide preference forms with abuse controls. A purchase, uploaded file or another brand's contact record alone SHALL not be treated as consent. Import confirmation, consent wording and permissions to change privacy settings remain O-010.

**FL-AUD-003 — Imports and exports.** Imports SHALL support a preflight summary, field mapping, size/row limits, duplicate/invalid-row reporting and an explicit permission-to-contact declaration. Process large work asynchronously and scope exports to authorized members. Retries SHALL not duplicate subscribers; reimport SHALL not erase suppression or consent history.

**FL-AUD-004 — Effective unsubscribe.** Provide a visible unsubscribe option and supported one-click unsubscribe handling for marketing mail. Persist the suppression before confirming success; recheck it before every future submission. Public unsubscribe endpoints SHALL be scoped, tamper-resistant and independent of paid access. Marketing content SHALL include the sender identity and disclosures required by the approved launch policy. See [mail sender guidance](https://support.google.com/mail/answer/81126).

**FL-AUD-005 — Data lifecycle.** Retain canceled account data for 90 days, then purge it under a documented lifecycle covering the application database, engine, media, exports, logs and copies. Proposed clock: effective service end, not the date a future cancellation was requested. Define export, correction and earlier owner-requested deletion. O-009 must explicitly resolve minimal billing/suppression records, any legally necessary holds and backup expiry before making deletion promises; retained exceptions cannot contain an unnecessary recoverable mailing list. Restoring an older backup SHALL reapply deletion/suppression records before enabling access or sends. Data must not cross customers or brands without valid authority and consent.

## Campaign creation and delivery

**FL-CAM-001 — Authoring.** Provide reusable templates, a Flockletter-branded visual newsletter editor, accessible editing, subject/from/reply-to fields, plain-text alternatives, preview and bounded media management. The MVP SHALL support core email-safe blocks such as text/headings, images, links/buttons, spacing/dividers and simple layouts; brand-aware defaults and reusable templates SHALL reduce the need to write HTML. Validate message content and uploads, including active content, unsafe URLs and unsupported formats. Do not expose private attachment or engine-storage paths through public messages.

**FL-CAM-002 — Complete preflight.** Before requesting a send, report sender readiness, audience and exclusion counts, content errors, subscription access, consent/suppression checks, rate/usage limits and provider readiness. Missing critical checks SHALL block dispatch; a successful preview alone SHALL not imply delivery eligibility.

**FL-CAM-003 — Reviewed send intent.** An authorized send or schedule command SHALL identify the reviewed campaign version, sender, recipient snapshot, timing and maximum count. Changes to those inputs invalidate that authorization. Scheduling freezes the recipient set; later eligibility checks may remove recipients but SHALL not silently add new ones. UI and MCP SHALL expose the same review and confirmation semantics.

**FL-CAM-004 — Durable lifecycle.** Persist draft, scheduled, preparing, sending, paused, completed, canceled and failed/reconciliation states as appropriate. Restarting processes SHALL not lose work or duplicate the schedule. Pause/cancel stops future provider submissions; the UI SHALL explain that already accepted messages cannot be recalled.

**FL-CAM-005 — Recipient outcome integrity.** Assign stable campaign-recipient operation keys and persist dispatch intent. Reconcile ambiguous provider acceptance before retrying. Do not claim exactly-once delivery when a provider cannot establish it; show an unresolved state and a safe recovery path instead of blindly resending.

**FL-CAM-006 — Eligibility at execution.** Immediately before provider submission, recheck workspace/subscription eligibility, send authority, sender verification, current suppression and remaining reserved budget. Expired, revoked or invalid work SHALL stop with an actionable reason. Marketing jobs SHALL not be used for unrelated retail fulfillment or payment operations.

**FL-CAM-007 — Honest reporting.** Separate queued, submitted, provider-accepted, delivered, bounced, complained and unsubscribed outcomes. Explain that open/click measurements can be incomplete or affected by client behavior. Respect tracking configuration and retention; show freshness and incomplete provider feedback rather than fabricated success.

**FL-CAM-008 — Newsletter Studio draft fidelity.** The visual studio SHALL save an editable, versioned draft representation in the authorized workspace and brand, and reopen it without silently losing supported layout, text, images or links. Render HTML and a meaningful plain-text alternative from the reviewed revision for preview, test send and eventual dispatch. Provide desktop/mobile previews, a clear saved/unsaved/error state and an explicit human review before send or schedule. Edits to the draft after authorization invalidate the prior reviewed-send intent under FL-CAM-003. Template/media reuse SHALL enforce workspace/brand boundaries and source licenses; publishing a product or saving a draft is not permission to send a campaign.

**FL-CAM-009 — Replaceable editor and rendering boundary.** Evaluate `@react-email/editor` and compatible React Email rendering as the preferred Newsletter Studio implementation. Keep the editor interchangeable behind Flockletter's canonical draft, asset, preview and send contracts (FL-API-001/003), without requiring the recipient to load editor JavaScript, a proprietary hosted editor, or Resend's delivery service. Before implementation, validate the pinned candidate with Flockletter's React/TypeScript/Vite stack, durable serialization and round-trip migration, sanitized links/assets, HTML/plain-text rendering, Listmonk-compatible handoff, and representative Gmail/Outlook/mobile email clients. Unsupported editor features and imported HTML SHALL fail visibly or use a documented safe fallback rather than silently corrupting messages. The specific package/version is subject to O-014; editor selection alone does not authorize live sending.

## Included delivery and abuse controls

**FL-DEL-001 — Managed delivery.** The standard hosted subscription SHALL include outbound delivery through a selected provider. Customers SHALL not need provider credentials. Self-hosters may configure their own delivery connection. Provider selection must establish real production access, costs, rate limits, feedback and tenant attribution before launch.

**FL-DEL-002 — Verified sending identity.** Guide customers through domain ownership and sender setup; verify the required SPF, DKIM, DMARC and return-path configuration for the selected provider and policy. Require verified sending identity before external campaigns. Revocation or loss of eligibility SHALL block future submission without silently switching to another customer's sender.

**FL-DEL-003 — Trust and reputation.** Open signup SHALL include verification, initial sending limits, rate controls and risk-based suspension/review. A payment alone SHALL not authorize arbitrary bulk mail. Define acceptable use and complaint/bounce responses before launch. Apply holds to affected workspaces and prevent reputation spillover as far as the selected provider's architecture supports.

The detailed trust-policy discussion is deferred at the owner's request. It does affect delivery design: O-007 must be resolved before sending implementation. This does not block drafting the SRD, and recipient caps do not replace consent, suppression or complaint handling.

**FL-DEL-004 — Authenticated feedback.** Verify delivery webhooks using provider-supported authentication, deduplicate them and resolve the owning workspace from trusted mappings. Missing authentication requires authoritative reconciliation before changing eligibility. Complaints and hard bounces SHALL suppress future applicable mail; repeated or out-of-order feedback SHALL not undo suppression.

D-038 implements the staging portion of FL-CAM-007 and FL-DEL-004. A newly reviewed local feedback test exercises delivery, temporary bounce, permanent bounce and complaint outcomes. An operator-configured Amazon SES simulator test is a separate choice, limited to AWS-owned simulator addresses and the workspace, brand and sender configuration frozen at review. Both use the same recipient reports as other rehearsals. The public provider decision and ordinary customer delivery remain open. [Staging campaign feedback](implementation/CAMPAIGN_FEEDBACK.md)

**FL-DEL-005 — Transport-independent enforcement.** All actual sends SHALL pass through the approved usage, suppression and provider controls, including engine retries and direct API paths. Before implementation, validate where Listmonk can enforce these checks; treat missing adapter/hooks as a design gap requiring review. Do not expose an unguarded engine send endpoint behind a billing-aware dashboard.

D-039 covers the staging portion of FL-DEL-005 and FL-OPS-003. The private Listmonk method renders the reviewed message locally. The separately approved SES method can deliver it to AWS-owned simulator mailboxes. Flockletter records which operation was approved, rechecks eligibility at submission, and uses its saved provider receipt to recover after a restart. [Private Listmonk rehearsals](implementation/PRIVATE_LISTMONK.md)

**FL-DEL-006 — Delivery-provider boundary and portability.** The hosted outbound delivery candidate for evaluation SHALL be Amazon SES à la carte (with Essentials evaluated separately), using SES Tenants for downstream customer attribution, while Resend remains a comparison/possible alternative and a separately scoped confirmation-email option. This is a preferred technical/cost direction, **not** production provider selection, account/plan activation or sending authorization. The application SHALL expose a provider-neutral delivery adapter for identity provisioning, sending, quotas/throttling, event processing, suppression, pause/resume, cost/usage and reconciliation. Listmonk remains the selected campaign engine; its SMTP/custom-messenger and retry paths SHALL be validated against the adapter rather than trusted to enforce Flockletter authorization by themselves. Self-hosters SHALL be able to supply their own approved delivery provider without an AWS subscription. Changing the provider SHALL NOT rewrite subscriber consent, campaign identity, send history or billing allowances. Provider-specific feature gaps SHALL surface explicitly, not be silently downgraded.

**FL-DEL-007 — Downstream SES tenant boundaries.** The proposed hosted mapping is one SES tenant per Flockletter customer workspace, with verified brand-specific sending identities and configuration sets assigned according to an approved policy; a brand is NOT automatically an SES tenant. SES tenant names, configuration sets, sender identities and message/event identifiers SHALL be bound server-side to the authenticated workspace. Any SMTP headers such as `X-SES-TENANT` and `X-SES-CONFIGURATION-SET` SHALL be generated or allowlisted from trusted mappings; an end user, campaign draft, imported content or delegated client SHALL NOT be able to choose another customer's SES identity/tenant by supplying headers. Tenant creation, identity verification, region-specific setup, sending pause, resource cleanup and provider-account quota failures SHALL have observable, reversible states. A paused tenant SHALL stop sends for that workspace without disabling compliant workspaces where provider capabilities permit. SES Tenants provide **logical reputation controls, not guaranteed IP separation or absolute account-level reputation isolation**; Flockletter must retain cross-workspace abuse monitoring, account-wide rate budgets and independent consent/suppression controls. Evaluate SES tenant-scoped suppression separately from the Flockletter canonical brand consent/suppression ledger.

**FL-DEL-008 — Provider choice and cost evidence gate.** Before production delivery is enabled, verify SES sandbox exit and production eligibility, sender DNS requirements, account/region quotas, a controlled two-workspace SMTP/API integration, outbound provider acceptance, authenticated bounce/complaint/delivery feedback, SES tenant pause/recovery behavior, Listmonk retry and campaign-header handling, and safe resolution of ambiguous provider outcomes. Confirm the chosen SES plan (new account/region combinations may default to Essentials), tenant add-on, data, monitoring, dedicated IP and other optional costs against full-tier usage and platform caps. Compare Resend's transactional API email-volume plans separately from its contact-based marketing broadcast plans; they are not interchangeable without validating the integration and terms. A plan switch, provider key, public DNS change, paid commitment or live external send requires the separate provider/operational authorization already specified by O-002/O-007 and D-031; a documentation PR does not grant it.

## API MCP and FFA integration

**FL-API-001 — Shared commands.** UI, HTTP API and MCP SHALL call canonical domain operations with the same validation, permissions, state transitions, operation keys and audit records. No transport SHALL grant broader access or permit side effects through a nominally read-only command.

**FL-API-002 — Delegated grants.** Define workspace-scoped, revocable credentials with distinct read, draft, import/export, asset and send/schedule capabilities. Credential issuance, storage, rotation and consent SHALL be reviewed before implementation. Backend authority SHALL not be inferred from a tool prompt, uploaded document or arbitrary callback URL.

**FL-API-003 — Practical campaign workflow.** Provide inspect/preflight, draft, audience selection, media/template management, preview/test, send/schedule and status/report operations. Return blocking gaps together before expensive preparation. Support batch operations with per-item results and safe retry behavior; do not make customers repeat successful items after partial failures.

**FL-API-004 — FFA integration.** FFA SHALL use the ordinary isolated customer workspace and sending controls, with the complimentary billing exception in FL-BIL-008. Its integration may create a campaign draft from approved published product data and authorized photo references. It SHALL NOT alter product photography, catalog content, prices, availability, checkout, payments or manufacturing settings. Publishing a product SHALL not automatically send a marketing campaign.

**FL-API-005 — Independent permissions and consent.** FFA integration SHALL use an explicitly scoped Flockletter grant; an existing commerce/catalog grant is not newsletter-send authority. Transfer only authorized data and consent changes. Define one authoritative preference/suppression path and reconciliation behavior before integration, without cross-application database joins.

## Email support and AI replies

**FL-SUP-001 — Email support.** Provide email support with AI-assisted reply automation. Keep a customer-visible conversation and handoff path; phone and live-chat support are outside the MVP. Proposed automation handles acknowledgments and answers from approved product guidance, identifies itself as automated and escalates uncertain answers, billing disputes, security/privacy matters and account recovery to a human. Support hours, response targets, AI provider and which replies may send automatically remain O-012.

**FL-SUP-002 — Support authority and data.** Support messages, attachments and AI output SHALL be treated as untrusted content. Receiving an email does not establish account authority. Automated replies SHALL not issue refunds, change billing/entitlements, remove abuse holds, change identities, export/delete customer data or launch campaigns. Use only necessary, authorized context; do not expose other customers' records or pass mailing lists and secrets to the AI provider. Record automated replies and human escalation under a defined retention policy. Before enabling the provider, review data use, retention and disclosure; repeated auto-replies and mail loops SHALL be bounded.

## Data hosting and service operation

Render is the selected host for Flockletter application, worker and engine services. The proposed topology is a standalone portal/API with durable control jobs, a protected Listmonk engine per customer, a delivery provider and a logical Flockletter application database. Existing PostgreSQL capacity may host these databases if isolation and load checks permit it. The proposed FFA admin entry point uses the SaaS integration; other businesses use the independent dashboard. Exact process layout, engine isolation and region remain open. Stripe and Clerk are selected external services; delivery and support-AI providers remain undecided.

**FL-OPS-001 — Shared infrastructure boundaries.** Use dedicated logical databases and restricted runtime/migration identities. Inspect effective privileges, including inherited grants, rather than relying on role names. No Flockletter runtime SHALL access another application's business records or own its schema. Existing shared roles/settings SHALL not be changed without the applicable separate authorization.

**FL-OPS-002 — Capacity before activation.** Establish connection, CPU, memory, disk, query, import and worker budgets including deployment overlap and per-customer engines. Measure the existing host's headroom before activation. A new signup SHALL not allocate unbounded paid resources; provisioning requires bounded durable work and recorded outcomes. Define an extraction path to dedicated infrastructure.

**FL-OPS-003 — Durable operations.** Persist external intents, queue leases, attempts and reconciliation state. Migrations SHALL run under guarded release authority, separate from routine runtime privileges. Critical configuration omissions SHALL fail closed. Credentials and operational data SHALL not depend on an ephemeral application filesystem.

**FL-OPS-004 — Environment separation.** Local and CI tests SHALL use disposable data. Staging SHALL use isolated billing test environments, credentials, logical databases and captured mail or a fixed approved recipient allowlist. Production customer lists and delivery credentials SHALL not be copied into ordinary previews. Code deployment and live campaign sending are separate authorizations.

**FL-OPS-005 — Recovery and monitoring.** Monitor onboarding failures, queue lag, payment-event processing, provider feedback, send usage, abuse indicators and shared resource budgets. Define numeric alert, retention and recovery targets before service commitments. Test a tenant/logical-database restore into an isolated destination without overwriting the shared live instance; reconcile external facts before restarting sends.

**FL-OPS-006 — Browser and operational safety.** Apply secure session/origin checks, least privilege, bounded uploads and imports, signed/scoped asset access, dependency review and redacted logs. Core customer flows SHALL support keyboard use, clear validation and accessible status messages. Review storage, mail rendering and provider callbacks as untrusted boundaries.

**FL-OPS-007 — Public delivery readiness.** Before enabling paid public operation, demonstrate account isolation, billing lifecycle, provider/DNS setup, suppression, capacity, recovery and operator response using the planned acceptance cases. Document remaining gaps honestly. A passing mock is not proof of live provider behavior or deliverability.

## Hosted tier limits

The owner has accepted the limits below. Campaign and recipient allowances are shared across the entire subscription, including all its companies and brands; they are not multiplied by each brand. Starter, Growth and Pro remain working names. All tiers include core consent, suppression, secure access, billing visibility, permitted exports and email support; source for all tiers remains open.

| Allowance | Tier 1 | Tier 2 | Tier 3 |
| --- | --- | --- | --- |
| Monthly price (USD) | $15 | $25 | $39 |
| Integer monthly price (USD cents) | 1500 | 2500 | 3900 |
| Active contacts per subscription | 2,500 | 5,000 | 10,000 |
| Maximum recipients per campaign | 2,500 | 5,000 | 10,000 |
| Campaigns per month | 2 | 5 | 20 |
| Total recipient emails per month | 5,000 | 25,000 | 100,000 |
| Companies per account | 1 | Up to 3 | Up to 5 |
| Brands total per account | 1 | Up to 3 | Up to 5 |
| Users | 1 | Up to 3 | Unlimited |

The owner approved prices and numeric limits in D-024. All caps apply together. Tier 3 supports ten full-audience campaigns to 10,000 contacts, or twenty campaigns averaging 5,000 recipients, within 100,000 total emails; public copy must not promise twenty full 10,000-person sends. Real test messages consume recipient allowance, so using tests reduces the remaining campaign-send capacity. All dollar prices are USD per month before any applicable tax. Tier names remain working labels.

D-025 accepts a 14-day, card-required trial capped at 250 active contacts and 500 recipient emails for the entire trial. FFA's operator-granted complimentary entitlement bypasses Stripe/card and is not a trial. Its assigned plan remains O-011. Trial campaign/seat/company/brand limits and paid transition, period anchors/rollover, sender domains, cumulative contact counting and storage ceilings remain explicit open decisions. No automatic overage billing is in scope.

### Operating cost assumptions

The detailed [cost model](COST_MODEL.md) records full-allowance delivery at a planning budget of $0.20 per 1,000 recipient emails, a proposed $7/month separate mailing service per workspace, standard domestic Stripe card processing plus Billing at 3.6% + $0.30 per monthly payment, and a $1/workspace operating reserve. At full send usage, estimated direct costs are $9.84/$14.20/$29.70, leaving $5.16/$10.80/$9.30 toward shared costs and overhead. These are estimates, not profit guarantees.

Because Clerk owns memberships as well as login (D-026), include the $100/month Enhanced B2B add-on needed for unlimited organization members in the launch budget. Together with a $25/month base authentication allowance, shared production/staging capacity and the complimentary FFA allowance, the proposed fixed planning budget is about $250/month, plus paid-workspace direct costs and growth-related provider usage. Under the stated 60%/30%/10% tier mix at full usage, infrastructure break-even is approximately 35 paid workspaces. FFA alone produces no subscription revenue and requires owner funding. Costs exclude development, substantial support labor, taxes, refunds/disputes and larger capacity upgrades. Provider choice and measured capacity remain open. The owner requires approval for each individual expense above USD 25. The estimates are for planning.

## UI design review

The [design review guide](design/README.md), [screen catalogue](design/SCREENS.md) and [user stories](design/USER_STORIES.md) are phase-one review artifacts. The owner authorized mockups using Cadence's visual stylesheet and the ChatGPT Sites workflow, plus publication to this public repository. All scenarios use fictional data. Hosted previews and browser-local simulations are not production Flockletter code, an authenticated app, or evidence that payment, delivery, Clerk or infrastructure acceptance cases pass. Designs expose proposed states for review; they cannot resolve an open policy by silently displaying one default.

## Records and authority

Conceptual records include workspace, company, brand, membership, delegated grant, sender domain, subscriber/consent, list/segment, template/media, campaign/version, recipient dispatch, subscription/complimentary entitlement, usage reservation/ledger, provider mapping, support conversation, job/inbox and audit. This is a requirements inventory, not a database schema or migration.

Clerk owns hosted login and organization membership facts. Flockletter's application database owns workspace mappings, narrower company/brand authorization, limits, complimentary grants, intended operations and audit; any local membership projection must remain subordinate to verified Clerk facts. Stripe owns actual payment/subscription facts; a complimentary grant is not a Stripe fact. The delivery provider owns acceptance and delivery facts. The engine owns its campaign execution facts behind the adapter. Document the field-level ownership and synchronization contract before implementation so two systems cannot independently overwrite consent or usage.

## Verification and phase gates

Staging now exercises the campaign lifecycle with synthetic recipients, immutable reviews, version checks, periodic processing, independent usage reservations and scoped reporting. Operators can issue complimentary access, while Stripe test facts and live marketing remain separate. [Pilot evidence and operating scope](implementation/CAMPAIGN_PILOT.md)

The [traceability matrix](TRACEABILITY.md) maps every requirement to a planned acceptance case. Foundation implementation evidence is recorded separately in [verification](implementation/VERIFICATION.md); full release acceptance remains open. Prototype navigation and visual checks are recorded separately as design verification only. For later implementation, verify unit/domain invariants, real database isolation/concurrency, provider contracts and end-to-end browser/API/MCP parity with focused tests appropriate to the change.

Before starting a dependent workstream, resolve the relevant open decisions and record its requirement IDs, adapter contracts and test plan. Before staged acceptance, use two synthetic customer workspaces, not just FFA, to test isolation and failure paths. External mail checks must use only approved recipients. Billing checks must use test environments until separately authorized.

The [phase 1 review](PHASE_1.md) defines the documentation completion gate. Approval of the SRD alone does not deploy a service or send messages. The later owner instruction recorded in D-030 authorizes the foundation build.

## References

See [source references](SOURCES.md) for public upstream documentation and the limits of what it establishes. Existing private application designs inform only the reviewed-reuse process described in [reuse review](REUSE_REVIEW.md); their code and infrastructure details are not published here.
