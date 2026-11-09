# Proposed Amendment: Flockletter Trial Reuse Protection (Owner Review)

**Status:** DRAFT — NOT ACCEPTED. No business decision is marked as accepted.
**Scope:** Narrow policy amendment for lifetime trial eligibility enforcement and data retention exceptions.

## 1. Policy Definition
*   **Policy ID:** `trial-once-lifetime-v1` (Proposed)
*   **Version:** 1
*   **Eligibility Rule:** Lifetime one-trial-per-verified-Clerk-owner and provider-card identity across all workspaces.
*   **Constraint:** Bounded alternatives (e.g., 365-day refresh) cannot satisfy the current lifetime no-refresh rule. Implementation currently permits bounded logic only for synthetic exercises.

## 2. Data Retention & Privacy
*   **Standard Tenant Policy:** All ordinary tenant data remains under the existing 90-day retention policy from effective service end. Legal holds are disclosed separately.
*   **Narrow Exception:** Global minimal consumed claims are retained indefinitely (`retainUntil=null`) after account purge. This is an explicit, narrow exception to the 90-day rule.
*   **Unconsumed Reservations:** Their eligibility expires after the existing 35-minute flow; this is not a promise of physical deletion at minute 35. Due-only cleanup runs through the restricted retention mechanism. Attempt records enforce the rolling 24-hour retry limit.
*   **Data Minimization:** Records are keyed HMAC-SHA256 pseudonymous personal data (not anonymous).
    *   **Included:** Namespace/key tag, approved policy ID/version/mode/retention days, claim kind, owner/card/workspace keyed digest, random intent UUID, reservation/consumed state, creation timestamp, nullable expiry.
    *   **Excluded:** Raw IDs, fingerprints, emails, PAN, address, list/message content.

## 3. Security & Configuration
*   **HMAC Secret:** Stable in private credential storage. Rotation/reset must preserve history under reviewed migration.
*   **Configuration Gates:**
    *   `FLOCKLETTER_TRIAL_HMAC_KEY`: ≥32 characters.
    *   `FLOCKLETTER_TRIAL_POLICY_ID`: `trial-once-lifetime-v1`.
    *   `FLOCKLETTER_TRIAL_POLICY_VERSION`: `1`.
    *   `FLOCKLETTER_TRIAL_RETENTION_APPROVED`: `true` **only** after owner approval.
    *   `FLOCKLETTER_TRIAL_HISTORY_BASELINE`: `verified-empty` or `reviewed-backfill` **only** after factual provider/history review.

## 4. Baseline Verification Protocol
*   **Requirement:** Do NOT guess baseline from empty new DB.
*   **Procedure:** Inspect actual configured Stripe account, all Flockletter previous trial/subscription/setup history, reconcile existing app mappings and legacy saved agreements.
*   **Decision Logic:**
    *   If absolutely no historical actual free trials: Select `verified-empty` and retain dated evidence.
    *   If history exists: Do NOT select `reviewed-backfill` until authoritative import code, review, and evidence exist.
    *   **Note:** Current repository has no historical-backfill importer.

## 5. Owner Decisions Required
The owner must explicitly select these policies; deployment or credential approval alone does not select them:

1.  **Eligibility Model:**
    *   [ ] Approve the Lifetime Narrow Exception (implemented but currently disabled for real trials).
    *   [ ] Amend to Bounded Retention (e.g., 365 days) — *Requires coding, disclosure, and tests before live use.*
    *   [ ] Defer Real Trials — Keep new real trials off while paid/complimentary preparation continues.
2.  **Public Disclosure:**
    *   [ ] Approve public disclosure of the retention exception and pseudonymous data handling.
3.  **Infrastructure & Facts:**
    *   [ ] Identify/Confirm retention signing storage location.
    *   [ ] Confirm AWS account control for credential management.
    *   [ ] Supply factual evidence for `FLOCKLETTER_TRIAL_HISTORY_BASELINE`.

---
*This is an owner-review proposal, not an accepted policy or a statement of live provider verification.*
