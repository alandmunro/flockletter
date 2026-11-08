# Rehearse the support inbox

An operator can capture fictional support emails, acknowledge receipt, review an AI-assisted draft, hand a case to a person, and close it. The local tool records its inbox, ticket history and captured replies in a private SQLite database. Run it on an operator-controlled Mac or Linux machine with Node.js and the project's dependencies. The existing local `llm` command prepares drafts for public topics.

## Review a ticket

Use a private operator directory on a persistent disk to retain the queue across machine restarts. The following example creates a disposable directory.

```sh
export FLOCKLETTER_SUPPORT_REHEARSAL_DIR="$(mktemp -d)"
npm run support:inbox -- receive mail-001 plans
npm run support:inbox -- acknowledge mail-001
npm run support:inbox -- draft mail-001
```

Read the draft beside its approved facts. To capture it, use the review code from that exact draft. The captured reply includes the AI disclosure. A draft that needs correction can be handed to a person with `escalate`.

```sh
npm run support:inbox -- approve mail-001 COPY_THE_REVIEW_CODE
npm run support:inbox -- close mail-001
npm run support:inbox -- show mail-001
npm run support:inbox -- list
```

Use `receive mail-002 security` followed by `draft mail-002` to rehearse a human handoff. Billing cases, privacy, security, recovery and unfamiliar questions go directly to a person. An operator can also escalate an ordinary ticket. Automatic replies are marked ignored on receipt to prevent loops. The `--help` command lists the complete set of sample topics.

## Capture an email envelope

The `ingest` command accepts one synthetic JSON email envelope on standard input. Use fictional addresses under `.test`. It accepts bounded plain text and rejects attachments and extra fields. Incoming email has no authority over workspaces, accounts or subscribers. Only an exact match to the built-in public questions can produce a model draft. The model receives the selected public facts. The operator can inspect unfamiliar questions directly in the inbox.

```sh
npm run support:inbox -- ingest <<'JSON'
{"kind":"flockletter.support-rehearsal.v1","messageId":"mail-003","from":"owner@shop.test","to":"support@flockletter.test","subject":"Account recovery","text":"I cannot sign in to my fictional workspace.","autoSubmitted":"no"}
JSON
npm run support:inbox -- draft mail-003
```

Retrying an identical message ID returns its existing ticket. Changed content under the same ID is rejected. The directory must be owned by the operator and accessible only to that account. Reuse it to resume after restart. Each database holds up to 250 tickets including closed ones. Start a fresh directory for another exercise. These fictional records are for the operator's local rehearsal.

## Release evidence

FL-SUP-001, FL-SUP-002 and FL-AT-035 cover support drafts, disclosure, handoff, isolation and bounded replies. The rehearsal records captured acknowledgments and replies with their ticket. Live intake and outgoing support mail still need an authenticated mail provider, a retention policy and approved rules for automated replies and escalation under O-012. [Requirement](../SRD.md#email-support-and-ai-replies) · [Verification cases](../../tests/support-inbox-boundary.test.ts)
