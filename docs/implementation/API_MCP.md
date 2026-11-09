# API and MCP preparation workflow

The campaign foundation exposes preparation commands through the administration UI, HTTP and MCP. Owners use `intake.status` and `intake.configure` through the same command layer. First-party signup has a distinct server-to-server HTTP operation and a single-brand `subscriber:signup` credential. General assistant tools keep their existing preparation scopes. [Intake contract](FFA_SUBSCRIBER_INTAKE.md)

## Start by reporting gaps

1. Run `workspace_preflight`. Report every setup gap before collecting images or writing a draft. Missing send prerequisites do not prevent preparation, but must remain visible.
2. Read `workspace_get` for authorized brands and the plan catalogue. If the workspace is not initialized, its owner completes the dashboard setup once.
3. Create a draft with `campaign_create`. Keep the returned ID and version. Use one stable operation key for identical retries.
4. Upload originals together with `asset_upload_files` or `asset_uploadBatch`. Keep each file's stable item key. Inspect **every** item result; a successful HTTP response can contain rejected files. Correct failed files and retry with a new batch key; keep successful file keys to avoid duplicates.
5. Save selected images and content with `campaign_update`, using the current expected version. A version conflict requires reading the current draft and reconciling edits; do not blindly overwrite it.
6. Run `campaign_preview` for that saved version and `campaign_preflight`. Present the exact preview and all remaining gaps. Staging capture has its own review and approval commands and scopes. Campaign delivery remains gated.

Normal preparation uses a few batch calls, not one call per image. Authentication, file preparation and intentional editing add calls. Do not claim an upload, save or preview is publication.

## Rehearse a scheduled provider submission

1. Call `rehearsal_review` with `operationKey`, `brandId`, `campaignId`, `expectedVersion`, `audience` and `transport: "provider_test"`. For a scheduled run add an ISO date and time with an offset in `dueAt`. Use `"test"` for the fixed test mailbox or `"confirmed"` for eligible test contacts in the brand. A delegated connection requires `read` and `campaign:rehearse`, plus `audience:summary` for confirmed contacts. The staging operator must bind the brand before reviewing a provider test. Omitting `transport` selects the existing capture workflow.
2. Present the returned review and obtain approval for its version, audience and time. Call `rehearsal_approve` with its `id`, the same `brandId` and a new `operationKey`. The worker processes approved recipients when due. `rehearsal_process` with `id`, `brandId` and its own `operationKey` requests one worker step. Read the outcome through the report.
3. Call `rehearsal_report` with `brandId` and `id` for run state and counts, including pending, submitting, accepted, uncertain, rejected and skipped or cancelled recipients. `rehearsal_outcomes` takes the same arguments and returns `recipients` with each opaque `id`, `state`, `reason` and `attempts`. A subscriber who withdrew before their first submission has zero attempts. The same view appears under **Show recipient outcomes** on the dashboard.
4. For an uncertain attempt, inspect the original receipt. Only verified nonacceptance makes a new attempt eligible. `rehearsal_cancel` stops new submissions and still permits receipt checks on work already attempted. Follow the [staging pilot](CAMPAIGN_PILOT.md) for retry limits and worker configuration.

## Newsletter Studio commands

Use `campaign_get` to read the current `version`, brand and content. Use `campaign_create` or `campaign_update` with `content.studio` for the visual document. Existing title, subject, preheader, sender and reply-to metadata stay in the normal campaign fields. The following example is the Studio field of a campaign request.

```json
{
  "version": 1,
  "blocks": [
    {"type": "heading", "level": 1, "runs": [{"text": "Trail report"}]},
    {"type": "paragraph", "runs": [
      {"text": "Read the "},
      {"text": "November collection", "bold": true, "href": "https://example.org/collection"}
    ]},
    {"type": "button", "label": "Visit the shop", "href": "https://example.org/shop"}
  ]
}
```

Submit the complete campaign content and its ordered, distinct `assetIds` on each save. For this example, `assetIds` is empty. For an image, use `{"type":"image","assetId":"<same-brand asset UUID>","alt":"Description"}`. Resolve brand assets with `asset_list`. The block refers to the Flockletter asset ID, not an external image URL. The version inside `studio` identifies the document format. A command’s `expectedVersion` is the current campaign revision and advances on a successful update.

Treat `studio` as authoritative once present. Older readers can display the server’s projection into `heading`, `body`, `ctaLabel` and `ctaUrl`. To edit the visual content, preserve the existing metadata and change the relevant block. Omitting a saved Studio document is rejected; an unknown version or block prevents a destructive rewrite. Use the same operation key and identical input after a lost acknowledgement. If another edit committed, reload the current revision before resolving the conflict.

Use `campaign_preview` for the exact saved revision and `campaign_preflight` for remaining gaps. Further editing invalidates an outstanding review for the previous revision. Readers, editors, owners and connection tokens retain their existing brand permissions. [Studio workflow, migration and limits](NEWSLETTER_STUDIO.md) · [OpenAPI request schemas](../api/openapi.json)

## Owner-managed access

The dashboard's **API & MCP** page creates connections for the brands the owner selects. Read, draft-write, image-upload and audience totals are separate capabilities. The UI defaults to read-only for the first brand and a 30-day expiry. The API supports a maximum 90-day expiry. Only a current owner session may issue, list or revoke connections. Removing the issuing owner's Clerk authority invalidates its connection on the next authenticated request.

The secret is shown once. Store it in the MCP host's secret/environment facility. It is hashed in the database and is never returned by listing or retrying issuance. If the creation response is lost, list connections, revoke the affected one and issue a replacement. Never paste a token into a URL, repository, prompt or published screenshot. Rotation is create replacement, update the consumer, verify it, then revoke the old connection.

## HTTP contract

`POST /api/v1/commands/{command}` accepts a JSON object and an `Authorization: Bearer …` header. Replies use `{ "result": … }`; failures use `{ "error": { "code", "message", "details"? } }`. `GET /api/v1/schema` exposes the current schemas to an authenticated caller. The generated [OpenAPI specification](../api/openapi.json) lists the same input contracts. Browser calls require the configured same origin; arbitrary website origins are rejected. API clients must not follow redirects with credentials.

Most mutations require an `operationKey` of 16–128 letters, digits, `_` or `-`. Use a UUID. Identical retries return the saved result. Changed input under the same key returns `409 operation_conflict`. Keys are scoped to workspace and actor. The owner-only `audience.unsubscribe` derives its permanent replay key from the brand and contact IDs. Connection issuance follows the one-time-secret rule above. `expectedVersion` protects draft saves and previews.

## Recipient unsubscribe

Recipients can opt out without a login through `GET` and `POST /mail/unsubscribe?t=<opaque capability>`. GET and HEAD show an intentional confirmation form and make no database writes. A mailbox provider posts the single RFC 8058 form pair to the canonical HTTPS origin. Only a private, preauthorized worker may construct these links. Capabilities do not appear in owner previews, API/MCP results or tokens issued to assistants. [Marketing unsubscribe contract and verification](MARKETING_UNSUBSCRIBE.md)

## MCP setup


This release supplies a standard **stdio** MCP bridge, with token storage owned by the local MCP host. It does not advertise a remote OAuth endpoint or pretend that a static token is an OAuth consent flow. Remote Clerk OAuth MCP remains a later adapter workstream.

Build the repository, then configure the host to run:

```text
command: node
args: ["/absolute/path/to/flockletter/dist/server/mcp/main.js"]
```

Set these values through that host's secure environment configuration:

```text
FLOCKLETTER_API_ORIGIN=https://your-flockletter-staging-host
FLOCKLETTER_API_TOKEN=<owner-issued connection secret>
FLOCKLETTER_ASSET_ROOT=/absolute/path/to/approved/photos
```

The photo root is optional. Without it, local-file tools are absent. With it, `asset_upload_files` accepts relative paths, rejects paths/symlinks outside the root, bounds reads, and sends bytes to the configured Flockletter origin only. No supplier downloads or remote image fetches occur. Use a narrowly chosen photo folder, not the home directory. Other MCP tool names replace the HTTP command dot with `_`; for example, `campaign.preview` becomes `campaign_preview` and `asset.uploadBatch` becomes `asset_uploadBatch`.

Use `audience_summary` with `{"brandId":"<granted brand UUID>"}` for totals across the five subscriber states. This requires `audience:summary`. Combining `read` and `audience:summary` adds confirmed and excluded counts to `campaign_preflight`. Individual contacts, consent history and owner unsubscribe are available only to a current Clerk owner session. The separate `subscriber:signup` connection serves its single brand through the dedicated HTTP signup endpoint. [Audience walkthrough](AUDIENCE.md)

The owner-only `audience.previewImport` command accepts `brandId`, a base64-encoded UTF-8 CSV and a zero-based `emailColumn`. `audience.exportPage` returns up to 500 contacts for one brand. Submit its opaque cursor and revision to read another page. Both operations use the authenticated owner session. Assistant connections have no access to either operation. [CSV walkthrough](AUDIENCE.md#preview-a-csv)

`audience.applyPracticeImport` is an owner-session mutation on staging and local instances. Send the preview input, a UUID `operationKey`, and the explicit `fictional-contact-permission-v1` declaration. Its receipt identifies the brand, declaration and outcome for every data row. The UI uses the same command. MCP connections have no import authority. [Practice import](AUDIENCE.md#apply-a-practice-csv)

The `sender_deliveryReadiness` tool uses a simulator-scoped connection to report this brand’s setup gaps. A confirmed-address provider rehearsal can request `includeUnsubscribe: true` through `rehearsal_review` when `rehearsal_methods` reports `unsubscribeAvailable`. An approval report discloses the selected option and never returns a redeemable link. [Delivery readiness](DELIVERY_READINESS.md)


## Separate operator bridge

Platform operations use `/api/operator/v1/commands/*` and canonical `platformCommands`, also rendered by `/operator`. Configure a separate MCP process with `node /absolute/path/to/flockletter/dist/server/mcp/operator.js`, `FLOCKLETTER_API_ORIGIN` and a short-lived `FLOCKLETTER_OPERATOR_SESSION_TOKEN` kept in the host's secure settings. The server independently checks the current operator Clerk organization, named membership, enrolled MFA, both recent factor ages and exact case/action. Ordinary `flk_` customer tokens are rejected. Expired credentials require attended refresh; no long-lived elevated customer token is created. Capture exercises remain owner/workspace-only and cannot sign erasure. [Controls and playbook](PLATFORM_COMPLETION.md)

## Customer delivery audience selection

The Delivery screen can review all confirmed contacts or one existing named audience group. It submits the same optional `segmentId` accepted by `delivery_review`; the canonical server freezes the eligible recipient IDs. Later group additions do not enlarge an existing review, and execution still removes recipients whose consent or eligibility changes. If the selected group disappears during a refresh, the UI retains that unavailable selection and blocks a fresh review until the user explicitly chooses an audience; it never silently switches to all contacts. Group administration and directory listing keep their existing owner-only scope. A delegated assistant can use a known approved group ID with its existing brand-scoped delivery grant; this does not grant group-directory access.

`delivery_status` accepts an optional authorized `brandId`. With one, it checks that brand’s current legal sender profile, fresh DNS ownership and provider readiness; a verified brand has no fabricated sender-setup gap. Without one, the workspace-level report asks the caller to select a brand for those checks. Sender readiness alone never grants send authority or bypasses the separate exact review, subscription and execution checks. UI, HTTP and MCP share this input contract.

Local Qwen drafted the group-selector UI scaffold in 93.67 seconds (5,675 output characters). Chat corrected its missing brand argument, invalid spread syntax and unsafe fallback from a deleted group to all contacts, then implemented/reviewed sender-status authorization, recipient-snapshot tests and the browser journey. The browser proof uses disposable data and captured delivery; it is not live-mail evidence.
