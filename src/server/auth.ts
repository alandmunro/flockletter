import { createClerkClient } from '@clerk/backend';
import type { Request as ExpressRequest } from 'express';
import type { Capability } from '../shared/contracts.js';
import type { Config } from './config.js';
import { Database } from './db.js';
import { digest } from './content.js';
import { AppError, requireCondition } from './errors.js';
import type { Actor } from './service.js';
import {memberPermissions,type ClerkTeam} from './team.js';
import type { PendingInvitation } from '../shared/team.js';
import {clerkInvitationPilot} from './team-invitation-provider.js';

type ClerkOrganizations = ReturnType<typeof createClerkClient>['organizations'];
export async function pendingClerkInvitations(directory: Pick<ClerkOrganizations,'getOrganizationInvitationList'>, workspace: string, offset: number, limit: number) {
  const page = await directory.getOrganizationInvitationList({ organizationId: workspace, status: ['pending'], offset, limit });
  if (page.data.length > limit) throw Error('Invalid invitation page.');
  const invitations: PendingInvitation[] = page.data.map((row) => {
    if (row.organizationId !== workspace || row.status !== 'pending' || !row.id || !row.emailAddress ||
        !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= 0)
      throw Error('Invalid invitation in the workspace directory.');
    return { id: row.id, email: row.emailAddress, expiresAt: new Date(row.expiresAt).toISOString() };
  });
  return { total: page.totalCount, invitations };
}

export type IdentityProvider = {
  session(request: ExpressRequest): Promise<{ userId: string; workspaceId: string }>;
  isOwner(userId: string, workspaceId: string): Promise<boolean>;
  team?:ClerkTeam;
};
export function clerkIdentity(config: Config): IdentityProvider {
  const clerk = createClerkClient({ secretKey: config.clerkSecretKey, publishableKey: config.clerkPublishableKey });
  const team:ClerkTeam={
    invitePilot:config.invitationBinding && config.clerkSecretKey ? clerkInvitationPilot(clerk.organizations, config.invitationBinding,config.clerkSecretKey) : undefined,
    async membership(userId,workspaceId){
      const page=await clerk.organizations.getOrganizationMembershipList({organizationId:workspaceId,userId:[userId],limit:2});
      const member=page.data.find(row=>row.publicUserData?.userId===userId);
      return member?.role==='org:admin'?'owner':member?.role==='org:member'?'member':null;
    },
    async members(workspaceId,offset,limit){
      const page=await clerk.organizations.getOrganizationMembershipList({organizationId:workspaceId,offset,limit,orderBy:'+created_at'});
      return {total:page.totalCount,members:page.data.flatMap(row=>{
        const user=row.publicUserData;
        if(!user?.userId || !['org:admin','org:member'].includes(row.role))return [];
        return [{userId:user.userId,name:[user.firstName,user.lastName].filter(Boolean).join(' ')||'Workspace member',
          membership:row.role==='org:admin'?'owner' as const:'member' as const}];
      })};
    },
    invitations: (workspace,offset,limit) => pendingClerkInvitations(clerk.organizations,workspace,offset,limit),
  };
  return {
    team,
    async session(request) {
      const headers = new Headers();
      // The browser supplies an explicit Clerk bearer token. Never accept ambient cookies as API authority.
      headers.set('authorization', request.get('authorization') ?? '');
      const origin = request.get('origin') ?? config.origin;
      requireCondition(config.browserOrigins.includes(origin), 403, 'origin_rejected', 'This browser origin is not authorized.');
      const state = await clerk.authenticateRequest(new Request(origin + request.originalUrl, { headers }), { authorizedParties: config.browserOrigins, acceptsToken: 'session_token' });
      const auth = state.toAuth();
      requireCondition(auth?.userId, 401, 'sign_in_required', 'Sign in to continue.');
      requireCondition(auth.orgId, 403, 'workspace_required', 'Select or create a workspace in the account menu.');
      const session = await clerk.sessions.getSession(auth.sessionId);
      requireCondition(session.status === 'active' && session.userId === auth.userId, 401, 'session_revoked', 'Sign in again to continue.');
      return { userId: auth.userId, workspaceId: auth.orgId };
    },
    async isOwner(userId, workspaceId) {
      return (await team.membership(userId,workspaceId))==='owner';
    },
  };
}
export function localIdentity(): IdentityProvider {
  return {
    team:{async membership(user,w){return user==='local_owner'&&w==='org_local_sample'?'owner':null;},
      async members(w,offset){return {total:w==='org_local_sample'?1:0,members:w==='org_local_sample'&&offset===0?[{userId:'local_owner',name:'Local owner',membership:'owner'}]:[]};},
      async invitations(){return {total:0,invitations:[]};}},
    async session(request) {
      requireCondition(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? ''), 403, 'loopback_required', 'Local identity requires loopback access.');
      requireCondition(request.get('authorization') === 'Bearer local-development-only', 401, 'sign_in_required', 'The local development session is required.');
      return { userId: 'local_owner', workspaceId: 'org_local_sample' };
    },
    async isOwner(user, workspace) { return user === 'local_owner' && workspace === 'org_local_sample'; },
  };
}
export class Authenticator {
  constructor(readonly db: Database, readonly identity: IdentityProvider) {}
  async authenticate(request: ExpressRequest): Promise<Actor> {
    const authorization = request.get('authorization') ?? '';
    requireCondition(authorization.startsWith('Bearer ') && authorization.length < 8192, 401, 'sign_in_required', 'A valid bearer credential is required.');
    const token = authorization.slice(7);
    if (token.startsWith('flk_')) {
      const match = /^flk_([A-Za-z0-9_-]{1,256})\.([A-Za-z0-9_-]{43})$/.exec(token);
      requireCondition(match, 401, 'invalid_connection', 'The connection is invalid, expired or revoked.');
      const workspaceId = Buffer.from(match[1]!, 'base64url').toString('utf8');
      requireCondition(/^org_[A-Za-z0-9_-]{1,120}$/.test(workspaceId), 401, 'invalid_connection', 'The connection is invalid.');
      const row = await this.db.tenant(workspaceId, async sql => (await sql.query<{ id: string; issuer_id: string; scopes: Capability[]; brand_ids: string[] }>('SELECT id,issuer_id,scopes,brand_ids FROM connections WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()', [digest(token)])).rows[0]);
      requireCondition(row, 401, 'invalid_connection', 'The connection is invalid, expired or revoked.');
      if (row.scopes.includes('subscriber:signup')) {
        requireCondition(row.scopes.length===1 && row.brand_ids.length===1,401,'invalid_connection','The connection is invalid, expired or revoked.');
      }
      requireCondition(await this.identity.isOwner(row.issuer_id, workspaceId), 403, 'membership_revoked', 'The connection owner no longer has workspace authority.');
      return { workspaceId, userId: row.issuer_id, actorId: `connection:${row.id}`, kind: 'connection', owner: true, scopes: row.scopes, brandIds: row.brand_ids };
    }
    const identity = await this.identity.session(request);
    let role:'owner'|'member'|null;
    try {role=this.identity.team?await this.identity.team.membership(identity.userId,identity.workspaceId):await this.identity.isOwner(identity.userId,identity.workspaceId)?'owner':null;}
    catch { throw new AppError(503, 'membership_unavailable', 'Current workspace membership could not be verified. Retry shortly.'); }
    requireCondition(role,403,'membership_required','Current Clerk workspace membership is required.');
    if(role==='member'){
      const access=await this.db.tenant(identity.workspaceId,sql=>memberPermissions(sql,identity.workspaceId,identity.userId,this.identity.team!));
      return {...identity,actorId:'user:'+identity.userId,owner:false,kind:'session',...access};
    }
    return { ...identity, actorId: `user:${identity.userId}`, owner:true, kind: 'session', scopes: ['read', 'draft:write', 'assets:write', 'audience:summary','campaign:rehearse','campaign:simulate'], brandIds: null };
  }
}
