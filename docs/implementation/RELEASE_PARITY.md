# Flockletter release parity

D-044 authorizes Flockletter production and staging code promotion. Applicable requirements: FL-ID-001, FL-API-001/003, FL-OPS-001–007, FL-DEL-001–005 and FL-SUP-002. Code parity means the same reviewed Git source tree, not shared credentials, customer data or provider modes.

## Release record

At the start of this promotion, staging ran `310b76a1ad4be5cfa1e35ecf22fb7f3479ea34ea` from `codex/foundation-workflow`. GitHub `main` was 57 commits behind. No Flockletter production service existed. The private Tailscale entry point forwards to staging; it is not a separate development deployment.

PR #24 merged the tested release into `main` as `f7a5e3ddb314a8ec596155664da368b0d6d8c549`. Its source tree and the staging-tested tree are both `ef983f14d2cd3bc8e0d17100547b1a1c0ee6b01d`. Staging was switched to manual deployments from `main`; deploy `dep-dbogljhsrm7s73btvj40` became live with that commit. Its Free compute plan and provider settings were preserved.

Production preparation is not production verification. Record each resulting deployment commit, source-tree ID and readiness result before marking parity complete. A merge commit can differ while its Git tree remains identical. Builds may vary by operating system and approved environment configuration; do not claim identical artifact hashes without measuring them.

## Protected production release commands

Prefer the [protected file release runner](RELEASE_RUNNER.md), which binds a separately supplied target specification and exact source before reading private input, then sends JSON directly to a fixed child. This avoids browser-terminal credential pasting. Legacy interactive `PRIVATE_INPUT_READY` tags only correlate a process; they do not authenticate it or prove that a later browser action still targets that process.

Use an echo-disabled, history-disabled private release shell on Render's internal network, pinned to the reviewed commit. The Postgres external firewall remains closed. Do not place administrator or migration credentials in web-service settings, shell arguments or logs.

`APP_ENV=production node scripts/provision-production.mjs inspect <operation-tag>` reads a protected JSON line containing `adminUrl`, `expectedHost`, `expectedSource` and `confirmProduction: true`. The source must match the exact reviewed host/database and its production designation; fixed target names and ownership markers prevent adoption of unrelated resources. `prepare` creates only the new Flockletter database with connections disabled. `apply` additionally accepts distinct 32-byte random hex `runtimePassword` and `migratorPassword`, audits capacity and effective foreign grants, prepares the two private namespaces, applies migrations and verifies the restricted runtime. Reuse the same private inputs on retries. Existing role secrets are never silently rotated.

For later releases, `APP_ENV=production node scripts/migrate-production.mjs <operation-tag> --pair-stdin` accepts `migrationUrl` and `runtimeUrl` on the protected input stream. It requires the exact Flockletter production database/roles and the same host/port, checks the actual migration identity, then rechecks runtime permissions. It cannot fall back to a web-service credential. Staging remains separately scoped; direct provisioning now explicitly requires `APP_ENV=staging` and `confirmStaging: true`, and uses the same guarded options, early input validation and read-only foreign audit as production.

## Promotion checklist

- Compare all active development work and remote branches; preserve unrelated uncommitted work. Review the exact release tree and its migration changes.
- Require lint, type checks, tests, production build, API regeneration, dependency audit, private Listmonk integration, browser journeys and the restore drill to pass for the promoted tree.
- Merge the staging-tested release into `main` with an expected-head check. Use manual deployment and inspect the actual running commit; a successful build alone is insufficient.
- Keep staging on Free compute with its existing isolated database, development Clerk and captured/exercise provider settings. Sleeping staging is not continuous scheduling.
- Prepare a separate `flockletter_production` logical database and restricted migration/runtime roles. Inspect shared-host capacity and effective foreign privileges on Render's private network. Preserve all other applications' schemas, roles, grants and settings. Refuse unsafe inherited access rather than repairing another application's grants.
- Use a dedicated Clerk production instance and production keys. Do not copy staging users or organizations. Keep migration credentials outside the web service in an unlinked release group.
- Production must use `APP_ENV=production`; synthetic identity, captured providers and exercise modes are forbidden. Missing configuration must fail closed. Real billing, newsletter delivery, confirmation/support mail, resource provisioning and erasure retain their separate activation requirements.
- Verify health/readiness, deployed revision, anonymous access rejection and current-owner workspace access after refresh. Customer, administration and MCP operations must use the same canonical server contracts. A local fixture is not a hosted authentication test.
- Move the canonical domain only after production is ready. Retain a separate staging origin and update exact origin/Clerk redirect configuration, including the private proxy, before cutover. Preserve existing mail-routing records.
- Keep rollback tied to a previously reviewed compatible code/configuration pair. Never undo durable provider outcomes, restore old trial keys, or bypass restore quarantine to make a health check pass.

## Activation ledger

| Capability | Staging policy | Initial production policy |
| --- | --- | --- |
| Login and workspace persistence | Existing development Clerk and staging database | Separate production Clerk, database and roles; verify hosted sign-in |
| Customer workflows | Existing capture/exercise modes | Default off until each external integration is configured and verified |
| Team invitations | Exercise | Enable real Clerk invitations only after production membership setup is verified |
| Global operator access | Own-workspace capture only | Off until separate operator organization, named users, recent MFA and restricted role are verified |
| Paid trial history | Synthetic namespace | D-048 policy accepted; actual stable key/policy configuration, disclosure, provider/history baseline and current-owner agreement still required |
| Hosted erasure | Disposable capture | Independent restricted executor and exact approvals; no customer HTTP/MCP deletion |

The local model drafted the checklist, mechanical production-script conversions and disposable-database test scaffolding. Chat corrected an unsupported completed-parity claim, merge-SHA/build-hash equality, assumptions about existing credentials, escaped source formatting and test-order assumptions. Chat removed a private physical-database identifier from the draft, added explicit production confirmation/environment checks and reviewed foreign-grant preservation, migration scope and secret handling. Security decisions, environment boundaries and release evidence remain with Chat.


## Dedicated production worker release

The production queue service is a separate background worker in the same Render workspace, project environment and region as the web service. Both use restricted Flockletter runtime authority. The worker build must include development build tools (`npm ci --include=dev && npm run build`); it starts the compiled standalone entry point with explicit dedicated mode. Staging stays on Free with embedded captured execution. Do not copy migration, operator, Stripe, AWS or Resend credentials merely to prepare an idle worker.

Production promotion requires `RENDER_PRODUCTION_WORKER_SERVICE_ID` in protected repository configuration in addition to the web service reference. Its read-only destination check validates distinct exact resource IDs, types, repository, main branch, manual deployment, nonsuspended state, matching owner/environment/region, the production web origin and canonical worker entry point. Missing or mismatched destinations stop before any deployment, including in dry runs.

After the existing exact-commit CI, staging and migration gates, deploy the worker first and wait for a terminal result. Public workflow output omits resource/deployment identifiers, credentials and raw provider error bodies. The deployment helper requires Render's live response to report the exact requested commit; missing or different commit proof fails. Only then deploy the web service at that same commit and verify its readiness and version on both configured addresses. A worker failure prevents the web deployment. A later web failure can leave the newer worker running with the prior web; releases must preserve migration and mixed-version compatibility, and an operator must inspect actual outcomes before retry or rollback. Deployment does not undo durable jobs, messages or payment outcomes.

Render's live state proves deployment completion, not scheduler health. Inspect the protected dedicated heartbeat, queue-pass history and failures separately before operational acceptance. The initial idle-worker verification rechecked runtime database boundaries and observed a fresh dedicated heartbeat. Connection headroom exceeded the bounded web/worker overlap budget, but this is not a mailing-engine throughput or full-cohort capacity claim. Worker provider modes remain off, and live billing/sending remain separately disabled.

Local Qwen drafted the negative destination tests and shell transport fixture. Chat corrected test typing, a same-ID assertion, missing imports, shell-template/argument parsing and PATH handling; primary review owns the target binding, exact-commit proof, sequencing, runtime credential boundaries and hosted verification.

Validation passed lint, type checking, production build and 117 test files (918 passed; two existing gated native checks skipped). Additional focused transport cases verify raw provider-error and unknown-status redaction. The destination predicate also accepted actual read-only Render metadata for the intended web/worker pair. These checks are not a live deployment; production dry run and promotion are recorded separately after observation.
