# Flockletter agent instructions

## Current authorization

On November 9 the owner explicitly accepted D-048’s narrow indefinite retention of minimal keyed owner/card/workspace trial-eligibility history beyond the ordinary 90-day tenant purge; these are pseudonymous personal records, not anonymous data. D-049 accepts the trial limits and billing defaults, and D-050 selects Growth for FFA’s 100% complimentary entitlement. Record these as accepted policy, not an installed configuration, an issued grant or a customer agreement. Verify the actual FFA workspace and current operator before a durable grant. Provider/account/history-baseline verification, accurate disclosures, legal/tax facts, exact customer acceptance, capacity and action-specific activation gates remain. Signed-in Resend/AWS/Stripe sessions do not establish those facts. No alert approval, live flag, mail, charge or hosted purge follows from this documentation update. See [decisions](docs/DECISIONS.md), [trial protection](docs/implementation/TRIAL_ABUSE.md) and [production preparation](docs/implementation/PRODUCTION_LAUNCH_PREPARATION.md).

D-047 additionally authorizes the bounded single-confirmed-recipient test-send workflow: five approved test requests per workspace per UTC day across brands, without refunding daily admission after failure, rejection or cancellation; accepted real messages consume recipient-email allowance, not campaign slots. Separate immutable review and explicit approval are required. Ordinary authority, service, sender, consent/suppression, usage and provider controls remain; staging uses captures and live transport remains separately gated. Do not infer approval of a full campaign or unresolved retention/legal/tax policies. Read [the test-send playbook](docs/implementation/TEST_SEND.md) before changing this path.

The earlier completion instruction (D-046) authorizes completing the remaining Flockletter implementation and production preparation autonomously, including Resend, Clerk and Render production credential setup. Use reasonable decisions, practical parallel work and as much local-model coding as appropriate, with primary-assistant review and validation; stop only for genuinely missing owner information. Keep staging on Render Free. Each individual move costing more than USD 25 still needs owner approval; do not split a move to avoid that threshold. Preserve existing applications, photos and commerce settings. This extends earlier Flockletter staging-only workstream wording; it does not establish completion, external verification, the selected Stripe merchant account or legal/tax facts. Its then-unapproved lifetime exception was subsequently accepted only within D-048’s narrow scope. Configuration, privacy, capacity and action-specific activation gates still apply. No transport, charge, purge or resource mode is enabled by this documentation entry.

The owner subsequently authorized bringing Flockletter production and staging into code parity with development and GitHub. D-044 supersedes the earlier staging-only deployment boundary for Flockletter. Promote a tested immutable source tree through staging and production with separate Clerk instances and logical databases/roles. Keep staging inexpensive and preserve other applications. Code promotion does not itself activate customer mail, live billing, infrastructure mutations or hosted erasure; their configuration, policy and verification gates remain binding. Record actual deployed revisions and blockers rather than calling prepared infrastructure a successful release.

On November 8 the owner authorized all seven remaining customer workstreams, asked for much more local-model coding with chat oversight, and requested a staging application to exercise within 12 hours. D-042 and [the integration plan](docs/implementation/COMPLETE_WORKFLOWS.md) extend the earlier foundation scope. Complete reusable implementations and normal UI/API/MCP paths. Explicit captured exercises must use the same durable state machines while external activation stays separately configured. Continue without routine questions while the owner is away. Record local drafts actually used and corrections made.

The owner requested all independently buildable work after the staging assessment. D-034 covers the staging campaign pilot, sender ownership checks, protected complimentary grants, customer administration, Stripe sandbox integration and independent engine tests. D-037 adds a separate, explicitly approved synthetic provider rehearsal and a real Listmonk integration in isolation. The original staging provider stores its receipts locally. Preserve old capture approvals; unresolved provider outcomes require lookup, never a speculative resend. [Pilot operation](docs/implementation/CAMPAIGN_PILOT.md)

Under the owner's direction to continue building, D-033 adds an owner audience directory and consent history, durable brand-specific opt-out and an optional aggregate-only assistant capability. Use the existing Flockletter subscriber records and verify populated flows with disposable addresses. [Audience workflow and verification](docs/implementation/AUDIENCE.md)

The owner authorized implementation of Flockletter PR #2 on November 7, 2026. This adds the Flockletter side of first-party subscriber intake, scoped owner controls, confirmation and unsubscribe, suppression and captured staging tests. Keep public FFA collection, production and live-provider activation behind the gates in [the intake specification](docs/implementation/FFA_SUBSCRIBER_INTAKE.md). FFA PR #181 is the separate storefront proposal.

The owner has authorized the foundation implementation and staging verification, and asked the assistant to make reasonable implementation decisions without routine confirmation. Build the independent application shell, isolated database setup, canonical UI/API/MCP operations, campaign drafts, bounded batch images, preview and actionable validation. Use the approved visual system and exact supplied logo. Record decisions and evidence in docs/implementation. Production deployment, live mailing and paid public activation are outside this workstream. Existing FFA staging may be resumed when needed; this does not authorize changing production or another application's data/settings. Gather genuinely missing configuration together after completing independent work.

Read [the SRD](docs/SRD.md), [decisions](docs/DECISIONS.md) and [phase 1 review](docs/PHASE_1.md) before work. Accepted owner decisions, proposed requirements and unresolved decisions are distinct. Do not silently promote a proposal to an accepted decision. Later explicit owner instructions take precedence; update the documents to reflect them.

D-035 covers brand-specific member preparation, static group capture, support drafts, retention preview and isolated self-host recovery under D-030. These workflows use explicit scopes and the same source of authority in UI, API and MCP. [Workspace workflows](docs/implementation/WORKSPACE_OPERATIONS.md)

D-036 authorizes the staging Newsletter Studio. Preserve authored content on unsupported input, original brand assets, and review of each saved revision. Keep the editor’s distributed notice inventory synchronized with dependency changes. [Editor notices](docs/implementation/STUDIO_LICENSES.md)

D-038 adds a staging-only choice between local feedback and an optional operator-bound SES mailbox simulator. Keep older rehearsal approvals on their selected method. AWS simulator access requires an explicitly reviewed AWS method. Protect its credentials and frozen sender configuration. Report AWS contract checks independently of live AWS evidence and the isolated Listmonk exercise. [Campaign feedback](docs/implementation/CAMPAIGN_FEEDBACK.md)

D-039 adds two explicitly reviewed private Listmonk methods for the bound staging brand. Use Flockletter’s protected database for operation state and receipts. The engine and its disposable database use loopback. The local method stays inside Flockletter. The optional SES method can submit only to AWS-owned simulator mailboxes. [Private Listmonk operation](docs/implementation/PRIVATE_LISTMONK.md)

## Product and public repository boundaries

D-041 covers the additional staging implementation. Use server-owned SES mappings, separately reviewed personal unsubscribe links, and the synthetic import, support and retention exercises. Read [delivery readiness](docs/implementation/DELIVERY_READINESS.md) before working on the provider boundary. Production mailing, public paid activation and retention on hosted customer data retain their separate release requirements.

- The product is Flockletter; the repository slug is `flockletter`.
- Flockletter is an independent open-source mailing SaaS. Frosty Flamingo Apparel is its first intended customer.
- Open self-service signup, included delivery in hosted plans and AGPLv3 are accepted decisions.
- Original repository material is licensed under AGPL-3.0-only. Preserve third-party licenses and attribution. Review provenance and compatibility before importing code.
- Keep credentials, customer data, production identifiers, private application source and machine-specific configuration out of the public repository. D-029/D-030 permit the exact supplied Frosty Flamingo Software logo in mockups and the application shell; no other private brand assets are permitted.
- Existing applications retain their data, identities, payment settings, photos and deployments. Shared hosting does not authorize cross-application access or changes.

## Local model delegation

Delegate bounded mechanical coding, boilerplate, test scaffolding, repetitive conversions, documentation scaffolding and first-draft commit messages to the configured local coding model when available. Use the locally installed model through the `llm` command; keep machine-specific model configuration outside this public repository. Never select removed or unavailable models.

Keep architecture, product intent, security, money, tenant isolation, acceptance criteria and final review with the primary assistant. Supply the local model with the relevant facts and constraints, then review its output before use. Preserve the local service's recommended sampling defaults and allow sufficient reasoning time; do not impose a small token budget. If one correction does not resolve a draft's problems, finish that assignment in the primary assistant. If the local service is unavailable or no suitable mechanical assignment exists, continue and explain why.

For bounded mechanical drafts, use the optional `llm --mechanical --stats` mode when the local command supports it. This mode must use a verified template for the installed model, preserve its sampling defaults and context, and enforce at most two concurrent requests. It avoids extended reasoning for routine drafts. Security, billing policy and integration still require primary review. Keep the machine-specific adapter outside this repository.

Every completion report must identify actual local-model and primary-assistant contributions, including corrected or replaced drafts and skipped delegation. Report token or cost percentages only when measured.

## Implementation requirements

- Tenant identity comes from verified authentication and membership. Enforce isolation in browser, API, MCP, worker, storage and provider operations.
- Use one canonical command layer for customer administration, HTTP APIs and MCP. Draft permission does not grant send permission.
- Money uses integer minor units with an explicit currency. Verify payment-provider events; browser redirects never establish payment or access.
- Record durable intent and stable operation keys before external mutations. Reconcile unknown outcomes before retrying.
- Recheck consent, suppression, sender eligibility, subscription access and limits before delivery. Never treat a purchase as marketing consent.
- Keep staging credentials and recipients separate. Live sends, purchases and deployments require the applicable owner authorization.
- Before implementation, resolve the decision gates listed in the SRD; before release, satisfy the relevant acceptance cases. Update traceability with real evidence and distinguish mock checks from external verification.

## Documentation discipline

Use stable requirement and acceptance IDs. Keep the SRD as the canonical specification and the decisions file as its decision ledger. Additions must identify status, dependencies and verification. Avoid duplicating requirements across files. Do not add speculative features merely because an upstream tool supports them.
