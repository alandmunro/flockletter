# Worker liveness and queue progress

This implements FL-ONB-004 and FL-OPS-002/003/005/006 for dedicated production workers and embedded staging workers. Worker configuration, process liveness, recent queue progress and customer send eligibility are different facts.

## Authoritative observations

`CustomerWorkflows.run()` generates an ephemeral UUID inside the trusted server process and starts a heartbeat task independent of due work. The task records a database-clock observation every 15 seconds, including while the scheduler is idle or waiting for workspace work. On clean shutdown it records a stop. Failed writes log only a static diagnostic and never manufacture successful evidence.

The private `flockletter_customer_jobs.worker_instances` table stores only the UUID, the bounded embedded/dedicated kind, first heartbeat time, latest heartbeat and optional stop. It contains no workspace, customer, host or credential identifiers. The runtime has no direct table privileges. Three fixed-search-path, migration-owned SECURITY DEFINER functions accept or report only this operational metadata; customer commands and delegated MCP grants cannot record a heartbeat.

Liveness uses the database clock with a 60-second freshness window:

| State | Meaning |
| --- | --- |
| `unknown` | No heartbeat has been observed for the configured worker kind, or a future timestamp cannot be trusted. Configuration alone is insufficient. |
| `fresh` | A matching active process reported within the last 60 seconds. This proves recent trusted-process activity, not successful queue processing. |
| `stale` | A matching active record exists, but its observation has expired. It does not prove the process is dead; current liveness is unverified. |
| `stopped` | Only stopped records remain for that kind. A clean stop cannot continue to satisfy freshness. |

During deployment overlap an active instance is preferred over a stopped one. A stopped instance ID cannot be reused or changed to a different kind. Records older than one day are removed on the next heartbeat; at most the 16 newest stopped records are retained and the table is capped at 64 records. The first heartbeat time is an observation of process startup, not an operating-system uptime attestation.

The same protected runtime credential is used by the trusted web/worker application. This signal is operational liveness, **not independent attestation** against compromise of that credential. It must never release a hold, override consent, establish payment, authorize erasure or bypass a sending gate.

## UI, API and MCP

`operations.status.worker.running` now means a fresh observation for the configured kind. `localProcessRunning` separately reports whether this particular process is executing its scheduler. An external dedicated worker can be fresh while the web process correctly reports `localProcessRunning=false`.

The additive `heartbeat` object includes kind, state, database observation time, first/latest heartbeat, optional stop and the freshness window. `lastPass`/`lastFailure` remain separate workspace queue facts. A manual `operations.process` call can update a queue pass but never becomes a daemon heartbeat. A fresh heartbeat with old passes or failures is not reported as healthy processing. An older server response without the new observation renders as not verified.

The customer Operations UI and canonical API/MCP receive this same status. Unknown/stale/stopped observations add explicit operations gaps; these are diagnostic facts and do not themselves grant or revoke any business authority. Unknown worker deployment modes fail configuration instead of silently selecting embedded execution.

For a new production service with no workspaces, an authorized private release process can inspect `SELECT * FROM flockletter_customer_jobs.worker_liveness('dedicated')` without creating business data. Web readiness is distinct from worker readiness and must not be treated as proof of a continuously running queue.

## Platform control room

The control room now reads the same protected database heartbeat for the configured worker kind on every health refresh. It attaches that current observation to existing workspace health snapshots without changing their queue-pass time, failure or counts. The compact liveness display identifies its observation time and keeps queue progress separate. Legacy records and missing or failed heartbeat reads display unverified liveness; the configured dedicated-worker flag and a recent manual queue pass cannot supply it.

The live platform monitor independently rereads the protected heartbeat on every pass, even when each recorded workspace has an empty queue. `worker_liveness_unverified` is active for unknown, stale or stopped observations and for unavailable reads. Recovery clears that condition; repeated active observations retain acknowledgement and create no duplicate notification. The existing `worker_stale` condition still means pending work with no queue pass in five minutes. A fresh daemon can therefore coexist with a queue-progress alert, and a recent manual pass can coexist with unverified daemon liveness. Monitoring only covers workspaces with recorded health snapshots; a new service without any workspace still needs the private release check above. Notification transport retains its separate explicit activation gate.

## Release and verification

Apply migration 030 using the guarded migration role before starting updated web/worker code. Runtime-boundary verification requires the exact private routines, fixed paths, migration ownership and explicit execution grants, including denial of PostgreSQL 18 MAINTAIN and all direct private-table privileges. No new runtime database authority over customer records is added.

Disposable PostgreSQL tests cover unknown/fresh/stale/future/stopped states, clean shutdown, deployment overlap, recurring idle heartbeat, capacity/expiry, invalid kind/ID reuse, manual queue passes without liveness, a separate dedicated worker seen by a web reader and private privilege drift. UI tests retain old queue-pass/failure evidence next to fresh heartbeat and refuse to treat a legacy running boolean as verification. Hosted worker verification remains a separate release record; these tests are not a live infrastructure claim.

The local model drafted the environment-copy helper and tests in the preceding launch work. Chat authored and reviewed the heartbeat security/schema decisions, lifecycle code, operational presentation and focused tests. These changes required security and lifecycle judgment, so they were kept in Chat rather than delegated as mechanical work.

The platform follow-up passed four focused test files (24 tests), targeted lint and TypeScript checks. Disposable PostgreSQL and a separately restricted operator role verify current heartbeat reads, idle unknown/stopped/stale states, independent queue progress, manual-pass non-authority, unavailable reads, recovery, acknowledgement preservation and notification deduplication. Static rendering checks cover fresh, expired, stopped, unknown and missing observations. No provider calls or hosted changes were performed. Local Qwen drafted the small presentation component (16.47 seconds, 902 output characters) and its seven rendering tests (42.80 seconds, 2,638 output characters), using the shared two-slot runner. Chat removed output fences, corrected the test import, removed an unnecessary unsafe cast and redundant fallback, reviewed both drafts and implemented the trusted-reader integration, alert behavior and database tests. The first restricted local-model request and disposable-database test attempt could not reach local sockets; their authorized local executions succeeded. These are measured draft statistics, not a token or cost percentage.


## Standalone startup and preparation diagnostics

The standalone customer worker now requires `FLOCKLETTER_CUSTOMER_WORKER=dedicated` before opening a database connection. Missing or embedded mode cannot silently report an embedded heartbeat from a separately deployed worker. The web entry point retains embedded mode for inexpensive staging. Embedded operation is described as sharing the web process; its hosting plan and observed heartbeat determine continuity, rather than assuming every web service sleeps.

`operations.status.preparation` is an additive, read-only inventory of selected billing, trial-protection and mail-credential configuration groups. The owner UI, HTTP command and MCP share these redacted observations even when workflows are off. Missing settings, structurally invalid trial configuration and recorded groups are distinct. No setting values or provider identifiers are returned, no provider is constructed/called, and no mode is changed. Recorded groups are not a complete launch checklist: sender routes, receiving, operator roles, hosting, actual history, provider permissions, legal/tax facts and explicit activation still need their separate evidence. Disabled modes now say disabled instead of claiming configuration is absent.

Focused tests cover missing/whitespace settings, actual trial configuration validation, secret redaction, input preservation, canonical owner status and standalone failure before database access. The captured browser journey checks the new section. Local Qwen drafted the UI; chat corrected workspace-versus-service wording. Its first test draft used an inappropriate mocked registry and incorrect whitespace expectations; the reviewed replacement exercises the actual registry. Chat retains security, configuration semantics, worker startup, integration and final verification.

Local validation passed lint, type checking, 115 test files (886 passed; two existing gated native checks skipped), production build, API regeneration without a generated diff, and dependency audit with zero reported vulnerabilities. The ordinary desktop and 390px captured customer journeys passed. These are configuration/isolated-browser checks, not hosted provider or production-worker evidence.
