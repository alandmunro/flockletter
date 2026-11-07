# Workspace team access

Open **Team** as a current Clerk workspace owner. The screen lists existing Clerk organization members, their Flockletter brand access and the workspace's seat allowance. Each page contains up to 25 members. A failed directory lookup shows a retry action. Member names and grants stay within the authenticated screen.

1. Select **Manage access** for an existing non-owner member. The form shows the end of their Clerk account ID so an owner can distinguish people with the same display name.
2. Choose **Viewer** to read campaign drafts and images, or **Editor** to also create and edit drafts and upload images. Select one to five named brands and choose **Save brand access**.
3. To stop that member’s Flockletter access, select **Remove brand access**, review the member, and choose **Confirm removal**. Cancel returns to the form without changing access. The person's Clerk account, organization membership and seat remain in place.
4. If the connection drops during a change, retry the same selection. The UI retains its operation key until the server acknowledges the change, then reloads the directory.

The seat count includes every current Clerk member, including owners. Starter allows one, Growth three and Pro unlimited. The preparation workspace has a one-seat limit. When membership exceeds the workspace allowance, non-owner brand access and new grants are held. Owners can still remove a Flockletter grant.

## Using Flockletter as a member

Members see **Campaigns** and **Image library** for the brands the owner selected. A viewer can open a saved draft, read its rendered and plain-text previews and browse images. An editor can also create a draft, save a new version and check its preview. Audience, connections, team administration and workspace settings are owner functions.

Removing a member’s brand access takes effect on the next request, including a save from an editor tab that was open before removal. Refreshing then shows an access message. Other members keep their own grants.

The authenticated owner commands are `team.list` with an offset, `team.grant` with a verified member ID, role, explicit brand IDs and operation key, and `team.revoke` with the member ID and an operation key. These commands do not create accounts, send invitations, change Clerk membership or issue a roster export. Customer preparation credentials cannot administer the team. [Requirements and accepted limits](../SRD.md#identity-and-workspace-isolation)

## Verification

Run `npx vitest run tests/team-ui.test.ts tests/team-access.test.ts`. After a production build, `node --import tsx scripts/prove-team-ui.ts` opens separate owner, viewer and editor browser sessions against the actual Flockletter HTTP server and a disposable PostgreSQL database. The Clerk directory, browser identities, brands and campaigns use synthetic data. The proof exercises Flockletter authorization and leaves live Clerk sign-in and organization membership untouched. For installed Chrome use `FLOCKLETTER_BROWSER_CHANNEL=chrome`. Set `FLOCKLETTER_TEAM_SCREENSHOTS` to a local directory for the desktop, phone, viewer and editor captures.

The owner proof covers paging, keyboard focus, a dropped acknowledgment after a committed grant or revoke, atomic replay and a plan downgrade. The member proof assigns different brands to a viewer and an editor. It checks both previews, an editor draft saved at version two, direct requests for the other brand, and a rejected save from an open tab after revocation. The harness checks the saved draft in PostgreSQL and confirms the removed member still belongs to the Clerk fixture.
