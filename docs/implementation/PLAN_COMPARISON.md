# Compare a hosted plan

Signed Stripe sandbox events trigger a fresh lookup of the subscription’s current price and quantity. A verified change between catalogued monthly plans updates the comparison and Billing view while preserving the original Checkout intent, usage and complimentary access. An unsigned browser return cannot update a tier. A scheduled price change appears when Stripe applies it. [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)

In **Workspace → Billing sandbox → Compare a hosted plan**, choose a target tier and select **Compare allowances**. The owner can repeat the check after a membership or audience change. Each comparison reads the current workspace and leaves billing and workspace data untouched.

The comparison uses the shared USD plan catalogue. It reports company and brand counts, current Clerk seats, and confirmed subscriptions across brands. Each confirmed subscription counts within its own brand. Pending, unsubscribed, bounced and complained contacts are excluded from this count. Owners can expand the brand breakdown. If the roster lookup fails after the owner signs in, the seat count shows as unverified. Pro has unlimited seats.

The separate practice figures show completed and reserved rehearsal usage for the UTC month. The contact count is a current snapshot. Cumulative paid-period accounting, proration, refunds and the timing of a plan change remain subject to the billing policy. A formal plan change will need fresh checks at scheduling and at the effective time.

The canonical command is `billing.comparePlan`, with `plan` set to `starter`, `growth` or `pro`. It requires a verified owner session. The existing delegated MCP credential scopes continue to exclude billing. The public catalogue and trial reference remain available without a billing account.

FL-BIL-001, FL-BIL-005, FL-USG-001 and FL-AT-034 cover the catalogue, shared allowances and downgrade checks. [Comparison tests](../../tests/plan-comparison.test.ts)
