> Update November 6, 2026: the owner has now authorized the [foundation implementation](implementation/FOUNDATION.md) and staging verification (D-030). The design-only restrictions below describe the earlier planning phase and are superseded for that bounded scope. Full SaaS launch, live sending and production remain gated.

# Flockletter phase 1 product review

Phase 1 turns the product idea into a reviewable software requirements document. It includes this public repository and its planning material. It additionally includes owner-authorized nonproduction screen mockups through Sites, published design artifacts and user stories. It does not include production application code, test scaffolds, Render provisioning, live provider setup or operational deployment.

## Product definition

Flockletter helps small retailers and general small businesses communicate with people who have chosen to hear from them. The hosted MVP combines audience management, campaign preparation, included delivery, scheduling, basic reports and subscription billing. Customers should be able to onboard themselves and operate through either the dashboard or delegated API/MCP access. Large enterprises and complex marketing journeys are outside this first release.

The first concrete use case is an FFA product or collection announcement: choose an authorized audience, prepare a draft using existing approved product information and photos, review it, send a test, then authorize sending or scheduling. That integration does not change the merchandise or commerce system. A second business must be able to perform the same workflow without FFA-specific assumptions.

The value of the hosted service is managed operation, delivery integration, convenience and support. Open-source self-hosting remains a supported product goal, with all required application code available and no dependency on the owner's private applications.

## What the owner has settled

The name is Flockletter, the repository is public, future signup is open and self-service, hosted plans include delivery, and the license is AGPLv3. The target market is small US businesses, with inexpensive pricing and a 14-day card-required trial. FFA is the first intended customer and receives complimentary access without Stripe or card payments. The intended operator is Frosty Flamingo Software, LLC; its planned Colorado DBA filing remains pending.

The three tiers allow 2, 5 and 20 campaigns per month, with campaign and recipient allowances pooled across each subscription. Company/brand totals are 1/1, 3/3 and 5/5; user limits are 1, 3 and unlimited. Monthly prices are $15/$25/$39, active contacts and maximum recipients per campaign are 2,500/5,000/10,000, and monthly recipient emails are 5,000/25,000/100,000. The trial is limited to 250 contacts and 500 total emails. Clerk owns all hosted login and workspace membership, with Google, Apple and Microsoft sign-in, plus email with a one-time verification code. Listmonk, Stripe and Render are also selected. Double opt-in defaults on, tracking defaults off, canceled-account data is retained 90 days then purged, and support is email-only with AI replies.

The product remains in documentation and design-only phase 1. These choices are D-001 through D-029 in [decisions](DECISIONS.md). Engine isolation, billing details, data-lifecycle exceptions and support automation controls remain proposals; provider selection does not authorize infrastructure changes.

## Discussion order

1. **Validate the accepted cost model.** Prices and recipient caps are accepted; establish measured capacity, storage limits and the launch budget using the $250 shared-cost assumption. Include Clerk Enhanced B2B and shared subscription accounting; essential safety controls belong in every tier.
2. **Choose delivery and validate the engine boundary.** Compare provider terms, production approval, reputation isolation, feedback, rate limits and cost at full allowance. Review Listmonk enforcement and per-customer provisioning costs. Do not assume existing accounts or hosting capacity cover a public SaaS.
3. **Complete the account and Render design.** Define company/brand access, Clerk configuration, independent self-hosting and the FFA integration. Validate database headroom and component reuse rights.
4. **Finish the operating details.** Resolve trial campaign/seat/company/brand limits and paid transition, exact billing behavior, refunds, retention clocks/copies, pending legal/tax work and AI support escalation. The owner has deferred the detailed abuse-policy conversation; retain it as a gate before sending implementation, without blocking SRD drafting.
5. **Approve a bounded implementation plan.** Freeze the first workstream's contracts, list its required decisions and tests, and obtain explicit implementation authorization. A public draft SRD is not that authorization.

## Phase 1 deliverables

| Deliverable | Current state |
| --- | --- |
| Public project identity and license | Defined in README, LICENSE and the decision ledger |
| Product scope, people and workflows | Drafted in the SRD |
| Numbered product and operational requirements | Drafted for review |
| Architecture and reuse choices | Proposals with identified gaps; no implementation reuse approved |
| Acceptance cases and traceability | Planned cases only; no executable tests or verification claims |
| Tier values and providers | Prices, recipient/campaign/company/brand/user and trial contact/email caps accepted; core providers accepted; delivery provider and counting details open |
| Operating budget and detailed policies | Cost assumptions documented, including Clerk memberships; spending authorization, exact capacity and detailed policies remain open |
| User interface review | Sites concept, complete MVP screen catalogue and linked user stories; design review does not authorize implementation |
| Foundation permission to build | Authorized by D-030; broader release acceptance remains open |

## Documentation review criteria

The owner should be able to determine what the customer can do, what each system owns, how a failed action is recovered and what remains undecided. Every requirement must have a planned acceptance case. Accepted choices and proposals must remain distinguishable. No public document may contain customer records, secrets or unnecessary private infrastructure details.

The phase 1 draft can be published while decisions remain open. Completing phase 1 for implementation requires resolving the decisions needed for the first authorized workstream, accepting its requirement baseline, confirming reuse/licensing scope and explicitly authorizing coding. Delivery, database activation and production operation have additional gates; permission to code does not waive them.

## Gaps to resolve before work starts

- Listmonk integration must establish how quotas, suppression and retries are enforced on every dispatch path. API availability alone does not prove this.
- Per-customer engine isolation must fit a measured provisioning and connection budget; the existing always-running application does not establish spare capacity.
- Included delivery requires a provider and an abuse/reputation plan suitable for open signup.
- Reusing a billing pattern does not establish reusable code, compatible licensing or verified live behavior.
- A usable open-source deployment needs portable authentication and delivery configuration; private account assumptions must be removed.
- Multi-company/brand permissions must preserve consent boundaries while enforcing one shared subscription allowance.
- A 90-day purge must cover engine data, exports, media and restore behavior; any narrow retention exceptions need an explicit policy.
- AI support needs approved context, reply rules, handoff and operating costs before automatic replies are enabled.

The complete list, with timing and proposed starting points, is O-001 through O-013 in [decisions](DECISIONS.md).
