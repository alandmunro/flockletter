# Subscriber intake staging runbook

The FFA storefront is a server-side collection client. Flockletter owns the subscriber, immutable consent history, confirmation links, outbox and suppression state. Stage and public activation are independent. The deployed foundation supports only local, test and staging environments.

## Configure the release

Apply migrations with the dedicated migrator. The web service and worker use the restricted runtime role. Migration 002 is additive and can be applied before updating the app. It protects eight new tables with workspace **and** brand policies. Consent events and received feedback are append-only for the runtime role. Run `npm run db:migrate` in the protected release environment. For an interactive Render release, `scripts/migrate-staging.mjs` accepts one private JSON line with `migrationUrl` on standard input after terminal echo has been disabled. The release validates the role, database and host against the existing staging runtime connection.

| Setting | Staging behavior |
| --- | --- |
| `FLOCKLETTER_CONFIRMATION_MODE` | Defaults to `off`. `capture` is a synthetic mailbox in the worker process. `live` invokes only the dedicated confirmation transport. |
| `FLOCKLETTER_INTAKE_WORKSPACE`, `FLOCKLETTER_INTAKE_BRAND` | Bind exactly one Clerk organization and its existing brand UUID. |
| `FLOCKLETTER_INTAKE_SOURCE_DOMAIN` | Exact approved storefront hostname. The contract accepts `storefront-footer` or `storefront-homepage`. |
| `FLOCKLETTER_CONFIRMATION_SIGNING_KEY` | Independent 32-byte random hex secret, shared between the Flockletter web service and worker. Keep it available for previously issued opt-out links. |
| `FLOCKLETTER_CONFIRMATION_RECIPIENTS` | Explicit allowlist of up to 25 staging recipients. Capture accepts only reserved example domains or `.test` recipients. |
| `FLOCKLETTER_CONFIRMATION_FROM`, `FLOCKLETTER_CONFIRMATION_FEEDBACK_SECRET` | Live mode requires the approved sender and the Flockletter webhook signing secret. Register `POST /api/v1/confirmation-feedback` for permanent bounces and complaints. |
| `FLOCKLETTER_CONFIRMATION_LIVE_APPROVED` | Set to `true` only after separate provider, sender and acceptable-use approval. |
| `FLOCKLETTER_CONFIRMATION_RESEND_KEY` | Worker only. Supply an independent Flockletter key. Resend is an optional adapter; FFA's transactional account is separate. |

Start a continuously running confirmation worker with `npm run confirmation:worker`. Give it the same Flockletter binding, restricted database and ability to verify current Clerk membership. It renews its heartbeat every 15 seconds while idle. A heartbeat older than two minutes closes intake. A job has an independent 60-second lease. Select **API & MCP** in the workspace, check readiness, enable the brand, then issue its dedicated credential. It is shown once. An ordinary preparation credential never acquires signup access.

## Storefront contract and confirmation

Send `POST /api/v1/brands/{brandId}/subscriber-signups` with `Authorization: Bearer`, `Content-Type: application/json` and `Idempotency-Key`. Use the [PR #2 request fields](FFA_SUBSCRIBER_INTAKE.md). The example in FFA PR #181 is illustrative. The accepted path includes `/api`, the operation key belongs in the header and Flockletter assigns the timestamp. Unknown fields are rejected. The strict body limit is 8 KiB. A 202 acknowledges committed intent. First-time, duplicate and suppressed addresses have the same response.

The email policy preserves the ASCII local part, dots and plus tags, trims exterior whitespace and lowercases the domain. Each connection is limited to 30 requests a minute. Each brand has limits of 60 a minute and 1,000 a day. A pending address receives at most one confirmation in 24 hours and three in seven days. Operation records have a seven-day minimum replay window. Signup never reactivates an unsubscribed, hard-bounced or complained address.

The email links carry secrets in URL fragments. GET displays the page without changing consent. The explicit same-origin POST consumes the confirmation once. Confirmation links expire after 24 hours. Opt-out remains available when intake is paused, including when the transport is turned off while the signing key and brand binding remain configured. Keep these values across restarts. Changing the signing key invalidates existing links and requires a deliberate recovery plan.

## Monitoring and recovery

Owners see counts of pending and confirmed subscribers, queued jobs, provider acceptances, captures, failures and unknown outcomes. Monitor the worker's count-only alerts for pending or leased jobs older than 15 minutes, uncertain provider responses, and failed or unknown jobs. Never copy message contents, addresses, tokens or provider response bodies into logs or support tickets.

Pause intake first if a credential leaks or abuse is suspected, then revoke it under **Your connections**. Keep the opt-out route and signed feedback active. The worker rechecks eligibility, suppression, credential validity and current issuer membership before submission. An accepted confirmation email only advances the job, not the subscriber.

A retry uses the original job key and identical payload. After six attempts or outside the 23-hour safety window, ambiguous results require provider reconciliation. In a protected release session, match the provider record to the same job tag, operation and sender. Record the provider ID and disposition before correcting the scoped outbox row. If acceptance cannot be established, leave the job unknown and investigate; do not create a fresh send. A signed permanent-bounce or complaint event also reconciles the mapped job and suppresses its subscriber. [Provider idempotency](https://resend.com/changelog/idempotency-keys) · [Signed feedback](https://resend.com/docs/webhooks/verify-webhooks-requests)

Rollback starts by disabling the brand and stopping the worker. Keep the additive schema, consent history, suppression state, signing material and private migration group. Restore the previous application revision only with delivery held. Avoid re-running older blanket grants against these tables.

## Verification

- FI-001–005 and FI-012–013 exercise the exact FFA payload, durable 202, replay and conflict, concurrent duplicates, fixed consent policy, server timestamps, body size, rate limits and redaction. Tests use Flockletter PostgreSQL only.
- FI-006–007 exercise forced workspace/brand RLS, composite references, append-only evidence, dedicated single-brand grants, current issuer membership, and revocation at intake and at dispatch.
- FI-008–011 exercise transaction rollback, leases, retry and uncertain outcomes, single-use expiry, scanner-safe GET, suppression priority, confirmation and unsubscribe, disabled-brand and worker-readiness gates. Captures and provider stubs are clearly labeled in tests.
- FI-014 includes `npm run check`, generated OpenAPI parity and `node --import tsx scripts/prove-intake.ts local`. The latter runs an actual HTTP consumer with a disposable restricted Postgres role and an in-memory confirmation mailbox. The corresponding `staging` mode runs on private Render loopback, with an isolated synthetic workspace in the real Flockletter staging database; it pauses that fixture and revokes its credential on exit.
- FI-015 keeps public FFA collection, real confirmation sending and production gated. End-to-end testing through FFA's storefront requires the separate PR #181 implementation. Real provider acceptance requires its own verified sender, signed feedback setup, acceptable-use decision and approved test recipient.

### November 7 staging proof

Revision `40e2805` passed 114 tests, lint, strict type checking and the production build. CI also checked generated OpenAPI parity and audited the dependency graph. [CI run](https://github.com/alandmunro/flockletter/actions/runs/42396875843)

The isolated Render release process applied migration 002 to the existing `flockletter_staging` database with the dedicated migrator. `scripts/prove-intake.ts staging` then passed against the restricted staging runtime role. The FFA-format HTTP consumer received the expected 202, replay, conflict and validation responses. One captured confirmation was generated, GET left it pending, explicit POST confirmed it once, and opt-out survived a fresh signup. The private fixture revoked its token, verified the resulting 401 and paused its brand. The live storefront, live mail provider and real customer addresses were outside this controlled exercise.

The local model drafted the admin intake panel, the signup schema tests and the first operator notes. Chat corrected the tests' consent/source fixture and the UI's assumed response shape, credential recovery and connection-list refresh. Chat implemented the data, authorization, worker, provider-safety and confirmation boundaries and reviewed the integrated result.
