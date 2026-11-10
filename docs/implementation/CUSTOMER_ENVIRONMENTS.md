# Customer workflow environment boundaries

The customer workflow settings default to `off`. An unknown mode fails startup rather than selecting a permissive fallback. Runtime secrets belong in the dedicated Flockletter service configuration, never in this public repository or a browser form. Existing applications and merchant settings remain separate.

For the staging owner exercise, configure the existing Flockletter staging service with these nonsecret settings:

```dotenv
APP_ENV=staging
FLOCKLETTER_CUSTOMER_BILLING=exercise
FLOCKLETTER_CUSTOMER_DELIVERY=capture
FLOCKLETTER_CUSTOMER_AUDIENCE=exercise
FLOCKLETTER_CUSTOMER_TEAM=exercise
FLOCKLETTER_CUSTOMER_SUPPORT=capture
FLOCKLETTER_CUSTOMER_RETENTION=capture
FLOCKLETTER_CUSTOMER_INFRASTRUCTURE=capture
FLOCKLETTER_PRIVATE_ENGINE=embedded
FLOCKLETTER_CUSTOMER_ENGINE_COUNT=1
```

The service retains its isolated database and verified Clerk configuration. This mode records captured outcomes in PostgreSQL and supports owner review without sending customer email, charging a card, creating external team invitations or erasing hosted data. The embedded worker runs while the staging web service is awake; sleeping free staging does not provide continuous scheduling. A dedicated worker is a separately configured hosting decision.

For D-052's captured test-only rehearsal, additionally set `FLOCKLETTER_CUSTOMER_DELIVERY_SCOPE=tests`. Production SES in this scope requires its separate exact `FLOCKLETTER_TEST_MAILING_APPROVED=true`; a broad-mail flag alone cannot authorize it. Scope `all` still requires `FLOCKLETTER_LIVE_MAILING_APPROVED=true`, and the tests flag cannot enable broadcasts. Both use the same verified provider, consent, sender and service controls. Keep all production activation flags false during code promotion. [Test-only deployment and first-letter gaps](TEST_ONLY_DELIVERY.md)

| Area | External mode | Additional gate |
| --- | --- | --- |
| Customer delivery | `FLOCKLETTER_CUSTOMER_DELIVERY=ses` | Production only; exact `FLOCKLETTER_LIVE_MAILING_APPROVED=true`, dedicated sender/tenant/feedback routes and credentials, verified sender and provider readiness, protected subscriber consent and limits. |
| Customer billing | `FLOCKLETTER_CUSTOMER_BILLING=stripe_test` or `stripe_live` | Dedicated account/price/card/webhook configuration and matching key type; live additionally requires production and `FLOCKLETTER_LIVE_BILLING_APPROVED=true`. Browser redirects never establish access. |
| Audience confirmation | `FLOCKLETTER_CUSTOMER_AUDIENCE=live` | `FLOCKLETTER_CONFIRMATION_ACTIVATION_APPROVED=true`, dedicated sender/provider/signing configuration. Public signup is not an automatic marketing subscription. |
| Team administration | `FLOCKLETTER_CUSTOMER_TEAM=clerk` | Verified Flockletter Clerk configuration, current owner checks and durable provider intents. |
| Support replies | `FLOCKLETTER_CUSTOMER_SUPPORT=live` | `FLOCKLETTER_SUPPORT_ACTIVATION_APPROVED=true`, dedicated sender/provider and server-owned support-operator allowlist. Each reply still requires exact human review. |
| Sender infrastructure | `FLOCKLETTER_CUSTOMER_INFRASTRUCTURE=aws` | Production only, `FLOCKLETTER_INFRASTRUCTURE_ACTIVATION_APPROVED=true`, dedicated provisioning credentials and a separately reserved bounded operator allowance; default zero denies resource mutations. |
| Retention review | `FLOCKLETTER_CUSTOMER_RETENTION=live` | Verified current billing facts and current owner; this enables planning/review only. Actual erasure is absent from customer HTTP/MCP and requires independent restricted operator credentials, exact-target approval and protected checkpoints. |

`capture` and `exercise` modes are rejected in production. Approval strings are exact lowercase `true`; truthy lookalikes do not activate sending. Setting a mode alone does not prove the provider is configured or reachable. Read the Operations view for authoritative blocked reasons, captured outcomes and provider uncertainty. No test using an injected provider is reported as external delivery.

The focused settings and SES contract suites validate the boundaries with synthetic values and injected transport functions. They do not use AWS, Stripe or another tenant’s credentials, and they do not start a provider send.

The local Qwen model scaffolded the SES provider tests using its verified mechanical mode (162.21 seconds, 8,015 output characters). Chat reviewed the security assertions, removed formatting fences, corrected a default-off configuration case and weak mock typing, and added independent tenant-versus-sender isolation, immutable binding snapshots, sender/header controls, extra CC/header rejection and unverifiable-readiness checks. The focused settings tests and environment-gate assessment were written in chat. The tests exposed raw unsubscribe header controls and missing cross-workspace tenant/identity binding checks; the parent implementation hardened both before verification. Original inline photo bytes are compared directly with the SES request payload; tests never call AWS.

The infrastructure exercise lives in Operations and requires a saved sender profile. It records a versioned plan and captured provisioning outcome with `.invalid` DNS examples. These examples do not configure DNS or establish AWS readiness. Real provisioning needs a separate approved AWS binding, confirmed feedback subscription and the platform capacity allowance, whose default is zero.
