# Flockletter Release Runner Operational Runbook

Applicable requirements: FL-OPS-001/003/006/007. This is release preparation tooling, not live-provider or hosted deployment evidence.

## 1. Workflow Overview
The release runner supports eight fixed operations: `production.inspect/prepare/apply/migrate` and `staging.inspect/prepare/apply/migrate`.

1.  **Prepare Target:** Create an owner-private JSON target file containing the operation, host, port, and fixed role/database names.
2.  **Generate Plan:** Execute the `plan` command to generate a public correlation bundle containing fingerprints and digests.
3.  **Prepare Input:** Create an owner-private input file containing scoped provisioning data or paired URLs.
4.  **Execute:** Run the `execute` command referencing both the plan and input files by absolute path.
5.  **Reconcile:** In case of failure, reconcile state before retrying.

## 2. Command Reference

| Step | Command | Description |
| :--- | :--- | :--- |
| **Plan** | `node scripts/release-runner.mjs plan /absolute/owner-private/target.json` | Generates `{ok:true,plan,planDigest}`. Save output securely as `plan.json`. |
| **Execute** | `node scripts/release-runner.mjs execute /absolute/owner-private/plan.json /absolute/owner-private/input.json` | Runs the operation using fixed child dispatch. |

## 3. File & Security Boundaries

### Target Specification (Nonsecret)

Nonsecret does not mean suitable for public sharing: target and plan files identify private infrastructure. Keep them outside Git and ordinary logs, with access limited to approved operators.
*   **Fields:** `version: 1`, `operation`, `host`, `port` (numeric).
*   **Fixed Values:**
    *   Database: `flockletter_<environment>`
    *   Migration Role: `flockletter_<environment>_migrator`
    *   Runtime Role: `flockletter_<environment>_runtime`
*   **Provisioning Additions:** Requires `sourceDatabase` and `administratorRole`.
*   **Validation:** Source must contain the correct environment token (`production`/`prod` or `staging`) and no opposing, `dev`, `development` or `test` tokens. The source cannot equal the target database. An expected host/source must come from the separately reviewed target specification, never be derived from a credential and presented as verification.

The plan records the exact operation, environment, target, `targetFingerprint`, `sourceFingerprint`, random `operationId` and `createdAt`. Source correlation covers every release MJS script, SQL migration, runtime boundary, public runtime-table manifest and package/lock files. Source files and ancestors must be owned by root/current UID, without group/world write access except trusted root-owned sticky system ancestors; source symlinks and files over four MiB are refused. Install dependencies from the reviewed lock first: this fingerprint is not installed-dependency or remote-machine attestation.

Generate and review the plan from the approved release checkout. Compare its source fingerprint independently with that approved artifact before supplying credentials on the release host; a plan produced by an untrusted process cannot authenticate that process. Execution recomputes the source fingerprint before private-file access and again before child dispatch.

The private input file is an envelope with `version: 1`, the exact `operation`, the bundle's `planDigest`, and `input`. The `input` is the existing scoped provisioning object or `{migrationUrl, runtimeUrl}` for migrations. `planDigest` is not a secret and grants no authority. Review and bind host/port/database/roles/source before obtaining or opening credentials.

Private files are transient release transport, not the credential source of truth. Keep authoritative secrets in the approved protected store and reuse the original values for reconciliation/retry; do not make an ephemeral service filesystem their only copy. Dependencies must be installed before preparing the source-bound plan. Refresh the plan after a source change or expiry.

### Private File Safeguards
*   **Paths:** Canonical absolute paths. No symlinks or hardlinks.
*   **Permissions:** Regular files owned by current UID, inaccessible to group/other users (`0600` recommended). Immediate directory is owner-private (`0700`).
*   **Ancestors:** Must be root/current-owner. Not group/world-writable, except trusted root-owned sticky system directories (e.g., `/private/tmp`).
*   **Timing:** Plan max 30 minutes old, max 1 minute future. Plan shape, age, target digest and exact source are checked before opening private input. Private connections must match the plan's selected host/port and source/admin role; migration/runtime roles and database are fixed by environment.
*   **Validation:** All missing/invalid static fields are returned together as codes before any DB connection or mutation.

### Execution Constraints
*   **Credentials:** Never paste secrets at a browser terminal. `argv` carries file paths only; no actual credentials in docs or arguments.
*   **Child Dispatch:** Fixed `process.execPath`, `shell:false`, direct JSON stdin.
*   **Environment:** Only `APP_ENV` is passed to the child process. No inherited service credentials or shell evaluation.
*   **Output:** Runner emits only static result codes and source/target digests. `stdout`/`stderr` from child are discarded.
*   **Nature:** This is protected file ownership/correlation, not tag authentication or remote identity proof.

## 4. Environment-Specific Requirements

| Feature | Staging | Production |
| :--- | :--- | :--- |
| **`APP_ENV`** | `staging` | `production` |
| **Confirmation Flag** | `confirmStaging: true` | `confirmProduction: true` |
| **Apply Passwords** | Valid distinct 64-hex before connection | Valid distinct 64-hex before connection |

*   **Access Audit:** Both environments audit runtime and migrator effective access for foreign table/column/sequence/security-definer/schema/database CREATE and PG17MAINTAIN.
*   **Grants:** Foreign grants are never repaired automatically.
*   **Secrets:** Existing secrets are reused on retries; they are never rotated automatically.

## 5. Explicit Non-Goals
*   No new automatic LOGIN activation, provider activation, live charge, sending, or hosted purge.
    The existing `apply` operation still provisions and activates its runtime/migrator roles; this work adds no activation of the metadata operator, planner or executor.
*   No external services are changed by local software tests.
*   Existing manual fallback ready tags do not constitute authentication.

## 6. Verification and model contributions

Disposable PostgreSQL checks prove invalid apply passwords leave database/role catalogs and source ACLs unchanged; protected runner inspection works for both environments; child provider environment values and raw output are not inherited/forwarded; and failure returns only static uncertainty/reconciliation codes. File tests cover permissions, ownership contract, symlink/hardlink refusals, source/target mismatch before private-file access, exact operation binding, stale/future plans and size limits. These are software tests, not live Render, hosted sign-in or provider verification.

Final validation passed lint, type checking, the production build and all 101 test files: 662 tests passed and two explicitly gated engine tests skipped. The five focused preflight/provisioning/migration suites passed all 14 tests. Both paired-URI suites prove malformed userinfo and even empty URL fragments refuse before migrations, preserving the disposable grant sentinel.

Local Qwen drafted this runbook (53.18 seconds, 3,867 output characters). Chat corrected the version-key syntax, an overstated secure-bundle phrase, exact permission wording and missing digest/envelope/dependency caveats. Chat retained input contracts, authority decisions, implementation, negative test design, integration and final review. No measured token or cost percentage is available.
