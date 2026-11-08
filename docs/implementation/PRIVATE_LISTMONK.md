# Private Listmonk rehearsals

Select **Private Listmonk test** to render the approved campaign inside Flockletter and simulate its delivery locally. **Listmonk with Amazon SES simulator** requires its own review, an eligible sender, and the separately configured SES binding. It addresses only AWS-owned simulator mailboxes. [Campaign feedback and SES setup](CAMPAIGN_FEEDBACK.md)

## Enable the staging engine

Set `APP_ENV=staging` and `FLOCKLETTER_PRIVATE_ENGINE=embedded` for the build and running service. Use the existing `FLOCKLETTER_CAPTURE_WORKSPACE` and `FLOCKLETTER_CAPTURE_BRAND` values for the intended synthetic brand. The build verifies the pinned Listmonk 6.2.0 binary. The engine, its callback listener and its disposable PostgreSQL database listen on loopback. SMTP is disabled. The free web service uses its existing Flockletter database to keep approved work and receipts across engine restarts. [Staging release procedure](STAGING.md) · [Listmonk 6.2.0 release](https://github.com/knadh/listmonk/releases/tag/v6.2.0)

## Run one test

1. In **Campaigns**, open the saved draft and choose **Private Listmonk test**.
2. Choose **One test mailbox** to use the reserved address `reader@campaign.test`.
3. Select **Review private Listmonk test**. Check the method, campaign version, recipient count and scheduled time, then select **Approve private Listmonk test**.
4. Select **Show recipient outcomes**. The visible screen follows a due private rehearsal for up to two minutes. Use **Refresh rehearsals** to check again later. **Preparing in Listmonk** and **Queued for the test provider** both show zero provider attempts. The outcome records provider acceptance and delivery feedback separately.

To test with AWS, select **Listmonk with Amazon SES simulator**, review its destinations, then select **Approve Listmonk SES simulator test**. A review for the local method authorizes only that method.

For MCP, discover the available methods with `rehearsal_methods`, then use `rehearsal_review` and `rehearsal_approve`. Read results with `rehearsal_report` and `rehearsal_outcomes`. To wake the worker for an approved run, use `rehearsal_process`. HTTP command names use a period between the two words, as in `rehearsal.review`. The connection requires `read`, `campaign:rehearse` and `campaign:simulate` for the bound brand. Reviewing a confirmed group also requires `audience:summary`. [MCP rehearsal workflow](CAMPAIGN_PILOT.md)

## Restarts and unresolved outcomes

Flockletter ties each rendered message to its workspace, brand, reviewed recipient and operation. It checks subject, HTML and original attachment bytes against the approved revision, restores the reviewed plain-text body, then rechecks consent, membership, the reservation and provider eligibility before submission. A matching repeated callback refers to the same operation.

If the renderer stops, its temporary database can be rebuilt. Opening staging wakes a sleeping free instance. Flockletter then resumes eligible work from the handoff saved in its protected database. A missing SES acknowledgment keeps the operation uncertain and its allowance reserved. Use **Check rehearsal status** on that operation while waiting for a signed event or a saved receipt.

To disable private rendering, switch `FLOCKLETTER_PRIVATE_ENGINE` to `off`. Keep the original workspace/brand binding and signed SNS feedback route while draining. Pending work that has not reached the provider is blocked and its reservation is released. For an uncertain SES submission, the worker preserves the reservation and checks the original operation for a receipt.

The isolated engine and SDK test uses synthetic recipients. A real AWS simulator receipt and a separately authorized customer inbox check provide different evidence. [Isolated engine exercise](LISTMONK_CAPTURE.md)

## Hosted staging evidence

On November 7, 2026, the owner dashboard ran version 2 of the existing Alpine Field Notes staging draft through the private Listmonk method on Render Free. One synthetic mailbox reached the local test provider in one attempt. The dashboard displayed acceptance and a separate delivery confirmation. Render sampled approximately 163 MiB of memory during this single rehearsal on the 512 MiB instance. The pinned Linux engine and restart checks also passed. [Release PR](https://github.com/alandmunro/flockletter/pull/17) · [Verification run](https://github.com/alandmunro/flockletter/actions/runs/42442244333)
