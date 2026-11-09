# Flockletter website cookie choices

D-045 implements FL-PRV-001 and supports FL-ID-001/005, FL-AUD-002 and FL-OPS-004/006. The owner requested FFA-equivalent consent behavior for FFF, meaning Frosty Flamingo Flockletter. This is an independent React implementation of the relevant behavior, with no FFA runtime or commerce dependencies.

## Behavior and scope

Every application route, including public pricing/help, signup, the workspace and operator shell, renders the same cookie controls. A first visit presents equally prominent Reject optional cookies and Accept all cookies buttons, the purposes currently in use and a privacy link. Cookie choices remains available after dismissal. `/privacy`, `/policies/privacy` and `/cookies` open the same public notice without requiring sign-in.

The necessary browser preference contains only the notice version, choice, timestamp and listed optional purposes, under `flockletter_cookie_choices` in this origin's local storage. Both decisions last at most 180 days; reads and refreshes never renew them. Expiry, unknown versions/purposes, malformed records and future timestamps prompt again. Focus/resume and storage events recheck the choice; cross-tab changes are reflected. Browser timer delays are bounded to avoid long-timeout overflow. Storage failures display a retry explanation without blocking the service or enabling optional tracking.

No optional website analytics or advertising provider is configured. Accept all covers the uses described in the current notice and grants no unnamed or future purpose. The shared purpose allowlist is empty and the optional-cookie guard denies all purposes, including when an acceptance exists. A future provider needs a new notice/purpose revision plus reviewed loader, server-side collection and withdrawal enforcement; this UI is not permission to activate one. Global Privacy Control and Do Not Track are treated conservatively as optional tracking denied.

Changing a cookie choice does not reload the page, clear Clerk cookies, alter workspace membership, invalidate a campaign, change a subscription or grant email consent. It is a browser preference, not a tenant command; UI/API/MCP workspace grants cannot substitute for a visitor's choice. Login-free newsletter confirmation/unsubscribe pages and upstream Clerk pages retain their separate purposes and authority.

The public notice describes Flockletter's actual sign-in and preference storage and directs account-data questions to the existing support address. No apparel shopping/purchase disclosures, provider IDs, cart cookies or FFA consent records are copied. FFA itself is unchanged.

The pattern uses clear choices, easy refusal/withdrawal and renewed consent for new purposes, consistent with the [ICO's consent implementation guidance](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/how-do-we-manage-consent-in-practice/). No claim of full legal-policy certification follows from a browser control.

## Verification

`tests/cookie-consent.test.ts` covers the fixed notice/purpose scope, exact expiry boundary, malformed/future records and deny-by-default behavior. `scripts/prove-cookie-consent.ts` exercises desktop/390px layouts, equal choice styling, persistence without renewal, cross-tab expiry, withdrawal preserving a synthetic HttpOnly sign-in cookie, every application entry route, privacy access, unavailable storage and a browser privacy signal. Its isolated site records network origins to verify that accepting loads no optional external tracker. These checks use disposable browser state and do not assert live Clerk behavior.

Existing audience, team, Studio, customer-workflow and operator browser journeys use the ordinary rejection button before their main flow. Studio additionally changes cookie choices during an unsaved draft and checks that its title/subject survive. CI runs the new browser journey as well as the existing ones. Record hosted verification and the deployment revision after release; production credential setup remains separate.

Local validation passed: 90 test files, 584 passing tests and two explicitly gated engine tests skipped; lint, types and the production build passed. The new consent browser journey, real Studio authoring/unsaved-draft preservation, all seven customer workflows and the operator browser journey passed with disposable data. Hosted deployment and sign-in evidence are recorded in the release PR description after staging verification.

Local Qwen drafted the banner markup, responsive CSS and unit-test scaffolding. Chat corrected mismatched CSS classes, overly broad button styling, code fences and an incorrect exact-expiry expectation. Chat owns privacy/purpose boundaries, preference validation, synchronization, routing, preservation of identity/drafts, integration and final verification.
