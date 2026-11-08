import {lockWorkspace} from './workspace-lock.js';
import { randomUUID } from 'node:crypto';
import type { Database, Sql } from './db.js';
import { digest } from './content.js';
import { AppError, requireCondition } from './errors.js';
import type { InvitationOutcome, InvitationPilot } from '../shared/team.js';
import type { Actor } from './service.js';
import type { ClerkTeam } from './team.js';
import type { ClerkInvitationPilot, IssuedInvitation } from './team-invitation-provider.js';

const intentActor = 'system:team-invite:intent';
const receiptActor = 'system:team-invite:receipt';
const addressDigest = (workspace:string,email:string) => digest(JSON.stringify([workspace,email]));
type Intent = { emailHash: string; operationKey: string; issuer: string; reference: string };
type Record = { intent: Intent; receipt: { id: string; state: IssuedInvitation['state'] } | null };
const uncertain = (operationKey: string): InvitationOutcome => ({
  operationKey,
  state: 'awaiting_reconciliation',
});
const outcome = ({ intent, receipt }: Record): InvitationOutcome =>
  receipt ? { operationKey: intent.operationKey, state: receipt.state } : uncertain(intent.operationKey);
const unavailable = () =>
  new AppError(503, 'invitation_capacity_unavailable', 'Clerk invitation capacity could not be verified.');
async function records(sql: Sql): Promise<Record[]> {
  const rows = (
    await sql.query<Record>(
      `
    SELECT i.result AS intent,r.result AS receipt FROM operations i LEFT JOIN operations r ON
    r.workspace_id=i.workspace_id AND r.actor_id=$2 AND r.operation_key=i.operation_key
    WHERE i.actor_id=$1 ORDER BY i.operation_key LIMIT 501`,
      [intentActor, receiptActor],
    )
  ).rows;
  if (rows.length > 500) throw unavailable();
  return rows;
}
export async function invitationControls(
  sql: Sql,
  workspace: string,
  clerk: ClerkTeam,
  seats: number | null,
  capacity?: Capacity,
): Promise<InvitationPilot | undefined> {
  const binding = clerk.invitePilot?.binding;
  if (binding?.workspace !== workspace || !capacity) return;
  const tracked = await records(sql);
  return {
    reserved: heldSeats(tracked,capacity,workspace),
    maximum: capacity.maximum, blocked: invalidMaximum(capacity,seats),
    choices: binding.recipients.map((email) => {
      const prior = tracked.find(({ intent }) => intent.emailHash === addressDigest(workspace,email));
      return { email, prior: prior ? outcome(prior) : null };
    }),
  };
}
async function currentOwner(clerk: ClerkTeam, actor: Actor) {
  let membership;
  try {
    membership = await clerk.membership(actor.userId, actor.workspaceId);
  } catch {
    throw unavailable();
  }
  requireCondition(
    actor.kind === 'session' && actor.owner && membership === 'owner',
    403,
    'owner_required',
    'Use a current workspace owner session.',
  );
}
function existing(rows: Record[], emailHash: string, key: string) {
  const byKey = rows.find(({ intent }) => intent.operationKey === key);
  requireCondition(
    !byKey || byKey.intent.emailHash === emailHash,
    409,
    'operation_conflict',
    'This invitation key belongs to another address.',
  );
  return byKey ?? rows.find(({ intent }) => intent.emailHash === emailHash);
}
function match(intent: Intent, workspace: string, rows: IssuedInvitation[]): IssuedInvitation | undefined {
  const candidates = rows.filter((row) => row.reference === intent.reference);
  const row = candidates[0];
  if (
    candidates.length === 1 &&
    row &&
    row.workspace === workspace &&
    row.role === 'org:member' &&
    addressDigest(workspace,row.email) === intent.emailHash
  )
    return row;
}
type Capacity = Awaited<ReturnType<ClerkInvitationPilot['inspect']>>;
function invalidMaximum(cap:Capacity,seats:number|null) {
  return seats !== null && (cap.maximum < 1 || cap.maximum > seats);
}
function heldSeats(rows:Record[],cap:Capacity,workspace:string,ownKey?:string) {
  return rows.filter(({ intent, receipt }) => {
    if (intent.operationKey === ownKey) return false;
    const seen = match(intent, workspace, cap.invitations);
    if (!seen || (receipt && seen.id !== receipt.id)) return true;
    return seen.state === 'accepted' && !cap.members.includes(seen.email);
  }).length;
}
function verifyCapacity(
  cap: Capacity,
  rows: Record[],
  workspace: string,
  email: string,
  seats: number | null,
  operationKey: string,
) {
  if (invalidMaximum(cap,seats))
    throw new AppError(
      409,
      'clerk_seat_limit_required',
      'Clerk must enforce this workspace’s finite seat allowance before invitations.',
    );
  requireCondition(
    !cap.members.includes(email) && !cap.invitations.some((i) => i.state === 'pending' && i.email === email),
    409,
    'invitation_exists',
    'This address already has a membership or pending Clerk invitation.',
  );
  const held = heldSeats(rows,cap,workspace,operationKey);
  const pending = cap.invitations.filter((i) => i.state === 'pending').length;
  const ceiling = cap.maximum === 0 ? seats : seats === null ? cap.maximum : Math.min(seats, cap.maximum);
  requireCondition(
    ceiling === null || cap.members.length + pending + held < ceiling,
    409,
    'seat_limit',
    'Members, pending invitations and unresolved requests use all available seats.',
  );
}
async function recordReceipt(db: Database, actor: Actor, intent: Intent, evidence: IssuedInvitation) {
  return db.tenant(actor.workspaceId, async (sql) => {
    await lockWorkspace(sql,actor.workspaceId);
    const stored = existing(await records(sql), intent.emailHash, intent.operationKey);
    if (
      !stored ||
      stored.intent.reference !== intent.reference ||
      (stored.receipt && stored.receipt.id !== evidence.id)
    )
      throw Error('Invitation evidence does not match the durable operation.');
    if (stored.receipt) return outcome(stored);
    await sql.query(
      'INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4,$5)',
      [
        actor.workspaceId,
        receiptActor,
        intent.operationKey,
        intent.emailHash,
        { id: evidence.id, state: evidence.state },
      ],
    );
    await sql.query('INSERT INTO audit(workspace_id,id,actor_id,action,resource_id) VALUES($1,$2,$3,$4,$5)', [
      actor.workspaceId,
      randomUUID(),
      actor.actorId,
      'team.invite.recorded',
      intent.operationKey,
    ]);
    return { operationKey: intent.operationKey, state: evidence.state };
  });
}
async function reconcile(
  db: Database,
  actor: Actor,
  pilot: ClerkInvitationPilot,
  row: Record,
): Promise<InvitationOutcome> {
  if (row.receipt) return outcome(row);
  try {
    const verified = match(row.intent, actor.workspaceId, await pilot.lookup(actor.workspaceId));
    if (verified) return await recordReceipt(db, actor, row.intent, verified);
  } catch {
    /* A lookup failure leaves the seat reserved. */
  }
  return uncertain(row.intent.operationKey);
}
export async function inviteMember(
  db: Database,
  actor: Actor,
  clerk: ClerkTeam,
  seatLimit: (sql: Sql) => Promise<number | null>,
  email: string,
  key: string,
): Promise<InvitationOutcome> {
  const w = actor.workspaceId,
    pilot = clerk.invitePilot;
  requireCondition(
    pilot && pilot.binding.workspace === w && pilot.binding.recipients.includes(email),
    403,
    'invitation_pilot_disabled',
    'This workspace and address are not enabled for staging invitations.',
  );
  await currentOwner(clerk, actor);
  const emailHash = addressDigest(w,email);
  const saved = await db.tenant(w, async (sql) => existing(await records(sql), emailHash, key));
  if (saved) return reconcile(db, actor, pilot, saved);
  let capacity: Capacity;
  try {
    capacity = await pilot.inspect(w);
  } catch {
    throw unavailable();
  }
  const reservation = await db.tenant(w, async (sql) => {
    await lockWorkspace(sql,w);
    const rows = await records(sql),
      prior = existing(rows, emailHash, key);
    if (prior) return { row: prior, fresh: false };
    requireCondition(
      (await sql.query('SELECT FROM workspaces WHERE workspace_id=$1', [w])).rowCount,
      409,
      'workspace_required',
      'Initialize the workspace before inviting a member.',
    );
    verifyCapacity(capacity, rows, w, email, await seatLimit(sql), key);
    const intent: Intent = { emailHash, operationKey: key, reference: randomUUID(), issuer: actor.userId };
    await sql.query(
      'INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4,$5)',
      [w, intentActor, key, emailHash, intent],
    );
    await sql.query('INSERT INTO audit(workspace_id,id,actor_id,action,resource_id) VALUES($1,$2,$3,$4,$5)', [
      w,
      randomUUID(),
      actor.actorId,
      'team.invite.requested',
      key,
    ]);
    return { row: { intent, receipt: null }, fresh: true };
  });
  if (!reservation.fresh) return reconcile(db, actor, pilot, reservation.row);
  const { intent } = reservation.row;
  // Only this caller received the new reservation. Every later invocation can look up the
  // provider's private reference, including when the original process stopped before its POST.
  try {
    const latest = await pilot.inspect(w);
    await db.tenant(w, async (sql) => {
      await lockWorkspace(sql,w);
      verifyCapacity(latest, await records(sql), w, email, await seatLimit(sql), key);
    });
  } catch {
    return uncertain(intent.operationKey);
  }
  await currentOwner(clerk, actor);
  try {
    const issued = await pilot.create({
      workspace: w,
      email,
      issuer: intent.issuer,
      reference: intent.reference,
    });
    const verified = match(intent, w, [issued]);
    if (verified) return await recordReceipt(db, actor, intent, verified);
  } catch {
    /* A durable intent remains for lookup after an ambiguous response. */
  }
  return reconcile(db, actor, pilot, reservation.row);
}
