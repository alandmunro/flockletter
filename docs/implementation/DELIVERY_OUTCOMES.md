# Recipient outcome reports

**Scope:** Read-only reporting. Captured checks do not establish live provider delivery.
**Requirements:** FL-CAM-007, FL-API-001/003, FL-OPS-006.

## Shared operation
The new canonical `delivery.outcomes` (MCP `delivery_outcomes`) is a read-only function. It uses the existing `campaign:send+read` owner-issued grant and adheres to existing brand restrictions. The owner browser uses the same function for access.

## Input and Output
**Inputs:** `brandId`, `id`, optional `after` (UUID), `limit` (default 25, max 100), optional `state` (9 states), and optional `feedback` (4 kinds).
**Outputs:** Opaque recipient IDs, state, attempts, reason, and provider feedback only. No addresses, subscriber IDs, or provider IDs are exposed. The response includes `total`, `nextCursor` and `observedAt`.

## Compatibility and UI Behavior
The legacy `delivery.report` retains first 50 compatibility. The new UI supports lazy open for every page, including later uncertain states, filters, and refresh actions that start again. Closing the view invalidates pending replies. Request/generation guards are implemented to manage state.

## Data Consistency
Actual recipient rows represent a frozen reviewed set, but feedback changes live across pages. Each query’s `total/items` reflect the same SQL snapshot; earlier pages are not refreshed until an explicit refresh occurs. Missing or wrong-delivery cursors are refused, while changed status of a cursor remains valid.

## Safety and Constraints
No retries, sends, reservations, or queue mutations occur on read. Uncertain states require existing Process or reconcile actions; never blind resend. Captured acceptance/feedback is labeled as simulation, not actual inbox data.

## Verification Status
Focused PostgreSQL/MCP tests cover pagination, isolation, revocation and unchanged operation/reservation/recipient rows. Normal desktop and390px browser journeys cover traversal beyond50, uncertainty and feedback filters, empty results, read failure/retry and rejection of a late response after close/reopen. Captured fixtures do not establish live mail delivery.

## Implementation Notes
Local Qwen drafted the UI and this operational note. Chat replaced unsafe asynchronous lifecycle/retry logic, added mobile-safe rendering and explicit captured labels, corrected the response field name and model attribution in this note, and handled database logic, permissions, review and verification.
