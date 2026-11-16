# Flockletter

Flockletter is an open-source mailing SaaS for small retailers and general small businesses to manage permission-based audiences and newsletter campaigns. Frosty Flamingo Apparel is the first intended customer; other businesses can operate independently. Large enterprises are outside the target market.

## Current status

Flockletter is live in production at [flockletter.frostyflamingosoftware.com](https://flockletter.frostyflamingosoftware.com). Production serves an exact, staging-tested commit from GitHub `main`, promoted through the [release process](docs/implementation/RELEASE_PARITY.md). The running commit is public at `/api/health/version`.

Production configuration as observed on November 16, 2026 (`/api/config`):

| Workflow | Production mode |
| --- | --- |
| Billing | `stripe_live` |
| Newsletter delivery | `resend`, scope `all` |
| Audience and signup | `live` |
| Team lifecycle | `off` |
| Support inbox | `off` (help is by email) |
| Hosted retention and erasure | `off` |
| Platform operator console | `off` |
| Operator MFA policy | `pre-revenue` (D-051 temporary exception) |

This table records configuration, not customer traffic, provider acceptance or revenue. Under D-051 the operator MFA exception ends once paying customers arrive, and hosted retention stays off while it is in force. D-060 holds new Pro enrollment and D-062 selects the temporary no-tax-collection mode.

The product offers a 14-day trial with caps of 2,500 contacts and 2,500 emails, and paid plans at $15, $25 and $39. It enforces per-brand public double opt-in by default, handles up to 2,500 CSV rows per import, preserves existing suppression, and requires an exact saved review and explicit approval before a campaign is queued. No tracking is enabled by default.

Staging is a separate Render Free service that can sleep, with its own Clerk instance and logical database. Staging exercises use captured modes: team invites, removals and ownership changes are recorded without real Clerk membership updates, support replies are captured, and cancellation runs the 90-day retention workflow with captured zero-deletion outcomes. A separately privileged erasure executor is tested with disposable data and stays disabled for hosted customer data.

Operations rely on durable queues and worker records. The private Listmonk renderer pool operates per workspace with original assets preserved in the database. Provider adapters exist for AWS SES/SNS, Resend, Stripe and Clerk; each is selected by explicit configuration.

Local model drafts are reviewed before integration. Code approval, configuration, real provider evidence and activation remain separate facts; record each one only from its own evidence.

- [Owner Testing Guide](docs/implementation/OWNER_TESTING_GUIDE.md)
- [Customer Browser Proof](docs/implementation/CUSTOMER_BROWSER_PROOF.md)
- [Customer Environments](docs/implementation/CUSTOMER_ENVIRONMENTS.md)
- [Customer Billing](docs/implementation/CUSTOMER_BILLING.md)
- [Customer Audience & Team](docs/implementation/CUSTOMER_AUDIENCE_TEAM.md)
- [Customer Support & Retention](docs/implementation/CUSTOMER_SUPPORT_RETENTION.md)
- [Customer Infrastructure](docs/implementation/CUSTOMER_INFRASTRUCTURE.md)


## Working foundation

The application uses TypeScript, React/Vite, Express and PostgreSQL. You can create a workspace and first brand, save campaign drafts, batch-upload original images, review HTML/plain-text previews and manage scoped connections. First-party intake has an independent worker, double opt-in and suppression. Campaign sending and paid activation are selected by explicit configuration; see the current status above for production.

[Newsletter Studio](docs/implementation/NEWSLETTER_STUDIO.md) covers visual editing, original brand images, versioned previews and captured rehearsals.

The [first-newsletter walkthrough](docs/implementation/DELIVERY_READINESS.md) covers per-brand delivery setup, the two-workspace SES evaluation and an end-to-end unsubscribe rehearsal.

## Local setup

See the [workspace workflows](docs/implementation/WORKSPACE_OPERATIONS.md) for group rehearsals, team permissions, billing recovery, retention and support.

For a standalone Docker installation, a synthetic loopback owner demo or a scoped PostgreSQL restore drill, see the [self-hosting guide](docs/implementation/SELF_HOST.md).

Use Node 24 and a disposable loopback PostgreSQL instance:

1. Run `npm ci`.
2. In terminal 1, run `npm run db:local` and leave it running.
3. In terminal 2, copy `.local/database.env` to `.env`, run `npm run build`, then run `npm run dev`.
4. Open [Flockletter locally](http://127.0.0.1:4310).

Stopping the database process normally removes its disposable test data. Local identity is synthetic and cannot run in staging. Run `npm run check` for lint, type checks, tests and the production build. Tests use their own temporary PostgreSQL instance and fictional data; they do not depend on the development database.

Read the [foundation scope](docs/implementation/FOUNDATION.md), [API/MCP workflow](docs/implementation/API_MCP.md), [staging setup](docs/implementation/STAGING.md) and [verification evidence](docs/implementation/VERIFICATION.md). Never put service keys or customer data in this public repository.

## Planning documents

- [Software requirements](docs/SRD.md) — canonical draft scope and requirements.
- [Product decisions](docs/DECISIONS.md) — accepted choices, proposals and unresolved questions.
- [Phase 1 review](docs/PHASE_1.md) — product discussion and approval gates.
- [Reuse review](docs/REUSE_REVIEW.md) — candidate components and review boundaries.
- [Requirement traceability](docs/TRACEABILITY.md) — full-release acceptance cases and targeted foundation evidence.
- [Design review and screen mockups](docs/design/README.md) — interactive concept, screen inventory, screenshots and user stories.
- [Cost model](docs/COST_MODEL.md) — approved plan values and explicit operating assumptions.
- [Source references](docs/SOURCES.md) — public upstream documentation.

See [AGENTS.md](AGENTS.md) for contribution and agent instructions, including the foundation authorization and local-model review requirements.

## License

Original Flockletter material is licensed under the GNU Affero General Public License version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE). Third-party components retain their own licenses and attribution. Newsletter Studio distributes a [dependency inventory](public/studio-dependencies.json) and [third-party notices](public/studio-notices.txt). See [editor and asset provenance](docs/implementation/STUDIO_LICENSES.md). The owner-supplied [software logo](docs/design/prototype/assets/README.md) is separate brand artwork; its inclusion does not grant a general artwork reuse license or trademark rights.

Newsletter delivery supports an explicit per-brand [AWS SES or Resend choice](docs/implementation/SELECTABLE_DELIVERY.md) in Delivery and through separately scoped API/MCP commands. Selection never activates sending or automatically retries an unknown message through another service.
