# Listmonk HTTP messenger proof

Run `bash scripts/listmonk-capture/run.sh` with Node and a local Unix-socket Docker daemon. The harness starts a fresh PostgreSQL database, Listmonk, and a capture endpoint on an internal Docker network. It publishes no host ports, mounts no host files and uses no provider credentials. Fixture passwords are generated per run. Exiting the script removes its containers, database and network. Dependency images stay in Docker’s cache.

The fixture pins the official **Listmonk 6.2.0** multi-platform image at `sha256:f535d59e14991337a9f2d570273685378ae86b0d7698c3e00da444e3bc205286`. On November 7, 2026, this was the latest stable-numbered release. Upstream also published 7.0.0-beta.1. The PostgreSQL and Node helper images are pinned in the script. [6.2.0 release](https://github.com/knadh/listmonk/releases/tag/v6.2.0) · [7.0 beta release](https://github.com/knadh/listmonk/releases/tag/v7.0.0-beta.1) · [Official image](https://hub.docker.com/r/listmonk/listmonk/tags?name=v6.2.0)

## Verified behavior

The probe creates a double-opt-in list with one fictional confirmed contact and one unconfirmed contact. It submits a real personalized campaign through Listmonk’s API, selects the private messenger and waits for the campaign to finish. It checks that exactly one authenticated callback arrived with the campaign UUID, confirmed subscriber UUID, email, and exact rendered subject and body. The pending contact receives no callback. This passed on November 7 with the official Linux/arm64 image. [Campaign API](https://listmonk.app/docs/apis/campaigns/) · [HTTP messenger format](https://listmonk.app/docs/messengers/)

Two engine settings matter for the Flockletter integration.

- Listmonk’s default sends confirmation messages through its native email messenger. The first fixture run closed the request while creating the pending control with SMTP removed. The passing fixture disables `app.send_optin_confirmation` before starting Listmonk. Flockletter owns the consent flow and confirmation links. [Subscriber insertion](https://github.com/knadh/listmonk/blob/v6.2.0/internal/core/subscribers.go) · [Email messenger](https://github.com/knadh/listmonk/blob/v6.2.0/internal/messenger/email/email.go)
- A plain campaign can inherit Listmonk’s default HTML template and its Listmonk-managed links. The fixture explicitly selects a body-only template and compares the whole rendered string. The HTTP messenger serializes campaign headers from the campaign object. A real outbound transport must supply and verify the Flockletter recipient’s unsubscribe body link and one-click headers. [Template compilation](https://github.com/knadh/listmonk/blob/v6.2.0/models/campaigns.go) · [HTTP postback serialization](https://github.com/knadh/listmonk/blob/v6.2.0/internal/messenger/postback/postback.go)

Hosted production delivery still requires verified senders, a provider, protected engine send paths and authenticated feedback. FL-AT-024 and FL-DEL-005 remain open for live delivery. [Provider boundary review](PROVIDER_REVIEW.md)

## Delivery worker test

The staging web service uses a PostgreSQL receipt for a synthetic provider submission. The Docker harness separately runs the Flockletter worker through the pinned Listmonk engine. It schedules two fictional recipients, withdraws one after approval, and drops the worker’s acknowledgement for the other after contacting Listmonk. The private HTTP messenger authenticates the callback and matches its recipient, subject, HTML and original attachment bytes to the reviewed submission. The test requires one accepted attempt, one skipped recipient with zero attempts, and one engine submission. Its SMTP messenger is disabled. [Worker exercise](../../scripts/listmonk-capture/worker-proof.ts)

The `listmonk-capture` CI job runs this harness. Its result demonstrates the engine path for the tested commit. Gmail phone checks separately cover newsletter rendering on the device. [CI workflow](../../.github/workflows/ci.yml) · [Mailbox checks](VERIFICATION.md#newsletter-studio)

## Newsletter Studio revisions

Install the project dependencies with `npm ci` before running the harness. It also renders a fictional Studio revision on the Flockletter server, including its approved image content ID, a two-column layout, inline links and Outlook conditional markup. The harness submits the HTML to the pinned engine with the plain-text alternative, then submits the same plain text separately through the body-only template. Each campaign reached the private HTTP messenger exactly once for the confirmed subscriber. The subject, HTML and text matched the reviewed strings byte-for-byte. The control subscriber produced no callbacks. The captured content includes literal template-like text, which remains literal in Listmonk. [Executed integration](https://github.com/alandmunro/flockletter/actions/runs/42426155887/job/128564761461)

Listmonk's HTTP messenger includes the primary body but omits the separate MIME alternative in the callback. For hosted delivery, the final transport must take both bodies and the original attachments from the authorized reviewed revision. The fixture wraps each already-rendered string as a quoted literal for Listmonk so that its Go template processor cannot reinterpret user content or strip conditional comments. It has no provider connection. [Upstream messenger](https://github.com/knadh/listmonk/blob/v6.2.0/internal/messenger/postback/postback.go) · [Studio MIME example](NEWSLETTER_STUDIO.md#inspect-a-sample-email)


## Listmonk to SES mailbox-simulator contract

The private `/api/tx` messenger registers the Flockletter operation before contacting Listmonk. After Listmonk posts its authenticated callback, Flockletter matches the original recipient, subject, HTML and attachment bytes to that review. The callback supplies neither routing nor extra recipients. Flockletter restores the reviewed plain-text body and inline image IDs from the same frozen message. It sends the resulting SES request only to an in-memory AWS SDK transport in this fixture. The engine acknowledging its callback does not count as provider acceptance.

The isolated proof schedules two synthetic contacts and withdraws consent for one after review. It expects one actual Listmonk submission, one SDK wire request for the AWS success simulator, byte-identical photos, and no second send after the worker loses its acknowledgment. It opens no AWS connection. A deployed private messenger with durable storage and reconciliation, a verified SES account, and a controlled end-to-end recipient test are still prerequisites for customer delivery.
