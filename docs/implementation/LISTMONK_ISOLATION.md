# Two-workspace private Listmonk exercise

This exercise starts two Listmonk 6.2.0 renderers on loopback. Each renderer has its own private PostgreSQL process, port, data directory, callback listener and credential. Both workspaces use one disposable Flockletter application database through its restricted runtime role. The only delivery method is the local test provider.

## Run the exercise

From the repository root, use the supported Node version and install the pinned Listmonk binary:

```sh
npm ci
FLOCKLETTER_PRIVATE_ENGINE=embedded node scripts/prepare-listmonk.mjs
node --import tsx scripts/prove-listmonk-isolation.ts
```

The installer checks the release archive and executable hashes on macOS arm64 or Linux x64. The script creates fictional workspaces and brands, reads no hosted credentials and removes the temporary engines and application database on exit. The existing Linux Listmonk CI job executes the same command. [Pinned installer](../../scripts/prepare-listmonk.mjs) · [Exercise](../../scripts/prove-listmonk-isolation.ts)

## What the run verifies

1. Two workspaces approve separately scoped test campaigns and render their messages concurrently. Each private listener receives its own reviewed message. The exercise checks distinct native PostgreSQL process IDs, ports and data directories.
2. Sending A’s actual callback to B with A’s credential returns HTTP 401. Using B’s valid credential to present A’s callback returns HTTP 409. Repeating the original callback at A is idempotent. B cannot read A’s rehearsal or process its work.
3. A stops after accepting its callback but before recording a provider receipt. B settles its first message and renders another one while A is stopped. B keeps the same engine directory, PostgreSQL process and port.
4. A’s restarted listener rejects its retired credential, accepts a duplicate of its original callback with the new credential, and settles the existing operation. A and B render again concurrently. The local provider records two receipts for A and three for B. Each operation has exactly one attempt, a delivery report available through HTTP and MCP, and the provider binding of its reviewed workspace and brand.

## Local measurements

Measured on November 7, 2026 (Denver), on macOS arm64 with Node v26.12.1 and Listmonk 6.2.0. The clock starts before the application asks the renderer to process a reviewed message and stops when the authenticated callback has been durably recorded. The concurrent pair time is wall-clock time.

| Metric | First run (ms) | Repeat (ms) |
| --- | ---: | ---: |
| Concurrent cold callbacks together | 1,424 | 947 |
| A cold | 1,424 | 947 |
| B cold | 1,423 | 947 |
| B warm while A stopped | 54 | 55 |
| A cold after restart | 898 | 924 |
| B warm while A restarted | 56 | 55 |

These figures describe two runs with small synthetic messages. Hosted CPU, memory, connection headroom, sustained send throughput and operating cost need separate measurements. SES tenant isolation, real provider acceptance and tenant pause/recovery require an authorized SES environment. [Private Listmonk staging operations](PRIVATE_LISTMONK.md) · [Delivery readiness](DELIVERY_READINESS.md)
