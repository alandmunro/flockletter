# Customer workflow browser proof

Run a current production UI build, then:

```sh
node --import tsx scripts/prove-customer-workflows.ts
```

The harness creates and stops its own disposable local PostgreSQL database. It serves the normal built UI through the real application router, Authenticator, CommandService and customer domain modules. It uses only the documented loopback local-development identity (`org_local_sample`), with no injected cookies, fabricated Clerk sessions or interception of customer API responses. `FLOCKLETTER_BROWSER_CHANNEL` selects an installed browser; its default is Chrome. `FLOCKLETTER_CUSTOMER_SCREENSHOTS` selects an output directory; its default is a `flockletter-customer-proof` directory beneath the operating system temporary directory.

Two normal browser journeys retain the same durable database while using fresh HTTP rate-limit windows. The first starts a captured card-required trial on Growth and records simulated payment success; configures brand consent; opens and submits the public signup form; confirms one captured signup through its native public confirmation form and another through the owner exercise controls; unsubscribes a contact; previews and imports duplicate/invalid/suppressed rows; creates and edits a template draft; reviews and approves customer delivery; opens its captured recipient message; and records delivery feedback. Durable checks verify suppression remains intact and only the confirmed, unsuppressed reader received a capture.

The first also saves a legal sender profile and exercises Infrastructure review, explicit approval and captured processing through Operations, asserting that saved DNS uses `.invalid` and that its route remains unverified. The second initializes the team scenario, invites and accepts a member, creates a support conversation, prepares and reviews its reply, and records its captured outcome. It cancels service, advances only the verified exercise clock by 120 days, reviews the retention inventory and captures a due job. Durable checks require zero erasure receipts and an intact workspace. The Operations screen processes saved jobs and must report no hidden worker failure. Each customer area is also opened at 390 pixels with fully loaded content; the support conversation and retention inventory are expanded for the overflow checks. Screenshots use synthetic business names and addresses.

The delivery rendering dependency is an explicitly injected deterministic no-network function. This proof verifies the actual approval, recipient selection, durable processing, capture payload, preview and feedback paths; it does not claim a Listmonk engine run or inbox delivery. Real pinned Listmonk integration and provider contracts have separate checks. All billing, invitations, support and retention results are labeled captured exercises. No card, external recipient or hosted account is mutated.

The browser proof found that a normal native form submission under `Referrer-Policy: no-referrer` presents `Origin: null` in Chromium despite same-origin navigation. The router now accepts that opaque origin only with both `Sec-Fetch-Site: same-origin` and `Sec-Fetch-Mode: navigate`. It preserves no-referrer protection for tokens. Nine focused route cases verify the exact native exception and rejection of cross-site, absent-metadata and foreign-origin variants; the normal API origin policy remains unchanged.

Local Qwen provided the first harness draft (81.40 seconds, 4,018 output characters). Chat corrected invented mode variable suffixes, missing domain injection and unsafe cleanup/type assumptions, implemented the real click journeys and durable assertions, fixed selectors to match the existing UI, and reviewed the security findings. No model-use percentage is inferred from these output statistics.

Verification completed: all seven areas passed desktop journeys and fully loaded 390-pixel layouts, including an expanded retention table and captured support history. The native signup and confirmation forms both completed through the browser. Nineteen synthetic screenshots were saved to the configured output directory. Owned lint and global typecheck passed.
