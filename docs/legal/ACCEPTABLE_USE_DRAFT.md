# Acceptable use — review draft

**Not published or in force. No effective date assigned.** This is a proposed customer policy assembled from existing requirements. D-023 deferred the detailed trust-policy decision; O-007 remains open. No numeric reputation threshold or new enforcement authority is accepted by this file. Existing verified-sender, consent, suppression, rate/usage and hold checks remain binding. See the [review packet](README.md).

## Existing controls the draft must preserve

- Account creation or payment alone never authorizes bulk mail. Sending eligibility is checked separately for the workspace, brand, sender, audience, subscription, reviewed campaign and provider.
- A purchase, uploaded file or another brand's contact record is not marketing consent. New signup defaults to double opt-in. Reimport cannot remove an opt-out, complaint or applicable bounce suppression.
- Marketing messages need the approved sender identity/disclosures and visible unsubscribe handling; public unsubscribe does not require a paid login. Suppression is persisted and rechecked before future submissions.
- Hard bounces and complaints suppress the matching recipient. Verified holds and provider pauses stop affected future work. Payment or a plan upgrade does not clear a sender/abuse hold.
- All send paths, including engine retries, API and MCP, use the same authority, suppression and quota controls. Unknown provider outcomes require reconciliation before another submission.
- D-047 test sends require separate exact review and approval, exactly one existing confirmed same-brand recipient, and no more than five approved requests per workspace UTC day across brands. Failed/rejected/canceled requests do not refund daily admission. Real accepted tests consume recipient-email allowance without a campaign slot. Test access cannot bypass ordinary controls or approve a full campaign.

## Proposed customer wording for owner review

Use Flockletter to contact audiences you are authorized to contact for the specific sending brand and purpose. Keep the permission-to-contact evidence required by onboarding/import review and honor unsubscribe and suppression decisions. Do not use purchases, scraped contacts or another brand's audience as a substitute for permission.

Use only sending identities you are authorized to manage. Do not misrepresent sender identity, defeat verification, forge provider/workspace mappings or use another customer's assets or records. Do not attempt to evade a usage limit, review hold, suppression or trial-eligibility restriction through additional accounts, copied campaigns, test sends or alternative interfaces.

Review the exact content, audience, sender and timing before approving a send. Changed content or eligibility may require a new review. Pausing or canceling work stops future submissions; a message already accepted by the delivery provider cannot be recalled. Provider acceptance is not guaranteed inbox placement.

If sending is blocked or held, follow the displayed remediation or contact `support@frostyflamingosoftware.com` for human review. An email request does not grant account authority or release a hold. Flockletter must preserve affected-workspace and account-wide safety controls while a review is unresolved.

These paragraphs are proposed wording, not acceptance of a complete AUP. Additional prohibited content/use categories and their review process require owner approval; none is silently inherited from another application or provider.

## Additional proposed prohibited-use wording — owner and counsel review

Do not use Flockletter to send deceptive or materially misleading messages; conceal or falsify the sending brand, origin, subject or reply path; impersonate another person or organization; distribute malware or phishing content; or collect credentials through a deceptive message. Do not use the service to harass or threaten recipients, or to distribute content that violates applicable law or another person's rights.

Do not upload or send to a purchased, rented, scraped or third-party list merely because you possess the addresses. For each brand and purpose, retain a defensible permission basis and respect applicable opt-outs. The final policy should state the permitted import evidence, any exceptions and the human review path; the product's own permission standard may be stricter than the minimum law requires. Do not reimport, change brands or use a different provider to bypass a recipient's applicable suppression.

Commercial messages must use truthful routing and subject information, a functioning opt-out method and the sender disclosures required by applicable law. The FTC's [CAN-SPAM business guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) explains federal commercial-email requirements; it does not establish that every Flockletter subscriber has consented or that a particular campaign meets state or international law. [COUNSEL: confirm customer geography, marketing-consent standard, postal-address presentation and any sector-specific restrictions.]

Flockletter may investigate credible abuse signals and apply the actual sending holds needed to protect recipients, other customers and provider access. [OWNER/COUNSEL: define evidence, notice, urgent action, appeal and reinstatement; do not publish a discretionary termination promise that exceeds the implemented controls.]

## Unresolved trust policy

| Decision needed | Review must specify |
| --- | --- |
| Initial sending trust | Eligibility checks and initial workspace/account limits, independent of purchased plan caps. |
| Bounce/complaint thresholds | Numeric values, numerator/denominator, sample minimums, time windows, provider facts and responses. Any suggested numbers in later work remain proposals until explicitly accepted. |
| Holds and review | Who may apply/review/release a hold, evidence required, human escalation and reinstatement criteria, without weakening existing controls. |
| Account-wide risk | Aggregate budgets, reputation spillover response and treatment of unaffected workspaces; no guarantee of absolute provider isolation. |
| Customer disclosures | Final permission/import wording, sender address/disclosures, tracking authority, prohibited uses and understandable recovery instructions. |

Owner policy approval, matching enforcement and selected-provider verification must precede general external sending. Source requirements: FL-AUD-002/003/004, FL-CAM-003/005/006/010, FL-DEL-002/003/004/005/007/008, FL-USG-004; decisions D-017/047; open items O-007/010/015. This draft activates no provider or transport and claims no live abuse-response exercise.
