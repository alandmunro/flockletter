# Customer workflows delivery

The owner authorized all seven remaining workstreams on November 8 and asked for a testable staging application by November 9 at 03:43 UTC. Make reasonable implementation choices without waiting for the owner, delegate bounded coding to local Qwen, and review its output.

## Integration plan

1. Complete guarded campaign review, send, scheduling, outcome and reconciliation operations for ordinary confirmed subscribers.
2. Complete billing eligibility, trial, plan changes, failed payment, cancellation and usage accounting.
3. Complete real-domain CSV imports and reusable brand signup with double opt-in and suppression preservation.
4. Complete Clerk member invitations, removal and ownership workflows with durable external intents.
5. Add a durable hosted support inbox, reviewed replies, escalation and authenticated provider integration.
6. Add hosted retention scheduling, a privileged deletion executor and protected restore reconciliation.
7. Add environment readiness, provisioning, reliable workers, operations visibility and deployment support.

Use the normal UI, canonical HTTP operations and MCP where explicit permissions apply. Existing drafts, images, consent, billing intents and rehearsals retain their contracts. Domain modules own dedicated tenant-scoped tables with forced row-level security. Runtime credentials receive only the permissions those operations need. Destructive erasure uses separate operator authority.

## Staging exercise

An explicitly enabled exercise mode records captured provider outcomes and billing events in protected PostgreSQL. It requires current Clerk authentication, uses clearly labeled exercise entitlements and never establishes a real payment or delivery fact. It must exercise the actual domain state machines, persistence, permission checks and limits. Provider activation is a separate configuration gate. Capture of real-domain addresses is allowed for owner testing with double opt-in, with no external transport in exercise mode.

Reusable code for production can be built while production mailing, charges, deployment and customer-data purge retain their existing activation requirements. The free staging service remains the test target. Do not read or print environment secrets.

## Chosen reversible exercise policies

The 14-day trial has one company, one brand, one user, two campaigns, 250 active contacts and 500 total recipient messages. Paid prices and limits stay at the accepted catalogue. Exercise upgrades apply after a verified exercise provider event, downgrades and cancellation at period end. Past-due access suspends on day six and closes on day thirty. UTC calendar months define exercise usage periods and do not roll over. Imports create pending subscribers with recorded permission evidence and preserve stronger existing states. Support replies require exact human review, or an immutable human-approved policy limited to recognized public guidance under D-043; sensitive and uncertain requests escalate. Automated retention first identifies and holds due work for a separately authorized executor.

These are implementation defaults for staging and configurable production policy. They are not a statement that commercial terms, external sending or destructive hosted erasure have been activated.

## Verification and handoff

Record model contributions, fix invalid local drafts, and test two workspaces, retries, revocation, concurrency, changed consent and provider uncertainty. Test the normal browser entry points at desktop and phone sizes. Finish a version-checked staging PR/deploy and a practical owner testing guide. Report live provider checks independently of captured exercises.

D-043 completes the three remaining platform integrations with separate live activation gates. See [implementation and exercise playbook](PLATFORM_COMPLETION.md).

Production mail credential separation, private confirmation-feedback routing, suppression and activation checks are specified in [the production mail checklist](PRODUCTION_MAIL.md). Local tests are not live-provider evidence.
