# Temporary production administrator sign-in policy

Applicable: D-051, FL-ID-001/005, FL-OPS-003/006 and FL-AT-006.

The owner explicitly deferred production operator MFA until paid customers. The default remains `required`. Only the server setting `FLOCKLETTER_OPERATOR_MFA_POLICY=pre-revenue` enables the **temporary single-factor exception**. This does not purchase Clerk or activate the platform control room.

Even under the exception, the server verifies the signed Clerk session, exact dedicated operator organization, named operator allowlist, active user-bound session and current admin membership. The first factor must have been verified within five minutes; missing or malformed verification ages are rejected. The browser requests first-factor reverification when needed. Customer API/MCP connection tokens never substitute for an operator session. Current authority is rechecked when a case authorizes later work, including queued support actions. Cases record their authentication policy; changing policy cannot silently upgrade an older case.

The exception is rejected outside production or when any customer/legacy billing mode, hosted retention or erasure-approval signing is enabled. Restore and verify MFA **before enabling paid billing**, rather than waiting for a first charge. This interlock does not inspect or certify provider revenue history. The exception is explicitly selected for the owner’s pre-revenue deployment with live billing off; it does not certify historic billing or trial eligibility. Operators must not reapply the exception after paid operation begins.

UI, HTTP API and MCP use the same canonical command checks. The control room and owner Operations setup observations identify the exception without claiming MFA. Signing hosted erasure approvals stays unavailable. Ordinary customer sign-in, restricted database roles, origin checks, exact case/resource scoping, audit, sending limits and external-action gates remain intact.

The residual risk is that compromise of the operator's single sign-in factor can grant its configured privileges. The separate organization and allowlist limit who can use those privileges but do not replace a second factor.

## Restore MFA

1. Enable production MFA in Clerk and enroll the named operator's authenticator and recovery method.
2. Set `FLOCKLETTER_OPERATOR_MFA_POLICY=required` (or remove the explicit exception) on the production web and worker, keeping billing and sending off during verification.
3. Deploy the tested release and verify fresh two-factor operator authentication, expiry and revocation. Reopen exact cases under the restored policy.
4. Only then consider the separate paid-activation approval and all remaining billing/legal/provider gates.

## Evidence

`platform-live-auth.test.ts` exercises production identity logic with synthetic Clerk responses, including the explicit exception, strict default, freshness, enrollment, session/user binding, named membership, revocation and paid-activation refusal. HTTP and service tests exercise the canonical first-factor challenge and recorded case assurance. These are controlled checks, not proof of a real production operator sign-in. Hosted release results are recorded separately.

Local Qwen drafted the policy documentation. Chat narrowed its wording to the actual startup interlock, removed an invented mandatory incident policy, and owns security design, implementation, tests, integration and deployment review. No token or cost percentage is inferred.
