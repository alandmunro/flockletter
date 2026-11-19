# Texting phase 2: implementation plan

**Status: approved 2026-11-18, merged in PR #84 (`7c67ab9`) and live on staging in mock mode. FL-AT-041–044 pass locally and were exercised on staging against the mock; FL-AT-045 is not yet done.** D-063 authorizes FL-SMS-001–015 only. The [SRD](../SRD.md) is canonical. Source IDs (REG-, CON-, MSG-…) refer to [the texting requirements](PROPOSED_TEXTING_AND_GIFTING.md).

Out of scope: self-serve onboarding, identity checks, probation, billing or charges, gifting, coupons, events, date automations, hosted business pages and outside customers. Birthday and anniversary values are collected by the sign-up page (FL-SMS-007) and stored, but nothing sends on them.

## 1. Principles carried over from the codebase

- **Workspace isolation (FL-SMS-001).** Every new public table has `workspace_id`, `ENABLE`/`FORCE` row-level security and the `workspace_scope` policy. Composite foreign keys include `workspace_id`. Unauthenticated entry points (Twilio webhooks, short-link redirects, the public sign-up page) resolve to one workspace only through `SECURITY DEFINER` routing functions in `flockletter_customer_jobs`, then work inside `db.tenant(workspaceId)`.
- **One command layer.** Customer commands are added to `src/shared/` and served by `CommandService`, so browser, HTTP and MCP stay the same. Operator commands are added to `platformCommands`, served by the operator UI, `/api/operator/v1` and the operator MCP.
- **Durable intent first.** Every Twilio mutation is a row committed in state `calling` (with a stable operation key) before the HTTP call. Twilio has no idempotency keys, so an `unknown` outcome is reconciled by a lookup (section 4) and never by a second POST.
- **Fail closed on settings.** A required operator setting that is unset blocks the dependent action with a named reason. No fraud value is in code, migrations or this repository.
- **Logs.** No message bodies, phone numbers, credentials or tokens in logs (SEC-8). Bodies live only in the database.

## 2. Data model

One migration, `040_texting.sql`, added to the ordered list in `scripts/apply-migrations.mjs` and `src/shared/runtime-tables.json`. Migrations have no rollback files today. To satisfy CHG-3 for this feature, I'll add `migrations/rollback/040_texting.down.sql`, which drops only the new objects, plus a test that applies it and then applies 040 again.

### Public tables (row-level security by workspace)

| Table | Purpose and key columns |
| --- | --- |
| `sms_workspace_profile` | One row per workspace. `short_name` (unique, 3–30 of `[a-z0-9-]`, blocked-word list is an operator setting), `notification_email`, sign-up field switches `phone_field`, `birthday_field`, `anniversary_field`, `anniversary_label` (FL-SMS-007). |
| `sms_carrier_brands` | One per company (FL-SMS-002): `company_id` **unique**, `legal_name`, `dba_name`, `entity_type`, registration profile `jsonb` (EIN, address, website, contact, vertical), `help_contact`, `privacy_policy_confirmed_at`, `sms_terms_confirmed_at`. A company has at most one carrier brand, and its brands send under it. |
| `sms_registrations` | The registration state machine (section 3): `carrier_brand_id`, `state`, `revision`, `rejection_reason`, provider ids (`customer_profile_sid`, `brand_sid`, `messaging_service_sid`, `campaign_sid`). |
| `sms_registration_steps` | One durable intent per provider call: `registration_id`, `step`, `operation_key` (unique), `state` (`queued`, `calling`, `done`, `uncertain`, `rejected`, `held`), `attempts`, `next_check_at`, `provider_sid`, `facts jsonb`, `operator_approval_id`. |
| `sms_numbers` | `e164`, `provider_sid`, `carrier_brand_id`, `messaging_service_sid`, `state` (`reserved`, `active`, `released`). Sending needs an `active` number on an `approved` registration. |
| `sms_contacts` | `phone_e164` (US only, FL-SMS-011), optional `subscriber_id`, `name`, `time_zone`, `textable`, `not_textable_reason`, `consecutive_temp_failures`. Unique `(workspace_id, phone_e164)`. |
| `sms_consents` | Current state per `(workspace_id, company_id, contact_id)`, because STOP is scoped to the number that received it, and each company has one number: `none`, `pending_confirmation`, `opted_in`, `opted_out`, `pending_reenrollment`. |
| `sms_consent_events` | Append-only (a trigger blocks update and delete): `event`, `source`, exact `wording`, `wording_digest`, `policy_version`, `evidence_message_id`, `recorded_by`, `recorded_at` (FL-SMS-005/006). |
| `contact_dates` | Generic `type`, `label`, `month`, `day`, optional `year` (DATA-2). Phase 2 stores only; nothing reads it to send. |
| `sms_sends` | A composed text: `company_id`, `kind` (`broadcast`, `test`), `body`, `state` (`draft`, `scheduled`, `confirmed`, `running`, `paused`, `completed`, `cancelled`), `scheduled_at`, `confirmation` snapshot (recipients, segments, allowance use, days needed), `confirmed_by`. |
| `sms_messages` | One per recipient and message, outbound and system: `send_id` (null for system texts such as confirmations and HELP), `contact_id`, `id` = operation key, `rendered_body`, `encoding` (`gsm7`, `ucs2`), `segments`, `state` (`pending`, `admitted`, `calling`, `accepted`, `delivered`, `undelivered`, `failed`, `uncertain`, `skipped`, `cancelled`), `reason`, `provider_sid`, `send_day`, `next_check_at`, `attempts`. |
| `sms_inbound` | `number_id`, `from_e164`, `contact_id` (null for unknown numbers, INB-6), `body`, `provider_sid` (unique), `classification` (`stop`, `help`, `start`, `confirm`, `other`, `unknown_number`), `forwarded_at`. |
| `sms_provider_events` | Webhook dedupe: `event_key` (unique), `digest`. Same key with different content gives a 409, like Resend feedback. |
| `sms_usage` | `(workspace_id, period_month)`: `segments_reserved`, `segments_used` (FL-SMS-012). |
| `sms_links` | `code` (`COLLATE "C"`, case-sensitive), `destination`, `expires_at`, `clicks`. |
| `sms_audit` | `actor_id`, `interface` (`ui`, `api`, `mcp`, `worker`, `webhook`, `operator_ui`, `operator_api`, `operator_mcp`), `action`, `target`, `old_value`, `new_value`, `at`. This is a new table, because the existing `audit` table has no old/new value or interface columns (FL-SMS-013/015). |

### Private tables (`flockletter_customer_jobs`, runtime reaches them only through functions)

| Table | Purpose |
| --- | --- |
| `texting_settings` | `key`, `workspace_id` (null = platform value), `value jsonb`, `revision`. Read by `texting_setting(ws, key)`, which returns the workspace override or else the platform value. Written only by operator commands. |
| `texting_setting_changes` | Old value, new value, actor, interface, reason, time (ADM-6). |
| `sms_provider_accounts` | `workspace_id` → subaccount SID plus its API key and auth token, **encrypted** (AES-256-GCM, key from Bitwarden). No customer role and no customer command can read them (FL-SMS-003). |
| `sms_number_routes` | `e164` → `workspace_id`, `number_id`, for inbound and status webhooks. |
| `sms_link_routes` | `(short_name, code)` → `workspace_id`, destination, expiry, for the redirect. |
| `sms_mock_state` | Staging mock only: created resources, queued callbacks and fault scripts, so the mock survives restarts. |

### Settings catalogue

The catalogue is code in `src/shared/texting-settings.ts`. For each key it holds the type, hard safe bounds, whether a workspace override is allowed, and whether the tenant may narrow it. **Values are never in code.** Examples: quiet-hours start and end (bounded to 8:00 a.m.–9:00 p.m. local), per-contact frequency limit, carrier daily limit, monthly segment allowance, link life, retry policy, opt-out keyword list, short-name blocked words, unconfirmed-phone expiry, test texts per day, and the live-recipient allow-list. Section 7 asks whether the publicly documented defaults should be seeded.

## 3. Registration state machine (FL-SMS-004)

The operator runs it from the operator UI, API or MCP, using the registration code later reused by self-serve onboarding.

```
draft ──operator submit──▶ provisioning ──▶ brand_pending ──▶ campaign_pending ──▶ approved
  ▲                           │                 │                 │                  │
  └──── operator correct ◀── rejected ◀─────────┴─────────────────┘           suspended (callback)
```

Provisioning steps, each one durable intent row in `sms_registration_steps`, run in this order:

1. `subaccount` (mock only in staging, CHG-1; in live mode the staging workspace binds to the existing staging subaccount instead).
2. `customer_profile` (secondary profile under the ISV primary profile).
3. `brand` (brand registration).
4. `messaging_service` (inbound and status callback URLs set to Flockletter).
5. `campaign` (`UsAppToPerson`, with sample messages, opt-in, HELP and STOP wording).
6. `number` (search and buy, then attach to the messaging service).

Step rules:

- **Before each call:** in one transaction, check the registration revision, set the step to `calling` with `operation_key = sms-reg/<registration>/<revision>/<step>`, write `sms_audit` and commit. Then call Twilio.
- **Outcomes:** created → `done` with the SID. 4xx validation → `rejected` with the mapped reason; the registration becomes `rejected`. 429 → stays `queued` with a back-off. Timeout, 5xx or network → `uncertain`.
- **Reconcile `uncertain` by lookup, never by repeating the POST.** Each created resource's `FriendlyName` carries the operation key, so the worker lists by it (subaccounts, profiles, messaging services, numbers), or reads the parent (brand by profile, campaign by messaging service). Found → `done`. Not found after the configured settle time → back to `queued`, and only then retried.
- **Status changes** (brand approved or failed, campaign verified or failed) arrive by signed webhook and are also polled on a schedule (ONB-3). Callbacks are applied only as forward moves: a duplicate is a no-op, and an out-of-order or older status is recorded but cannot move the state backwards.
- **Sending stays locked** unless the company's registration is `approved` and its number is `active`. The send path checks this, as well as the composer.
- **Real-action gate.** In `live` mode, each of brand, campaign and number needs a separate operator approval record naming the registration, step and cost, in addition to the command itself. So a stray call can't buy a number or file a registration. I will stop and ask you before any of these runs.

## 4. Twilio adapter (real and mock)

No new dependency: plain `fetch` with an injected `fetch` in tests, `boundedJson` for bodies and zod for every response, like `resend.ts`.

```ts
type Outcome = 'accepted' | 'rejected' | 'not_submitted' | 'unknown';

interface TwilioPlatformPort {            // platform Main API key; operator registration only
  createSubaccount(op: string): Promise<Result<{ accountSid: string; authToken: string }>>;
  createSubaccountKey(accountSid: string, op: string): Promise<Result<{ keySid: string; secret: string }>>;
  createCustomerProfile(accountSid: string, op: string, profile: BusinessProfile): Promise<Result<{ sid: string }>>;
  submitBrand(accountSid: string, op: string, profileSid: string): Promise<Result<{ sid: string; status: string }>>;
  createMessagingService(accountSid: string, op: string, callbacks: CallbackUrls): Promise<Result<{ sid: string }>>;
  submitCampaign(accountSid: string, op: string, input: CampaignInput): Promise<Result<{ sid: string; status: string }>>;
  buyNumber(accountSid: string, op: string, search: NumberSearch, serviceSid: string): Promise<Result<{ sid: string; e164: string }>>;
  find(kind: ProvisionKind, accountSid: string, op: string, parentSid?: string): Promise<{ outcome: Outcome; sid?: string; status?: string }>;
  status(kind: 'brand' | 'campaign', accountSid: string, sid: string): Promise<{ status: string; reason?: string }>;
}

interface TwilioMessagingPort {           // per-workspace subaccount credentials only
  send(m: { op: string; from: string /* messaging service SID */; to: string; body: string; statusCallback: string }):
    Promise<{ outcome: Outcome; sid?: string; retryAfterSeconds?: number; permanent?: 'invalid' | 'landline' | 'unsubscribed' }>;
  lookup(m: { op: string; sid?: string; to: string; from: string; sentAfter: Date; bodyDigest: string }):
    Promise<{ outcome: Outcome; sid?: string; status?: string }>;
}

interface TwilioSignature { verify(url: string, params: Record<string, string>, header: string, authToken: string): boolean }
type Result<T> = { outcome: Outcome; value?: T; reason?: string; retryAfterSeconds?: number };
```

- **Real (`twilio-http.ts`).**
  - Send: 201 → `accepted`. Error 21610 (recipient sent STOP) → `rejected`, and the consent is set to `opted_out`. 21211 or 21614 → `rejected`, number not textable. 429 or 20429 → `not_submitted` with retry-after. 5xx or timeout → `unknown`.
  - Message lookup: by SID, or else list messages for that `To` and `From` since the attempt, matching the body digest. The status callback URL carries the message id, so a late callback also settles it.
  - Signatures: HMAC-SHA1 over the full URL and sorted parameters, using the **auth token of the account that owns the number**.
- **Mock (`twilio-mock.ts`).** It implements both ports with the same outcome rules, stores state in `sms_mock_state` (persistent in staging), and generates realistic SIDs and signed callbacks through the real webhook route. It is scriptable, for tests and for the staging operator console:
  - a timeout after the provider commits;
  - 429 and 5xx;
  - delayed, duplicate and out-of-order callbacks;
  - brand or campaign rejection, then approval;
  - an inbound STOP, HELP, START, YES or other reply from a given number.
- **Mode.** `FLOCKLETTER_TEXTING ∈ off | mock | live`. Production refuses `mock`. `live` also needs `FLOCKLETTER_TEXTING_ACTIVATION_APPROVED`, and in phase 2 any recipient not on the operator's live-recipient allow-list is refused at the transport (D-063: owner's opted-in numbers only). Staging defaults to `mock`.

## 5. Sending, consent, links and inbound

- **Consent (FL-SMS-005/006).**
  - The sign-up page shows the SMS checkbox (separate, optional, unchecked) only when the brand's company has an approved number. Checking it records `pending_confirmation` with the exact wording and queues one confirmation text. Only a YES reply moves the consent to `opted_in`. Unconfirmed phones expire after the configured period.
  - Imports never create consent.
  - STOP (and the configured opt-out words) sets `opted_out` for that company's number. HELP replies with the business name and the carrier brand's help contact. START restores `opted_in` from `opted_out` or `pending_reenrollment`.
  - Re-adding an opted-out contact sets `pending_reenrollment`, after a warning in the UI. No provider opt-out API is called.
- **Sign-up page (FL-SMS-007).** Optional phone, birthday (month and day) and anniversary fields, each switched per workspace and never required. Email confirmation is unchanged, following the brand's D-054 setting.
- **Composer and send (FL-SMS-008).**
  - Commands: `sms.draft`, `sms.preview`, `sms.testSend`, `sms.confirm`, `sms.schedule`, `sms.pause`, `sms.cancel` and `sms.status`, with read-only `sms.contacts` and `sms.inbound`.
  - Encoding: emoji and decorative symbols are rejected; curly quotes and long dashes are converted. GSM-7 or UCS-2 is chosen per recipient after merge fields, and segments are counted per recipient.
  - Test send goes to the member's verified phone, which is itself confirmed by a code text. It is limited to the configured number per day with the D-047 unique-slot pattern.
  - Nothing sends without `sms.confirm` on an exact snapshot: recipients, segments, allowance use and the days needed.
- **Send grant.** A new capability, `sms:send`. Owners hold it. Editors need an explicit grant (a new `team_grants.sms_send`, default false; existing grants unchanged). Analysts and readers never hold it. Connections need the scope issued explicitly. Drafting needs only `draft:write`.
- **Delivery (FL-SMS-009/011/012).**
  - The per-workspace worker pass runs under the workspace advisory lock and admits each message through one function, `sms_admit`. It checks, in order:
    1. registration approved and number active;
    2. consent `opted_in` and number textable (otherwise `skipped`, using no allowance);
    3. quiet hours in the recipient's time zone (contact, else area code, else workspace);
    4. per-contact frequency;
    5. carrier daily limit;
    6. allowance (segments reserved at admission, released on rejection).
  - A refused message gets `next_check_at` at the next allowed window, so a large send spreads over days. The confirmation screen shows the estimate first.
  - Intent before the call: `admitted` → `calling` (committed) → POST.
  - On restart, `calling` and `uncertain` rows are only ever looked up, never re-sent.
  - Status webhooks set `delivered`, `undelivered` or `failed`. A permanent failure marks the number not textable.
- **Links (FL-SMS-010).** Every URL in a body is checked: allowed only for the workspace's verified sending domain or its Flockletter-hosted pages. The send rewrites it to `https://<short-link origin>/<short_name>/<code>`, with a mixed-case code matched case-sensitively. The redirect route only follows a stored, unexpired destination. The short-link origin is configuration: an app path in staging, `flkl.cc` in production (DNS and the Render domain are a separate change).
- **Inbound (FL-SMS-015).**
  - `POST /api/v1/texting/twilio/inbound` and `/status` verify the signature, dedupe on the message SID, route the number to its workspace, store the text, then classify it: STOP, HELP, START, pending-confirmation YES, or other.
  - Other replies are forwarded to `notification_email` through the existing Resend path (capture mode in staging).
  - Unknown numbers are logged only.
  - Every send, consent change, registration step and settings change is written to `sms_audit`.
- **Secrets (FL-SMS-014).** At start-up, with `BWS_ACCESS_TOKEN` and the project id set, the app loads the Twilio platform key, the subaccount-credential encryption key and (in staging) the staging subaccount values from Bitwarden into memory, then forgets the token. Values are never logged. A missing value fails closed for live texting only; mock mode needs no secrets.

## 6. Test plan

Unit and DB tests use embedded Postgres and the mock by default. No test reaches Twilio.

| Case | What it proves |
| --- | --- |
| **FL-AT-041** isolation | Two synthetic workspaces, each with a company, brand, number and contacts. Every customer command (HTTP and MCP) and the browser path for A cannot read or change B's numbers, contacts, consent, messages or links (row-level security errors and `not_found`). Webhooks for B's number never touch A. The worker pass for A never admits B's rows. Customer roles and connections can't read `sms_provider_accounts` or call `platform.texting*`. A settings change is bounded, audited with old and new values, actor and interface, and rejected for customer actors. |
| **FL-AT-042** registration | Every step runs exactly once per operation key under: a timeout after commit (reconciled by `find`), 5xx, 429, duplicate, delayed and out-of-order callbacks, rejection then correction, and a worker restart mid-step. Sending is refused until `approved` with an active number. A second carrier brand for the same company is refused. |
| **FL-AT-043** consent | Unchecked box; phone without consent; imported number; unconfirmed number (no other text, then expiry); STOP, HELP, START; Spanish opt-out words from the setting; pending re-enrollment; permanent failure → not textable; both D-054 email modes. Each produces the documented state, and consent events are preserved and immutable. |
| **FL-AT-044** sending | No send grant → 403 on HTTP and MCP; test-send daily limit; emoji blocked; curly quotes converted; per-recipient GSM-7 vs UCS-2 segment counts (for example `José`); quiet hours across time zones; frequency and daily limits with multi-day spreading and the shown estimate; kill and restart the worker mid-send with no loss and no duplicate; allowance exhaustion stops sending; link allow-list refusal; case-sensitive short codes and expiry. |
| **FL-AT-045** (after your approval) | Staging mock and Bitwarden loading verified, inbound and audit verified; then the real registration and one real text to your phone, with reply, STOP and START. |

Staging evidence for FL-AT-041–044: run the same suites, plus a scripted browser-and-API exercise against staging in `mock` mode with two synthetic Clerk organizations. Record each in `docs/TRACEABILITY.md`, marked **mock**, kept apart from FL-AT-045's live evidence.

Also: the adapter contract tests run the same cases against the real HTTP adapter (with fake `fetch`) and against the mock, so the mock can't drift from the outcome rules.

## 7. Questions before coding

1. **Bitwarden client.** Bitwarden's official SDK (`@bitwarden/sdk-napi`) uses a proprietary license, which conflicts with AGENTS.md's licensing rules. Options:
   - (a) A small in-house client for the Secrets Manager protocol: access-token login, list secrets, decrypt with `node:crypto`. This is my recommendation.
   - (b) A start-up wrapper that runs the `bws` CLI on Render.
   - (c) The SDK, after a license review.
2. **Missing Bitwarden access.** This Mac's existing machine account can see only the `openclaw` project, not `flockletter-staging`, so I can't load the Twilio values yet. Staging also needs a Render machine-account token (the requirements doc lists machine accounts as "still to create"). Should I create a read-only machine account for `flockletter-staging` (I'll ask before creating it), or will you?
3. **Twilio auth token.** Webhook signatures are verified with the **auth token** of the account that owns the number. The staging project lists an Account SID and API key, but no auth token. Please add `FLOCKLETTER_TWILIO_AUTH_TOKEN` for the staging subaccount before FL-AT-045. The mock doesn't need it.
4. **Seeded defaults.** Should the migration seed only the non-fraud defaults already public in the requirements doc (quiet hours 9:00 a.m.–8:00 p.m., 4 texts per contact per month, 2-month link life, 7-day unconfirmed expiry, Spanish opt-out words)? The alternative is seeding nothing, so you set every value. Either way, the carrier daily limit, allowance, test-text limit and live-recipient allow-list stay unset until you set them, and sending fails closed until then.
5. **Sign-up field switches.** FL-SMS-007 says "per workspace", but sign-up pages are per brand today. I plan per-workspace switches, applied to every brand's page.

## 8. Owner answers (2026-11-18)

The owner approved the plan with the recommended defaults:

1. **Bitwarden client:** (a), a small in-house client. No new dependency.
2. **Bitwarden access:** connect to both `flockletter-staging` and `flockletter-production`. Staging loads only from `flockletter-staging` and production only from `flockletter-production`. The loader refuses to run if the project doesn't match `NODE_ENV`. The machine account gets read-only access. Phase 2 reads no production value until FL-AT-045 is approved.
3. **Auth token:** `FLOCKLETTER_TWILIO_AUTH_TOKEN` is in `flockletter-production`. Twilio is reported to sign each subaccount's webhooks with that subaccount's own auth token. So FL-AT-045 must confirm which account the token belongs to before it is used to verify staging-subaccount webhooks. Signature verification looks up the token by the `AccountSid` in the request and fails closed if none matches.
4. **Seeded defaults:** yes, only the public non-fraud defaults. Fraud limits stay unset.
5. **Sign-up switches:** per workspace, applied to every brand page.

## 9. Implementation (2026-11-18)

Code: `migrations/040_texting.sql` (+ `migrations/rollback/040_texting.down.sql`), `src/shared/texting*.ts`, `src/shared/us-area-codes.ts`, `src/server/texting/`, `src/server/secrets/bitwarden.ts`, `src/client/Texting.tsx`, `src/client/OperatorTexting.tsx`. Tests: `tests/texting.test.ts`, `tests/texting-migration.test.ts`, `tests/bitwarden.test.ts`.

### Configuration

| Variable | Meaning |
| --- | --- |
| `FLOCKLETTER_TEXTING` | `off`, `mock` or `live`. Default `mock` in staging, `off` elsewhere. Production refuses `mock`. |
| `FLOCKLETTER_TEXTING_ACTIVATION_APPROVED` | Must be `true` for `live`. |
| `FLOCKLETTER_SHORT_LINK_ORIGIN` | Short-link origin and path. Default `<APP_ORIGIN>/l`; `https://flkl.cc` once its DNS and Render domain exist. |
| `BWS_ACCESS_TOKEN`, `BWS_PROJECT` | Live only. The machine-account token and this environment's project (`flockletter-staging` or `flockletter-production`); any other project name is refused. The token is removed from the process environment after loading. |

Bitwarden keys read in live mode: `FLOCKLETTER_TWILIO_ACCOUNT_SID`, `FLOCKLETTER_TWILIO_API_KEY_SID`, `FLOCKLETTER_TWILIO_API_KEY_SECRET`, `FLOCKLETTER_TWILIO_AUTH_TOKEN` (staging subaccount); `FLOCKLETTER_TWILIO_PLATFORM_ACCOUNT_SID`, `FLOCKLETTER_TWILIO_PLATFORM_API_KEY_SID`, `FLOCKLETTER_TWILIO_PLATFORM_API_KEY_SECRET`, `FLOCKLETTER_TWILIO_PRIMARY_PROFILE_SID` (platform); `FLOCKLETTER_TEXTING_SEAL_KEY` (64 hex characters). Mock mode reads none.

### Staging exercise

1. Operator control room → texting settings: set `carrier_daily_limit`, `monthly_segment_allowance`, `test_texts_per_day`, `member_code_minutes`, `member_code_attempts` (and optionally `reconcile_settle_minutes`, `registration_poll_minutes`).
2. For each synthetic workspace: `platform.textingCarrierBrand` → `platform.textingConfirmPolicies` → `platform.textingSubmit` → “Simulate brand approval” → “Simulate campaign approval”.
3. Workspace → Texting: set a short name and sign-up fields, add contacts, compose, review, send. `platform.textingMock` scripts faults and inbound replies.

### Staging evidence (2026-11-18)

Staging (`flockletter-staging`, development Clerk, mock Twilio) was exercised through the operator and customer HTTP command APIs and the hosted sign-up page, signed in as the workspace owner. The operator account is a workspace-only exercise actor, so only one workspace (`org_3LmYkS07OAgBzsblHl3ppMfXrBk`) was available; cross-workspace isolation between two live tenants remains covered by the local tests only.

**Release.** The schema-compatibility rehearsal for serving `4c47ec6` → candidate `7c67ab9` failed (`serving_web_on_new_schema`): the old runtime check rejects the new texting routines and the new check requires them, so neither order is ready-safe. With owner approval this ran as a staging maintenance window: point-in-time recovery point 15:07:44 UTC; migration 040 applied by `scripts/migrate.ts` as a one-off Render job on a temporary worker at `7c67ab9` (15:27:46 UTC); `7c67ab9` deployed and verified by `/api/health/version` and `/readyz` (15:30:37 UTC); worker deleted. Staging was not ready for about three minutes. Production will hit the same incompatibility and needs a bridge release or its own window.

| Case | Observed on staging |
| --- | --- |
| FL-AT-041 | Operator exercise actor refused for another workspace (`exercise_workspace_only`) on settings, registration and mock; platform-scope setting changes refused; operator commands unknown on the customer API; foreign company id `not_found`; unsigned or wrongly signed Twilio webhooks (inbound, status, registration) refused with 403 and changed no consent. Five sending settings plus `reconcile_settle_minutes` set at workspace scope, each audited. |
| FL-AT-042 | Submit refused until policies confirmed (`policies_unconfirmed`); second carrier brand after submit refused (`registration_in_progress`). Injected faults: campaign `429` → queued, then `5xx` → uncertain, held as `not_found_yet` until the settle time was set, then retried and done (3 calls); number `timeout_after_commit` → uncertain → found by lookup with a single create. Campaign waited for brand approval; number active only after campaign approval. |
| FL-AT-043 | Hosted sign-up shows optional phone and birthday fields with the SMS checkbox unchecked. Checkbox sign-up → `pending_confirmation` → YES → `opted_in`; sign-up without the checkbox and an import without consent stayed `none` (import's YES classified `other`); unknown number's YES classified `unknown_number`. HELP kept consent; `stop` and `PARAR` opted out; START restored the STOP contact. |
| FL-AT-044 | Emoji refused (`text_characters_blocked`); curly quotes and long dash converted; GSM-7 single segment with business prefix and STOP line; non-allow-listed link reported `link_not_allowed`; test send refused until the member phone is verified, wrong code returned `verified: false`; review → confirm with digest → accepted → delivered via mock callback; allowance usage recorded. |

**Findings from the staging run.**
- Changed SMS wording on the hosted sign-up is refused with 409 `consent_wording_changed` and nothing is recorded. (A first attempt returned a one-off 503 that did not reproduce.) Like the existing `consent_changed` refusal, a native form post shows the JSON error rather than a page.
- An uncertain registration step waits indefinitely while `reconcile_settle_minutes` is unset (fail-closed by design), but nothing said so. Fixed in PR #86: the setting is now listed as needed while a step is uncertain.
- Calling `platform.textingCarrierBrand` again while the registration is a draft or rejected corrects it (audited as `carrier_brand.correct`, and policy confirmation is cleared); this is the designed correction path. The staging registration was submitted as "Other LLC" because the exercise called it twice.
- Correct-code phone verification and two-tenant isolation were not exercised on staging (the code isn't readable through any customer or operator interface; only one workspace is available).

### Known limits (not hidden)

- **Erasure of private texting routes.** Public `sms_*` tables are erased with the workspace (they are runtime tables). The private `texting_*` route, account and short-name rows are not yet in the retention executor's private list; that needs the executor and its role grants updated together.
- **Inbound forwarding** records `captured`; no email transport is wired for INB-4 yet.
- **Editors with the send grant** use the API or MCP; the browser Texting page is in the owner navigation only.
- **Tenant narrowing** of quiet hours and frequency (owner can only narrow) is not built; only operator settings exist.
- **Carrier daily limit** counts per UTC day.
- **Real adapter.** TrustHub, A2P brand, campaign and number calls follow Twilio's ISV documentation but are first exercised in FL-AT-045. Each live step needs `platform.textingApprove`.
- **Auth token.** The token in `flockletter-production` is likely the parent account's. Signature checks use the token of the account named in `AccountSid` and fail closed, so FL-AT-045 must confirm the staging subaccount's token first.
- **US numbers only** by area code: 360 area codes for the 50 states and DC, maintained by hand in `src/shared/us-area-codes.ts`; a new overlay must be added there.
