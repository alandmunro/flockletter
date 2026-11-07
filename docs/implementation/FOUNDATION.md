# Foundation workstream

Owner authorization: November 6, 2026. Build without routine approval stops, make reasonable decisions, delegate suitable mechanical work to the local model and review its output. Staging may be resumed; production remains outside this workstream.

## Scope and decisions

Implement a working preparation flow: Clerk workspace selection, a durable workspace and first brand, campaign drafts with optimistic versions, bounded batch image uploads with per-item outcomes, safe HTML/plain-text preview, complete readiness gaps, and revocable scoped API connections used by an MCP stdio bridge. All commands share one server implementation. API/MCP access is available regardless of proposed tier. Sending, billing activation, subscriber imports and engine provisioning are later workstreams; the UI must say so rather than simulate success.

Use TypeScript, React/Vite and Express, with PostgreSQL. One application process serves the portal and API. No worker is necessary until durable external jobs exist. Use a dedicated logical database, separate migration/runtime roles, forced row-level security and tenant-scoped foreign keys. Uploaded originals live in the application database for this bounded foundation, avoiding ephemeral disk loss and a new storage service; migrate behind an asset adapter before larger-scale operation. No code or data from other applications is imported.

Foundation limits: 10 files/batch, 5 MiB/file, 20 MiB decoded/batch, JPEG/PNG/WebP only, 25 megapixels/image, 6 images/campaign, 100 MiB media/workspace, 100 draft campaigns/workspace, 10 active connections/workspace. These are protective preparation limits, not advertised billing entitlements. An unactivated workspace can prepare one brand and drafts; preparation grants no trial, complimentary entitlement or delivery access. The accepted paid plan catalogue remains unchanged.

Hosted authentication uses a Flockletter-owned Clerk application. Verify session signature, authorized origin and active organization, then retrieve current membership from Clerk for each authenticated operation. `org:admin` is the foundation owner role. Other roles receive no authority until deliberately configured; do not silently give all members access to every brand. Scoped owner-created connections can narrow draft/read/asset access to a set of existing brands. Connection tokens are random, hashed at rest, expire within 90 days, can be revoked and remain subordinate to the issuing owner's current Clerk membership. Tokens cannot manage other connections. Remote OAuth MCP is deferred; the standard stdio MCP bridge keeps credentials in its host environment and calls the same versioned HTTPS API.

Local development uses explicitly enabled loopback-only synthetic identity and disposable records. This mode must reject hosted/staging configuration, non-loopback listeners and origins. Never deploy a synthetic identity bypass. Staging requires its own Clerk configuration and dedicated database roles before readiness can pass. A missing setting is a visible setup gap, not a successful authenticated staging test.

## Security and integration gates

Content is structured plain text and an optional HTTPS call-to-action; no arbitrary HTML, templates, remote fetching or JavaScript URLs. Previews escape all content, embed only authorized image bytes and run in a sandboxed iframe. Files are decoded and checked before storage; names are display metadata only. No rendering path emits filesystem paths. All mutations require stable idempotency keys; version conflicts cannot silently overwrite another editor. Read commands never provision records. Audit entries contain identifiers/actions, not tokens or message bodies.

Listmonk's ordinary campaign APIs and HTTP messenger interface do not by themselves prove the required per-recipient reservation, suppression, revocation and ambiguous-outcome guarantees. This workstream reviews the adapter boundary but does not activate an engine or claim that FL-DEL-005 passes. No raw engine API is exposed. There is no send route or SMTP credential in the foundation.

## Verification

Use two synthetic tenants and a real disposable PostgreSQL server. Check forced RLS using the runtime role, foreign associations, replay/content conflicts, concurrent updates and batch retries. Verify API/MCP parity with a real MCP client and HTTP server, current membership revocation, origin/authentication failure, malicious/oversized media, safe previews and disabled delivery. Run lint, typecheck, tests and production build; exercise the customer flow at desktop and phone sizes. Record exact results and distinguish mocked Clerk contracts from real provider verification.

Applicable requirements: FL-PROD-001/003/004, FL-ONB-001/002/004, FL-ID-001–005, FL-BIL-001, FL-CAM-001/002, FL-API-001–003, FL-OPS-001/003/004/006/007. Full release acceptance remains broader than this foundation.
