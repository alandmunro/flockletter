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

Platform operations use `/api/operator/v1/commands/*` and canonical `platformCommands`, also rendered by `/operator`. Configure a separate MCP process with `node /absolute/path/to/flockletter/dist/server/mcp/operator.js`, `FLOCKLETTER_API_ORIGIN` and a short-lived `FLOCKLETTER_OPERATOR_SESSION_TOKEN` kept in the host's secure settings. The server independently checks the current operator Clerk organization, named membership, enrolled MFA, both recent factor ages and exact case/action. The only accepted exception is [D-051’s explicit pre-revenue policy](PRE_REVENUE_OPERATOR_AUTH.md): verified first-factor freshness replaces the second factor temporarily, with all other authorization checks retained. `platform.overview` exposes the exact authentication policy identically to the admin UI and MCP; a connection cannot choose it. Ordinary `flk_` customer tokens are rejected. Expired credentials require attended refresh; no long-lived elevated customer token is created. Capture exercises remain owner/workspace-only and cannot sign erasure. [Controls and playbook](PLATFORM_COMPLETION.md)

## Customer delivery audience selection

The Delivery screen can review all confirmed contacts or one existing named audience group. It submits the same optional `segmentId` accepted by `delivery_review`; the canonical server freezes the eligible recipient IDs. Later group additions do not enlarge an existing review, and execution still removes recipients whose consent or eligibility changes. If the selected group disappears during a refresh, the UI retains that unavailable selection and blocks a fresh review until the user explicitly chooses an audience; it never silently switches to all contacts. Group administration and directory listing keep their existing owner-only scope. A delegated assistant can use a known approved group ID with its existing brand-scoped delivery grant; this does not grant group-directory access.

`delivery_status` accepts an optional authorized `brandId`. With one, it checks that brand’s current legal sender profile, fresh DNS ownership and provider readiness; a verified brand has no fabricated sender-setup gap. Without one, the workspace-level report asks the caller to select a brand for those checks. Sender readiness alone never grants send authority or bypasses the separate exact review, subscription and execution checks. UI, HTTP and MCP share this input contract.

Local Qwen drafted the group-selector UI scaffold in 93.67 seconds (5,675 output characters). Chat corrected its missing brand argument, invalid spread syntax and unsafe fallback from a deleted group to all contacts, then implemented/reviewed sender-status authorization, recipient-snapshot tests and the browser journey. The browser proof uses disposable data and captured delivery; it is not live-mail evidence.

## Complete recipient outcome reports

Use `delivery_outcomes` (`delivery.outcomes` over HTTP) with the current brand and reviewed delivery ID. Read-only pages expose opaque recipient identifiers and status, feedback, attempts and reason; they never resend or reserve allowance. `after` is the prior page's `nextCursor`, `limit` defaults to25 and cannot exceed100. Optional `state` and `feedback` filters let an authorized sender locate uncertain outcomes beyond the legacy report's first50 entries. Start again when changing filters. Each response has one observed snapshot; earlier pages retain older feedback until refreshed. Existing connection scopes, issuer ownership, revocation and brand boundaries apply. [Reporting behavior and verification](DELIVERY_OUTCOMES.md).

## Current campaign preflight

FL-CAM-002 and FL-API-003 now use the current customer delivery checks rather than foundation placeholders. `campaign_preflight` remains draft-read scoped and observes the saved campaign’s current brand. `delivery_preflight` requires the existing draft-read plus campaign-send grant and accepts `brandId`, `campaignId`, optional `expectedVersion`, `segmentId` and `dueAt`. Both use the same read-only implementation: content/original-image integrity, renderer mode, current sender/profile/provider readiness, consent-eligible audience, service eligibility, scheduled-period allowance and applicable end dates. Its response binds the observed campaign version, selected group, sender revision and observation time. It always returns `canSend: false` and `reviewRequired: true`; approval and execution retain all their independent checks.

Checks collect applicable gaps together. Unauthorized, revoked or unavailable brands/campaigns/groups still fail without exposing other records. Audience counts require a current owner session or an explicit `audience:summary` grant. Numeric allowance is owner-session-only; provider/customer identifiers, addresses and subscription records are absent. Oversized audiences return an explicit over-limit observation without fabricated eligible/excluded counts. The older editor response omits audience counts when they are restricted or over limit. Current provider readiness is a bounded authoritative read, not provider provisioning. Preflight creates no review, recipient, reservation, audit event or queue wake and does not hydrate/mutate infrastructure routes.

## Bounded one-recipient tests

D-047 now approves the separate one-confirmed-recipient test path under FL-CAM-010. Use `delivery_reviewTest` and an explicit `delivery_approveTest`; generic broadcast approval is not interchangeable. The shared workspace limit is five approved test requests per UTC day, including failed/canceled requests. Accepted real tests use one recipient email and no monthly campaign slot. Tests are immediate; new attempts expire at the approval day’s midnight UTC, and unknown outcomes remain reconciliation-only.

The [test-send playbook](TEST_SEND.md) records exact owner selection, known-ID-only delegated operation, frozen facts, operation-key retry and status/capture inspection. Generic delivery reports omit private subscriber references, and owner-only directory/details commands do not become delegated permissions. Existing rehearsal transports retain their reserved-address boundaries. Staging captures and synthetic provider checks remain distinct from authorized real provider/inbox evidence; documentation and credential setup do not activate live mail.

Local Qwen drafted three preflight test scaffolds in 81.15 seconds (4,188 output characters). Chat corrected PostgreSQL result handling, the blank-subject fixture, comparison/type errors, then implemented and reviewed the read-only helper, privacy/permission checks, canonical usage observations, MCP parity and negative/oversized tests. All external provider responses in tests are fixtures.

Verification for this preflight change: full local lint/typecheck/build and 99 test files passed (661 tests; two explicitly gated private-engine tests skipped). Focused checks include real MCP transport, read/send/audience-summary separation, persisted grant narrowing/revocation/expiry, removed issuer ownership, original images, over-limit observations and unchanged operations/audit/reservations/queue routing. The seven normal desktop/390px captured customer browser journeys also passed. These are local checks, not a live provider readiness or inbox-delivery claim.

The customer Delivery screen checks `delivery.preflight` for its exact saved version, audience selection and schedule when the owner requests review. It displays all blocking preparation gaps together and creates no review until they are resolved. This observation never approves a send; the normal review, approval, allowance and execution checks remain authoritative.

Delivery-list reports batch their aggregate state/feedback counts and first 50 opaque recipient outcomes in two sequential database reads for up to 100 deliveries. PostgreSQL applies the per-delivery outcome cap before returning rows; full totals still include outcomes beyond that cap. Exact workspace/brand/delivery tuples select and map the facts, and the existing DTO contains no additional recipient information. Empty batches do no reporting query. Single-delivery reports use the same mapper. This replaces concurrent queries on one PostgreSQL client and avoids two reporting queries per listed delivery. Query-budget, all-state/feedback, capped-order, duplicate-key and brand-isolation tests cover the change. Local Qwen drafted the pure mapper in 53.14 seconds (3,220 output characters); chat corrected key encoding/type assertions and owns the SQL, isolation, integration and verification.

## Animated media and optional email confirmation

GIF/WebP animation and static SVG-to-PNG import use the existing batch upload tools. Read every per-item result and conversion notice. `audienceOnboarding_confirmContacts` subscribes only the explicitly supplied IDs, with permission declaration, source and current policy version. It requires a separately granted `audience:confirm` capability. An import with `confirmWithoutEmail:true` also requires that capability plus its existing `audience:write` grant and `consentPolicyVersion`. Existing write grants cannot promote contacts. Signup mode configuration and detailed contact browsing remain owner-only. See [the workflow and evidence](MEDIA_AND_CONFIRMATION.md).

## Selectable newsletter delivery

D-055 adds `delivery.providers` and `delivery.selectProvider` through the same canonical HTTP/MCP layer used by the Delivery dashboard. Owner sessions can choose a configured service per brand. Delegated clients need the new explicit `delivery:configure` grant plus `read`, scoped to the exact brand and current issuing owner; existing send/draft grants gain no configuration authority. Provider configuration does not grant campaign send permission. Supply `provider: ses|resend`, `expectedRevision` and a stable operation key; never supply keys, provider URLs or another workspace. [Configuration, invalidation and reconciliation](SELECTABLE_DELIVERY.md).
