import { createClerkClient } from '@clerk/backend';
import type { Request as ExpressRequest } from 'express';
import type { Capability } from '../shared/contracts.js';
import type { Config } from './config.js';
import { Database } from './db.js';
import { digest } from './content.js';
import { AppError, requireCondition } from './errors.js';
import type { Actor } from './service.js';

export type IdentityProvider = {
  session(request: ExpressRequest): Promise<{ userId: string; workspaceId: string }>;
  isOwner(userId: string, workspaceId: string): Promise<boolean>;
};
export function clerkIdentity(config: Config): IdentityProvider {
  const clerk = createClerkClient({ secretKey: config.clerkSecretKey, publishableKey: config.clerkPublishableKey });
  return {
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
      const memberships = await clerk.organizations.getOrganizationMembershipList({ organizationId: workspaceId, userId: [userId], limit: 2 });
      return memberships.data.some(m => m.publicUserData?.userId === userId && m.role === 'org:admin');
    },
  };
}
export function localIdentity(): IdentityProvider {
  return {
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
    let owner: boolean;
    try { owner = await this.identity.isOwner(identity.userId, identity.workspaceId); }
    catch { throw new AppError(503, 'membership_unavailable', 'Current workspace membership could not be verified. Retry shortly.'); }
    requireCondition(owner, 403, 'owner_required', 'This foundation is available to workspace owners. Member roles will be added with explicit brand permissions.');
    return { ...identity, actorId: `user:${identity.userId}`, owner, kind: 'session', scopes: ['read', 'draft:write', 'assets:write'], brandIds: null };
  }
}
