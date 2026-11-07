# Audience workspace

A current Clerk workspace owner can review one brand’s contacts and consent history, and honor an unsubscribe request. This implements the directory and contact-detail portions of design screens S16 and S19 and the audience counts on the S26 campaign review.

## Look up a contact

1. Open **Audience**. In a workspace with several brands, choose the brand that received the signup.
2. Read total, confirmed, pending and suppressed counts. Suppressed combines unsubscribes, hard bounces and complaints. The status filter shows each separately.
3. Enter the full address and select **Search**. The lookup trims surrounding spaces and lowercases the domain. It preserves case, dots and tags before the @ sign. Browse in alphabetical order, 25 contacts per page.
4. Select an address for its current status and reverse-chronological consent history. Events show the time, source, policy version, purpose and original signup domain when recorded.
5. To honor an opt-out, select **Unsubscribe contact** and **Confirm unsubscribe**. **Cancel** leaves the record alone. The command invalidates unused confirmation links, cancels unsent confirmation work and preserves stronger complaint or hard-bounce suppressions. Repeat signups cannot restore the subscription.

Changing brands clears the current contact and search. Search addresses go in an authenticated POST body. Responses are marked private to the request with `Cache-Control: no-store`. Audit and retry receipts store opaque identifiers. An older contact with no signup evidence can be stopped, and the new event identifies the owner's action without inventing a prior signup.

## Prepare a campaign or grant access

On a saved draft, choose **Preview & check** to see the current confirmed count and the number excluded. Those counts describe the brand now. A send would still require a separately reviewed recipient snapshot and another suppression check.

In **API & MCP**, select the intended brands and enable **Read audience totals by status**. MCP's `audience_summary` returns `total`, `pending`, `confirmed`, `unsubscribed`, `hard_bounced` and `complained`. Add the existing read permission to show the brand counts in campaign preflight. Old credentials retain their original access. Only a current owner session can read an address or unsubscribe a contact. [API contract](API_MCP.md)

## Verify the workflow

Run `npm ci` and `npm run check`. Then install a test browser with `npx playwright-core install chromium` and run `npm run audience:verify`. The browser check starts its own loopback PostgreSQL and uses 27 fictional contacts in one brand and an empty second brand. On a Mac with Chrome installed, set `FLOCKLETTER_BROWSER_CHANNEL=chrome` to use it. Set `FLOCKLETTER_AUDIENCE_SCREENSHOTS` to a local directory to capture the three views.

The database and transport tests cover tied history timestamps, paging while new contacts arrive, cross-brand and cross-workspace identifiers, revoked membership, denied individual access through MCP, aggregates matching HTTP, duplicate opt-outs and opt-outs at the operation limit. Intake tests exercise real confirmation-token invalidation and queue cancellation with a captured provider. The browser checks search, paging, filtering, consent history, cancel/confirm, persistence after reload, brand switching, mobile layout, campaign counts and issuing/revoking an aggregate grant in a disposable database.

[Directory with sample contacts](screenshots/audience-directory.png) · [Contact and consent history](screenshots/audience-consent.png) · [Mobile directory](screenshots/audience-mobile.png)
