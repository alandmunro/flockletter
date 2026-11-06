# Flockletter visual system

Design review version 1 · November 6, 2026.

The owner requested Cadence’s stylesheet as the visual reference. The current stylesheet and shared shell were inspected read-only. Flockletter adapts its visual tokens and typography, with newly authored prototype layouts and no imported Cadence runtime components, private data, credentials, brand images or operational code. The owner explicitly authorized this bounded visual reuse in D-027. Private source provenance is retained outside this public repository; the private application is not a public runtime dependency.

## Visual vocabulary

| Element | Choice |
| --- | --- |
| Main background | Cadence snow `#fff7f8` |
| Action color | Cadence crimson `#a41f2d`; hover `#7f1622` |
| Deep accent | Wine `#4a0a1e` |
| Borders | Blush `#f2dae0`; stronger `#e6c3cc` |
| Text | `#1b1d21`; secondary `#7d6670` |
| Positive status | `#1f6f4a` with a label, not color alone |
| Display type | Fraunces, falling back to Georgia/Times New Roman |
| Body type | Geist, falling back to Nunito Sans/system UI |
| Corners | 8 / 12 / 18 px for controls, cards and larger groupings |
| Depth | Restrained shadows tinted toward wine |

Fonts are referenced from Google Fonts and fall back to system fonts. No font binary is copied into this repository; upstream font licenses remain applicable. All displayed stationery artwork is an original CSS illustration for the fictional sample brand. FFA product photographs and existing commerce settings are untouched.

## Layout and navigation

The customer shell keeps the workspace visible and gives primary navigation to Overview, Campaigns, Audience, Reports and Settings. Subscriber screens use the sending brand without a SaaS sign-in prompt. Operators have a separate navigation context. Business records and privileges do not mix merely because the preview can navigate between roles.

The design review toolbar is outside the proposed product interface. It opens the full screen catalogue and the story attached to the current view. Its Next control follows the intended journey; Previous follows catalogue order. It can navigate past blocked sample states for review, which is not a production authorization bypass.

The working layout uses a readable centered canvas, concise forms, clear tables, explicit labels and one prominent primary action per task. Desktop editing has a block palette, message preview and settings panel. Narrow layouts stack content; wide tables scroll within their own container. The concept is light-themed; a final dark-theme design remains outside this initial review.

## Interaction and accessibility intentions

Use visible focus, keyboard-operable links/buttons, native controls and dialogs, labeled fields, text-based statuses and readable contrast. The skip link focuses main content without changing the route. Honor reduced motion. Real actions must offer explicit validation and accessible status feedback; a prototype toast is not proof of backend success.

Consent and final review acknowledgements are not preselected. Import mapping demonstrates the permission declaration before proceeding. Previewing never means a campaign is authorized. The final send review separates content, audience and timing; paused or unknown outcomes have different explanations. Success on unsubscribe is shown only as the successful-persistence design state; a failure example avoids claiming suppression was saved.

The preview is not an accessibility certification or a verified Clerk/Stripe component integration. Production keyboard, screen-reader, error summary, provider component and responsive checks remain planned acceptance work.

## Review questions still open

- Is the amount of context on preflight and billing sufficient without overwhelming a small-business owner?
- Are the proposed role names and brand-specific permissions understandable? O-013 remains unresolved.
- Should a new user land on the checklist until their first successful campaign, then on the overview?
- What exact billing/trial period, test limits and retention wording should the finalized controls show?
- Does the editor need rearrangeable blocks in the MVP, or is a simpler structured editor enough? The mockup illustrates blocks without implementing a drag-and-drop product.

These are design questions, not new accepted requirements. Record review decisions before implementation.
