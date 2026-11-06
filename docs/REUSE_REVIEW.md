# Flockletter reuse review

This is a phase 1 inventory of possible reuse. No source code has been imported into Flockletter, no component has passed a reuse acceptance review, and no existing application is being modified. The purpose is to preserve useful patterns while making the product independently maintainable and publishable.

## Candidate inventory

| Candidate | Intended benefit | Review required before reuse |
| --- | --- | --- |
| Existing SaaS plan-catalogue pattern | One definition for prices, allowances and capabilities | Verify current code and tests, integer-money rules, workspace isolation, ownership/license and Flockletter-specific units. Existing commercial prices and product limits do not transfer. |
| Existing verified-event ingress pattern | Verify, durably record, deduplicate and reconcile external events | Review immutable source revision and tests; adapt to Flockletter-owned tables, identities, provider resources and error handling. Never reuse another application's ingress database function or keys. |
| Existing membership and access patterns | Server-resolved workspace access and explicit capabilities | Review session/audience validation, membership revocation, database enforcement and background-job authorization; distinguish customer and platform authority. |
| Existing UI primitives and operational conventions | Familiar forms, status displays, validation, logs and deployment practices | Separate generic components from private business behavior, branding, data and deployment identifiers. Publish only material whose rights and dependencies permit it. |
| FFA product context | Prepare a newsletter draft from approved merchandising data | Define a scoped API contract and consent reconciliation. Existing photos and commerce settings remain unchanged; no database sharing or automatic sends. |
| Listmonk | Reuse mailing lists, templates, campaign APIs and execution | Select a stable version, preserve license/notices, review security and adapter contracts, prove per-workspace isolation and all-path usage/suppression enforcement. |
| Selected Stripe and Clerk integrations | Reduce bespoke handling of sensitive functions | Select supported versions and verify real contracts, Google/Apple production setup and the complimentary-account exception; do not transplant old API assumptions or custom cryptography merely because it exists elsewhere. |

Selected plan-catalogue and verified-event-ingress patterns were observed in the owner's existing SaaS source during product discussion. That limited observation is not a code audit, license clearance, performance measurement or proof of deployed behavior. Private source excerpts, repository internals and operating details are not reproduced here.

The owner also selected similar commercial billing policies. The SRD states a proposed Flockletter adaptation explicitly, rather than inheriting another application's prices, discounts or conflicting historical draft language. FFA's approved Stripe-free complimentary entitlement takes precedence over any existing coupon-based pattern. Current policy decisions inform the draft; deployed billing behavior has not been verified by this documentation review.

## Reuse acceptance process

Before importing a component, record its source repository/path, immutable commit, copyright/license, relevant dependencies, purpose, tests carried over and changes needed. Confirm the authority to publish it in an AGPLv3 project. Keep sensitive provenance in an appropriate private record while publishing required notices and sufficient public attribution.

Then verify that the extracted component has no dependency on private tables, account IDs, credentials, environment files, users, provider subscriptions, brand assets or runtime services. Reuse a versioned generic package or an attributed bounded adaptation; avoid an unversioned dependency on another private repository.

Money, authentication, tenant access, event verification and job execution need primary-assistant review. The local model may help with mechanical extraction or test scaffolding only after implementation is authorized and the contracts are approved.

## Mailing engine decision gate

Listmonk's API and list permissions are useful capabilities, but they do not by themselves prove a SaaS boundary. Before coding the adapter, determine:

- where a provider submission and any retry occur;
- how Flockletter authorizes, reserves and settles recipient usage;
- how new unsubscribes, complaints and revoked access stop queued work;
- whether raw SQL or engine-wide permissions can reach other customer data;
- how a provider timeout is reconciled without guessing or duplicating a send;
- which parts require configuration, a supported hook, a transport adapter or an upstream change;
- what per-customer compute, connections, storage and upgrade work will cost.

If the upstream engine cannot satisfy the proposed requirements within a bounded adapter, return the tradeoff to product review. Do not silently fork a large subsystem or bypass a requirement to preserve the engine choice. No engine fork or alternative is approved by this inventory.

## Public repository review

Review the actual files and their history before publishing. Remove credentials, account/tenant identifiers, private infrastructure endpoints, customer examples and copied private source. Use fictional fixtures for future tests. An owner's request for a public repository authorizes publication of this project's intended material, not unrelated private application contents.
