import type { Sql } from './db.js';
import { AppError, requireCondition } from './errors.js';
import { workspaceAccess } from './campaign/access.js';
import { plans, type Capability } from '../shared/contracts.js';
import type { TeamPage, TeamRole, DirectoryMember } from '../shared/team.js';

export type ClerkTeam = {
  members: (
    workspace: string,
    offset: number,
    limit: number,
  ) => Promise<{ total: number; members: Pick<DirectoryMember, 'userId' | 'name' | 'membership'>[] }>;
  membership: (user: string, workspace: string) => Promise<'owner' | 'member' | null>;
};
export const unavailableTeam: ClerkTeam = {
  async members() {
    throw new AppError(503, 'membership_unavailable', 'The current Clerk team could not be verified.');
  },
  async membership() {
    throw new AppError(503, 'membership_unavailable', 'The current Clerk membership could not be verified.');
  },
};
export async function seatLimit(sql: Sql) {
  const access = await workspaceAccess(sql);
  if (!access.plan) return 1;
  return plans.find((p) => p.id === access.plan)!.users;
}
export async function teamPage(sql: Sql, w: string, clerk: ClerkTeam, offset: number): Promise<TeamPage> {
  const limit = 25,
    page = await clerk.members(w, offset, limit),
    seats = await seatLimit(sql);
  const records = (
    await sql.query<{ user_id: string; permission: TeamRole; brand_ids: string[] }>(
      `SELECT g.user_id,g.permission,
    array_agg(b.brand_id ORDER BY b.brand_id) brand_ids FROM team_grants g JOIN team_grant_brands b USING(workspace_id,user_id)
    WHERE g.user_id=ANY($1::text[]) GROUP BY g.user_id,g.permission`,
      [page.members.map((m) => m.userId)],
    )
  ).rows;
  const grants = new Map(records.map((row) => [row.user_id, row]));
  return {
    members: page.members.map((m) => ({
      ...m,
      permission: grants.get(m.userId)?.permission ?? null,
      brandIds: grants.get(m.userId)?.brand_ids ?? [],
    })),
    total: page.total,
    offset,
    limit,
    seats,
    overLimit: seats !== null && page.total > seats,
    source: 'clerk',
  };
}
export async function grantMember(
  sql: Sql,
  w: string,
  issuer: string,
  clerk: ClerkTeam,
  user: string,
  permission: TeamRole,
  brandIds: string[],
) {
  requireCondition(
    (await clerk.membership(user, w)) === 'member',
    422,
    'member_required',
    'Select a current non-owner member of this Clerk workspace.',
  );
  const seats = await seatLimit(sql);
  if (seats !== null) {
    const { total } = await clerk.members(w, 0, 1);
    requireCondition(
      total <= seats,
      422,
      'seat_limit',
      'The Clerk membership exceeds this plan’s seat allowance. Review members before granting access.',
    );
  }
  const ids = [...new Set(brandIds)].sort();
  requireCondition(
    (await sql.query('SELECT id FROM brands WHERE id=ANY($1::uuid[])', [ids])).rowCount === ids.length,
    404,
    'brand_unavailable',
    'Choose existing brands in this workspace.',
  );
  await sql.query(
    `INSERT INTO team_grants(workspace_id,user_id,permission,updated_by) VALUES($1,$2,$3,$4)
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET permission=excluded.permission,updated_by=excluded.updated_by,updated_at=now()`,
    [w, user, permission, issuer],
  );
  await sql.query('DELETE FROM team_grant_brands WHERE user_id=$1', [user]);
  await sql.query(
    'INSERT INTO team_grant_brands(workspace_id,user_id,brand_id) SELECT $1,$2,unnest($3::uuid[])',
    [w, user, ids],
  );
  return { userId: user, permission, brandIds: ids };
}
export async function revokeMember(sql: Sql, user: string) {
  const removed = await sql.query('DELETE FROM team_grants WHERE user_id=$1 RETURNING user_id', [user]);
  requireCondition(
    removed.rowCount,
    404,
    'grant_unavailable',
    'There is no current Flockletter grant for this member.',
  );
  return { revoked: true, userId: user };
}
export async function memberPermissions(sql: Sql, w: string, user: string, clerk: ClerkTeam) {
  const row = (
    await sql.query<{ permission: TeamRole; brand_ids: string[] }>(
      `SELECT g.permission,array_agg(b.brand_id ORDER BY b.brand_id) brand_ids
    FROM team_grants g JOIN team_grant_brands b USING(workspace_id,user_id) WHERE g.user_id=$1 GROUP BY g.permission`,
      [user],
    )
  ).rows[0];
  requireCondition(row, 403, 'brand_access_required', 'Ask a workspace owner to grant access to a brand.');
  const seats = await seatLimit(sql);
  if (seats !== null)
    requireCondition(
      (await clerk.members(w, 0, 1)).total <= seats,
      403,
      'seat_limit',
      'The workspace exceeds its seat allowance. An owner can review team access.',
    );
  const scopes: Capability[] =
    row.permission === 'editor' ? ['read', 'draft:write', 'assets:write'] : ['read'];
  return { brandIds: row.brand_ids, scopes };
}
