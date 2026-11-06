# Flockletter

Flockletter is a planned open-source mailing SaaS for small retailers and general small businesses to manage permission-based audiences and newsletter campaigns. Frosty Flamingo Apparel is the first intended customer; other businesses can operate independently. Large enterprises are outside the target market.

## Current status

The owner has authorized the first application foundation and staging verification. This repository now includes working campaign preparation, an isolated database setup, and shared UI/API/MCP operations alongside the original design review. Sending, paid signup, subscriber management and production deployment are not active. See the [foundation scope](docs/implementation/FOUNDATION.md) and [verification record](docs/implementation/VERIFICATION.md).

Settled choices include a public repository, AGPLv3 licensing, open self-service signup for the eventual hosted service, included email delivery and a 14-day trial with a card required. FFA will use a complimentary customer account that bypasses Stripe and card payments.

The first release is a minimum viable product. The draft covers audiences, newsletters and announcements, previews and test sends, scheduling, basic reports, and consistent UI, API and MCP operations. Three tiers are approved at $15/$25/$39 monthly, with 2,500/5,000/10,000 active contacts and 5,000/25,000/100,000 recipient emails monthly. The 14-day trial allows 250 contacts and 500 emails. See the complete limits in the [SRD](docs/SRD.md).

Selected technologies are Listmonk, Stripe, Clerk for all hosted logins and workspace memberships, including Google, Apple and Microsoft sign-in, plus email with a one-time verification code, and Render hosting. Engine isolation, the delivery provider, actual capacity and exact topology remain to be designed; planning costs include the Clerk membership add-on. Support will be by email with AI reply automation; the provider and operating rules are still under review.

The planned hosted service is paid. Self-hosting must not require the owner's private systems or a Flockletter subscription. All application code, including administration, billing and MCP, is intended to remain open source; credentials and customer data stay private.

## Run the foundation locally

Use Node 24 and `npm ci`. In one terminal, run `npm run db:local` and leave it running. In another terminal:

```sh
cp .local/database.env .env
npm run build
npm run dev
```

Open [the local application](http://127.0.0.1:4310). The database is a real disposable PostgreSQL instance; stopping its process removes its test data. The synthetic owner identity is restricted to loopback development and cannot run in staging. `npm run check` runs lint, type checks, isolated tests and the production build.

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
