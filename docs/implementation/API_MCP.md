# API and MCP preparation workflow

The campaign foundation exposes preparation commands through the administration UI, HTTP and MCP. Owners use `intake.status` and `intake.configure` through the same command layer. First-party signup has a distinct server-to-server HTTP operation and a single-brand `subscriber:signup` credential. General assistant tools keep their existing preparation scopes. [Intake contract](FFA_SUBSCRIBER_INTAKE.md)

## Start by reporting gaps

1. Run `workspace_preflight`. Report every setup gap before collecting images or writing a draft. Missing send prerequisites do not prevent preparation, but must remain visible.
2. Read `workspace_get` for authorized brands and the plan catalogue. If the workspace is not initialized, its owner completes the dashboard setup once.
3. Create a draft with `campaign_create`. Keep the returned ID and version. Use one stable operation key for identical retries.
4. Upload originals together with `asset_upload_files` or `asset_uploadBatch`. Keep each file's stable item key. Inspect **every** item result; a successful HTTP response can contain rejected files. Correct failed files and retry with a new batch key; keep successful file keys to avoid duplicates.
5. Save selected images and content with `campaign_update`, using the current expected version. A version conflict requires reading the current draft and reconciling edits; do not blindly overwrite it.
6. Run `campaign_preview` for that saved version and `campaign_preflight`. Present the exact preview and all remaining gaps. There is no approval or send operation in this build.

Normal preparation uses a few batch calls, not one call per image. Authentication, file preparation and intentional editing add calls. Do not claim an upload, save or preview is publication.

## Owner-managed access

The dashboard's **API & MCP** page creates connections for the brands the owner selects. Read, draft-write, image-upload and audience totals are separate capabilities. The UI defaults to read-only for the first brand and a 30-day expiry. The API supports a maximum 90-day expiry. Only a current owner session may issue, list or revoke connections. Removing the issuing owner's Clerk authority invalidates its connection on the next authenticated request.

The secret is shown once. Store it in the MCP host's secret/environment facility. It is hashed in the database and is never returned by listing or retrying issuance. If the creation response is lost, list connections, revoke the affected one and issue a replacement. Never paste a token into a URL, repository, prompt or published screenshot. Rotation is create replacement, update the consumer, verify it, then revoke the old connection.

## HTTP contract

`POST /api/v1/commands/{command}` accepts a JSON object and an `Authorization: Bearer …` header. Replies use `{ "result": … }`; failures use `{ "error": { "code", "message", "details"? } }`. `GET /api/v1/schema` exposes the current schemas to an authenticated caller. The generated [OpenAPI specification](../api/openapi.json) lists the same input contracts. Browser calls require the configured same origin; arbitrary website origins are rejected. API clients must not follow redirects with credentials.

Most mutations require an `operationKey` of 16–128 letters, digits, `_` or `-`. Use a UUID. Identical retries return the saved result. Changed input under the same key returns `409 operation_conflict`. Keys are scoped to workspace and actor. The owner-only `audience.unsubscribe` derives its permanent replay key from the brand and contact IDs. Connection issuance follows the one-time-secret rule above. `expectedVersion` protects draft saves and previews.

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
