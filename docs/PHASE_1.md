# Flockletter phase 1 product review

Phase 1 turns the product idea into a reviewable software requirements document. It includes this public repository and its planning material. It does not include application code, test scaffolds, infrastructure provisioning, live provider setup or deployment.

## Product definition

Flockletter helps a business communicate with people who have chosen to hear from it. The hosted product combines audience management, campaign preparation, included email delivery, reporting and subscription billing. Customers should be able to onboard themselves and operate through either the dashboard or delegated API/MCP access.

The first concrete use case is an FFA product or collection announcement: choose an authorized audience, prepare a draft using existing approved product information and photos, review it, send a test, then authorize sending or scheduling. That integration does not change the merchandise or commerce system. A second business must be able to perform the same workflow without FFA-specific assumptions.

The value of the hosted service is managed operation, delivery integration, convenience and support. Open-source self-hosting remains a supported product goal, with all required application code available and no dependency on the owner's private applications.

## What the owner has settled

The name is Flockletter, the repository is public, future signup is open and self-service, hosted plans include delivery, and the license is AGPLv3. FFA is the first intended customer. The product remains in documentation-only phase 1. These decisions are recorded in D-001 through D-008 in [the decision ledger](DECISIONS.md).

Three hosted tiers, Listmonk, Stripe, isolated mailing engines and the exact reuse/hosting approach are proposed designs. They have not been represented as completed features or approved infrastructure changes.

## Discussion order

1. **Define what each plan buys.** Choose the customer size and useful differences between Starter, Growth and Pro. Establish contacts, recipient sends, seats and sender domains before choosing prices. Separate essential safety/data controls from optional convenience features.
2. **Choose included delivery economics.** Compare real provider terms, production approval, tenant/domain isolation, feedback, limits and costs at full allowance. Include per-customer engine compute, authentication, billing and support costs. Do not assume existing accounts cover a new public SaaS.
3. **Approve the account and hosting design.** Choose authentication, confirm the proposed Listmonk boundary, and validate shared-database headroom. Decide how much UI can be reused while preserving independent deployment and open-source installation.
4. **Set commercial and operating policies.** Resolve trials, cancellation, refunds, tax/markets, acceptable use, privacy defaults, retention and recovery. Specify the normal self-service path and exceptional hold/recovery paths.
5. **Approve a bounded implementation plan.** Freeze the first workstream's contracts, list its required decisions and tests, and obtain explicit implementation authorization. A public draft SRD is not that authorization.

## Phase 1 deliverables

| Deliverable | Current state |
| --- | --- |
| Public project identity and license | Defined in README, LICENSE and the decision ledger |
| Product scope, people and workflows | Drafted in the SRD |
| Numbered product and operational requirements | Drafted for review |
| Architecture and reuse choices | Proposals with identified gaps; no implementation reuse approved |
| Acceptance cases and traceability | Planned cases only; no executable tests or verification claims |
| Tier values, selected providers and operating budget | Open decisions |
| Final SRD approval and permission to build | Pending owner instruction |

## Documentation review criteria

The owner should be able to determine what the customer can do, what each system owns, how a failed action is recovered and what remains undecided. Every requirement must have a planned acceptance case. Accepted choices and proposals must remain distinguishable. No public document may contain customer records, secrets or unnecessary private infrastructure details.

The phase 1 draft can be published while decisions remain open. Completing phase 1 for implementation requires resolving the decisions needed for the first authorized workstream, accepting its requirement baseline, confirming reuse/licensing scope and explicitly authorizing coding. Delivery, database activation and production operation have additional gates; permission to code does not waive them.

## Gaps to resolve before work starts

- Listmonk integration must establish how quotas, suppression and retries are enforced on every dispatch path. API availability alone does not prove this.
- Per-customer engine isolation must fit a measured provisioning and connection budget; the existing always-running application does not establish spare capacity.
- Included delivery requires a provider and an abuse/reputation plan suitable for open signup.
- Reusing a billing pattern does not establish reusable code, compatible licensing or verified live behavior.
- A usable open-source deployment needs portable authentication and delivery configuration; private account assumptions must be removed.

The complete list, with timing and proposed starting points, is O-001 through O-013 in [decisions](DECISIONS.md).
