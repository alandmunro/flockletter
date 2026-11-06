# Flockletter agent instructions

## Current authorization

Flockletter is in phase 1: product definition and software requirements. The owner has authorized a public repository, planning documents and nonproduction UI mockups using ChatGPT Sites and Cadence visual styling, with design artifacts and user stories published here. Static prototype HTML/CSS/JS and screenshots are allowed only under docs/design; they must use fictional data and simulated actions, with no live integrations. This is not permission to build the product. Do not add application code, executable infrastructure, migrations, deployment workflows, provider configuration, paid resources or live email sending until the owner explicitly authorizes implementation. Documentation review and revision may continue.

Read [the SRD](docs/SRD.md), [decisions](docs/DECISIONS.md) and [phase 1 review](docs/PHASE_1.md) before work. Accepted owner decisions, proposed requirements and unresolved decisions are distinct. Do not silently promote a proposal to an accepted decision. Later explicit owner instructions take precedence; update the documents to reflect them.

## Product and public repository boundaries

- The product is Flockletter; the repository slug is `flockletter`.
- Flockletter is an independent open-source mailing SaaS. Frosty Flamingo Apparel is its first intended customer.
- Open self-service signup, included delivery in hosted plans and AGPLv3 are accepted decisions.
- Original repository material is licensed under AGPL-3.0-only. Preserve third-party licenses and attribution. Review provenance and compatibility before importing code.
- Keep credentials, customer data, production identifiers, private application source, machine-specific configuration and proprietary brand assets out of the public repository.
- Existing applications retain their data, identities, payment settings, photos and deployments. Shared hosting does not authorize cross-application access or changes.

## Local model delegation

Delegate bounded mechanical coding, boilerplate, test scaffolding, repetitive conversions, documentation scaffolding and first-draft commit messages to the configured local coding model when available. Use the locally installed model through the `llm` command; keep machine-specific model configuration outside this public repository. Never select removed or unavailable models.

Keep architecture, product intent, security, money, tenant isolation, acceptance criteria and final review with the primary assistant. Supply the local model with the relevant facts and constraints, then review its output before use. Preserve the local service's recommended sampling defaults and allow sufficient reasoning time; do not impose a small token budget. If one correction does not resolve a draft's problems, finish that assignment in the primary assistant. If the local service is unavailable or no suitable mechanical assignment exists, continue and explain why.

Every completion report must identify actual local-model and primary-assistant contributions, including corrected or replaced drafts and skipped delegation. Report token or cost percentages only when measured.

## Requirements for later implementation

- Tenant identity comes from verified authentication and membership. Enforce isolation in browser, API, MCP, worker, storage and provider operations.
- Use one canonical command layer for customer administration, HTTP APIs and MCP. Draft permission does not grant send permission.
- Money uses integer minor units with an explicit currency. Verify payment-provider events; browser redirects never establish payment or access.
- Record durable intent and stable operation keys before external mutations. Reconcile unknown outcomes before retrying.
- Recheck consent, suppression, sender eligibility, subscription access and limits before delivery. Never treat a purchase as marketing consent.
- Keep staging credentials and recipients separate. Live sends, purchases and deployments require the applicable owner authorization.
- Before implementation, resolve the decision gates listed in the SRD; before release, satisfy the relevant acceptance cases. Update traceability with real evidence and distinguish mock checks from external verification.

## Documentation discipline

Use stable requirement and acceptance IDs. Keep the SRD as the canonical specification and the decisions file as its decision ledger. Additions must identify status, dependencies and verification. Avoid duplicating requirements across files. Do not add speculative features merely because an upstream tool supports them.
