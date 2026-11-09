# Fixed production retention role bootstrap

This prepares FL-AUD-005, FL-ID-005 and FL-OPS-005 without enabling hosted erasure or issuing credentials. The fixed database is `flockletter_production`; the database/role marker is exactly `Flockletter production foundation`. The local model drafted the phase table and checklist. Chat corrected its role-creation actor, replaced shell-pipe placeholders with executable examples, and retained privilege decisions, implementation and validation.

| Phase | Apply SQL as | Effect |
| --- | --- | --- |
| `role` | Actual marked database owner, with CREATEROLE | Create only the missing exact role with NOLOGIN, NOINHERIT, no elevated attributes, connection limit two and the correct marker. No password is generated or assigned. |
| `database` | Actual marked database owner | Reset only that role's direct privileges on this database and grant CONNECT. |
| `objects` | Marked `flockletter_production_migrator` | Reset only the role's direct object grants in the three Flockletter namespaces; grant exact rights and transactionally verify effective access. |

The fixed roles are `flockletter_production_retention_planner` and `flockletter_production_retention_executor`. Existing roles must already be marked, restricted, NOLOGIN, without memberships, sessions or owned objects. Replays do not rotate existing credentials or change their attributes to make an unsafe role pass. The metadata operator's corresponding creation phase is documented in [operator bootstrap](PRODUCTION_OPERATOR_BOOTSTRAP.md).

Run each generator in the reviewed release checkout to obtain SQL; the generators themselves do not connect to PostgreSQL:

```sh
APP_ENV=production node --import tsx scripts/provision-production-retention.ts planner role
APP_ENV=production node --import tsx scripts/provision-production-retention.ts planner database
APP_ENV=production node --import tsx scripts/provision-production-retention.ts planner objects
APP_ENV=production node --import tsx scripts/provision-production-retention.ts executor role
APP_ENV=production node --import tsx scripts/provision-production-retention.ts executor database
APP_ENV=production node --import tsx scripts/provision-production-retention.ts executor objects
```

Review each output and apply its transaction through the separately protected release connection, treating every database error as fatal. Complete migrations before object grants. Do not combine the owner and migrator connections or grant either role broad membership to bypass ownership. The generic `scripts/retention-operator-grants.ts` remains available for isolated/nonproduction setups and refuses production; its combined database, role and object operations are unsuitable for the production ownership split.

The planner receives SELECT on the public runtime manifest and four private inventory tables, plus EXECUTE on `trial_retention_inventory`. The executor additionally receives the exact DELETE/UPDATE/journal privileges in [hosted retention](HOSTED_RETENTION.md) and EXECUTE on `trial_expire_claims`. The generated transaction verifies the entire expected table/permission set and exact callable functions, rejecting extra PUBLIC/column/sequence/CREATE/MAINTAIN access. It never modifies PUBLIC grants or another database.

Migration 029's private `confirmation_routes` and public `customer_audience_feedback` are included. Migration 030's `worker_instances` contains global process metadata: neither retention role can read/delete it or call heartbeat/liveness routines. Trial claim tables remain private; inventory/expiry functions are the only approved route into trial facts.

Keep both roles NOLOGIN after all phases. Separate protected credential issuance/activation must include a foreign-database effective-access audit and `verifyRetentionIdentity` using the actual restricted connection. Object grants alone cannot establish safe access elsewhere on a shared host. Install planner/executor credentials only in their owner-only files; neither belongs on the web runtime. Finish the [protected storage, signing, rehearsal and restore checklist](PRODUCTION_OPERATOR_BOOTSTRAP.md#retention-and-trial-prerequisites) before operational activation. No SQL generator authorizes customer deletion or accepts the lifetime trial-retention exception.

Software verification uses real disposable PostgreSQL with a nonsuper CREATEROLE database owner and a distinct migration actor. It proves role markers/NOLOGIN/no-password creation and replay, actor refusals, 029 permissions, 030 denial, table/sequence/function PUBLIC drift rollback and actual-role identity checks. It does not prove live Render role installation, AWS storage protection or hosted disposal.

The completed workstream passed lint, type checking, the production build and all 98 test files: 637 tests passed and two explicitly gated engine tests skipped. The focused paired-migration/production-role suite passed all 11 tests. No hosted roles, credentials or data were changed by these checks.
