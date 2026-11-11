# Protected complimentary access

Applicable requirements: FL-BIL-001/008, FL-ID-002/003/005, FL-ONB-004, FL-USG-001/002/006 and FL-OPS-003/006. D-053 authorizes completing the production writer and applying the accepted FFA Growth entitlement to the owner-selected existing workspace, after staging verification. It authorizes no Stripe operation, message or provider activation.

Grant/revocation writes remain a protected platform release operation. Customer web/worker roles retain read-only access to `workspace_access_events`; customer UI/API/MCP callers gain no grant-writing capability. Existing canonical reads supply the same entitlement and catalogue to every surface. Names and email domains never establish entitlement authority.

## Inspect and apply

First verify the actual Clerk organization/current owner, the selected application workspace and existing brand, and the operator's authorization. Independently verify the Render database host/port. Keep those references private. Never derive an expected host from a credential and call that independent review. Pin the release service to the tested source. Migration credentials stay outside customer web/worker settings and public network access stays closed.

The existing `scripts/access-cli.ts <grant-file>` form remains staging-only. New forms are:

```sh
node --import tsx scripts/access-cli.ts inspect /absolute/owner-private/target.json
node --import tsx scripts/access-cli.ts apply /absolute/owner-private/target.json
```

The target is a credential-free owner-private regular file in an owner-private directory, under the existing protected-release file checks:

```json
{
  "version": 1,
  "environment": "production",
  "expectedHost": "reviewed-database.internal",
  "expectedPort": 5432,
  "expectedCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "confirmApply": false,
  "change": {
    "workspaceId": "org_reviewed_example",
    "plan": "growth",
    "operator": "Reviewed operator",
    "reason": "Approved complimentary entitlement",
    "operationKey": "11111111-1111-4111-8111-111111111111"
  },
  "guard": {
    "expectedRevision": 0,
    "expectedWorkspaceName": "Reviewed workspace",
    "expectedBrandId": "22222222-2222-4222-8222-222222222222",
    "expectedBrandName": "Reviewed brand",
    "requireNoBillingHistory": true
  }
}
```

Replace examples with the reviewed references/SHA. The process requires matching `APP_ENV`, `RENDER_GIT_COMMIT` and protected `MIGRATION_DATABASE_URL`. The connection must match the independent host/port and fixed `flockletter_<environment>` database / `_migrator` role. Driver overrides, duplicate options and fragments are refused. The actual role/database must have the exact foundation markers, with no elevated role flags, inheritance or memberships. One connection is used.

`inspect` takes the shared workspace lock and writes no entitlement event. Review its result and the target, then change only `confirmApply` to true for `apply`. Wrong modes, fields, source/environment or absent confirmation fail before connection. Apply rechecks workspace/brand identity and current revision inside the same transaction/lock as the grant write. Existing sandbox checkouts, subscriptions, billing intents/events or trial-card setup history prevent a new guarded grant, including pending/uncertain billing work. Retention quarantine remains enforced. Every shared writer lookup explicitly constrains workspace even under a privileged test identity.

The existing event ledger records operator, reason, tier, increasing revision, operation key and database-recorded effective time. Exact retries return the original receipt; conflicting reuse fails. Revocation appends `plan: null` under a fresh key/current revision. Replaying an old grant cannot restore revoked access. CLI output separates the historical receipt from current effective plan/revision and omits credentials, supplied names and raw provider/database errors.

A failed/lost response can follow a committed event. Inspect/reconcile the original key before retrying; never issue a replacement key to hide uncertainty. Rollback does not erase grant history. Revocation requires its own reviewed event. Existing usage, consent, sender checks and holds are not reset by a grant.

## Verification sequence

1. Pass lint, type checking, tests and build. Deploy the reviewed source to Free staging, keeping captured provider modes.
2. Through the isolated staging release identity, inspect/apply an explicitly synthetic grant. Verify canonical limits, retry, audit and revocation without a provider call. Preserve the synthetic audit evidence.
3. Promote the exact tested source through the guarded production workflow; sending/billing remain off.
4. Inspect the approved production workspace/brand and zero billing-history condition. Apply only its accepted Growth grant, without a second workspace, card or Stripe resource.
5. Verify the durable event, effective date and current restricted-runtime reads. Refresh Subscription/Workspace and canonical API/MCP entitlement views. Growth has five campaigns, 5,000 active contacts/per-campaign recipients, 25,000 monthly emails and three users/companies/brands, pooled across the workspace.
6. Verify delivery prerequisites, consent/suppression, holds and consumed/reserved usage remain independent. Remove the temporary release service and unlink credentials afterward; authoritative credentials remain in the approved secret store.

## Evidence and models

Local release checks passed: lint, type checking, 982 tests across 123 files (two existing gated checks skipped), and the production build. Focused canonical UI/API/MCP entitlement checks also run against the disposable database; hosted issuance is recorded separately.

The local model drafted disposable-database grant tests. Primary review removed speculative comments/unused imports, fixed unscoped runtime queries that made empty-row assertions vacuous, and strengthened permission/audit checks. Primary work owns production release/authority design, connection guards, billing-history/locking logic, independent CLI/identity/concurrency regressions, integration and review. Test results and hosted grant receipts are recorded only after observation; local checks do not establish production issuance.
