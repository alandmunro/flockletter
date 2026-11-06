# Flockletter

Flockletter is a planned open-source mailing SaaS for small retailers and general small businesses to manage permission-based audiences and newsletter campaigns. Frosty Flamingo Apparel is the first intended customer; other businesses can operate independently. Large enterprises are outside the target market.

## Current status

Phase 1 covers product definition and a draft software requirements document. This repository contains planning documents only. There is no application, deployable service, signup page or live email sending yet. Implementation has not been authorized.

Settled choices include a public repository, AGPLv3 licensing, open self-service signup for the eventual hosted service, included email delivery and a 14-day trial with a card required. FFA will use a complimentary customer account that bypasses Stripe and card payments.

The first release is a minimum viable product. The draft covers audiences, newsletters and announcements, previews and test sends, scheduling, basic reports, and consistent UI, API and MCP operations. Three tiers have accepted campaign, company, brand and user limits; prices and recipient caps remain open in the [SRD](docs/SRD.md).

Selected technologies are Listmonk, Stripe, Clerk with Google and Apple sign-in, and Render hosting. Engine isolation, the delivery provider, costs and exact topology remain to be designed. Support will be by email with AI reply automation; the provider and operating rules are still under review.

The planned hosted service is paid. Self-hosting must not require the owner's private systems or a Flockletter subscription. All application code, including administration, billing and MCP, is intended to remain open source; credentials and customer data stay private.

## Planning documents

- [Software requirements](docs/SRD.md) — canonical draft scope and requirements.
- [Product decisions](docs/DECISIONS.md) — accepted choices, proposals and unresolved questions.
- [Phase 1 review](docs/PHASE_1.md) — product discussion and approval gates.
- [Reuse review](docs/REUSE_REVIEW.md) — candidate components and review boundaries.
- [Requirement traceability](docs/TRACEABILITY.md) — planned acceptance cases; no test results yet.
- [Source references](docs/SOURCES.md) — public upstream documentation.

See [AGENTS.md](AGENTS.md) for contribution and agent instructions, including the documentation-only boundary.

## License

Original Flockletter material is licensed under the GNU Affero General Public License version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE). Third-party components retain their own licenses and attribution.
