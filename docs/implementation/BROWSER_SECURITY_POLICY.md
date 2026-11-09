# Browser security policy

## Scope and decision

FL-OPS-006 and D-051 govern this bounded response to the November 9, 2026 staging ZAP report. Rule 10055 reported broad font sources and inline styles under CWE-693. These are browser-policy findings; the report does not by itself demonstrate executable injection or an account compromise.

The shared Helmet middleware in `src/server/app.ts` now explicitly sets `fontSrc: ["'self'"]`. Previously the omitted directive inherited Helmet's `font-src 'self' https: data:` default. Local, staging and production responses must permit only same-origin fonts. The application stylesheet uses system fonts; it does not need arbitrary external or embedded fonts. Authentication, script/frame/connection sources, upload restrictions, API permissions and operational activation modes are unchanged.

Subscriber and unsubscribe pages retain their stricter route-specific policies. Protected asset responses retain their separate sandbox policy. A stricter route may deny all fonts; it must not restore broad font sources.

## Remaining inline-style exception

The owner explicitly accepted retaining `style-src 'self' 'unsafe-inline'` for the current Clerk components, editor and email previews. [Clerk's CSP guidance](https://clerk.com/docs/guides/secure/best-practices/csp-headers) requires inline styles for its runtime styling. The installed Clerk nonce option is not evidence of supported style nonces. The application uses prebuilt sign-in, sign-up, account and organization controls; replacing those is outside this fix.

The email editor emits styled content, and sandboxed `srcDoc` previews inherit the embedding page's policy. Their sandbox must remain in place. Removing inline styles without a compatible replacement would break legitimate account and campaign flows. Moving `unsafe-inline` to another style directive merely to suppress a scanner result is not a fix.

This leaves ZAP's inline-style alert unresolved and explicitly accepted within D-051. Script restrictions, `script-src-attr 'none'`, framing protections and other existing controls remain. Inline-style permission is not permission for inline scripts. No claim of a clean full scan follows from this patch.

Revisit this exception when updating Clerk or the editor, when changing preview isolation, or when adding externally hosted fonts. Any proposed exception must name the exact required source and validate normal sign-in and preview behavior before release.

## Verification

The prepatch HTTP reproduction returned `font-src 'self' https: data:` and failed an exact same-origin assertion. Regression coverage in `tests/clerk-csp.test.ts` checks health, configuration and setup-required API errors across local, staging and synthetic production configurations. It also retains the existing Clerk script/frame/connection/worker controls and the explicitly accepted style policy. These tests start real HTTP listeners without provider calls or customer data.

Hosted verification must inspect the effective response header on the deployed revision and exercise real Clerk controls and campaign preview styling. Focused policy checks and local tests are not a replacement for a full ZAP scan, and captured workflows are not evidence of live email delivery. Deployment and browser results must be recorded separately when observed.

Local verification on November 9: the focused HTTP matrix passed all 11 tests. `npm run check` passed lint, type checking, all 107 test files (743 passed, two native integration checks skipped by their existing gates), and the production build. An independent read-only candidate review found no concrete surviving font-policy bypass or regression; hosted Clerk/editor compatibility remained a separate deployment check.

## Model contribution

The local model supplied a bounded test scaffold. Chat reviewed it, replaced sequential assertions with independent environment/response cases, and applied style coverage to every case. Chat retained ownership of the security decision, runtime patch, exception wording and integration review. No token or cost percentage is inferred.
