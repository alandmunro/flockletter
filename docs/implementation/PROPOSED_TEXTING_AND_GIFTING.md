# Proposed texting and gifting requirements

Proposed November 16-17, 2026. **Status: proposal only.** Not accepted into the SRD, no decision recorded in the ledger and no implementation authorized. The SRD currently defers SMS; see O-016 in [decisions](../DECISIONS.md).

This is the public copy. Fraud-control thresholds, cost-to-serve and margins, and details of the owner's own business registrations are withheld and kept in the owner's private requirements document.

## Summary

Flockletter adds text messaging and small automated gifts, built as a multi-tenant service that the owner's own businesses use first and outside customers (Realtors and restaurants) buy later.

The feature has three parts:

- **Texting:** broadcast and automated SMS from each tenant's own registered number.
- **Date automation:** birthday and home-anniversary messages, plus client-appreciation event invites.
- **Gifting:** an optional small digital gift card (for example $5 coffee) attached to an automated message.

## Conflicts with accepted decisions

These must be resolved before any of this is accepted. None is changed by this proposal.

| Proposal | Existing decision or requirement | Conflict |
| --- | --- | --- |
| Texting as a whole | SRD release scope | The SRD lists SMS among deferred features |
| PRC-2 per-text overage | SRD release scope; O-001 | The SRD defers automatic usage-overage billing |
| TAX-1 Stripe Tax | D-062 | Flockletter currently runs in explicit no-tax-collection mode |
| OFF-5 and CBK-4 suspension after 14 days | D-049 | Failed payment suspends on day 6 and closes on day 30 |
| PLN-4 and GFT-8 refunds | D-049 | Refunds require manual review, with no automatic guarantee |
| PLN-1 immediate prorated upgrades | D-049 | Accepted only after actual provider and portal behavior is verified |
| WF-1 roles Owner, Sender, Viewer | O-013 | Proposed roles are owner, editor and analyst |
| Texting plan names Starter, Growth, Pro | D-024, D-049, D-050, D-060 | Growth and Pro already name newsletter tiers; new Pro enrollment is held |
| Carrier "brand" registration | SRD terms | A Flockletter brand is a sending identity; a carrier brand is a legal entity or DBA. The mapping needs defining |
| SUB-1 double opt-in only | D-054 | Owners may choose single opt-in for email |
| SEC-3 Bitwarden Secrets Manager | Current deployment practice | The current credential store and how Render reads secrets need confirming |

## User story

One Realtor gift campaign, by who acts at each step:

1. Tenant signs up, enters business details and pays the setup fee, without leaving Flockletter.
2. Flockletter verifies identity and files the carrier brand and campaign.
3. Tenant follows approval on a progress page.
4. Tenant shares the sign-up page and QR code; imported contacts get an opt-in invitation by email.
5. Their client opts in: confirms email, replies YES by text, adds a birthday or anniversary.
6. Tenant buys gift credit and sets up a gift campaign of 15, 30 or 60 days.
7. Flockletter sends the anniversary text inside quiet hours, with a flkl.cc link to the claim page.
8. Their client taps Claim, and the $5 card is bought at that moment, once per person.
9. Flockletter returns unclaimed value to the tenant's credit when the campaign ends.
10. Tenant reads the dashboard: gifts claimed, who claimed them, and credit left.

The tenant acts at five steps, their client at two, and Flockletter does the rest. The platform operator appears nowhere in the normal path; he is involved only when a sign-up is flagged for review.

## Goals and non-goals

**Goals**

- Let any tenant send compliant SMS to contacts who have opted in.
- Automate relationship touchpoints: birthdays, home anniversaries, event invites and reminders.
- Attach an optional low-value digital gift to an automated touchpoint.
- Handle carrier registration and consent collection for the tenant, since this is where customers struggle.
- Treat the owner's own entities as ordinary tenants, with no special code path.
- Keep the door open for a later bridge to Cadence (CRM).

**Non-goals for the first release**

- Cold outreach or lead-generation texting.
- Two-way conversational inbox beyond STOP, HELP and simple reply capture.
- MMS, short codes, toll-free numbers, and non-US recipients.
- Building the Cadence bridge itself.
- Replacing a CRM; Flockletter stores only what it needs to send.

## Users and tenants

Every sender is a workspace, and the platform operator is a separate role above all workspaces.

| Party | Role | Notes |
| --- | --- | --- |
| Frosty Flamingo Software | Platform operator (reseller) | Holds the SMS provider account and files registrations for all tenants |
| The owner's own businesses | Tenants | The first tenants, including Flockletter texting its own users; registration details withheld |
| Realtor customers | Tenants | Target market: birthday, home-anniversary and event messages to past clients |

Each of the owner's businesses is its own workspace, and none share contact lists.

## Second target market: restaurants

A restaurant sending a newsletter, birthday messages and coupons runs on the same engine as the Realtor case, with five additions.

**What stays the same:** tenancy, registration, consent, sending, newsletters by email, birthday automation and billing. A restaurant is one more workspace.

**What it adds:**

- **CON-7** In-venue opt-in: a QR code and a text-a-keyword sign-up the restaurant can print on tables, receipts and signage, leading to a hosted sign-up page.
- **DATE-5** The sign-up page can collect a birthday as month and day only, with no year required.
- **CPN-1 to CPN-5** Coupons: the tenant's own offer, separate from third-party gift cards (see Coupons under Functional requirements).
- **MSG-9** A campaign can go out as email, text or both from one composer, so a newsletter and a short text announcing it are one send.
- **CMP-9** Alcohol content: carriers restrict alcohol promotion to age-verified recipients. Restaurant templates default to food-only wording, and alcohol offers are blocked unless the workspace has enabled age-gated sign-up.

**Volume difference:** a restaurant list can be far larger than an agent's past-client list. A busy restaurant may exceed the low-volume tier's daily limits and need a Standard brand registration ($46 one-time, $10 a month).

## Functional requirements

Each requirement has an ID so it can be referenced in build tasks and tests.

### Tenancy

- **TEN-1** Every phone number, contact, consent record, message, gift and bill belongs to exactly one workspace.
- **TEN-2** A workspace maps one-to-one to a Clerk organization.
- **TEN-3** The platform-operator role is separate from any workspace and can view and suspend all workspaces.
- **TEN-4** No query or send can cross workspace boundaries.

### Sender registration

- **REG-1** A workspace submits business details (legal name, EIN, address, website, authorized contact, sample messages) through an in-app form.
- **REG-2** The platform files brand and campaign registration through the SMS provider's API on the tenant's behalf.
- **REG-3** Registration status is one of: draft, submitted, approved, rejected, suspended.
- **REG-4** Sending is locked until status is approved.
- **REG-5** A rejection shows the reason and lets the tenant correct and resubmit.
- **REG-6** Each approved workspace gets its own dedicated phone number.
- **REG-7** The form checks that the tenant's website has a privacy policy, terms and SMS opt-in wording before submission.

### Automated onboarding

A customer signs up, enters business details and is provisioned with no action from the operator and without leaving Flockletter.

- **ONB-1** All sign-up, business details, payment and status steps happen on Flockletter pages. The customer never visits the SMS provider's site.
- **ONB-2** After submission, the platform runs these steps by API with no operator action: create provider subaccount, create customer business profile, submit brand, create messaging service and campaign, buy a phone number, attach it, unlock sending.
- **ONB-3** Brand and campaign status changes arrive by webhook, with scheduled polling as a fallback, and advance the registration state automatically.
- **ONB-4** The form validates before submission: EIN format, legal name entered exactly as on IRS paperwork, a reachable website, and a privacy policy and terms page.
- **ONB-5** Sample messages, the opt-in description and the opt-in, HELP and STOP auto-replies are generated from a template per vertical (Realtor, restaurant, general). Customers do not free-type them.
- **ONB-6** The setup fee is charged through Stripe before any registration call, because registry fees are non-refundable.
- **ONB-7** Provider rejection codes map to plain-language fixes shown to the customer, with a resubmit action.
- **ONB-8** The customer sees a progress page: submitted, brand approved, campaign under review, approved. It states the expected wait (days for brand, one to two weeks or more for campaign).
- **ONB-9** Sole-proprietor sign-ups (no EIN) are supported; the customer completes the carrier's verification text from their own phone.
- **ONB-10** Registrations stuck beyond a set time, or flagged by identity checks, go to an operator review queue. This is the only planned manual step.

### Identity verification

The registry confirms that an EIN matches a business name, not that the applicant is authorized to use it. These controls close that gap.

- **IDV-1** The applicant proves control of the business's website domain by entering a code sent to an email address at that domain. Free email domains do not qualify. A tenant with no domain of its own, using only the hosted business page, cannot pass this check and instead uploads the IRS letter and goes to the review queue (IDV-5).
- **IDV-2** The applicant verifies a business phone number by one-time code.
- **IDV-3** The Stripe payer name and billing address are compared with the business details; a mismatch raises a risk flag.
- **IDV-4** One EIN maps to one owning account. That account may run several workspaces on the EIN, one per DBA, each registered as its own brand with its own campaign and number. A sign-up using the same EIN from a different account is blocked and flagged.
- **IDV-5** When risk flags are present, the applicant uploads the IRS EIN confirmation letter (CP 575 or 147C) and the sign-up goes to the review queue.
- **IDV-6** New workspaces start in a probation period with templated messages only and links restricted to the verified domain. The daily send cap ramps: a low cap in the first week, then a higher cap until probation ends, then the registration tier's limit.
- **IDV-7** Probation lifts automatically only when both conditions are met: the minimum period has passed, and a minimum number of messages has been delivered with no pause or suspension.
- **IDV-8** Enforcement has two levels, and both alert the operator. A pause is automatic and the tenant can review the cause and resume. A suspension stops all sending until the operator lifts it. Thresholds for each are in the Default settings table.

- **IDV-9** The first broadcast from a new workspace goes to a small canary group, waits, and releases the rest only if no pause threshold is hit.
- **IDV-10** Gifting is off until the workspace's first Stripe payment has cleared and a waiting period has passed. A low monthly gift cap then applies until probation ends. This limits the use of stolen cards to buy gift cards.
- **IDV-11** The operator can end probation early for a workspace verified by hand, and the action is written to the audit log.

EIN and legal name are checked by the carrier registry at brand registration. No separate business-verification vendor is used.

### Consent

- **CON-1** A contact can be texted only with a recorded SMS opt-in for that workspace.
- **CON-2** Each consent record stores timestamp, source, and the exact wording shown.
- **CON-3** Opt-in methods: hosted opt-in page (link sent by email), text-a-keyword, and a checkbox on event RSVP forms.
- **CON-4** The SMS checkbox is separate from other consents, optional, and unchecked by default.
- **CON-5** STOP and HELP are handled automatically, scoped to the number that received them.
- **CON-6** A business can re-add an opted-out contact, but the contact enters a pending re-enrollment state and receives no texts until they confirm by text. Carriers block any message to a number that sent STOP, so the platform cannot text the invitation; it goes by email or is given in person. The contact confirms either by texting START to the workspace's number, or by re-submitting the sign-up page and replying YES to the confirmation text that follows (where the provider allows clearing the opt-out after a new web opt-in). Before saving a re-added contact, the app tells the business user that texts will not go out until the contact confirms, and the contact shows as pending re-enrollment until then.

### Subscriber sign-up page

Each workspace has a hosted sign-up page where its own customers subscribe. Email is required; everything else is optional and set by the business.

- **SUB-1** Email uses double opt-in: the subscriber enters an address, receives a confirmation email, and is added to the list only after clicking the link in it.
- **SUB-2** An unconfirmed address receives no newsletters and expires after a set period.
- **SUB-3** The page can show an optional phone number field. A subscriber can sign up for email without giving a phone number.
- **SUB-4** A phone number alone is not SMS consent. Texting requires the separate SMS checkbox (CON-4), and the number is confirmed by a text the subscriber replies to before any other message is sent.
- **SUB-5** The business can turn on an optional birthday field (month and day; year not required).
- **SUB-6** The business can turn on an optional anniversary field, with a label the business sets (for example home purchase, wedding, or customer since).
- **SUB-7** Dates captured on the page are stored as important dates (DATE-1) and feed the date automations.
- **SUB-8** Each optional field is switched on or off per workspace, and none can be made mandatory for email sign-up.
- **SUB-9** The sign-up page is always hosted by Flockletter. It is reachable by link and QR code, and is the destination for in-venue sign-up (CON-7). Tenants link to it from their own site; forms on a tenant's own site are not supported and cannot record consent.

### Messaging

- **MSG-1** A user can compose and send a text to a list or segment of opted-in contacts.
- **MSG-2** The composer shows character count and segment count (160 characters per segment). Emoji and decorative symbols are not allowed in texts: the composer blocks them and converts curly quotes and long dashes to plain equivalents, in typed text, templates and automated messages. Letters from any language are allowed, so a name such as José is sent as written. Some accented letters fall outside the standard SMS character set and reduce that message to 70 characters per segment; when one is present, in typed text or in a recipient's merge-field value, the composer shows the lower limit and the segment count and cost reflect it per recipient. Emails are not affected.
- **MSG-3** Every message identifies the sender, and opt-out instructions are appended where required.
- **MSG-4** Messages support merge fields such as first name.
- **MSG-5** Sends run as background jobs with per-workspace rate limits.
- **MSG-6** Delivery status and inbound replies arrive by webhook and are logged per message.
- **MSG-7** A link in a message is allowed only if its destination is on the tenant's verified domain on record (IDV-1) or on a Flockletter-hosted page for that workspace (sign-up, RSVP, coupon, gift). Any other destination blocks the send with an explanation. Long links are shortened on the platform-owned short domain flkl.cc (purchased 2026-11-16, used only for short links) with the tenant's short name in the path, for example flkl.cc/acme/x7kP, so no per-tenant DNS records are needed, and the short link redirects only to an allowed destination. Public URL shorteners are never used. Short codes use mixed-case letters and digits and are matched case-sensitively end to end.
- **MSG-8** Sends respect quiet hours in the recipient's time zone.

### Date automation

- **DATE-1** A contact can hold any number of important dates, each with a type (birthday, home anniversary, custom) and a date.
- **DATE-2** A workspace can enable an automation per date type with its own message template and send time.
- **DATE-3** Automations skip contacts without SMS consent and can fall back to email.
- **DATE-4** The tenant can preview upcoming automated sends for the next 30 days and cancel any of them.

- **DATE-6** Birthday and anniversary automations repeat every year on the stored date.
- **DATE-7** Anniversary messages can use a years merge field (for example "your 3rd home anniversary"), available only when the date's year is known.
- **DATE-8** **Default (pending):** a February 29 date sends on February 28 in non-leap years.
- **DATE-9** Each automation sends at the tenant's chosen time in the recipient's time zone, within quiet hours.

### Events

- **EVT-1** A workspace can create an event (name, date, place, capacity) and invite a list by text or email.
- **EVT-2** Invitees RSVP through a hosted page; the page offers the SMS opt-in checkbox.
- **EVT-3** Reminder texts go to opted-in attendees before the event.

### Gifting

- **GFT-1** An automation can attach a digital gift of a tenant-set value (for example $5).
- **GFT-2** The message carries a claim link to a Flockletter page with a Claim button. The gift card is bought through the rewards API only when the recipient taps Claim, and the page then shows the redemption link. Opening or previewing the link never triggers a purchase. Each claim link is tied to one contact and can be claimed once. A repeated tap on Claim returns the same order and link, never a second purchase.
- **GFT-3** The tenant chooses a single brand or a recipient-choice link limited to 5 to 10 brands the tenant picks, never the full catalog.
- **GFT-4** Outstanding offers can never exceed the workspace's prepaid gift credit, so a claim is never refused for lack of tenant funds. The tenant is alerted when credit runs low and can buy more at any time.
- **GFT-5** Gift status (offered, claimed, expired) is tracked. The tenant sets each gift campaign or gift automation to run 15, 30 or 60 days. An offer not claimed within that period expires, and its value returns to the tenant's gift credit. The claim page shows the recipient the expiry date, and the claim link stays valid until the offer expires.
- **GFT-6** Gift message templates are thank-you wording only, with no mention of referrals.

- **GFT-7** Each workspace has a gift credit ledger showing purchases, amounts reserved for open offers, claims, amounts returned from ended campaigns, and refunds. The tenant can see the available and reserved balance at any time.
- **GFT-8** Unused gift credit does not expire. When a workspace closes, the remaining credit is refunded to the tenant.
- **GFT-9** The platform keeps its Tremendous balance at or above the total of all open offers plus a buffer. It tops the balance up by bank transfer through the API when credit is bought, and alerts the operator if the balance falls below the threshold.
- **GFT-10** If a claim cannot be fulfilled because of the platform's balance or a vendor outage, the recipient sees a try-again message, the claim is retried automatically, and the operator is alerted. The offer is not lost.

- **GFT-11** A gift offer is one record per contact per campaign, whatever channels deliver it. The text and the email both link to that same offer, credit is reserved once, and the dashboard counts it once. The claim is recorded in a single atomic step, and the order sent to the vendor carries the offer's ID as its reference, so taps from both channels, even at the same moment, produce one purchase. After a claim, either link shows the already-claimed gift and its redemption link, never a new one.
- **GFT-12** Before a gift campaign is sent, contacts that share an email address or phone number are treated as one recipient, so the same person does not receive two offers through duplicate records.

### Coupons

- **CPN-1** A workspace can create a coupon with an offer description, an expiry date and optional terms.
- **CPN-2** A coupon can be attached to a broadcast or to an automation such as a birthday message.
- **CPN-3** Each recipient gets a unique code or link, shown on a hosted page the customer presents in store.
- **CPN-4** Coupons are redeemed in store by staff. The coupon page on the customer's phone has a Redeem button that staff tap at the counter. The page then shows a Redeemed notice with the date and time, and the code cannot be redeemed again.
- **CPN-5** The tenant sees sent, viewed and redeemed counts per coupon.

Coupons cost the platform nothing to issue, unlike gift cards, so they need no funding or budget cap.

### Billing

- **BIL-1** Each workspace is billed through Stripe for a base plan plus metered message usage.
- **BIL-2** Registration fees are covered by a one-time setup fee (PRC-3).
- **BIL-3** Gifts are funded from prepaid gift credit that the tenant buys by card through Stripe. Creating gift offers reserves their full value from that credit, and a gift campaign cannot start until the credit covers every offer in it. When the campaign ends or an offer expires, the unclaimed value returns to the tenant's gift credit.
- **BIL-4** Each workspace has a hard monthly spending cap that stops sends when reached.
- **BIL-5** The tenant sees usage and cost to date for the current period.

### Platform controls

- **PLT-1** The operator can suspend a workspace's sending immediately.
- **PLT-2** Tenants accept an acceptable-use policy before registration.
- **PLT-3** The operator sees per-workspace delivery rates, opt-out rates and carrier error rates, with alerts on spikes.
- **PLT-4** All sends, consent changes and registration actions are written to an audit log.

### Tenant dashboard

Each workspace has a dashboard showing how every campaign performed, including gifts claimed and gift credit remaining.

- **DSH-1** Every broadcast, automation, gift campaign, coupon and event has its own results view, and an overview page lists all of them for a chosen date range.
- **DSH-2** Message results: sent, delivered, failed, opt-outs, replies and unique link clicks.
- **DSH-3** Gift results per campaign: offers sent, gifts claimed (count and rate), offers still open with days remaining, offers expired, and the dollar value claimed, reserved and returned to credit.
- **DSH-4** Gift credit balance is always visible: available, reserved for open offers, and total, with a link to the ledger (GFT-7).
- **DSH-5** Coupon results: sent, viewed, redeemed, and redemption rate.
- **DSH-6** Event results: invited, yes, no and no reply.
- **DSH-7** Cost per campaign: texts used, gift value claimed and fees, with cost per gift claimed or coupon redeemed. The overview also shows texts used against the plan allowance for the month.
- **DSH-8** List growth for the period: new subscribers, new SMS opt-ins and opt-outs.
- **DSH-9** A recipient list for each campaign shows who was sent it, who claimed or redeemed and when, so the tenant can follow up with those contacts.
- **DSH-10** Figures update within minutes of the underlying event, and any view can be exported as CSV.
- **DSH-11** All workspace roles can view the dashboard, including Viewer (WF-1).

A gift counts as claimed when the recipient taps Claim and the card is bought. Where the vendor reports that the recipient went on to open the redemption link, that is shown as a separate figure. Whether the card was later spent at the store is not available.

### Inbound replies

Items marked **Default** in this and the following sections were accepted by the owner on 2026-11-16 in the private document; they are not ledger decisions. They remain changeable through the admin settings (ADM-1).

- **INB-1** Every inbound text is stored against the contact and shown in that contact's message history.
- **INB-2** STOP, HELP and START are handled first (CON-5, CON-6). The HELP reply names the business and gives its support email or phone.
- **INB-3** When an event invite is pending for the contact, a reply of YES or NO is recorded as the RSVP and confirmed by text.
- **INB-4** **Default:** any other reply is forwarded to the tenant's notification email with the contact's name and the message text. No automatic text reply is sent.
- **INB-5** **Default:** from the contact's history page, the tenant can send one free-typed reply to an inbound message within 24 hours. This is not a full two-way inbox.
- **INB-6** A text from an unknown number is logged and never auto-added as a contact.

### Send pacing and carrier limits

- **PAC-1** Each workspace has a daily send limit taken from its registration tier, stored as a setting the operator can update when carriers change their caps.
- **PAC-2** A send larger than the remaining daily limit is spread across consecutive days automatically, in quiet-hours-compliant windows.
- **PAC-3** Before confirming a send that will be spread over days, the tenant is shown how many days it will take and can cancel.
- **PAC-4** Automated date messages are sent ahead of broadcasts when both compete for the same day's limit.
- **PAC-5** When a workspace regularly hits its limit, the app suggests upgrading to a Standard registration and shows the cost.

### Number quality

- **NUM-1** Phone numbers are normalized to E.164 format and rejected if not a valid US number.
- **NUM-2** **Default:** a number is checked for line type when SMS consent is confirmed, and landlines are marked not textable. The lookup has a per-check cost to confirm.
- **NUM-3** A permanent delivery failure (invalid, disconnected or landline) marks the number not textable at once.
- **NUM-4** **Default:** three consecutive temporary failures mark the number not textable.
- **NUM-5** Not-textable contacts are skipped at no charge, shown to the tenant in a list, and can fall back to email.

### Sending workflow

- **WF-1** Workspace roles: Owner (everything, including billing and registration), Sender (compose, schedule and send) and Viewer (read only).
- **WF-2** A message can be sent now or scheduled for a date and time, and a scheduled send can be edited or canceled until it starts.
- **WF-3** A test send delivers the message to the user's own verified phone before any real send.
- **WF-4** A confirmation screen shows recipient count, segments per message, estimated cost and any pacing over days. Nothing is sent without confirming it.
- **WF-5** **Default:** a send to more than 500 recipients requires the Owner role.
- **WF-6** A send in progress can be paused; messages already delivered are not affected.

### Hosted compliance pages

Many solo agents and small restaurants have no website or privacy policy, which registration requires (REG-7).

- **HST-1** Flockletter hosts a public business page for a workspace: business name, description, contact details, the sign-up form with opt-in wording, a privacy policy and SMS terms. The page has no domain of its own. It is served at a path on Frosty Flamingo Software's domain, set by the workspace's short name, and tenants cannot connect a custom domain or change the address.
- **HST-2** The privacy policy and SMS terms are generated from a template filled with the tenant's business details, and the tenant accepts them before they are published.
- **HST-3** A tenant with its own website lists it as the business site at registration, but sign-up and opt-in always happen on the Flockletter-hosted page (SUB-9).
- **HST-4** The hosted page is the website submitted at registration when the tenant has none. Whether carriers accept this is an open question to confirm with Twilio.

### Contact import

- **IMP-1** Contacts can be imported from a CSV file with a column-mapping step for name, email, phone, birthday and anniversary.
- **IMP-2** Rows are matched to existing contacts by email, then phone, within the workspace. Matches are updated, not duplicated.
- **IMP-3** The tenant confirms it has permission to email the imported contacts before the import completes.
- **IMP-4** Imported phone numbers never carry SMS consent (CMP-4). After import, the tenant can send an opt-in invitation by email with one click.
- **IMP-5** An import never changes a contact who has opted out of email or text.
- **IMP-6** The import finishes with a summary: added, updated, skipped and rejected rows, with reasons.

### Tenant offboarding

- **OFF-1** Canceling stops all sends and automations immediately and cancels outstanding gift offers.
- **OFF-2** **Default:** for 30 days after canceling, the tenant can export contacts, consent records and message history as CSV, and can reactivate.
- **OFF-3** After that period, the platform releases the phone number, deactivates the campaign and closes the provider subaccount, which ends the recurring carrier fees.
- **OFF-4** **Default:** personal data is deleted 90 days after cancellation, except consent and audit records, which are kept for 5 years in case of a consent dispute.
- **OFF-5** A workspace suspended for non-payment follows the same steps, starting 14 days after the first failed payment (**Default**).

### Requirements added 2026-11-17

Items marked **Default (pending)** in this group, and in DATE-8, are proposals awaiting the owner's acceptance. All values are admin settings (ADM-1).

### Prohibited content

- **CNT-1** **Default (pending):** every text is screened before sending for carrier-restricted content: adult content, hate speech, firearms, tobacco and vaping, cannabis and CBD, gambling, and high-risk financial offers such as payday loans, debt relief and credit repair. A match blocks the send and tells the user which rule applies.
- **CNT-2** Alcohol is allowed only under CMP-9.
- **CNT-3** Screening covers typed text, templates, automated messages and merged values, and every result is logged.
- **CNT-4** **Default (pending):** a set number of blocked sends within a set period flags the workspace for operator review (values set in the owner's private requirements document).
- **CNT-5** The acceptable-use policy (PLT-2) lists the same restricted categories.

### Gift credit disputes

- **CBK-1** Stripe dispute notifications are processed for every gift credit purchase.
- **CBK-2** When a dispute opens, the disputed amount is frozen and no new gift offers can draw on it until it is resolved.
- **CBK-3** If the disputed credit was already spent on claimed gifts, the workspace's gift balance goes negative, gifting and sending pause, and the tenant is asked to pay the balance.
- **CBK-4** **Default (pending):** a negative balance unpaid after 14 days suspends the workspace and follows the offboarding steps (OFF-5).
- **CBK-5** **Default (pending):** a lost dispute on a workspace still in probation suspends it at once for operator review.
- **CBK-6** Dispute evidence (purchase record, ledger entries, timestamped claim records) is gathered and submitted through Stripe automatically.

### Plan changes and trial

- **PLN-1** Upgrades take effect at once with a prorated charge. Downgrades take effect at the next billing date.
- **PLN-2** **Default (pending):** moving to Pro starts a Standard registration in the background. Until it is approved, the workspace keeps its current daily limit and plan price, and the Pro price starts on approval.
- **PLN-3** **Default (pending):** downgrading from Pro keeps the Standard registration; the setup fee is not refunded.
- **PLN-4** **Default (pending):** there is no free texting trial, because registration fees are paid up front. Instead, the first month's plan fee is refundable within 30 days; the setup fee is not.
- **PLN-5** Canceling only the texting add-on stops texting as in OFF-1 to OFF-3, and the newsletter subscription continues.

### Workspace short names

- **SLG-1** Each workspace has a unique short name, used in its short links (flkl.cc/name/code) and its hosted business page address.
- **SLG-2** The short name is suggested from the business name at sign-up and can be edited before registration.
- **SLG-3** **Default (pending):** 3 to 30 characters, lowercase letters, digits and hyphens.
- **SLG-4** Blocked names: platform words (admin, api, www, help, support, login, signup), financial and security words (bank, pay, verify, secure, account) and carrier and major brand names. The list is an admin setting.
- **SLG-5** **Default (pending):** a short name can be changed once every 90 days. The old name keeps redirecting for the link life (2 months) and cannot be taken by another workspace for 12 months.

### Recipient-facing pages

These apply to the sign-up, claim, coupon, RSVP and hosted business pages.

- **PUB-1** **Default (pending):** pages show the tenant's name and logo, with a small Powered by Flockletter footer.
- **PUB-2** Pages are designed for phones first and work in current mobile and desktop browsers.
- **PUB-3** Pages meet WCAG 2.2 level AA accessibility.
- **PUB-4** **Default (pending):** pages load in under 2 seconds on a typical mobile connection.
- **PUB-5** From a tap on Claim to the redemption link takes under 3 seconds; a longer wait shows a progress message.
- **PUB-6** Recipients never need an account or a sign-in.
- **PUB-7** Expired offers, closed workspaces and invalid links show a clear message, never an error page.

### Language

- **LNG-1** **Default (pending):** the interface and system texts (opt-in confirmations, HELP and STOP replies) are English in the first release.
- **LNG-2** Tenants can write their own messages in any language (MSG-2).
- **LNG-3** **Default (pending):** Spanish opt-out words (PARAR, CANCELAR, DETENER) are treated as opt-outs alongside the English ones. The list is an admin setting.
- **LNG-4** Spanish system texts and interface are a later phase.

### Retention and tax

- **RET-1** **Default (pending):** message bodies, outbound and inbound, are kept 24 months for active workspaces and then deleted. Delivery records (status, time, cost) are kept for the life of the workspace.
- **RET-2** Consent and opt-out records are kept for the life of the workspace plus 5 years (OFF-4).
- **RET-3** **Default (pending):** gift credit ledger and billing records are kept 7 years for accounting.
- **TAX-1** **Default (pending):** Stripe Tax calculates sales tax on plan fees, setup fees and gift credit fees from the tenant's address.
- **TAX-2** Whether tax applies to the gift credit itself is part of the legal review.

### Tenant notifications

- **NTF-1** The workspace Owner is notified by email and in the app of: registration submitted, approved or rejected; probation ended; a scheduled send completed; a send paused or the workspace suspended; gift credit low; a dispute opened; a payment failed; 80% and 100% of the month's texts used; and a gift campaign ended with credit returned.
- **NTF-2** **Default (pending):** gift credit counts as low when it falls below $20 or below the value of gift offers scheduled in the next 7 days, whichever is higher.
- **NTF-3** Each notification can be turned off, except those about registration, pauses, suspensions, disputes and failed payments.
- **NTF-4** Other workspace members can opt in to any notification.

### Default settings

Starting values, each adjustable by the operator and, where noted, by the tenant within the operator's limits.

| Setting | Default | Who can change it |
| --- | --- | --- |
| Quiet hours | No texts before 9:00 a.m. or after 8:00 p.m. in the recipient's local time | Tenant can narrow, not widen |
| Recipient time zone | Stored on the contact; else inferred from area code; else the tenant's time zone | System |
| Frequency limit | 4 marketing texts per contact per month per workspace, automations included | Tenant can lower; operator can raise |
| Probation length | Minimum period and minimum delivered messages, with no pause or suspension; values set in the owner's private requirements document | Operator |
| Probation daily cap | Ramped; values set in the owner's private requirements document | Operator |
| Automatic pause | Opt-out and carrier-filtered rate thresholds; values set in the owner's private requirements document | Operator |
| Unconfirmed email expiry (SUB-2) | 7 days | Operator |
| Coupon default expiry | 30 days | Tenant |

Suspension thresholds, the first-broadcast canary size and wait, the gifting waiting period and the gift cap during probation are also operator settings; their values are set in the owner's private requirements document.

## Operational requirements

These cover how the service is run and protected. Numeric targets are **Default** values, accepted by the owner on 2026-11-16 in the private document and changeable through the admin settings (ADM-1).

### Security

- **SEC-1** All traffic uses HTTPS, including the flkl.cc redirect and every webhook endpoint.
- **SEC-2** Personal data (names, phone numbers, emails, dates) is encrypted at rest in the database and in backups.
- **SEC-3** API keys and secrets for Twilio, Tremendous, Stripe, Clerk and Resend are stored in Bitwarden Secrets Manager and never in the repository. The app reads them from there at deploy or start-up, and they can be rotated without a code change.
- **SEC-4** Every inbound webhook is verified with the sender's signature (Twilio, Stripe, Tremendous) and rejected if the check fails.
- **SEC-5** Each tenant's Twilio subaccount credentials are stored per workspace, so a leak affects one tenant only.
- **SEC-6** Operator access to tenant data requires multi-factor sign-in and is recorded in the audit log (PLT-4).
- **SEC-7** Public pages (sign-up, RSVP, coupon, claim) are rate-limited and protected against automated submissions.
- **SEC-8** Logs never contain full message bodies, API keys or gift redemption links.

### Privacy

- **PRV-1** A contact can ask a tenant to delete their data. The tenant can delete a contact in one action, which removes personal data and keeps only the consent and opt-out record needed to honor the opt-out.
- **PRV-2** A tenant can export all data for one contact on request.
- **PRV-3** Tenant data is never used or shared across workspaces, and contact lists are never sold or used for the platform's own marketing.
- **PRV-4** Flockletter's own privacy policy and terms describe its role as a processor of tenant contact data.

### Reliability

- **REL-1** **Default:** the app, webhook endpoints and the flkl.cc redirect target 99.5% monthly uptime.
- **REL-2** The database is backed up daily, backups are kept 30 days (**Default**), and a restore is tested at least twice a year.
- **REL-3** Sends are queued. A provider outage or app restart never loses a queued message or sends one twice.
- **REL-4** Failed calls to Twilio, Tremendous and Stripe are retried with increasing delays, then surfaced to the operator.
- **REL-5** Webhooks are processed idempotently, so a repeated delivery of the same event changes nothing.
- **REL-6** Short links in messages keep working for 2 months after they are created; links to permanent pages, such as a workspace's sign-up page and its printed QR code, do not expire (**Default**), and never redirect anywhere once their workspace is closed.
- **REL-7** Date automations that were missed during an outage run when service returns, unless the date is more than 2 days past (**Default**).

### Monitoring and support

- **MON-1** The operator is alerted on: send queue backlog, webhook failures, provider errors, failed payments, registration rejections and automatic suspensions.
- **MON-2** A status view shows the health of each integration (Twilio, Tremendous, Stripe, Resend).
- **MON-3** Tenants have a support contact, and the HELP auto-reply for each workspace points to the tenant, not to Flockletter.
- **MON-4** An incident affecting sends or data is recorded with cause, impact and fix, and affected tenants are told.

### Environments and change control

- **CHG-1** A staging environment uses Twilio test credentials, the Tremendous sandbox and Stripe test mode. No real texts, gifts or charges can originate from it.
- **CHG-2** Changes reach production only through pull requests on GitHub with automated tests passing.
- **CHG-3** Database changes are applied by versioned migrations that can be rolled back.
- **CHG-4** Tests that cover consent, opt-out handling, tenant isolation and duplicate-charge protection must pass before any release.

### Admin configuration

Every target and limit is a setting the platform admin can change without a code change.

- **ADM-1** Every value in the Default settings table, and every numeric limit in this document (link life, backup retention, catch-up window, expiry periods, daily caps, probation and suspension thresholds, alert thresholds), is stored as a setting and never hard-coded.
- **ADM-2** The platform admin changes settings in an admin-only UI.
- **ADM-3** The same settings can be read and changed through an admin API, which is also exposed as an MCP server so an AI assistant can make changes on the admin's instruction.
- **ADM-4** The admin UI, API and MCP server are limited to the platform-admin role with multi-factor sign-in. The API and MCP server use their own revocable credentials. No tenant role can reach them.
- **ADM-5** A setting can be set platform-wide and overridden for a single workspace.
- **ADM-6** Each change is checked against safe bounds (for example, quiet hours cannot be widened past the legal window), takes effect without a deployment, and is written to the audit log with the old value, the new value, who made it and through which interface.

## Data model requirements

These are the records the feature needs; every one carries a workspace ID.

| Record | Key fields |
| --- | --- |
| Workspace | Clerk organization ID, short name, plan, registration tier, probation status, spending cap, status |
| Workspace member | User, role (Owner, Sender, Viewer) |
| Sender registration | Legal name, EIN, DBA flag, brand ID, campaign ID, status, rejection reason, Twilio subaccount ID |
| Phone number | Number, campaign ID, status |
| Contact | Name, phone in E.164 format, email, time zone, textable flag, external ID (ID in another system) |
| Consent | Contact, channel, status, timestamp, source, wording shown |
| Important date | Contact, type, label, date (year optional) |
| Automation | Date type or trigger, template, send time, gift setting, campaign length, enabled flag |
| Campaign | Type (broadcast, automation, gift, coupon, event), schedule, length in days, status |
| Message | Contact, direction (outbound or inbound), body, segments, status, provider message ID, cost, campaign |
| Gift offer | Contact, campaign, value, brand or choice list, status (offered, claimed, expired), expiry date, Tremendous order ID, redemption link |
| Gift credit ledger entry | Type (purchase, reserve, claim, return, refund, dispute), amount, related offer or Stripe payment |
| Coupon and redemption | Offer, expiry, terms; contact, unique code, viewed at, redeemed at |
| Event and RSVP | Event details; invitee, response, consent captured |
| Short link | Workspace short name, case-sensitive code, destination, expiry, clicks |
| Hosted page | Business details, accepted privacy policy and SMS terms versions |
| Setting | Key, platform value, workspace override, changed by, changed at |
| Audit log entry | Actor, interface (UI, API, MCP), action, target, old and new value, timestamp |

- **DATA-1** The contact's external ID is reserved for linking to Cadence or another CRM later.
- **DATA-2** Important dates use a generic type-plus-date shape so new date types need no schema change.
- **DATA-3** Contact, consent, date, automation and send operations are exposed as internal API endpoints, not only through the UI.

## Integration requirements

| System | Used for | Requirement |
| --- | --- | --- |
| Twilio | Registration, numbers, sending, webhooks, line-type lookup | One subaccount per workspace to isolate numbers, usage and carrier penalties; lookup cost per check to confirm (NUM-2) |
| Tremendous | Buying gift cards when a recipient claims | Prepaid balance topped up by bank transfer through the API (GFT-9); sandbox-tested 2026-11-16, one live gift still to test |
| Stripe | Plans, metered texts, setup fees, gift credit purchases, disputes, sales tax | Usage reported per workspace; dispute webhooks processed (CBK-1) |
| Clerk | Sign-in, organizations and roles | Organization equals workspace |
| Resend | Newsletters, email fallback, opt-in and notification emails | Already in place |
| Render | App, background jobs, webhook endpoints, scheduled automations | Already in place |
| Cloudflare | DNS for Flockletter's domains and flkl.cc | flkl.cc email lockdown in place; auto-renew and a redirect from the bare domain still to set |
| Bitwarden Secrets Manager | All API keys and secrets | Never stored in the repository (SEC-3) |
| Cadence (future) | Source of contacts and dates | Not built now; DATA-1 to DATA-3 keep it possible |

**Cadence bridge principle:** Cadence knows who the clients are and when their dates fall. Flockletter owns consent, the registered number and every outbound message. Cadence asks Flockletter to send; Flockletter decides whether it is allowed.

## Compliance requirements

The platform is accountable to carriers for what its tenants send, so these are build requirements, not policy notes.

- **CMP-1** No message is sent from an unregistered number (US A2P 10DLC brand and campaign approval).
- **CMP-2** Each legal entity registers its own brand; a brand is never shared across legal entities. Each DBA of an entity registers as its own brand on that entity's EIN.
- **CMP-3** Birthday, anniversary and event texts are treated as marketing and require express opt-in (see CON-1 to CON-6).
- **CMP-4** Imported phone numbers are stored as contacts without consent; the tenant must run an opt-in request before texting them.
- **CMP-5** Consent records are retained for the life of the workspace and remain exportable.
- **CMP-6** Real estate tenants: registration copy and sample messages describe past-client relationship messaging only. Real estate draws extra carrier scrutiny.
- **CMP-7** Gifts are never conditional on a referral. Real estate tenants are prompted to confirm broker approval before enabling gifting (RESPA and state license rules vary).
- **CMP-8** Third-party brand names and logos on gifts appear only through the rewards provider's own redemption page.

This is not legal advice. Legal review of the consent wording, terms and gifting flow is best effort: AI-driven, with a human accepting the result.

## Cost assumptions

A low-volume tenant costs about $19.50 to set up and $2.65 a month before message charges. Figures are from web sources checked on 2026-11-16 and must be confirmed on the provider's pricing page before registering.

| Item | Amount | When |
| --- | --- | --- |
| Brand registration | $4.50 | Once per brand |
| Secondary vetting (Standard brand only) | $41.50 | Once, only for higher volume |
| Campaign vetting | $15 | Once per campaign; charged again on resubmission |
| Campaign fee, low-volume | $1.50 | Monthly |
| Campaign fee, Standard | $10 | Monthly |
| Phone number | $1.15 | Monthly |
| Message (Twilio list price) | about $0.0083 per segment | Per message |
| Carrier surcharge | about $0.0035 to $0.005 | Per message |
| Line-type lookup | To confirm | Per new SMS opt-in (NUM-2) |
| Gift card | Face value; funding the Tremendous balance by bank transfer is free | Per claimed gift |

Prices charged to tenants are set in the Pricing section.

Sources: [Twilio A2P 10DLC](https://www.twilio.com/en-us/phone-numbers/a2p-10dlc) · [Reverbico fee breakdown](https://reverbico.com/blog/a2p-10dlc-registration/) · [Kanal Twilio pricing](https://getkanal.com/blog/twilio-sms-pricing) · [Tremendous pricing](https://www.tremendous.com/pricing/)

## Pricing

Texting is sold as an add-on to Flockletter in three monthly plans, priced under the texting-only tools at entry level, with the phone number and carrier fees included. Accepted by the owner on 2026-11-16 in the private document; every price is an admin setting (ADM-1).

| Plan | Price per month | Texts included |
| --- | --- | --- |
| Starter | $19 | 300 |
| Growth | $39 | 1,000 |
| Pro | $79 | 2,500 |

- **PRC-1** A text is one message segment. A message that runs to two segments counts as two texts.
- **PRC-2** Texts beyond the plan's allowance cost 3 cents each, up to the workspace's spending cap (BIL-4).
- **PRC-3** A one-time setup fee of $49 covers low-volume registration, or $99 for Standard registration. It is charged before any registration call (ONB-6) and is not refunded if the carrier rejects the registration.
- **PRC-4** The Pro plan assumes Standard registration.
- **PRC-5** Gift credit carries a 10% fee taken at purchase: $55 buys $50 of credit. On refund of unused credit (GFT-8), the fee for the unused portion is refunded too.
- **PRC-6** Coupons, sign-up pages, date automations, events and link shortening are included in every plan at no extra charge.
- **PRC-7** Unused texts do not roll over to the next month.

For comparison, texting-only tools start at about $25 to $29 a month for 500 texts, often with a separate number fee of $5 to $10, and charge about 4 cents for overage.

Sources: [SimpleTexting comparison](https://simpletexting.com/blog/best-text-messaging-services-small-business/) · [Referrizer price comparison](https://business.referrizer.com/posts/cheapest-sms-marketing-platforms/)

## Rollout phases

Each phase must pass its gate before the next starts.

1. **Foundation.** Open the Twilio reseller account under Frosty Flamingo Software, and add SMS wording to each site's privacy policy and terms. Gate: provider account approved.
2. **Core sending.** Build tenancy, consent, the sign-up page, the flkl.cc link shortener, admin settings and basic sending. Register the owner's first business by running the registration code as the operator, with no self-serve screens yet. Gate: campaign approved and a real opted-in text delivered.
3. **Self-serve onboarding.** Build the in-app sign-up flow, automated provisioning, identity checks, probation and the review queue. Prove it by registering the owner's remaining businesses through that flow. Gate: both approved without manual workarounds.
4. **Automation, events and coupons.** Add important dates, date automations, events and RSVP, coupons with tap-to-redeem, and inbound replies. Gate: automations run unattended for 30 days in the owner's own workspaces.
5. **Gifting.** Add claim-on-tap gifts, prepaid gift credit, the credit ledger and Tremendous balance top-ups. Sandbox tests passed on 2026-11-16. Gate: one live gift bought and claimed end to end.
6. **Outside customers.** Add plans and billing, spending caps, hosted business pages, the tenant dashboard, the acceptable-use policy and the operator dashboard, then onboard 3 to 5 pilot customers across Realtors and restaurants, in either order. Gate: AI-driven legal review accepted by a human, Twilio's answers to the open questions received, and pilot feedback collected.
7. **Cadence bridge.** Scoped separately after the pilot.

Three tracks start now, alongside phase 1, because none depends on code: opening the Twilio account, the legal review, and the live Tremendous gift test.

## Decisions

Owner decisions recorded in the private requirements document on 2026-11-16 and 2026-11-17. They are not entered in the [decision ledger](../DECISIONS.md) and do not override it (see O-016).

- **SMS provider:** Twilio.
- **DBA registration:** a DBA is a second brand on the same EIN.
- **Flockletter as a sender:** Flockletter texts its own users, so the platform operator also registers as a sender.
- **Gift model:** claim on tap. The gift card is bought only when the recipient taps Claim, and offers expire after 15, 30 or 60 days, as the tenant chooses.
- **Gift funding:** the tenant prepays gift credit to cover every offer in a campaign, and the unclaimed amount returns as credit when the campaign ends. If 5 of 100 recipients claim a $5 gift, $25 is spent and $475 returns to the tenant's credit.
- **Gift vendor:** Tremendous, chosen for the more mature API. Confirmed by a sandbox run-off against Giftbit on 2026-11-16 (23 vs 20 of 24 points): a repeated claim returns the same order and link, webhooks are signed, there is an official Node SDK, and Starbucks plus 8 of 10 target brands are available at $5. With claim on tap, vendor refund policy no longer matters.
- **Scope:** texting is a Flockletter feature only for now.
- **Legal review:** best effort, AI-driven, accepted by a human.
- **Coupon redemption:** by staff in store, with a tap-to-redeem button on the customer's phone and a Redeemed notice on the coupon. No point-of-sale integration.
- **First market:** Realtors and restaurants can both go first.
- **Link shortening:** built in-house on flkl.cc and free to tenants, with no separate charge; use is bounded by the number of messages a tenant sends.

- **Sign-up pages:** always hosted by Flockletter; tenant-hosted forms are not supported.
- **Emoji:** not allowed in texts. Letters from other languages, such as the é in José, are allowed.

- **Probation:** ends on time and volume conditions; ramped daily cap; first-broadcast canary; gifting waiting period and cap; a pause level and a suspend level; the operator can end probation early. Values withheld from the public copy.

- **Default items:** all accepted as written; each stays adjustable through the admin settings.

- **Pricing:** texting add-on plans at $19, $39 and $79 a month; 3 cents per extra text; $49 setup fee ($99 Standard); 10% fee on gift credit at purchase.

- **Hosted business page:** kept. It is domainless: a path on Frosty Flamingo Software's domain, with no custom-domain option for tenants.
- **Short-link codes:** mixed case, handled case-sensitively.

## Deferred

- Texting as a shared service that Cadence also calls.

## Open questions

- [x] Probation settings: decided 2026-11-16. See IDV-6 to IDV-11 and the Default settings table.
- [ ] Confirm at registration that Twilio accepts a second brand on the same EIN for a DBA.

- [ ] Confirm that Twilio's consent API can clear an opt-out after a new web opt-in on a 10DLC number (second path in CON-6).
- [x] Test in the Tremendous sandbox: a $5 Starbucks US card can be ordered by API and delivered as a link.

- [ ] Confirm with Twilio whether a Flockletter-hosted business page satisfies the website requirement for tenants with no site of their own (HST-4).
- [x] Default items and the Default settings table: accepted by the owner on 2026-11-16.

- [ ] Include prepaid gift credit in the legal review: refund terms and any state rules on unused customer balances.

- [ ] Review the Default (pending) items added on 2026-11-17: prohibited content, disputes, plan changes and trial, short names, recipient-facing pages, language, retention and tax, notifications, and DATE-8.
