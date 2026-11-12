# Production mail configuration and verification

This checklist supports FL-DEL-001–007, FL-AUD-002/004, FL-SUP-001/002 and FL-OPS-001/003/004/006. It records configuration requirements, not evidence that a provider or domain is active. Newsletter delivery supports selectable SES and Resend adapters under D-055; Resend confirmation, support and platform-alert credentials remain separate. See [selectable delivery](SELECTABLE_DELIVERY.md) for brand selection, configuration and evidence gates. Selecting a provider/plan, issuing its credentials and enabling external mail remain explicit operational actions.

## November 9 sender preparation evidence

The owner approved five SES verification records for `frostyflamingosoftware.com`: three Easy DKIM CNAME records and an MX/SPF pair only at `bounce.flockletter.frostyflamingosoftware.com`. Cloudflare imported all five with DNS proxying disabled, and authoritative DNS lookups returned the exact intended records. Existing root MX, SPF and DMARC values and forwarding rules were preserved. No sender credentials or external messages were created by the DNS import. SES domain/DKIM/MAIL FROM verification is a separate provider observation; the subsequent provider check confirmed identity verification, successful DKIM with signatures enabled, and successful custom MAIL FROM with reject-on-MX-failure. The Ohio account still remains in the sandbox (200 messages per day, one per second), with no messages sent. Its current plan is Essentials; no plan change was made.

Owner-supplied business details are kept in the approved sender profile and private review material, outside this public repository. The Flockletter-owned sender profile uses the selected platform sender and support reply address while delivery remains off. This does not populate another customer's brand or issue FFA's complimentary grant. Final legal wording, exact product tax classification, provider configuration and live activation remain separate gates.

## Resend account and credential boundaries

Use a Flockletter-only Resend account or team. The provider currently offers `sending_access` and `full_access`; retrieval requires the latter and cannot be described as read-only. Sending keys should use `sending_access` restricted to the verified sending domain. Separate sending and retrieval credentials are mandatory for live confirmations, support and approved alerts; the application never falls back to a sending key for retrieval. Keys cannot be shared with another application's mail account. [Resend key permissions](https://resend.com/docs/api-reference/api-keys/create-api-key)

| Configuration | Purpose |
| --- | --- |
| `FLOCKLETTER_CUSTOMER_SUPPORT=live` and `FLOCKLETTER_SUPPORT_ACTIVATION_APPROVED=true` | Enable reviewed support transport after its checks pass |
| `FLOCKLETTER_SUPPORT_RESEND_KEY` | Dedicated domain-scoped support sending key; POST `/emails` only |
| `FLOCKLETTER_SUPPORT_RESEND_RETRIEVE_KEY` | Dedicated retrieval credential; fixed GET sent/received email endpoints, provider Full access |
| `FLOCKLETTER_SUPPORT_SENDER` | Verified sending mailbox, independent of receiving destinations |
| `FLOCKLETTER_SUPPORT_NATIVE_WEBHOOK_SECRET` | Signing secret for `email.received` at `/api/v1/support/resend-inbound` |
| `FLOCKLETTER_SUPPORT_NATIVE_BINDINGS` | JSON array of exact server-owned `{address,workspaceId}` destinations, maximum 1,000 |
| `FLOCKLETTER_SUPPORT_NATIVE_ADDRESS` | Optional platform-wide unassigned-inbox address; requires live operator triage |
| `FLOCKLETTER_SUPPORT_REPLY_DOMAIN` | Dedicated receiving subdomain for participant-bound opaque reply addresses |
| `FLOCKLETTER_SUPPORT_THREAD_KEY` | Dedicated random signing secret, at least 32 bytes; never reuse a provider API key |
| `FLOCKLETTER_CUSTOMER_AUDIENCE=live` and `FLOCKLETTER_CONFIRMATION_ACTIVATION_APPROVED=true` | Enable generic customer confirmation transport |
| `FLOCKLETTER_CUSTOMER_CONFIRMATION_KEY` | Separate domain-scoped confirmation sending key |
| `FLOCKLETTER_CUSTOMER_CONFIRMATION_RETRIEVE_KEY` | Dedicated fixed-GET sent-email retrieval key, provider Full access; different from the sending key |
| `FLOCKLETTER_CUSTOMER_CONFIRMATION_WEBHOOK_SECRET` | Signing secret for `/api/v1/customer-audience/confirmation-events` |
| `FLOCKLETTER_CUSTOMER_CONFIRMATION_ROUTING_KEY` | Dedicated stable 32-byte hex opaque routing/recipient-HMAC signer, different from the link signer |
| `FLOCKLETTER_CUSTOMER_CONFIRMATION_FROM` | Verified confirmation sender |
| `FLOCKLETTER_CUSTOMER_CONFIRMATION_SIGNING_KEY` | Stable, dedicated 32-byte hex confirmation signer; preserve it while issued links remain valid |
| `FLOCKLETTER_PLATFORM_ALERTS_ENABLED=approved` | Enable alerts only with verified live operator configuration |
| `FLOCKLETTER_PLATFORM_ALERT_RESEND_KEY` | Separate domain-scoped platform alert sender credential |
| `FLOCKLETTER_PLATFORM_ALERT_RESEND_RETRIEVE_KEY` | Alert reconciliation retrieval credential, distinct from its sending key |
| `FLOCKLETTER_PLATFORM_ALERT_FROM` / `FLOCKLETTER_PLATFORM_ALERT_TO` | Exact reviewed sending mailbox and operator recipient |

Alert activation accepts only `off` or `approved`; unknown values fail configuration. Approved live alerts require nonblank, distinct sending and retrieval keys after whitespace normalization, and the transport receives those normalized values. Disabled alerts require no credentials.

Support and alert retrieval credentials may reside in the same dedicated Flockletter provider account, but must not be mistaken for technically restricted read-only credentials. Code uses only fixed retrieval URLs. Provider permissions and account separation require external verification; variable names do not prove them.

## DNS and receiving

Preserve the existing root-domain Cloudflare MX and forwarding rules. Put Resend receiving on dedicated inbound/reply subdomains, using exactly the provider-issued records, and verify sending DKIM/SPF/DMARC separately. Replacing root MX would redirect unrelated existing mail and is not required for these adapters. The existing public support address may continue forwarding to its current inbox; automatic ingestion of that address needs a separately reviewed forwarding path. Thread replies can use the dedicated receiving subdomain without changing root delivery.

Resend's signed `email.received` webhook contains metadata. The application verifies its raw signature, binds its destination before requesting content, retrieves only from Resend's fixed receiving API and validates the content against the metadata. It does not fetch sender-controlled URLs, raw MIME or attachments. Provider-computed `authentication.dmarc=pass` is required for authenticated conversation replies. Missing/null/non-pass proof is quarantined; `gray` may indicate a non-enforcing sender DMARC policy even when SPF/DKIM align. Forged `Authentication-Results` headers cannot establish authority. [Received-email reference](https://resend.com/docs/api-reference/emails/retrieve-received-email)

Verify: good signature and exact destination; bad signature; unbound destination; mismatched provider body; missing/gray authentication; known participant reply; duplicate receipt; and provider retrieval denied/unavailable. Retrieval errors remain retryable 503 outcomes, without ingesting a provider error body or manufacturing a ticket. Do not weaken authentication to make an inbox self-test pass.

## Customer confirmation receipts

Migration 029 adds private opaque confirmation routing and the append-only brand-scoped `customer_audience_feedback` ledger. Before the one permitted submission, a committed route binds the workspace, brand, operation and HMAC recipient digest. Its token is a provider tag; neither raw addresses nor workspace identifiers are stored in routing metadata. Routes expire 30 days after the confirmation-link expiry, with a database-enforced 90-day ceiling. Workspace erasure inventories and removes routes and feedback; the private insert guard prevents restoration from recreating erased data.

The raw 16 KiB-limited event must pass its signature and timestamp check before retrieval. Subscribe this webhook to `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.failed` and `email.delivery_delayed`. A UUID-only fixed `GET /emails/:id` retrieves authoritative route/operation tags; caller-supplied tags never select a workspace. Retrieved sender, sole recipient, route HMAC, operation, submitted attempt and immutable provider binding must match under the workspace/brand lock. Missing receipt data or unavailable retrieval remains unresolved. Event identifiers are globally unique; changed content or a changed provider mapping is rejected rather than rebound. [Sent-email reference](https://resend.com/docs/api-reference/emails/retrieve-email)

Authenticated transport facts can resolve an uncertain provider acceptance. They never mark a subscriber confirmed or create opt-in evidence. Only a permanent bounce or complaint strengthens canonical suppression, including when receipts arrive out of order; a transient bounce remains a delay. The existing token-based confirmation action is still required. Owner UI/API status includes the latest verified transport fact separately from subscription state. Existing delegated MCP grants keep their current bounds; aggregate audience counts reflect canonical suppression, while detailed owner-only confirmation records are not newly delegated. Old confirmations submitted before this routing scheme have no registered route and remain held; never infer acceptance from their absence in provider search or resend them automatically.

Disposable PostgreSQL tests cover missing/forged/expired signatures, body bounds, unavailable retrieval, missing/duplicate tags, recipient/provider mismatches, conflicting replay IDs, two-workspace isolation, immutable routing, append-only receipts, suppression ordering and restored-erasure/route expiry. A real signed provider receipt is still required for live verification.

## SES newsletter runtime

The customer renderer is separate from the legacy staging rehearsal messenger. Set `FLOCKLETTER_PRIVATE_ENGINE=embedded` for both the build and runtime when enabling customer rendering; the build verifies the pinned Listmonk artifact, and both web and dedicated-worker startup require that artifact to be executable before advertising a configured renderer. `FLOCKLETTER_CUSTOMER_ENGINE_COUNT` bounds the process-local pool to one through five isolated workspace renderers (default one). The renderer does not establish send authority or provider eligibility.

Production never starts the legacy rehearsal messenger and does not require `FLOCKLETTER_CAPTURE_WORKSPACE` or `FLOCKLETTER_CAPTURE_BRAND` for customer rendering. Staging rehearsals retain their existing explicit workspace/brand requirement. The private-engine switch accepts only `off` or `embedded`; invalid values fail startup. With customer delivery off, the customer renderer stays unallocated and no binary or separate worker is required. All delivery modes and live activation approvals keep their existing defaults and guards.

`FLOCKLETTER_CUSTOMER_DELIVERY=ses` requires `APP_ENV=production`, `FLOCKLETTER_LIVE_MAILING_APPROVED=true`, dedicated `FLOCKLETTER_CUSTOMER_SES_ACCESS_KEY_ID` / `FLOCKLETTER_CUSTOMER_SES_SECRET_ACCESS_KEY` (and optional `FLOCKLETTER_CUSTOMER_SES_SESSION_TOKEN`) and validated `FLOCKLETTER_CUSTOMER_SES_BINDINGS`. Each binding contains the exact `workspaceId`, `brandId`, US `region`, `accountId`, `tenant`, `configurationSet`, `from`, `identityArn` and `topicArn`. Do not put actual IDs or keys in this document.

For an initially provisioned sender, runtime calls are `ses:SendEmail`; account readiness `ses:GetAccount`; identity readiness `ses:GetEmailIdentity`; configuration readiness `ses:GetConfigurationSet` and `ses:GetConfigurationSetEventDestinations`; tenant readiness `ses:GetTenant`, `ses:ListTenantResources` and `ses:GetReputationEntity`. Limit identity/configuration-set/tenant actions to the reviewed resources where AWS supports resource permissions. `GetAccount` is account-level. Constrain sending to the reviewed From address and tenant using AWS's supported conditions; do not grant wildcard SES write access. This is a runtime call inventory, not a blanket IAM policy. [AWS action/resource reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html)

The separate automatic infrastructure adapter additionally creates only operator-bounded SES tenant/identity/configuration/event-destination resources and SNS topics/subscriptions under a reviewed prefix. It uses a separate credential and `FLOCKLETTER_CUSTOMER_INFRASTRUCTURE=aws`, `FLOCKLETTER_INFRASTRUCTURE_ACTIVATION_APPROVED=true`, an explicit account/US region/prefix and a nonzero monthly allowance. Do not reuse provisioning authority as the sending credential. The SES callback is `/api/v1/customer-delivery/ses-events`; verify SNS confirmation/signatures and exact route/recipient mappings before dispatch.

## FFA first-customer options

The newer customer audience contract supports live hosted forms at `/newsletter/:form`. An FFA brand can use a link to that form, with authoritative policy wording/version, affirmative consent, suppression protection and double opt-in. Forms intentionally deny framing. This can be the first production pilot without changing another application's subscriber database.

The legacy FFA server-proxy/intake contract remains explicitly staging-only. Its source-domain attestation and scoped grant cannot be replaced by posting the old proxy payload to a public hosted form. Preserving FFA's existing embedded on-site form requires a separately reviewed production intake extension and explicit grant/configuration. Do not weaken the old environment checks or change FFA in this workstream.

## Evidence and local-model work

Credential separation and retry behavior are covered by provider/configuration tests and disposable PostgreSQL support tests. The complete local validation passed 92 files and 603 tests, with two explicitly gated private-engine tests skipped; lint, typecheck and the production build passed. Final confirmation hardening also passed all 11 focused tests. They do not prove live delivery, domain ownership or Resend key permissions. Record actual provider/domain/receipt verification separately, without secret values or customer bodies.

Local Qwen drafted three bounded credential-isolation test cases. Chat reviewed the draft, corrected a mutable declaration and an existing lookup fixture, and owns credential scope, transport wiring, failure behavior and this operational checklist.

For the follow-up alert configuration regression, the local model drafted focused tests; Chat owns the fail-closed flag validation, normalized credential separation and runtime integration, and corrected its import, duplicate cases and capture-mode fixture before use.

The production-renderer startup follow-up passed lint, typecheck, all 107 test files (734 tests passed; two gated native-engine tests skipped) and the production build. Focused checks cover the real staging loopback dispatcher, scope/environment rejection, synthetic production customer configuration without staging scopes, invalid switches and unavailable/nonexecutable binary checks. File access and SES submission are substituted in the customer-startup tests; no native renderer or provider was launched by those tests. The local model drafted selector and binary-check scaffolds; Chat replaced its fake guard and untyped placeholders, added the omitted settings cases and actual customer-construction checks, and owns the startup design, activation boundaries and final validation.
