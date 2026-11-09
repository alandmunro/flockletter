# Production mail configuration and verification

This checklist supports FL-DEL-001–007, FL-AUD-002/004, FL-SUP-001/002 and FL-OPS-001/003/004/006. It records configuration requirements, not evidence that a provider or domain is active. Newsletter delivery currently uses the SES adapter; Resend handles customer confirmations, support and platform alerts. Selecting a provider/plan, issuing its credentials and enabling external mail remain explicit operational actions.

## Resend account and credential boundaries

Use a Flockletter-only Resend account or team. The provider currently offers `sending_access` and `full_access`; retrieval requires the latter and cannot be described as read-only. Sending keys should use `sending_access` restricted to the verified sending domain. Separate sending and retrieval credentials are mandatory for live support and approved alerts; the application never falls back to a sending key for retrieval. Keys cannot be shared with another application's mail account. [Resend key permissions](https://resend.com/docs/api-reference/api-keys/create-api-key)

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
| `FLOCKLETTER_CUSTOMER_CONFIRMATION_FROM` | Verified confirmation sender |
| `FLOCKLETTER_CUSTOMER_CONFIRMATION_SIGNING_KEY` | Stable, dedicated 32-byte hex confirmation signer; preserve it while issued links remain valid |
| `FLOCKLETTER_PLATFORM_ALERTS_ENABLED=approved` | Enable alerts only with verified live operator configuration |
| `FLOCKLETTER_PLATFORM_ALERT_RESEND_KEY` | Separate domain-scoped platform alert sender credential |
| `FLOCKLETTER_PLATFORM_ALERT_RESEND_RETRIEVE_KEY` | Alert reconciliation retrieval credential, distinct from its sending key |
| `FLOCKLETTER_PLATFORM_ALERT_FROM` / `FLOCKLETTER_PLATFORM_ALERT_TO` | Exact reviewed sending mailbox and operator recipient |

Support and alert retrieval credentials may reside in the same dedicated Flockletter provider account, but must not be mistaken for technically restricted read-only credentials. Code uses only fixed retrieval URLs. Provider permissions and account separation require external verification; variable names do not prove them.

## DNS and receiving

Preserve the existing root-domain Cloudflare MX and forwarding rules. Put Resend receiving on dedicated inbound/reply subdomains, using exactly the provider-issued records, and verify sending DKIM/SPF/DMARC separately. Replacing root MX would redirect unrelated existing mail and is not required for these adapters. The existing public support address may continue forwarding to its current inbox; automatic ingestion of that address needs a separately reviewed forwarding path. Thread replies can use the dedicated receiving subdomain without changing root delivery.

Resend's signed `email.received` webhook contains metadata. The application verifies its raw signature, binds its destination before requesting content, retrieves only from Resend's fixed receiving API and validates the content against the metadata. It does not fetch sender-controlled URLs, raw MIME or attachments. Provider-computed `authentication.dmarc=pass` is required for authenticated conversation replies. Missing/null/non-pass proof is quarantined; `gray` may indicate a non-enforcing sender DMARC policy even when SPF/DKIM align. Forged `Authentication-Results` headers cannot establish authority. [Received-email reference](https://resend.com/docs/api-reference/emails/retrieve-received-email)

Verify: good signature and exact destination; bad signature; unbound destination; mismatched provider body; missing/gray authentication; known participant reply; duplicate receipt; and provider retrieval denied/unavailable. Retrieval errors remain retryable 503 outcomes, without ingesting a provider error body or manufacturing a ticket. Do not weaken authentication to make an inbox self-test pass.

## SES newsletter runtime

`FLOCKLETTER_CUSTOMER_DELIVERY=ses` requires `APP_ENV=production`, `FLOCKLETTER_LIVE_MAILING_APPROVED=true`, dedicated `FLOCKLETTER_CUSTOMER_SES_ACCESS_KEY_ID` / `FLOCKLETTER_CUSTOMER_SES_SECRET_ACCESS_KEY` (and optional `FLOCKLETTER_CUSTOMER_SES_SESSION_TOKEN`) and validated `FLOCKLETTER_CUSTOMER_SES_BINDINGS`. Each binding contains the exact `workspaceId`, `brandId`, US `region`, `accountId`, `tenant`, `configurationSet`, `from`, `identityArn` and `topicArn`. Do not put actual IDs or keys in this document.

For an initially provisioned sender, runtime calls are `ses:SendEmail`; account readiness `ses:GetAccount`; identity readiness `ses:GetEmailIdentity`; configuration readiness `ses:GetConfigurationSet` and `ses:GetConfigurationSetEventDestinations`; tenant readiness `ses:GetTenant`, `ses:ListTenantResources` and `ses:GetReputationEntity`. Limit identity/configuration-set/tenant actions to the reviewed resources where AWS supports resource permissions. `GetAccount` is account-level. Constrain sending to the reviewed From address and tenant using AWS's supported conditions; do not grant wildcard SES write access. This is a runtime call inventory, not a blanket IAM policy. [AWS action/resource reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html)

The separate automatic infrastructure adapter additionally creates only operator-bounded SES tenant/identity/configuration/event-destination resources and SNS topics/subscriptions under a reviewed prefix. It uses a separate credential and `FLOCKLETTER_CUSTOMER_INFRASTRUCTURE=aws`, `FLOCKLETTER_INFRASTRUCTURE_ACTIVATION_APPROVED=true`, an explicit account/US region/prefix and a nonzero monthly allowance. Do not reuse provisioning authority as the sending credential. The SES callback is `/api/v1/customer-delivery/ses-events`; verify SNS confirmation/signatures and exact route/recipient mappings before dispatch.

## FFA first-customer options

The newer customer audience contract supports live hosted forms at `/newsletter/:form`. An FFA brand can use a link to that form, with authoritative policy wording/version, affirmative consent, suppression protection and double opt-in. Forms intentionally deny framing. This can be the first production pilot without changing another application's subscriber database.

The legacy FFA server-proxy/intake contract remains explicitly staging-only. Its source-domain attestation and scoped grant cannot be replaced by posting the old proxy payload to a public hosted form. Preserving FFA's existing embedded on-site form requires a separately reviewed production intake extension and explicit grant/configuration. Do not weaken the old environment checks or change FFA in this workstream.

## Evidence and local-model work

Credential separation and retry behavior are covered by provider/configuration tests and disposable PostgreSQL support tests. They do not prove live delivery, domain ownership or Resend key permissions. Record actual provider/domain/receipt verification separately, without secret values or customer bodies.

Local Qwen drafted three bounded credential-isolation test cases. Chat reviewed the draft, corrected a mutable declaration and an existing lookup fixture, and owns credential scope, transport wiring, failure behavior and this operational checklist.
