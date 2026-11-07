# Flockletter

Flockletter is a planned open-source mailing SaaS for small retailers and general small businesses to manage permission-based audiences and newsletter campaigns. Frosty Flamingo Apparel is the first intended customer; other businesses can operate independently. Large enterprises are outside the target market.

## Current status

Owners can search a brand’s contacts, review consent history and honor unsubscribe requests in **Audience**. Assistants can read counts by status with an explicit brand grant. Campaign previews show the current confirmed and excluded totals. [Audience walkthrough](docs/implementation/AUDIENCE.md)

The repository includes campaign preparation, isolated workspace storage, shared UI/API/MCP operations and a separately gated first-party subscriber intake endpoint. Workspace owners can inspect intake readiness and manage a dedicated brand credential. Hosted public collection requires a verified confirmation provider. [Foundation evidence](docs/implementation/VERIFICATION.md) · [Subscriber intake](docs/implementation/FFA_SUBSCRIBER_INTAKE.md)

Settled choices include a public repository, AGPLv3 licensing, open self-service signup for the eventual hosted service, included email delivery and a 14-day trial with a card required. FFA will use a complimentary customer account that bypasses Stripe and card payments.

The first release is a minimum viable product. The draft covers audiences, newsletters and announcements, previews and test sends, scheduling, basic reports, and consistent UI, API and MCP operations. Three tiers are approved at $15/$25/$39 monthly, with 2,500/5,000/10,000 active contacts and 5,000/25,000/100,000 recipient emails monthly. The 14-day trial allows 250 contacts and 500 emails. See the complete limits in the [SRD](docs/SRD.md).

Selected technologies are Listmonk, Stripe, Clerk for all hosted logins and workspace memberships, including Google, Apple and Microsoft sign-in, plus email with a one-time verification code, and Render hosting. Engine isolation, the delivery provider, actual capacity and exact topology remain to be designed; planning costs include the Clerk membership add-on. Support will be by email with AI reply automation; the provider and operating rules are still under review.

The planned hosted service is paid. Self-hosting must not require the owner's private systems or a Flockletter subscription. All application code, including administration, billing and MCP, is intended to remain open source; credentials and customer data stay private.

## Working foundation

The application uses TypeScript, React/Vite, Express and PostgreSQL. You can create a workspace and first brand, save campaign drafts, batch-upload original images, review HTML/plain-text previews and manage scoped connections. First-party intake has an independent worker, double opt-in and suppression. Campaign sending and paid activation remain gated.

## Local setup

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

Original Flockletter material is licensed under the GNU Affero General Public License version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE). Third-party components retain their own licenses and attribution. The owner-supplied [software logo](docs/design/prototype/assets/README.md) is separate brand artwork; its inclusion does not grant a general artwork reuse license or trademark rights.
