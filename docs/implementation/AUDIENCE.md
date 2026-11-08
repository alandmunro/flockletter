# Audience workspace

A current Clerk workspace owner can review one brand’s contacts and consent history, and honor an unsubscribe request. This implements the directory and contact-detail portions of design screens S16 and S19 and the audience counts on the S26 campaign review.

## Look up a contact

1. Open **Audience**. In a workspace with several brands, choose the brand that received the signup.
2. Read total, confirmed, pending and suppressed counts. Suppressed combines unsubscribes, hard bounces and complaints. The status filter shows each separately.
3. Enter the full address and select **Search**. The lookup trims surrounding spaces and lowercases the domain. It preserves case, dots and tags before the @ sign. Browse in alphabetical order, 25 contacts per page.
4. Select an address for its current status and reverse-chronological consent history. Events show the time, source, policy version, purpose and original signup domain when recorded.
5. To honor an opt-out, select **Unsubscribe contact** and **Confirm unsubscribe**. **Cancel** leaves the record alone. The command invalidates unused confirmation links, cancels unsent confirmation work and preserves stronger complaint or hard-bounce suppressions. Repeat signups cannot restore the subscription.

Changing brands clears the current contact and search. Search addresses go in an authenticated POST body. Responses are marked private to the request with `Cache-Control: no-store`. Audit and retry receipts store opaque identifiers. An older contact with no signup evidence can be stopped, and the new event identifies the owner's action without inventing a prior signup.

## Preview a CSV

Open **Preview a contact CSV** in the selected brand's **Audience** screen. Choose a UTF-8 comma-separated file with a header, up to 256 KiB, 1,000 data rows and 64 columns. The browser reads the headings locally. Select the email column by its position and use **Preview CSV** to send the file to Flockletter for comparison. **Clear file** removes the selection and result from the screen.

The report counts rows that are new to the brand, already confirmed, pending, suppressed, duplicated within the file or invalid. It shows the first ten row numbers that need attention. Row one is the header. Quoted line breaks are part of one row. A repeated valid address counts as a duplicate after its first occurrence.

This owner-session operation is read-only. It stores no file, adds no subscriber and sends no email. An actual import that establishes or changes consent still depends on the O-010 import policy. Machine connections can read aggregate audience totals with their explicit brand grants.

## Apply a practice CSV

On staging or a local instance, preview a file with 1 to 250 data rows. Check the permission declaration and select **Apply practice import**. Only valid fictional addresses ending in `.test` can be added. New contacts start as pending. The practice import never sends email, issues confirmation links or records subscriber consent.

Open **View all row outcomes** to see which rows were added, already present, suppressed, invalid, duplicated, outside the test domain or over the storage limit. Use the same file and selection after an interrupted response. An identical retry uses the original operation key and result. In the directory, a contact added this way shows its source row, import date and owner declaration separately from its consent history. The source CSV and addresses from skipped rows are not saved in the import receipt.

For practice imports, each stored contact row occupies one place across the workspace's brands. The ceiling is 250 for preparation workspaces and the plan’s contact limit for a complimentary workspace. Existing rows retain their current status even at the limit. These are staging storage bounds. Paid active-contact accounting and real audience import policy remain separate release decisions.

## Export a brand's contacts

Open **Export brand contacts** for the authorized brand. Review the data included, choose **Prepare export**, then **Download CSV**. The private file includes current email addresses, status, and added and confirmed timestamps. Each file covers one brand with at most 10,000 contacts. Fields that a spreadsheet might evaluate as formulas receive a leading apostrophe.

The owner-only `audience.exportPage` command returns at most 500 contacts. A changed audience, revoked membership, interrupted request or oversized brand aborts preparation. The browser offers the download only after all pages succeed. **Discard file**, closing the export panel, signing out or switching brands releases its in-memory file.

## Prepare a campaign or grant access

On a saved draft, choose **Preview & check** to see the current confirmed count and the number excluded. Those counts describe the brand now. A send would still require a separately reviewed recipient snapshot and another suppression check.

In **API & MCP**, select the intended brands and enable **Read audience totals by status**. MCP's `audience_summary` returns `total`, `pending`, `confirmed`, `unsubscribed`, `hard_bounced` and `complained`. Add the existing read permission to show the brand counts in campaign preflight. Old credentials retain their original access. Only a current owner session can read an address or unsubscribe a contact. [API contract](API_MCP.md)

## Verify the workflow

Run `npm ci` and `npm run check`. Then install a test browser with `npx playwright-core install chromium` and run `npm run audience:verify`. The browser check starts its own loopback PostgreSQL and uses 27 fictional contacts in one brand and an empty second brand. On a Mac with Chrome installed, set `FLOCKLETTER_BROWSER_CHANNEL=chrome` to use it. Set `FLOCKLETTER_AUDIENCE_SCREENSHOTS` to a local directory to capture the three views.

The database and transport tests cover tied history timestamps, paging while new contacts arrive, cross-brand and cross-workspace identifiers, revoked membership, denied individual access through MCP, aggregates matching HTTP, duplicate opt-outs and opt-outs at the operation limit. Intake tests exercise real confirmation-token invalidation and queue cancellation with a captured provider. The browser checks search, paging, filtering, consent history, cancel/confirm, persistence after reload, brand switching, mobile layout, campaign counts and issuing/revoking an aggregate grant in a disposable database.

CSV tests exercise multiline quoted cells and invalid UTF-8, exact address normalization, signed-in owner restrictions, brand isolation and evidence that preview adds no contacts or mail. Export tests exercise a 501-row download, a mid-export opt-out, the 10,001-row refusal and spreadsheet formula protection. The browser verifies that selecting and mapping a CSV sends zero preview requests until the owner chooses **Preview CSV**, then prepares, downloads and discards the brand export.

The practice-import suite exercises simultaneous replays and multi-brand capacity, changed inputs, revoked ownership, suppressed contacts, reserved-domain boundaries and empty or oversized batches. The browser interrupts the post-commit response and checks the retried result, then verifies that the saved pending contact has source evidence and zero consent events.

[Directory with sample contacts](screenshots/audience-directory.png) · [Contact and consent history](screenshots/audience-consent.png) · [Mobile directory](screenshots/audience-mobile.png)
