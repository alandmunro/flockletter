# Flockletter

Flockletter is a planned open-source mailing SaaS for businesses to manage permission-based audiences and newsletter campaigns. Frosty Flamingo Apparel is the first intended customer; the product is designed to serve other businesses independently.

## Current status

Phase 1 covers product definition and a draft software requirements document. This repository contains planning documents only. There is no application, deployable service, signup page or live email sending yet. Implementation has not been authorized.

The owner has selected a public repository, open self-service signup for the future hosted product, included email delivery in hosted subscriptions and AGPLv3 licensing.

The proposed design combines customer workspaces, administrator and team roles, three hosted subscription tiers, Stripe-based billing, a Listmonk mailing engine, and consistent UI, API and MCP operations. Prices, allowances, providers and final deployment choices remain under review.

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
