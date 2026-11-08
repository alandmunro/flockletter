import { createClerkClient } from '@clerk/backend';
import { AppError } from '../errors.js';
import type { TeamDirectory, TeamIntent, TeamLifecyclePort } from './service.js';
import type { LifecycleMember, LifecycleInvitation } from '../../shared/customer-team.js';

const unavailable = () =>
  new AppError(
    503,
    'clerk_directory_unavailable',
    'Current Clerk membership and capacity could not be verified.',
  );
export function customerTeamClerkPort(options: {
  secretKey: string;
  publishableKey: string;
  send?: typeof fetch;
}): TeamLifecyclePort {
  const clerk = createClerkClient({ secretKey: options.secretKey, publishableKey: options.publishableKey });
  const send = options.send ?? fetch;
  async function inspect(workspace: string): Promise<TeamDirectory> {
    const members: LifecycleMember[] = [],
      invitations: LifecycleInvitation[] = [];
    let count: number | undefined;
    for (let offset = 0; offset < 10000; offset += 100) {
      const page = await clerk.organizations.getOrganizationMembershipList({
        organizationId: workspace,
        offset,
        limit: 100,
        orderBy: '+created_at',
      });
      if (
        !Number.isSafeInteger(page.totalCount) ||
        (count !== undefined && count !== page.totalCount) ||
        page.data.length !== Math.min(100, page.totalCount - offset)
      )
        throw unavailable();
      count = page.totalCount;
      for (const row of page.data) {
        if (
          row.organization.id !== workspace ||
          !row.publicUserData?.userId ||
          !row.publicUserData.identifier ||
          !['org:admin', 'org:member'].includes(row.role)
        )
          throw unavailable();
        members.push({
          userId: row.publicUserData.userId,
          email: row.publicUserData.identifier.toLowerCase(),
          role: row.role === 'org:admin' ? 'owner' : 'member',
        });
      }
      if (members.length === count) break;
    }
    if (members.length !== count || new Set(members.map((m) => m.userId)).size !== members.length)
      throw unavailable();
    count = undefined;
    for (let offset = 0; offset < 10000; offset += 100) {
      const page = await clerk.organizations.getOrganizationInvitationList({
        organizationId: workspace,
        status: ['pending', 'accepted', 'revoked', 'expired'],
        offset,
        limit: 100,
      });
      if (
        !Number.isSafeInteger(page.totalCount) ||
        (count !== undefined && count !== page.totalCount) ||
        page.data.length !== Math.min(100, page.totalCount - offset)
      )
        throw unavailable();
      count = page.totalCount;
      for (const row of page.data) {
        if (row.organizationId !== workspace || !row.status || !row.emailAddress) throw unavailable();
        const reference = row.privateMetadata?.flockletter_customer_team_reference;
        invitations.push({
          id: row.id,
          email: row.emailAddress.toLowerCase(),
          state: row.status,
          ...(typeof reference === 'string' ? { reference } : {}),
        });
      }
      if (invitations.length === count) break;
    }
    if (invitations.length !== count || new Set(invitations.map((i) => i.id)).size !== invitations.length)
      throw unavailable();
    const org = await clerk.organizations.getOrganization({
      organizationId: workspace,
      includeMembersCount: true,
    });
    if (
      org.id !== workspace ||
      org.membersCount !== members.length ||
      !Number.isSafeInteger(org.maxAllowedMemberships) ||
      org.maxAllowedMemberships < 0
    )
      throw unavailable();
    return {
      members,
      invitations,
      maximum: org.maxAllowedMemberships === 0 ? null : org.maxAllowedMemberships,
    };
  }
  async function mutate(workspace: string, path: string, method: string, body?: unknown) {
    const response = await send(
      'https://api.clerk.com/v1/organizations/' + encodeURIComponent(workspace) + path,
      {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { authorization: 'Bearer ' + options.secretKey, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    await response.body?.cancel();
    if (!response.ok)
      throw new AppError(503, 'clerk_operation_uncertain', 'The membership operation needs reconciliation.');
  }
  return {
    inspect,
    async apply(workspace: string, intent: TeamIntent) {
      const current = await inspect(workspace);
      const owner = current.members.find((m) => m.userId === intent.issuer_id && m.role === 'owner');
      if (!owner) throw new AppError(403, 'owner_required', 'Current Clerk owner membership is required.');
      const target = current.members.find((m) => m.userId === intent.payload.userId);
      if (intent.action === 'invite') {
        const occupied =
          current.members.length + current.invitations.filter((i) => i.state === 'pending').length;
        if (
          intent.seat_limit !== null &&
          (occupied >= intent.seat_limit || current.maximum === null || current.maximum > intent.seat_limit)
        )
          throw new AppError(
            409,
            'seat_limit',
            'Current members and pending invitations must fit the verified plan allowance.',
          );
        if (
          current.members.some((m) => m.email === intent.payload.email) ||
          current.invitations.some((i) => i.state === 'pending' && i.email === intent.payload.email)
        )
          throw new AppError(
            409,
            'invitation_exists',
            'This address already has membership or a pending invitation.',
          );
        await mutate(workspace, '/invitations', 'POST', {
          email_address: intent.payload.email,
          role: 'org:member',
          inviter_user_id: intent.issuer_id,
          private_metadata: { flockletter_customer_team_reference: intent.reference },
        });
      } else if (intent.action === 'remove') {
        if (
          !target ||
          target.userId === intent.issuer_id ||
          (target.role === 'owner' && current.members.filter((m) => m.role === 'owner').length <= 1)
        )
          throw new AppError(409, 'last_owner', 'This membership cannot be removed.');
        await mutate(workspace, '/memberships/' + encodeURIComponent(target.userId), 'DELETE');
      } else if (intent.action === 'revokeInvite') {
        if (!current.invitations.some((i) => i.id === intent.payload.id && i.state === 'pending'))
          throw unavailable();
        await mutate(
          workspace,
          '/invitations/' + encodeURIComponent(intent.payload.id!) + '/revoke',
          'POST',
          { requesting_user_id: intent.issuer_id },
        );
      } else {
        if (!target || target.userId === intent.issuer_id) throw unavailable();
        if (intent.phase === 'initial') {
          if (target.role !== 'owner')
            await mutate(workspace, '/memberships/' + encodeURIComponent(target.userId), 'PATCH', {
              role: 'org:admin',
            });
        } else {
          if (target.role !== 'owner') throw unavailable();
          await mutate(workspace, '/memberships/' + encodeURIComponent(intent.issuer_id), 'PATCH', {
            role: 'org:member',
          });
        }
      }
    },
  };
}
