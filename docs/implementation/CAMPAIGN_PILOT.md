# Staging campaign pilot

Open **Campaigns** to start with a template or a product announcement. Product drafts take the published name, product URL, excerpt and existing same-brand images in your chosen order. Save the sender, reply address, subject, heading and body. **Preview & check** shows the content and current brand audience.

## Rehearse a campaign

1. Choose **Flockletter capture** to inspect a message inside the app, or **Staging test provider** to exercise the delivery worker. Capture is the default. Earlier capture approvals continue to use capture. Use the fixed test mailbox or a brand’s confirmed test contacts. A brand rehearsal requires a complimentary plan and accepts up to 25 recipients on reserved test domains.
2. For a future run, select **Schedule for later** and enter the local date and time. Choose **Review capture** or **Review provider test**, check the version, audience and scheduled time, then approve the displayed review within 30 minutes. Flockletter freezes the selected recipients, email content and original image references.
3. Before each provider submission, the worker rechecks the saved revision, current authority, grant, reserved allowance and the recipient’s current eligibility. Someone who unsubscribed after approval is skipped. New subscribers are outside the reviewed audience.
4. **Open captured email** shows the reviewed HTML and plain text for a capture. For a provider test, open **Show recipient outcomes**. Each row has a reference you can compare with MCP, its state, the number of attempts and a reason when available. The hosted test provider records its receipts in Flockletter’s database. It has no network connection or SMTP transport.

An uncertain submission may already have been accepted. Use **Check provider status**, then **Refresh rehearsals** to read the latest outcome. The worker checks the original operation and retries only when the provider can prove it did not accept that attempt and the recipient is still eligible. The limit is three submission attempts per recipient. **Cancel rehearsal** stops new submissions. An uncertain attempt retains its practice reservation until its receipt is resolved, even after cancellation. Test rehearsals reserve messages, and brand rehearsals also reserve a campaign slot in the selected UTC month. A preparation workspace can rehearse up to 25 test messages per month.

The staging web process polls approved work for its configured brands. Its existing `FLOCKLETTER_CAPTURE_WORKSPACE` and `FLOCKLETTER_CAPTURE_BRAND` pair also enables provider tests for that brand. To bind additional brands, set `FLOCKLETTER_DELIVERY_BINDINGS` to a JSON array of objects with a `workspace` Clerk organization ID and a `brand` UUID. The combined limit is 20 distinct pairs. Hosted provider reviews require an explicit binding. For continuous polling, the built application also provides `npm run delivery:worker` with the same isolated database, identity and binding configuration. A sleeping process picks up overdue work when it resumes. [Staging operation](STAGING.md)

## Access and sender setup

The protected grant tool takes a workspace ID, canonical plan, operator name, reason and stable UUID. Run `node --import tsx scripts/access-cli.ts <grant-file>` inside the isolated staging release process with `FLOCKLETTER_COMPLIMENTARY_WORKSPACE` and its restricted migrator connection. Set `plan` to null for revocation. Runtime access to grant history is read-only. Do not grant an FFA account by matching its name or email. The operator chooses the real FFA workspace and tier separately.

In **Workspace**, owners can view their plan, practice usage, activity, companies and brands. Under sending domain, save an owned public domain, publish the displayed DNS TXT record, and check it. That check establishes control of the domain only. The provider’s sending-domain, DKIM, SPF, DMARC and feedback setup are still required for outbound mail.

## Stripe sandbox

`FLOCKLETTER_BILLING_MODE=off` is the default. To run hosted billing tests use a separate Flockletter Stripe sandbox, a test key, its account ID, a dedicated signed webhook secret, a card-only payment-method configuration and three monthly USD price IDs matching the approved catalogue. Use the isolated sandbox owner checkout and portal. Configure signed events at `/api/v1/billing/stripe-events`. Checkout and subscription events map to a previously recorded intent; the server retrieves current Stripe state. A return from Checkout never grants access. Complimentary accounts bypass Stripe. Sandbox status has no effect on live sending.

The test suite exercises ambiguous Checkout creation, repeated and out-of-order events, raw webhook signatures, current sandbox state, and complimentary access. Real provider checkout requires the operator’s Flockletter sandbox. The dedicated Listmonk fixture verifies a rendered newsletter and a single authenticated callback in a disposable private network. [Engine proof](LISTMONK_CAPTURE.md)

## Verification

Run `npm ci`, `npm run check`, and `npm run audience:verify` with an installed Chromium browser. Run `bash scripts/listmonk-capture/run.sh` on a local Docker engine. Screens and automated fixtures use fictional workspaces and mailboxes. [Authoring](AUTHORING.md) · [Audience](AUDIENCE.md) · [API and MCP](API_MCP.md)
