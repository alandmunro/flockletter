# Production operator and recovery bootstrap

This implements a release preparation path for FL-ID-005 and FL-OPS-001/003/005/006. It does not activate hosted erasure, accept a trial-retention policy or prove a provider's live behavior. Production credentials and external operations remain with the separately authorized deployment work.

## Exact metadata operator role

The production SQL generator is `scripts/provision-production-operator.ts`. It only prints SQL; it never connects, reads or generates a password, activates LOGIN or changes another database. Its `role` phase can create the missing exact role, without credentials. Run it in the reviewed release checkout with its locked development tools installed:

```sh
APP_ENV=production node --import tsx scripts/provision-production-operator.ts role
APP_ENV=production node --import tsx scripts/provision-production-operator.ts database
APP_ENV=production node --import tsx scripts/provision-production-operator.ts objects
```

The fixed target is `flockletter_production`, the fixed metadata role is `flockletter_production_operator`, and the migration actor is `flockletter_production_migrator`. Database and role comments must exactly equal `Flockletter production foundation`. An existing role must have NOLOGIN, NOINHERIT, no elevated attributes, no memberships, no active connections and no owned database/schema/relation/function. The tool refuses adoption of unrelated or active roles. It does not create or rotate credentials.

1. Complete the dedicated production database provisioning and all migrations. Review/apply the `role` output as the actual marked database owner with CREATEROLE. It creates only a missing exact marked NOLOGIN role, with connection limit two and no password. Existing correctly restricted roles are preserved. Keep any separately issued private credential out of SQL artifacts and logs.
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

Each operator must have current admin membership in that organization and, by default, an enrolled second factor. [D-051](PRE_REVENUE_OPERATOR_AUTH.md) permits an explicit production-only temporary first-factor exception while billing, hosted retention and signing remain off. Restore MFA before paid activation. Under the default policy, Both factor verification ages must be under five minutes. The UI/API/MCP share these checks; a customer connection token cannot substitute for an operator session.

Alert delivery additionally requires `FLOCKLETTER_PLATFORM_ALERTS_ENABLED=approved`, a dedicated `FLOCKLETTER_PLATFORM_ALERT_RESEND_KEY`, and reviewed `FLOCKLETTER_PLATFORM_ALERT_FROM` / `_TO` addresses. Acknowledging an alert does not remove its underlying hold or failure. Unknown submissions reconcile rather than blindly retry.

## Dedicated database release preflight

The ordinary manual/static review of `scripts/provision-production.mjs` and `scripts/prepare-production-schemas.mjs` resulted in additional guarded-input and foreign-access checks. Only a single supported `sslmode` query option is accepted; duplicate options, fragments and all other query parameters are refused before connection. This matters because the actual PostgreSQL driver lets query fields override URL host/user fields inspected by release guards. Empty-host connections are also refused. This is not a formal security-scan result; no formal scan ran.

Both `scripts/migrate-production.mjs` and `scripts/migrate-staging.mjs` apply the same guard to each migration/runtime connection before opening either one, including staging's protected single-URI/environment-runtime form. Invalid runtime options must refuse before applying migrations, rather than failing only during the final runtime check. Disposable database regressions prove this with a temporary PUBLIC column ACL: rejected inputs leave it intact, while a valid complete migration removes it through the ordinary grant-reset path.

Before LOGIN activation, both the runtime and migrator must have no extra memberships or effective access to application objects in any other connectable database. Audits include table and column privileges, sequences, security-definer functions, schema/database creation and PostgreSQL 17+ MAINTAIN. They are read-only in foreign catalogs. A refusal preserves foreign grants and rows for explicit owner review. The independently executable schema helper also refuses a migrator with memberships rather than relying on a previous full-provisioning run.

Existing marked roles are reused without resetting passwords. A resumed release needs the original private role secrets, not fresh replacements; wrong credentials fail authentication. An interruption between database creation and its ownership comment safely leaves an unmarked database that requires explicit reconciliation. After LOGIN activation, a failed migration can leave those roles active, but the web service must not receive their configuration until the full runtime boundary check passes. Failed provisioning is not successful deployment.

The tool checks at least 12 available nonreserved connections before preparation. Separately review the shared Render host's live disk/storage, CPU, memory and connection metrics before running it; disposable tests do not establish that capacity. The runtime role's connection limit is ten, shared by web/worker/overlapping releases, so steady-state pool budgets and deployment overlap must fit the measured host. No other application's role, grants, schema, data or provider configuration may be changed to make this audit pass. Provisioning cannot enable sending, paid billing, trial-history exceptions or hosted erasure; each keeps its independent application gates.

## Retention and trial prerequisites

The separately restricted planner, destructive executor and recovery identity retain the boundaries in [hosted retention](HOSTED_RETENTION.md). Planner configuration files and the inventory directory must be absolute, owned by the running identity, not symlinked and not accessible to group/other users. Configure exact account IDs, US regions, dedicated versioned/Object Lock checkpoint storage, purpose-separated Ed25519 public keys, and the complete renderer-instance roster. All-host disposal and external-copy inventory must be real evidence, not a local renderer callback.

No Render/Clerk/Resend credential alone establishes AWS bucket protection or account authority. Record the owner-controlled storage/account facts and independently verify protected checkpoint writes, external inventory, disposal receipts and isolated restore/quarantine before calling retention operational. Execute a disposable synthetic tenant check; customer erasure still requires its exact short-lived approval and separate offline authority.

Bring up the protected planner/executor in this order after the AWS account is available:

1. Complete migrations and the [fixed production planner/executor phases](PRODUCTION_RETENTION_BOOTSTRAP.md). Keep their connections separate from runtime and metadata operator credentials.
2. Verify dedicated versioned US-region checkpoint storage with Object Lock COMPLIANCE, the fixed expected AWS account and `retention/<name>/` prefix. Register every external-copy store under its reviewed `customer-copies/<name>/` prefix. Inventory includes all immutable object versions and delete markers with SHA-256 checksums.
3. Separate the MFA approval signer, inventory signer, engine-disposal signer, checkpoint publisher, executor and restore authorities. The executor must not obtain the MFA private key or authority to delete protected checkpoints. Do not confuse Object Lock with protection against appending stale signed facts; restrict writers and use the durable conditional checkpoint publisher.
4. Generate purpose-separated Ed25519 keys and exact public-key allowlists. Store private keys, configuration and database connection files in owner-only absolute paths (files 0600, directories 0700), without symlinks. Never place them in Git, process arguments or logs.
5. Register the complete expected engine instance/boot roster, including old and offline hosts. Establish an independent means to verify process shutdown and disposal of owned directories on every host.
6. Publish the initial signed checkpoint through `publishProtectedCheckpoint`, then collect a current signed external-copy inventory. Configure the planner's protected configuration/database files and inventory directory using the exact names and fields in [hosted retention](HOSTED_RETENTION.md).
7. Configure the separate live operator organization, named members and recent enrolled MFA. Enable protected approval signing only after its exact case review and trusted planner are operational.
8. Rehearse a disposable synthetic hosted workspace using the actual protected storage. Obtain independent engine receipts, a fresh plan and its exact MFA-signed approval (at most 15 minutes). Run the restricted offline executor through protected stdin with `{approval, externalInventory, engineReceipts}`; uncertain external outcomes require reconciliation.
9. Independently verify the durable database receipt and complete external disposal before publishing an `erased` checkpoint. Exercise restore into an isolated destination, retaining quarantine until separate review releases it. Record which evidence was live and which was injected; a synthetic rehearsal does not authorize customer deletion.

D-048 accepts the narrow lifetime trial-history exception. See the [accepted scope and remaining evidence](PROPOSED_TRIAL_RETENTION_EXCEPTION.md) and [current trial configuration](TRIAL_ABUSE.md). Actual key/policy installation, disclosure, provider/history baseline and signed private-retention inventory remain independent checks. A fresh empty database is not proof of an empty provider history; policy acceptance does not authorize hosted purge or grant operator/alert access.

## Validation and model contribution

The new disposable PostgreSQL tests exercise exact owner/migrator phases, NOLOGIN bootstrap/replay, marker and identity refusals, foreign-grant preservation, metadata-only access and PUBLIC drift rollback. They also prove that PostgreSQL MAINTAIN authority is rejected by the actual operator verifier. These checks do not claim any production credential or provider verification.

The initial operator-bootstrap change passed lint, type checking, the production build and all 91 local test files (588 tests passed, two explicitly gated engine tests skipped). Its focused production-bootstrap/platform suites passed all 13 tests. The subsequent release-guard change passed the full check again (91 files, 589 passing tests and two explicitly gated engine skips), including lint, type checking and production build. Its regression checks cover the real driver's query parsing, both roles' foreign table/column/MAINTAIN/database-create grants, no-login refusal, preservation and idempotent retry, and standalone membership refusal. No hosted configuration was changed by these checks.

Local Qwen formatted the trial-policy proposal from supplied facts. Chat corrected its misleading approved-default and physical reservation-expiry wording. Chat retained privileged SQL design, authority decisions, implementation, integration, acceptance tests and review. No token or cost percentage is inferred.
