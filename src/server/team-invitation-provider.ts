import type { createClerkClient } from '@clerk/backend';
import { z } from 'zod';
import { invitationEmail, type InvitationState } from '../shared/team.js';

export type InvitationBinding = { workspace: string; recipients: string[] };
export function loadInvitationBinding(env: NodeJS.ProcessEnv): InvitationBinding | undefined {
  const mode = env.FLOCKLETTER_TEAM_INVITES ?? 'off';
  if (mode === 'off') return;
  const workspace = env.FLOCKLETTER_TEAM_INVITE_WORKSPACE ?? '';
  const addresses = (env.FLOCKLETTER_TEAM_INVITE_RECIPIENTS ?? '').split(',');
  if (
    mode !== 'allowlist' ||
    env.APP_ENV !== 'staging' ||
    !env.CLERK_SECRET_KEY?.startsWith('sk_test_') ||
    !env.CLERK_PUBLISHABLE_KEY?.startsWith('pk_test_') ||
    !/^org_[A-Za-z0-9_-]{1,120}$/.test(workspace) ||
    addresses.length > 25 ||
    addresses.some((value) => !invitationEmail.safeParse(value).success)
  )
    throw Error('Invalid Flockletter staging invitation configuration.');
  const recipients = addresses.map((value) => invitationEmail.parse(value));
  if (new Set(recipients).size !== recipients.length) throw Error('Duplicate staging invitation recipients.');
  return { workspace, recipients };
}

type ProviderState = Exclude<InvitationState, 'awaiting_reconciliation'>;
export type IssuedInvitation = {
  id: string;
  workspace: string;
  role: string;
  email: string;
  reference: string | null;
  state: ProviderState;
};
export type InviteRequest = { workspace: string; email: string; issuer: string; reference: string };
export type ClerkInvitationPilot = {
  binding: InvitationBinding;
  inspect(
    workspace: string,
  ): Promise<{ maximum: number; members: string[]; invitations: IssuedInvitation[] }>;
  lookup(workspace: string): Promise<IssuedInvitation[]>;
  create(request: InviteRequest): Promise<IssuedInvitation>;
};
type Organizations = ReturnType<typeof createClerkClient>['organizations'];
type Invite = Pick<Awaited<ReturnType<Organizations['createOrganizationInvitation']>>,
  'id'|'organizationId'|'emailAddress'|'role'|'status'|'privateMetadata'>;
const invitationResponse = z.object({
  id:z.string().min(1),organization_id:z.string(),email_address:invitationEmail,
  role:z.literal('org:member'),status:z.enum(['pending','accepted','revoked','expired']),
  private_metadata:z.object({flockletter_invitation_reference:z.string()}),
});
const directoryError = () => Error('Incomplete organization invitation directory.');
async function allPages<T extends { id: string }>(
  load: (offset: number, limit: number) => Promise<{ data: T[]; totalCount: number }>,
): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let expected: number | undefined;
  const limit = 100;
  do {
    const page = await load(rows.length, limit);
    if (
      !Number.isSafeInteger(page.totalCount) ||
      page.totalCount < 0 ||
      page.totalCount > 500 ||
      (expected !== undefined && expected !== page.totalCount) ||
      page.data.length !== Math.min(limit, page.totalCount - rows.length)
    )
      throw directoryError();
    expected = page.totalCount;
    for (const row of page.data) {
      if (!row.id || seen.has(row.id)) throw directoryError();
      seen.add(row.id);
      rows.push(row);
    }
  } while (rows.length < expected);
  return rows;
}
function projected(row: Invite, workspace: string): IssuedInvitation {
  if (
    !row.id ||
    row.organizationId !== workspace ||
    !row.status ||
    !['pending', 'accepted', 'revoked', 'expired'].includes(row.status) ||
    !row.role ||
    !invitationEmail.safeParse(row.emailAddress).success
  )
    throw directoryError();
  const reference = row.privateMetadata?.flockletter_invitation_reference;
  if (reference != null && typeof reference !== 'string') throw directoryError();
  return {
    id: row.id,
    workspace,
    role: row.role,
    email: invitationEmail.parse(row.emailAddress),
    state: row.status,
    reference: reference ?? null,
  };
}
export function clerkInvitationPilot(
  organizations: Organizations,
  binding: InvitationBinding,
  secretKey:string,
  send:typeof fetch = fetch,
): ClerkInvitationPilot {
  async function lookup(workspace: string) {
    const rows = await allPages((offset, limit) =>
      organizations.getOrganizationInvitationList({
        organizationId: workspace,
        status: ['pending', 'accepted', 'revoked', 'expired'],
        offset,
        limit,
      }),
    );
    return rows.map((row) => projected(row, workspace));
  }
  return {
    binding,
    lookup,
    async inspect(workspace) {
      // Count invitations first so a mid-read acceptance cannot immediately open another seat.
      const invitations = await lookup(workspace);
      const org = await organizations.getOrganization({
        organizationId: workspace,
        includeMembersCount: true,
      });
      const rows = await allPages((offset, limit) =>
        organizations.getOrganizationMembershipList({
          organizationId: workspace,
          offset,
          limit,
          orderBy: '+created_at',
        }),
      );
      if (
        org.id !== workspace ||
        !Number.isSafeInteger(org.maxAllowedMemberships) ||
        org.maxAllowedMemberships < 0 ||
        org.membersCount !== rows.length ||
        rows.some((row) => row.organization?.id !== workspace || !row.publicUserData?.identifier)
      )
        throw directoryError();
      return {
        maximum: org.maxAllowedMemberships,
        members: rows.map((row) => row.publicUserData!.identifier.toLowerCase()),
        invitations,
      };
    },
    async create({ workspace, email, issuer, reference }) {
      // A redirect to another POST endpoint must not repeat an invitation or disclose its payload.
      const response = await send('https://api.clerk.com/v1/organizations/'+encodeURIComponent(workspace)+'/invitations',{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
        headers:{authorization:'Bearer '+secretKey,'content-type':'application/json'},
        body:JSON.stringify({inviter_user_id:issuer,email_address:email,role:'org:member',private_metadata:{flockletter_invitation_reference:reference}}),
      });
      if (!response.ok) {await response.body?.cancel();throw directoryError();}
      const row=invitationResponse.parse(await response.json());
      return projected({id:row.id,organizationId:row.organization_id,emailAddress:row.email_address,role:row.role,
        status:row.status,privateMetadata:row.private_metadata},workspace);
    },
  };
}
