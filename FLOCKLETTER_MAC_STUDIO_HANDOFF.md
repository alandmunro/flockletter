# Flockletter Mac Studio handoff — birthday and anniversary automations

Pick up the five existing feature branches in `alandmunro/flockletter`. Take each one through a GitHub PR, green checks, merge into `main`, deployment to hosted staging, and a functional staging test. Report the result in the Mac thread before starting the next PR. The owner has authorized routine fixes, pushes, merges and staging releases. Work independently through recoverable failures. The requested endpoint for this feature is staging with synthetic recipients and captured delivery.

## Where the cloud session stopped

On November 25, 2026, Git showed `main` at `4b1c5f0b945658cb4a9ddb673fda0dc7180d6087` (PR #109). All five feature branches were published. The cloud session recorded **zero feature PRs opened, zero feature merges into main, and zero hosted staging tests**. Cloud access to the GitHub API and hosted staging was blocked. The Mac can resume with its existing access. Fetch current state before acting on this snapshot.

| Order | Published branch | Tip at handoff | What is already built |
| --- | --- | --- | --- |
| 1 | `feat/date-01-recurrence` | `973a709d1a51` | Brand-scoped date selection, legacy and shared-phone handling, local time, leap-day and DST rules. Migration 045. |
| 2 | `feat/date-02-definitions` | `5e689f34ff96` | Versioned definitions, occurrence ledger, scoped HTTP and MCP commands for drafts, approval, pause, history and cancellation. Migration 046. |
| 3 | `feat/date-03-scheduler` | `7407e9b09e46` | Thirty-day planner, restart recovery, two-local-day catch-up, duplicate prevention and progress across brands. |
| 4 | `feat/date-04-delivery` | `15766eb80ef1` | SMS-first submission, optional eligible marketing email fallback, consent and allowance checks, durable receipts and reconciliation. Migration 047. |
| 5 | `feat/date-05-controls` | `71053fc20ea3` | Owner controls under Audience, projected recipients and channels, activation review, cancellation, history, legacy-date confirmation and operational guidance. |

The cloud rehearsed all five merges into a disposable checkout of that main revision. Each transition passed a PostgreSQL schema-compatibility rehearsal. The combined checkout passed 76 focused tests, a production build, OpenAPI regeneration and desktop/mobile Chromium plus scoped HTTP/MCP checks. Those results are a baseline for diagnosing regressions. GitHub checks and hosted staging results for each actual merge SHA still need to be collected. [Recorded local evidence](https://github.com/alandmunro/flockletter/blob/71053fc20ea38409460e914a53b96a7f61622ce4/docs/TRACEABILITY.md)

## Start on the Mac

1. Open the local Flockletter clone in Codex. Read `AGENTS.md`. Use a fresh worktree if the checkout contains someone’s changes. Use Node 24 and `npm ci` in the working checkout. Use the existing authenticated GitHub CLI and staging access on the Mac. Keep credentials and private release files in their existing protected locations.
2. Synchronize and inspect the branches and all prior PR states. Preserve work that landed since the cloud snapshot. For an already merged PR, retrieve its merge SHA and staging evidence. Resume at the first incomplete step. If staging has advanced, check deployment history and ancestry before dispatching an older release.

   ```sh
   repo=alandmunro/flockletter
   gh auth status
   git fetch origin '+refs/heads/main:refs/remotes/origin/main' \
     '+refs/heads/feat/date-*:refs/remotes/origin/feat/date-*'
   git log -1 --oneline origin/main
   for branch in feat/date-01-recurrence feat/date-02-definitions \
     feat/date-03-scheduler feat/date-04-delivery feat/date-05-controls
   do
     git log -1 --oneline "origin/$branch"
     gh pr list --repo "$repo" --head "$branch" --state all \
       --json number,state,url,baseRefName,headRefOid,mergeCommit
   done
   ```

3. Read the implementation plan and feature runbook **at the fifth branch tip**. They include the acceptance fixtures and decisions used to build the stack. Use the current release runbooks on main for hosted operations. [Implementation plan](https://github.com/alandmunro/flockletter/blob/71053fc20ea38409460e914a53b96a7f61622ce4/docs/implementation/DATE_AUTOMATIONS_PLAN.md) · [Feature runbook](https://github.com/alandmunro/flockletter/blob/71053fc20ea38409460e914a53b96a7f61622ce4/docs/implementation/DATE_AUTOMATIONS.md) · [Staging](https://github.com/alandmunro/flockletter/blob/main/docs/implementation/STAGING.md) · [Protected release runner](https://github.com/alandmunro/flockletter/blob/main/docs/implementation/RELEASE_RUNNER.md)

## Repeat for each PR, in order

1. Review `git diff origin/main...origin/$branch` for the current step after the preceding step has landed. Compare the code and tests against the corresponding acceptance row below. Fix any gaps on that feature branch. If the branch needs current main, merge `origin/main` into it, resolve conflicts and push the reviewed commit. Run `npm run check` and the focused tests for the affected behavior.
2. Reuse the open PR if one exists. Otherwise open a PR with base `main` and the current feature branch as head. Describe its scope, migration, local results and planned staging test. Watch `gh pr checks "$pr" --repo "$repo" --watch`. Allow checks time to appear. For failures, inspect the failing job, fix the cause, push and watch the new head. Honor branch protections and required reviews.
3. Once checks pass, obtain `headRefOid` from `gh pr view`. Use a **merge commit** to preserve the ancestry of the remaining stacked branches. Run `gh pr merge "$pr" --repo "$repo" --merge --match-head-commit "$head_sha"`. Verify the PR state is `MERGED`, retrieve its full `mergeCommit.oid` as `merge_sha`, and verify it is on `origin/main` after fetching. Wait for successful `ci.yml` and `selfhost.yml` runs **on that exact merge SHA**. The staging workflow checks both.
4. Read the live staging web SHA from `/api/health/version`, check `/readyz`, and obtain the live worker revision from Render. For an embedded worker, use its web revision. Compare the deployed revision’s migrations to the candidate. When changed or unknown, use the protected **staging** procedure, with fresh compatibility evidence for the actual web, worker and candidate revisions, and verify the restricted runtime after migration. Set `migrations_applied=true` only after that migration succeeds. Use `false` for a verified unchanged migration set. The deploy workflow acts on the web service. For a dedicated worker, use its existing staging release procedure and verify its live revision too.
5. Dispatch the staging workflow with a unique correlation ID. Use the printed title to identify the run and watch that specific run through completion. Check the staging service’s `buildSha` against `merge_sha`, readiness, and worker heartbeat where applicable.

   ```sh
   request_id=$(openssl rand -hex 16)
   gh workflow run deploy-staging.yml --repo "$repo" --ref main \
     -f sha="$merge_sha" -f migrations_applied="$migrations_applied" \
     -f request_id="$request_id"
   echo "Look for: Deploy to staging · $request_id"
   gh run list --repo "$repo" --workflow deploy-staging.yml --event workflow_dispatch \
     --limit 20 --json databaseId,displayTitle,status,url
   # Set run_id to the databaseId of the matching title once it appears.
   gh run watch "$run_id" --repo "$repo" --exit-status
   ```

6. Run the applicable hosted acceptance below. Report the PR URL, full merge SHA, Actions and staging run URLs, verified web/worker revisions, test performed and observed result in the Mac thread. Then proceed to the next branch. If a hosted test fails after merge, diagnose and ship the fix through the normal PR path, restage and repeat the failed test before continuing. Preserve a precise checkpoint if an external permission or service blocks further progress.

## What to verify on hosted staging

Use two synthetic workspaces and the staging sign-in. When exercising automation, configure `FLOCKLETTER_DATE_AUTOMATIONS=capture` on staging web and worker, with mock texting, captured customer email, the private renderer and exercise billing. Record the effective modes before activating a fixture. Use the surface available at each release. `scripts/prove-date-automations.ts` creates its own local fixture and server. Record its output as local or CI evidence. Hosted evidence comes from the deployed staging service.

| After PR | Hosted acceptance |
| --- | --- |
| 1 | Verify migration 045 and restricted-runtime readiness. Through the existing Audience flow, save and reopen a synthetic birthday and a labeled anniversary. Check isolation using a second workspace. Record leap-day, DST and ambiguous-phone selection from the deterministic tests while the new planner still has no hosted UI. |
| 2 | With an authorized owner or scoped connection, create a draft, preview it, revise it and attempt activation against the stale revision. Verify stale activation and cross-brand access are refused, the current revision can be approved, and a draft creates no outbound submission. |
| 3 | Use dates inside the next 30 days. Observe the worker pass, compare projected dates with independently calculated expectations, cancel a single occurrence, and verify another pass preserves cancellation and creates no duplicate. Use disposable fixtures for worker-race, long-outage and 22-brand coverage. |
| 4 | Exercise one eligible mock SMS, one separately approved email fallback for an email-eligible recipient, and one held or revoked case. Compare receipts, chosen channel and usage. Check that a repeat pass produces no second submission, that an uncertain SMS stays on its channel, and that an eligible fallback uses one email recipient and one campaign slot. |
| 5 | In the signed-in staging UI, preview and activate a birthday and a labeled anniversary on desktop. Verify the expected channel and local time, cancel one occurrence on mobile, inspect history, and pause a definition. Exercise scoped HTTP/MCP access and a refused grant, and verify the second workspace cannot see the first workspace’s records. Reconcile all fixture outcomes against expected dates. |

Completion is five merged PRs with verifiable staging results for each. Give the owner a final table with links and record any remaining evidence gaps. The separate 30-day unattended owner pilot and a production release require their own follow-up. The current handoff covers plain birthday and anniversary greetings.
