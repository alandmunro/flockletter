# Provider boundary review

Reviewed November 6, 2026. This is an integration design review, not live provider acceptance.

## Clerk

The installed `@clerk/backend` SDK verifies session tokens with an exact authorized frontend origin. The adapter accepts session tokens only for browser authority, verifies the current session status through Clerk, and retrieves the specific user's current organization membership. It grants the initial owner role only for `org:admin`. It does not trust a browser-submitted organization ID or a stale local role projection. Connection issuance is confined to owner sessions; subsequent connection calls recheck the issuing owner's current membership.

The frontend uses Clerk's React components for sign-in, signup and organization selection. The application must have its own staging instance, with Google, Apple, Microsoft and email verification codes configured and verified. SDK compilation and an injected test identity provider are not evidence that those real methods work. Account linking, recovery, member-level brand permissions and production social-provider setup still need their release acceptance cases.

References: [Clerk Express authentication](https://clerk.com/docs/reference/express/clerk-middleware), [organization memberships](https://clerk.com/docs/reference/backend/organization/get-organization-membership-list), [sign-in methods](https://clerk.com/docs/guides/configure/auth-strategies/sign-up-sign-in-options). The installed SDK type declarations were inspected alongside current documentation.

## Listmonk

The [campaign API](https://listmonk.app/docs/apis/campaigns/) exposes draft, test and status-changing operations. Its [HTTP messenger interface](https://listmonk.app/docs/messengers/) passes campaign and recipient identifiers to a configured backend and documents success as HTTP 200. These provide a candidate boundary for a guarded transport. They do **not** demonstrate Flockletter's quota reservations, fresh suppression/authority checks or safe reconciliation after uncertain provider acceptance.

Design inference: use a private customer-isolated engine behind a Flockletter adapter, with a guarded delivery transport and no direct SMTP bypass or public engine administration. Before implementing delivery, choose and pin an engine version, inspect and exercise retries/partial outcomes and non-campaign send paths, and prove immutable recipient-operation mapping and all-path enforcement. A messenger success response must reflect durable accounting, not merely that an HTTP request was received. Provider credentials belong only in the guarded delivery service.

No engine or transport is activated by this foundation. No upstream fork has been assumed. FL-AT-024 and FL-DEL-005 remain open; ordinary API availability is insufficient evidence.

A disposable integration test subsequently ran Listmonk 6.2.0 with an internal HTTP messenger and a private database. Its confirmed subscriber received one personalized callback. The unconfirmed subscriber received none. The test also identified native confirmation and default template behavior that a Flockletter adapter must handle. [Listmonk capture verification](LISTMONK_CAPTURE.md)

## Render and other applications

The foundation is a single independent web process. The local fixture uses a genuine PostgreSQL server and restricted role; the Render service requires its own logical database and restricted runtime credential. Staging setup must not point at a private application's database or reuse its Clerk/Stripe settings. Shared PostgreSQL activation still needs effective-grant and capacity evidence. The free service is suitable only for the temporary setup preview, with idle suspension and limited included usage; it is not a production capacity decision. See [Render free-service limits](https://render.com/docs/free).
