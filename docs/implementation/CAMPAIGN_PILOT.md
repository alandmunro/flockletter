# Staging campaign pilot

Open **Campaigns** to start with a template or a product announcement. Product drafts take the published name, product URL, excerpt and existing same-brand images in your chosen order. Save the sender, reply address, subject, heading and body. **Preview & check** shows the content and current brand audience.

## Rehearse a campaign

1. Select **Review capture** for the fixed test mailbox, or select your brand’s confirmed test audience. A brand rehearsal requires an operator-issued complimentary plan. Only addresses on reserved test domains qualify. The maximum per rehearsal is 25.
2. Review the saved version, selected and excluded counts, and local scheduled time. Approve that review within 30 minutes. Flockletter keeps the rendered content, original image digests and chosen recipients. Subsequent signups do not enter it.
3. Immediate captures run when approved through the dashboard. Future captures remain queued until a configured worker picks them up. **Process if due** also runs one due rehearsal. **Cancel rehearsal** releases its practice reservation.
4. Open **Captured email** to view the reviewed HTML or plain text. Counts distinguish captured, excluded, pending, blocked and cancelled work. Captured means written to Flockletter's database. There is no outbound email call in this worker.

The worker rechecks current Clerk ownership, the issuing connection and brands, grant revision, saved draft version, subscriber state and address digest. Capture and usage are committed together. Concurrent retries cannot create a second captured message. Test captures reserve messages; brand captures also reserve a campaign slot. The selected month is UTC. These are separate practice counters. A preparation workspace can rehearse up to 25 test messages per month.

An operator can set `FLOCKLETTER_CAPTURE_WORKSPACE` and `FLOCKLETTER_CAPTURE_BRAND` together on the staging service to process its due queue every 15 seconds while the service is awake. The queue persists across restarts. A sleeping free service can process overdue work when it resumes. Live delivery requires an always-running worker, a selected provider, real sender authentication, usage policy and production approval.

## Access and sender setup

The protected grant tool takes a workspace ID, canonical plan, operator name, reason and stable UUID. Run `node --import tsx scripts/access-cli.ts <grant-file>` inside the isolated staging release process with `FLOCKLETTER_COMPLIMENTARY_WORKSPACE` and its restricted migrator connection. Set `plan` to null for revocation. Runtime access to grant history is read-only. Do not grant an FFA account by matching its name or email. The operator chooses the real FFA workspace and tier separately.

In **Workspace**, owners can view their plan, practice usage, activity, companies and brands. Under sending domain, save an owned public domain, publish the displayed DNS TXT record, and check it. That check establishes control of the domain only. The provider’s sending-domain, DKIM, SPF, DMARC and feedback setup are still required for outbound mail.

## Stripe sandbox

`FLOCKLETTER_BILLING_MODE=off` is the default. To run hosted billing tests use a separate Flockletter Stripe sandbox, a test key, its account ID, a dedicated signed webhook secret, a card-only payment-method configuration and three monthly USD price IDs matching the approved catalogue. Use the isolated sandbox owner checkout and portal. Configure signed events at `/api/v1/billing/stripe-events`. Checkout and subscription events map to a previously recorded intent; the server retrieves current Stripe state. A return from Checkout never grants access. Complimentary accounts bypass Stripe. Sandbox status has no effect on live sending.

The test suite exercises ambiguous Checkout creation, repeated and out-of-order events, raw webhook signatures, current sandbox state, and complimentary access. Real provider checkout requires the operator’s Flockletter sandbox. The dedicated Listmonk fixture verifies a rendered newsletter and a single authenticated callback in a disposable private network. [Engine proof](LISTMONK_CAPTURE.md)

## Verification

Run `npm ci`, `npm run check`, and `npm run audience:verify` with an installed Chromium browser. Run `bash scripts/listmonk-capture/run.sh` on a local Docker engine. Screens and automated fixtures use fictional workspaces and mailboxes. [Authoring](AUTHORING.md) · [Audience](AUDIENCE.md) · [API and MCP](API_MCP.md)
