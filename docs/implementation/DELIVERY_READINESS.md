# Preparing the first FFA newsletter

Open **Workspace**, choose the brand’s **Sending domain** panel and select **Check delivery setup**. The same brand-specific report is available over the API and through the `sender_deliveryReadiness` MCP tool with the simulator scope. A check reads configuration and never sends a message. A customer can still prepare campaigns while a check is unavailable.

## Configure the staging rehearsal

Keep the existing capture workspace on its current Render plan. The standalone delivery worker or the web worker processes only brands in its explicit delivery bindings. The private Listmonk renderer remains limited to its configured brand. A sleeping free web instance resumes due work when it next wakes.

`FLOCKLETTER_SES_SIMULATOR_BINDING` accepts the existing single binding or an array with up to 20 brand bindings. Each specifies `workspaceId`, `brandId`, `region`, `accountId`, `tenant`, `configurationSet`, `from`, `identityArn` and `topicArn`. Bind one tenant to each workspace, give each brand a distinct configuration set and SNS topic, and keep identities within their owning workspace. Invalid or overlapping assignments stop startup. Setting `paused: true` on a workspace’s binding disables new simulator submissions for all its brands. Keep its original bindings to authenticate late feedback. Resuming a blocked job requires a fresh review.

The report checks current DNS ownership, worker configuration and simulator access. If dedicated staging SES credentials are present, its bounded, cached inspection uses `GetAccount`, `GetTenant`, `GetReputationEntity`, `ListTenantResources`, `GetEmailIdentity`, `GetConfigurationSet` and `GetConfigurationSetEventDestinations`. Unavailable reads appear as unverified. SES production access is shown separately because AWS permits its simulator to operate in the sandbox. A ready inspection establishes configured resources. A signed feedback round trip and a delivered inbox message each need their own test. [SES tenant status and reputation](https://docs.aws.amazon.com/ses/latest/dg/tenants.html) · [SES event destinations](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetConfigurationSetEventDestinations.html)

## Rehearse one-click unsubscribe

Configure the brand’s HTTPS unsubscribe binding and dedicated signer as described in the [unsubscribe guide](MARKETING_UNSUBSCRIBE.md). In **Campaigns**, save the draft, choose confirmed test contacts and a provider rehearsal, then select **Include a personal one-click unsubscribe link**. Review and approve that version. The links are issued in the committed review, and the report identifies the selected option without displaying a recipient capability.

Immediately before provider submission the worker checks consent again and adds the recipient’s saved link to the HTML, plain text and both unsubscribe headers. If the signer or binding changed, prepare a new review. Earlier reviews retain their original message. The Listmonk renderer receives the approved content before the private link is added. Original image bytes follow the approved version. The staging SES port permits only AWS-owned simulator recipients and the expected HTTPS unsubscribe header pair.

## Evidence and next inputs

The [newsletter test](../../tests/first-newsletter.test.ts) takes a fictional storefront signup through captured double opt-in and an approved campaign. It verifies original photo bytes, redeems the personal unsubscribe link and checks both an already-queued and a subsequent campaign. The [provider tests](../../tests/delivery-readiness.test.ts) exercise separate workspace routes, pause and recovery, cross-brand denial, SDK header handling and unavailable AWS reads. The [signed feedback tests](../../tests/ses-notifications.test.ts) check the signature again after selecting a topic. These tests use disposable PostgreSQL and substituted delivery endpoints.

For a hosted AWS test, configure the dedicated SES account, region, tenant(s), verified sender, configuration set, SNS feedback route and restricted credential through the protected staging environment. Use success, bounce and complaint simulator destinations. For the subsequent real FFA test, release the production recipient policy separately, verify sender DNS, signed feedback, DKIM coverage of both unsubscribe headers and query redaction, then confirm receipt and opt-out at one consenting inbox. Actual customer sending and paid signup have separate release gates. [Provider evaluation](../DECISIONS.md) · [Feedback and simulator](CAMPAIGN_FEEDBACK.md)
