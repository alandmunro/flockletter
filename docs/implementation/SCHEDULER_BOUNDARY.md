# Durable scheduler routing

The customer scheduler stores only server-owned workspace identifiers and due timestamps in the private `flockletter_customer_jobs` schema. It holds no recipient, message, token, identity or billing values. App records and actual work remain under forced tenant policies.

The runtime has no table access to that schema. It can execute six fixed migration-owned functions. Wake, snooze, worker receipts and scoped status require the current authenticated tenant transaction. Due-scopes exposes at most 100 due identifiers for the trusted application worker to enter through its normal tenant transaction. No customer HTTP or MCP command exposes that directory.

Each durable command commits its wake request with its domain change. The worker discovers due scopes after restart, processes a bounded fair slice and computes the next wake from persisted jobs. A process restart or missed notification does not lose a scheduled operation.

The dedicated worker process runs the same scheduler loop as the web process. Database locks and durable claims coordinate overlaps. Free staging still sleeps with its web service. Production can deploy the dedicated worker to meet its scheduling availability requirements after infrastructure activation.

This extends FL-OPS-003 and FL-USG-004 under D-042. The migration owns the routing schema and definer functions. The runtime cannot alter functions, read their underlying table or gain schema creation privileges. Production deployment checks validate that boundary explicitly.

The sixth routine reserves a platform provisioning unit under a global capacity lock. Its configured monthly ceiling is bounded to twenty reviewed brand jobs and defaults to zero at runtime. Replays bind an opaque operation ID to a one-way workspace/brand digest and do not consume another unit. Its table stores no raw account, brand, contact or domain identifiers, is inaccessible to runtime table queries, and expires receipts after ninety days. A new paid infrastructure action remains disabled until an operator configures the binding and allowance.
