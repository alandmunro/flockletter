# Production operator and recovery bootstrap

This implements a release preparation path for FL-ID-005 and FL-OPS-001/003/005/006. It does not activate hosted erasure, accept a trial-retention policy or prove a provider's live behavior. Production credentials and external operations remain with the separately authorized deployment work.

## Exact metadata operator role

The production SQL generator is `scripts/provision-production-operator.ts`. It only prints SQL; it never connects, creates a role, reads a password, activates LOGIN or changes another database. Run it in the reviewed release checkout with its locked development tools installed:

```sh
APP_ENV=production node --import tsx scripts/provision-production-operator.ts database
APP_ENV=production node --import tsx scripts/provision-production-operator.ts objects
```

The fixed target is `flockletter_production`, the fixed metadata role is `flockletter_production_operator`, and the migration actor is `flockletter_production_migrator`. Database and role comments must exactly equal `Flockletter production foundation`. The role must already exist with NOLOGIN, NOINHERIT, no elevated attributes, no memberships, no active connections and no owned database/schema/relation/function. The tool refuses adoption of unrelated or active roles. It does not create or rotate credentials.

1. Complete the dedicated production database provisioning and all migrations. Use the separately reviewed database/role administrator path to create and mark the restricted operator role, initially NOLOGIN. Keep its private credential out of SQL artifacts and logs.
2. Review/apply the `database` output **as this logical database's actual owner**. It checks the exact database/role markers and actor, then grants only CONNECT to this database. Foreign database grants and other roles are untouched.
3. Review/apply the `objects` output **as `flockletter_production_migrator`**. Tables/functions belong to the migrator; the database administrator is not assumed to inherit object ownership or SET ROLE rights. The script removes this dedicated role's direct object grants in the three Flockletter namespaces, then permits only USAGE on the private control namespace, SELECT/INSERT/UPDATE on `platform_records`, and EXECUTE on `expire_platform_inbox()`. A transactional postflight refuses extra effective table, sequence, column, schema-create, database-create or function authority, including inherited PUBLIC access. It does not repair PUBLIC or other roles' grants.
4. Both phases must finish successfully with errors treated as failures. Replays are supported only while the role is inactive and has no sessions. This is bootstrap tooling, not a live-role privilege reset.
5. After reviewed credential activation, connect as the actual operator role and run `OperatorStore.verify()`. Prove metadata reads/writes work and ordinary tenant reads and private-table DELETE are denied. Only then install `FLOCKLETTER_OPERATOR_DATABASE_URL` on the Flockletter production service. Keep elevated administrator and migrator connections outside the web service.

The active store independently checks the database/role match, distinct metadata-only identity, effective table privileges/ownership, CREATE/membership authority, and function/column/sequence drift at startup. PostgreSQL 17+ MAINTAIN is included in its permission vocabulary; it is not an allowed operator capability.

## Live operator identity and alerts

Set these only for the separate verified production operator surface:

- `FLOCKLETTER_PLATFORM_MODE=live`
- `FLOCKLETTER_OPERATOR_ORGANIZATION_ID`: a dedicated Flockletter operator Clerk organization, not a customer organization
- `FLOCKLETTER_OPERATOR_USER_IDS`: exact named operators
- `FLOCKLETTER_OPERATOR_DATABASE_URL`: the restricted metadata role, same host/port/logical database as the runtime connection

Each operator must have current admin membership in that organization and an enrolled second factor. Both factor verification ages must be under five minutes. The UI/API/MCP share these checks; a customer connection token cannot substitute for an operator session.

Alert delivery additionally requires `FLOCKLETTER_PLATFORM_ALERTS_ENABLED=approved`, a dedicated `FLOCKLETTER_PLATFORM_ALERT_RESEND_KEY`, and reviewed `FLOCKLETTER_PLATFORM_ALERT_FROM` / `_TO` addresses. Acknowledging an alert does not remove its underlying hold or failure. Unknown submissions reconcile rather than blindly retry.

## Retention and trial prerequisites

The separately restricted planner, destructive executor and recovery identity retain the boundaries in [hosted retention](HOSTED_RETENTION.md). Planner configuration files and the inventory directory must be absolute, owned by the running identity, not symlinked and not accessible to group/other users. Configure exact account IDs, US regions, dedicated versioned/Object Lock checkpoint storage, purpose-separated Ed25519 public keys, and the complete renderer-instance roster. All-host disposal and external-copy inventory must be real evidence, not a local renderer callback.

No Render/Clerk/Resend credential alone establishes AWS bucket protection or account authority. Record the owner-controlled storage/account facts and independently verify protected checkpoint writes, external inventory, disposal receipts and isolated restore/quarantine before calling retention operational. Execute a disposable synthetic tenant check; customer erasure still requires its exact short-lived approval and separate offline authority.

The lifetime trial-history retention exception remains an owner decision. See the [proposed amendment](PROPOSED_TRIAL_RETENTION_EXCEPTION.md) and [current trial configuration](TRIAL_ABUSE.md). A fresh empty database is not proof of an empty provider history.

## Validation and model contribution

The new disposable PostgreSQL tests exercise exact owner/migrator phases, NOLOGIN bootstrap/replay, marker and identity refusals, foreign-grant preservation, metadata-only access and PUBLIC drift rollback. They also prove that PostgreSQL MAINTAIN authority is rejected by the actual operator verifier. These checks do not claim any production credential or provider verification.

Validation on this workstream: lint, type checking, the production build and all 91 local test files passed (588 tests passed, two explicitly gated engine tests skipped). The focused production-bootstrap/platform suites passed all 13 tests. No hosted configuration was changed by these checks.

Local Qwen formatted the trial-policy proposal from supplied facts. Chat corrected its misleading approved-default and physical reservation-expiry wording. Chat retained privileged SQL design, authority decisions, implementation, integration, acceptance tests and review. No token or cost percentage is inferred.
