# Animated media and confirmation choices

D-054 implements FL-CAM-001/008/009, FL-AUD-001/002/003/004, FL-ID-002/004, FL-API-001/002/003 and FL-OPS-004/006. Existing photos, commerce configuration and external delivery/billing activation are unchanged.

## Images

Image library and Studio uploads accept JPEG, PNG, GIF, WebP and self-contained static SVG. The shared upload command and local-file MCP helper use identical validation and per-file results. GIF/WebP animation retains the original bytes, dimensions, frame timing and loop settings. Validate every decoded frame, with at most 100 frames and 25 million total pixels across frames. Existing 5 MiB/file, 10 files/20 MiB batch and 100 MiB workspace storage bounds remain. APNG is rejected rather than silently flattened. Some inbox applications display only the first frame; make it meaningful.

SVG upload is an import operation: strict XML parsing reconstructs a bounded static shape/text/gradient vocabulary, then Sharp rasterizes it to PNG. Scripts, handlers, foreign content, DTD/entities, processing instructions, external references, style sheets, SMIL, image embedding and unsupported elements/attributes are rejected before native rendering. Local gradient/clip references are allowed. SVG input is limited to 1 MiB, 3,000 nodes and 32 levels. Generic system fonts only; outlines provide reliable branded lettering. The resulting PNG must fit the image/pixel limits. It is saved with a `.png` name and a conversion notice. Uploaded SVG markup is never stored or served. Original SVG bytes remain with the uploader; existing raster originals are never rewritten.

GIF is accepted by customer test/broadcast previews and the shared inline attachment validator. Neither successful upload nor preview authorizes sending. Static SVG and animation unsupported by this path fail per item, allowing successful items to be reused with stable keys.

## Contact subscription without an email response

In Audience → Signup page and consent, the owner can clear **Require email confirmation for new signups**, choose a new consent policy version and save. Double opt-in remains the default for existing and new brands. Older clients omitting the choice preserve the current setting. Single opt-in requires affirmative form consent, records current policy/source/time and creates no confirmation job. The public response does not reveal whether an address is new, already subscribed or suppressed. Existing rate/contact limits remain. Changing the setting does not convert existing pending contacts.

For first-session imports, upload up to 2,500 data rows in one UTF-8 CSV (1 MiB). The default remains pending regardless of the signup choice. **Subscribe imported contacts immediately without a confirmation email** additionally binds the saved consent policy, existing permission declaration and source. Per-row results distinguish newly subscribed, retained, invalid, duplicate and capacity-blocked contacts. Existing pending contacts may be explicitly subscribed; unsubscribed, hard-bounced and complained records remain unchanged.

**Subscribe existing pending contacts without email** offers selection of at most 50 contacts per UI page, with permission source and declaration. The canonical `audienceOnboarding.confirmContacts` accepts up to 250 distinct IDs per request. Exact operation retries return the saved outcome; changed requests under the same key conflict. Current ownership, brand scope, policy version and suppression are rechecked under the workspace lock. Unsent confirmation jobs are canceled; unknown/in-flight submissions remain reconciliation-only.

The durable subscriber state remains `confirmed` for compatibility, meaning subscribed/send-eligible subject to ordinary controls. New consent sources distinguish `customer-{exercise|live}-single-opt-in` and `customer-{exercise|live}-owner-attestation` from actual confirmation-link events. Evidence includes the permission source and recording actor. UI history explicitly says **Subscribed without email verification**; no mailbox ownership proof is invented. Exercise-only records cannot authorize production sending without separate live consent/attestation.

## API and MCP

Owners use the same canonical commands as UI. Delegated imports still require `audience:write`. Subscribing selected contacts or promoting imports without email additionally requires a new explicitly selected, brand-scoped `audience:confirm` capability. Existing grants gain no permission. Policy configuration and private contact browsing remain owner-session only. Grant expiry/revocation and current issuer ownership are rechecked in the transaction. The generated OpenAPI and MCP tool schema expose the exact flags, policy and batch limits.

## Release and verification

Apply additive migration `032_media_confirmation_choices.sql` before deploying the new source. It adds the confirmation choice (default double opt-in), optional consent evidence fields and GIF MIME permission. It does not modify existing subscriber states or media bytes, add runtime privileges, or enable transport. A code rollback can retain the additive schema; keep mailing off and review single-opt-in configuration and GIF assets before using an older client that cannot display them. Do not delete consent evidence or media as a rollback.

`tests/animated-media.test.ts` checks actual multi-frame bytes/metadata, PNG raster pixels, unsafe/oversized XML, frame limits and GIF inline attachments. `tests/optional-confirmation.test.ts` uses real disposable PostgreSQL for defaults/version changes, live and exercise provenance, non-enumerating signup, suppression/opt-out, import limits, selected contacts, exact replay, concurrency, current owner/grant checks and MCP parity. `scripts/prove-media-confirmation.ts` exercises normal desktop/390px screens with disposable contacts and no outbound mail. Existing foundation and audience tests retain photo-byte, partial upload, public-origin and double-opt-in coverage.

Local Qwen drafted the uploader changes and image tests. Primary review removed stale unsupported-format text, repaired invalid JSX/ESM, replaced a GIF fixture whose palette/alpha collapsed its frames, and added independent frame/PNG-pixel, malicious-SVG and transport checks. Chat owns consent and security policy, XML boundary, frame budgets, schema, canonical UI/API/MCP integration, contact tests and deployment review. Hosted verification is recorded separately after actual rollout.
