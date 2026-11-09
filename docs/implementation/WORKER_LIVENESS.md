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

## Release and verification

Apply migration 030 using the guarded migration role before starting updated web/worker code. Runtime-boundary verification requires the exact private routines, fixed paths, migration ownership and explicit execution grants, including denial of PostgreSQL 18 MAINTAIN and all direct private-table privileges. No new runtime database authority over customer records is added.

Disposable PostgreSQL tests cover unknown/fresh/stale/future/stopped states, clean shutdown, deployment overlap, recurring idle heartbeat, capacity/expiry, invalid kind/ID reuse, manual queue passes without liveness, a separate dedicated worker seen by a web reader and private privilege drift. UI tests retain old queue-pass/failure evidence next to fresh heartbeat and refuse to treat a legacy running boolean as verification. Hosted worker verification remains a separate release record; these tests are not a live infrastructure claim.

The local model drafted the environment-copy helper and tests in the preceding launch work. Chat authored and reviewed the heartbeat security/schema decisions, lifecycle code, operational presentation and focused tests. These changes required security and lifecycle judgment, so they were kept in Chat rather than delegated as mechanical work.
