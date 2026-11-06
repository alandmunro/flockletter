# Design verification record

Design review version 1 · November 6, 2026. These checks concern the static review artifact only. None of the SRD’s 35 FL-AT implementation acceptance cases is marked complete by this work.

## What was checked

| Check | Observed result |
| --- | --- |
| Screen coverage | 54 unique screen IDs, 54 view bodies and 54 mapped user stories; no missing next-screen targets |
| Desktop rendering | All 54 routes rendered with one main h1 and visible content at the default 1280 px browser viewport; no document-level horizontal overflow |
| Phone layout | All 54 routes checked at 390 × 844 px; no document-level horizontal overflow; viewport restored after review |
| Screenshots | 54 full-page desktop captures, 6 representative phone captures and 3 critical failure/uncertainty captures |
| Runtime/browser review | No error-level browser logs observed in the reviewed run; JavaScript syntax checks passed |
| Import walkthrough | Permission declaration blocks navigation until checked; the sample import result separates 942 ready, 38 duplicate and 20 excluded rows |
| Campaign review | Unchecked final review acknowledgement blocks the sample confirmation; checked acknowledgement opens an explicit simulated confirmation |
| Preflight | Blocked variant lists sender, allowance and footer gaps together and replaces the product send route with repair guidance |
| Send uncertainty | Reconciliation view explains reserved allowance, unknown provider acceptance and no blind resend |
| Preview controls | Desktop/mobile/plain-text views can be selected; the active-tab indicator follows the selection |
| Subscriber consent | Unchecked consent blocks the sample signup continuation; checking it navigates to confirmation |
| Unsubscribe failure | Failed-save example avoids a success claim and offers a retry path |
| Requirements and links | All 59 SRD requirement IDs remain mapped to planned acceptance cases; all screen requirement references are valid; relative documentation and screenshot links checked |
| Publication scope | Only planning documents and design artifacts are included; no provider credentials, customer records, hosting manifest, live integration or production application code is included in GitHub |

Visual inspection focused on the dashboard, pricing, editor and subscriber mobile view. The route sweep confirms rendering and layout bounds; it is not a comprehensive visual or accessibility certification of every state. Wide tables intentionally scroll inside their containers.

## Corrections made during review

- Fixed shared-script declarations before the first working browser preview.
- Made consent and final review acknowledgements explicit instead of preselected.
- Removed SaaS login/navigation prompts from the newsletter-reader views.
- Replaced contradictory green checks in the blocked-preflight example with the actual gap list.
- Corrected the access-recovery screen to one main heading and the preview-tab selected state.
- Kept the skip link within the current screen rather than interpreting it as a route.
- Clarified that trial onboarding and populated paid-workspace flows are separate fixtures.

## Limits of this verification

No live Clerk login or membership change, Stripe checkout/charge, mail delivery, DNS change, upload of customer data, database isolation test, accessibility certification, performance/load test, Render deployment or FFA integration occurred. Provider components are explicit handoff mockups. Dates, roles, metrics and service outcomes are illustrative. Static review controls can navigate between roles or past blocked states for inspection; they are not production security controls.

The Sites preview was privately published from source commit `3ea3dc21b4372da170502c2b998681009fc1b02a`; the source and packaged artifact matched. The public GitHub copy contains the same four prototype files, plus documentation and screenshots. Sites identity and write credentials are excluded from GitHub.

## Model contribution record

The local `qwen3.8-27b-mlx@8bit` model drafted the eight end-to-end walkthrough narratives and a first commit message after its local service became reachable. Chat reviewed the complete drafts, clarified paid-versus-trial examples, full-seat invitation behavior, future recovery requirements and nonpersistent state transitions, and shortened the commit message.

Chat handled the approved requirements and cost model, Clerk authority/security decisions, Cadence-style visual design and prototype creation using the Sites workflow, screen/story mapping, browser checks, final review and publication. No token or cost percentage is claimed because a measured split is not available.
