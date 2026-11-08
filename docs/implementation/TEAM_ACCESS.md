# Workspace team access

Open **Team** as a current Clerk workspace owner. The screen lists existing Clerk organization members, their Flockletter brand access and the workspace's seat allowance. Each page contains up to 25 members. A failed directory lookup shows a retry action. Member names and grants stay within the authenticated screen.

1. Select **Manage access** for an existing non-owner member. The form shows the end of their Clerk account ID so an owner can distinguish people with the same display name.
2. Choose **Viewer** to read campaign drafts and images, or **Editor** to also create and edit drafts and upload images. Select one to five named brands and choose **Save brand access**.
3. To stop that member’s Flockletter access, select **Remove brand access**, review the member, and choose **Confirm removal**. Cancel returns to the form without changing access. The person's Clerk account, organization membership and seat remain in place.
4. If the connection drops during a change, retry the same selection. The UI retains its operation key until the server acknowledges the change, then reloads the directory.

The seat count includes every current Clerk member, including owners. Starter allows one, Growth three and Pro unlimited. The preparation workspace has a one-seat limit. When membership exceeds the workspace allowance, non-owner brand access and new grants are held. Owners can still remove a Flockletter grant.

## Pending invitations

The Team screen also lists the active workspace’s pending Clerk invitations, 25 at a time. An owner can see the invited address and expiry. Remaining capacity on a finite plan subtracts current members and all pending invitations, including invitations on other pages. Pro displays its unlimited seat allowance. An unavailable provider count produces a retry state with unknown capacity. This count helps the owner review invitations already issued through Clerk. An invitation grants no Flockletter brand access.

`team.invitations` is a read-only owner-session command. It accepts only a page offset. The backend uses the authenticated workspace, filters for pending invitations, verifies the workspace on every returned invitation, and returns only its identifier, email and expiry. The owner response is uncached. Delegated MCP connections and members have no access to the invitation directory. [Clerk invitation API](https://clerk.com/docs/reference/backend/organization/get-organization-invitation-list)

### Restricted staging invitation

The optional **Invite a staging member** form appears only for the configured workspace. An owner selects a server-approved address and presses **Send member invitation**. Clerk issues an ordinary member invitation. Each allowed address has one durable pilot request. Refreshing the page shows the original request. If Clerk has not confirmed it, **Check invitation status** looks for the original private provider reference. A missing receipt continues to reserve a seat. This can require operator investigation even if the original process stopped before contacting Clerk. The pilot never resubmits an ambiguous request. A recorded result is the provider state when first verified. The pending directory shows the current Clerk list. [Create organization invitation](https://clerk.com/docs/reference/backend/organization/create-organization-invitation)

The pilot defaults to off. A separate operational approval is needed before enabling a real invitation. In an approved staging instance, `FLOCKLETTER_TEAM_INVITES=allowlist` requires one exact `FLOCKLETTER_TEAM_INVITE_WORKSPACE`, one to 25 specific addresses in `FLOCKLETTER_TEAM_INVITE_RECIPIENTS`, and Flockletter development Clerk keys. Flockletter stores a private operation reference at Clerk and an address digest in the workspace’s protected operation ledger. Acceptance links, provider metadata and raw provider errors stay out of the public response. An active Clerk owner and a complete directory are required. The local plan and provider organization cap must both have capacity. For a finite tier, Clerk’s own positive membership maximum must be at most the plan cap. A changing, unverified, or oversized directory holds the request. This small pilot inspects at most 500 organization invitations and 500 memberships. [Clerk organization properties](https://clerk.com/docs/reference/backend/types/backend-organization)

## Using Flockletter as a member

Members see **Campaigns** and **Image library** for the brands the owner selected. A viewer can open a saved draft, read its rendered and plain-text previews and browse images. An editor can also create a draft, save a new version and check its preview. Audience, connections, team administration and workspace settings are owner functions.

Removing a member’s brand access takes effect on the next request, including a save from an editor tab that was open before removal. Refreshing then shows an access message. Other members keep their own grants.

The authenticated owner commands are `team.list` with an offset, `team.grant` with a verified member ID, role, explicit brand IDs and operation key, and `team.revoke` with the member ID and an operation key. These commands do not create accounts, send invitations, change Clerk membership or issue a roster export. Customer preparation credentials cannot administer the team. [Requirements and accepted limits](../SRD.md#identity-and-workspace-isolation)

## Verification

Run `npx vitest run tests/team-ui.test.ts tests/team-access.test.ts`. After a production build, `node --import tsx scripts/prove-team-ui.ts` opens separate owner, viewer and editor browser sessions against the actual Flockletter HTTP server and a disposable PostgreSQL database. The Clerk directory, browser identities, brands and campaigns use synthetic data. The proof exercises Flockletter authorization and leaves live Clerk sign-in and organization membership untouched. For installed Chrome use `FLOCKLETTER_BROWSER_CHANNEL=chrome`. Set `FLOCKLETTER_TEAM_SCREENSHOTS` to a local directory for the desktop, phone, viewer and editor captures.

The owner proof covers paging, keyboard focus, a dropped acknowledgment after a committed grant or revoke, atomic replay and a plan downgrade. The member proof assigns different brands to a viewer and an editor. It checks both previews, an editor draft saved at version two, direct requests for the other brand, and a rejected save from an open tab after revocation. The harness checks the saved draft in PostgreSQL and confirms the removed member still belongs to the Clerk fixture.

The [invitation adapter test](../../tests/team-clerk-adapter.test.ts) sends the installed Clerk SDK to a local HTTP fixture and checks the organization path, status filter and pagination. [Team API tests](../../tests/team-access.test.ts) check owner scope, provider failures, pagination and finite and unlimited allowances with a disposable database.

The [invitation pilot test](../../tests/team-invitation-pilot.test.ts) exercises Clerk SDK lookups and the invitation POST against a loopback HTTP fixture. The mutation targets Clerk’s fixed organization endpoint, times out after ten seconds and refuses redirects. The test covers consumed seats, concurrent owners’ requests, lost replies, a redirect, mismatched provider evidence and lookup after an uncertain submission. No external invitation or email participates in these tests.
