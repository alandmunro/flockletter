# Privacy notice — counsel review draft

**Not published or in force. No effective date assigned.** This is proposed expansion of the public `src/client/Privacy.tsx` notice, not a replacement for it. The live source currently identifies `flockletter-privacy-v2` (updated November 11, 2026); counsel-approved wording must be reconciled with that route, actual deployments and data flows before publication. Bracketed items are unresolved facts, not promises.

## Proposed customer-facing structure

**Who we are and how to contact us.** Flockletter is operated by Frosty Flamingo Software, LLC. For questions or privacy requests, contact `support@frostyflamingosoftware.com`. [OWNER/COUNSEL: verify publishable business address, request channel, any legally required contact or appeal details, and whether the operator acts as a controller, processor/service provider or both for each data category.]

**Information we handle.** Depending on how the service is used, we process account and workspace identity, member roles, billing/subscription status, sender-domain configuration, subscriber addresses and consent/suppression history, campaign content and delivery outcomes, support communications, security/operation logs and necessary browser storage. Payment-card details are collected by the selected payment provider rather than as a Flockletter card vault. [VERIFY: precise fields, provider-held data, logs and backups before finalizing.]

**Why we handle it.** We use this information to authenticate users, administer workspaces and plans, prepare and deliver authorized email, maintain consent and suppression, prevent abuse and repeat trial use, provide support, secure the service, and meet applicable obligations. Customer-controlled campaign content and subscriber data should be processed to provide the service, subject to the final agreement and any DPA. [COUNSEL: settle lawful bases and role allocation for each audience and jurisdiction; do not claim every subscriber opted in.]

**Email subscription choices.** A brand may use confirmation-based signup or immediate signup after an affirmative form action. An authorized owner may record existing permission without verifying the mailbox. Those are different evidence states. Newsletter unsubscribe and suppression are separate from the website cookie choice and must remain available even when a workspace's paid sending is suspended. Open/click tracking is off by default; [OWNER/COUNSEL: identify any actually enabled tracking, who authorizes it, recipient disclosures and how a recipient changes preferences].

**Website cookies and storage.** Necessary sign-in/security storage supports Clerk authentication. The site currently uses no optional website analytics or advertising cookies. A browser-only cookie preference lasts up to 180 days and can be changed through Cookie choices. A future optional purpose requires a revised notice and fresh choice; accepting website cookies does not subscribe a person to marketing. [VERIFY: deployed scripts, storage inventory and consent behavior.]

**Service providers and disclosures.** The service uses providers for sign-in, hosting/storage, billing and selected email delivery (Amazon SES or Resend by brand), with Listmonk as the campaign engine. Information may be shared with those providers only as needed for the service and under the final provider arrangements. [VERIFY: actual live providers, locations, subprocessors, support/AI tooling, provider retention and any international transfer mechanism; do not imply both delivery providers receive every message.]

**Retention.** Ordinary canceled-account data follows the accepted 90-day retention policy after verified service end, subject to authorized holds and the unresolved backup, provider-copy, suppression, billing-record and recovery rules. Minimal keyed codes for trial owner, card and workspace, with necessary policy/status/time metadata, may be retained indefinitely solely to prevent repeat trials. These codes are pseudonymous personal data, not anonymous; the exception excludes raw identifiers, email addresses, card numbers, addresses, messages and mailing-list content. [OWNER/COUNSEL: settle the exact clock, exceptions, backup expiry, provider deletion and request treatment before promising any physical erasure deadline.]

**Requests and security.** Contact support for access, correction, export, deletion or other applicable privacy requests. Account-specific requests require authority verification; not every request can be completed while a lawful retention obligation, suppression necessity or authorized hold applies. [COUNSEL: specify rights by jurisdiction, response/appeal process and required notices. VERIFY: security controls and incident notice process before making guarantees.]

**Changes.** [COUNSEL/OWNER: specify notice-update process, effective date, material-change notification, and version archive.]

## Publication gate

- Map actual database fields, logs, cookies, email tracking, support/AI and provider copies to each statement above. Review deployed production separately from source.
- Confirm business/contact facts, customer/subscriber geography, provider agreements and transfer/role allocation with privacy counsel.
- Reconcile this draft with the hosted terms, AUP, refund language, D-048/D-054/D-055, and the runtime `/privacy` page; record final version, effective date and customer acceptance where needed.
- Do not publish this file verbatim or treat documentation merge as privacy clearance or activation of sending, billing or erasure.
