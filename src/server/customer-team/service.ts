import { createHash, randomUUID } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import type { Actor } from '../service.js';
import { requireCondition } from '../errors.js';
import {
  customerTeamCommands,
  type TeamLifecycleView,
  type LifecycleMember,
  type LifecycleInvitation,
} from '../../shared/customer-team.js';
import { seatLimit as existingSeatLimit } from '../team.js';

export type TeamDirectory = {
  members: LifecycleMember[];
  invitations: LifecycleInvitation[];
  maximum: number | null;
};
export type TeamAction = 'invite' | 'remove' | 'transfer' | 'revokeInvite';
export type TeamIntent = {
  id: string;
  action: TeamAction;
  payload: Record<string, string>;
  issuer_id: string;
  state: string;
  phase: string;
  reference: string;
  mode: 'exercise' | 'clerk';
  seat_limit: number | null;
};
export interface TeamLifecyclePort {
  inspect(workspace: string): Promise<TeamDirectory>;
  apply(workspace: string, intent: TeamIntent): Promise<void>;
}
export type CustomerTeamOptions = {
  mode: 'exercise' | 'clerk' | 'off';
  checkOwner: (user: string, workspace: string) => Promise<boolean>;
  port?: TeamLifecyclePort;
  seatLimit?: (sql: Sql, workspace: string) => Promise<number | null>;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type TeamContext = Pick<Actor, 'workspaceId' | 'userId' | 'actorId'>;
export class CustomerTeamLifecycle {
  constructor(
    readonly db: Database,
    readonly options: CustomerTeamOptions,
  ) {}
  private async owner(actor: Actor) {
    requireCondition(
      actor.kind === 'session' &&
        actor.owner &&
        (await this.options.checkOwner(actor.userId, actor.workspaceId)),
      403,
      'owner_required',
      'Use a current workspace owner session.',
    );
  }
  private async locked<T>(workspace: string, fn: (sql: Sql) => Promise<T>) {
    return this.db.tenant(workspace, async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [workspace]);
      return fn(sql);
    });
  }
  private async retained(sql: Sql) {
    requireCondition(
      !(await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount,
      410,
      'workspace_erased',
      'This workspace has completed its retention erasure.',
    );
  }
  private async externalMutation(workspace: string, intent: TeamIntent, authorize: () => Promise<void>) {
    return this.locked(workspace, async (sql) => {
      await this.retained(sql);
      await authorize();
      await this.options.port!.apply(workspace, intent);
    });
  }
  private limit(sql: Sql, workspace: string) {
    return this.options.seatLimit ? this.options.seatLimit(sql, workspace) : existingSeatLimit(sql);
  }
  private async scenario(sql: Sql): Promise<TeamDirectory> {
    const members = (
      await sql.query<LifecycleMember>(
        'SELECT user_id AS "userId",email,role FROM customer_team_scenarios ORDER BY created_at,user_id',
      )
    ).rows;
    const invitations = (
      await sql.query<LifecycleInvitation>(
        'SELECT id,email,state,reference FROM customer_team_invites ORDER BY created_at,id',
      )
    ).rows;
    return { members, invitations, maximum: null };
  }
  private verify(
    actor: Actor,
    action: TeamAction,
    payload: Record<string, string>,
    directory: TeamDirectory,
    limit: number | null,
    reserved = 0,
  ) {
    const members = directory.members,
      owners = members.filter((m) => m.role === 'owner'),
      target = members.find((m) => m.userId === payload.userId);
    if (action === 'invite') {
      requireCondition(
        !members.some((m) => m.email.toLowerCase() === payload.email?.toLowerCase()) &&
          !directory.invitations.some(
            (i) => i.state === 'pending' && i.email.toLowerCase() === payload.email?.toLowerCase(),
          ),
        409,
        'invitation_exists',
        'This address already has membership or a pending invitation.',
      );
      const capacity =
        directory.members.length +
        directory.invitations.filter((i) => i.state === 'pending').length +
        reserved;
      requireCondition(
        limit === null || capacity < limit,
        409,
        'seat_limit',
        'Pending invitations and members fill the plan allowance.',
      );
      if (this.options.mode === 'clerk' && limit !== null)
        requireCondition(
          directory.maximum !== null && directory.maximum > 0 && directory.maximum <= limit,
          409,
          'provider_seat_limit',
          'Configure Clerk to enforce the plan seat limit.',
        );
    } else if (action === 'remove') {
      requireCondition(target, 404, 'member_unavailable', 'This member is unavailable.');
      requireCondition(
        target.userId !== actor.userId,
        409,
        'transfer_required',
        'Transfer ownership before removing your own membership.',
      );
      requireCondition(
        target.role !== 'owner' || owners.length > 1,
        409,
        'last_owner',
        'The workspace must retain an owner.',
      );
    } else if (action === 'transfer') {
      requireCondition(
        target && target.userId !== actor.userId,
        409,
        'member_required',
        'Choose another current member as the new owner.',
      );
      if (this.options.mode === 'clerk')
        requireCondition(
          owners.some((m) => m.userId === actor.userId),
          403,
          'owner_required',
          'Current owner membership is required.',
        );
    } else {
      requireCondition(
        directory.invitations.some((i) => i.id === payload.id && i.state === 'pending'),
        404,
        'invitation_unavailable',
        'This pending invitation is unavailable.',
      );
    }
  }
  private async status(actor: Actor): Promise<TeamLifecycleView> {
    requireCondition(
      this.options.mode !== 'clerk' || this.options.port,
      503,
      'team_provider_required',
      'Configure the Clerk lifecycle provider.',
    );
    const [directory, local] = await Promise.all([
      this.options.mode === 'clerk' && this.options.port
        ? this.options.port.inspect(actor.workspaceId)
        : this.db.tenant(actor.workspaceId, (sql) => this.scenario(sql)),
      this.db.tenant(actor.workspaceId, async (sql) => ({
        limit: await this.limit(sql, actor.workspaceId),
        operations: (
          await sql.query<{ id: string; action: string; state: string }>(
            'SELECT id,action,state FROM customer_team_intents WHERE mode=$1 ORDER BY created_at DESC LIMIT 50',
            [this.options.mode],
          )
        ).rows,
      })),
    ]);
    return {
      mode: this.options.mode,
      initialized: directory.members.length > 0,
      members: directory.members,
      invitations: directory.invitations,
      operations: local.operations,
      seatLimit: local.limit,
    };
  }
  async execute(name: string, raw: unknown, actor: Actor): Promise<unknown> {
    if (!(name in customerTeamCommands)) return undefined;
    await this.owner(actor);
    const definition = customerTeamCommands[name as keyof typeof customerTeamCommands];
    const input = definition.schema.parse(raw) as Record<string, string>;
    if (name === 'teamLifecycle.status') return this.status(actor);
    requireCondition(
      this.options.mode !== 'off',
      503,
      'team_disabled',
      'Team lifecycle operations are disabled.',
    );
    requireCondition(
      this.options.mode !== 'clerk' || this.options.port,
      503,
      'team_provider_required',
      'Configure the Clerk lifecycle provider.',
    );
    if (name === 'teamLifecycle.initializeExercise') {
      requireCondition(
        this.options.mode === 'exercise',
        403,
        'exercise_only',
        'Use Clerk onboarding for a real team.',
      );
      return this.locked(actor.workspaceId, async (sql) => {
        await sql.query(
          `INSERT INTO customer_team_scenarios(workspace_id,user_id,email,role)
          SELECT $1,$2,'owner@exercise.test','owner' WHERE NOT EXISTS(SELECT FROM customer_team_scenarios)
          ON CONFLICT DO NOTHING`,
          [actor.workspaceId, actor.userId],
        );
        return { initialized: true, mode: 'exercise' };
      });
    }
    if (name === 'teamLifecycle.exerciseAccept') {
      requireCondition(
        this.options.mode === 'exercise',
        403,
        'exercise_only',
        'Accept real invitations through Clerk.',
      );
      return this.locked(actor.workspaceId, async (sql) => {
        const invitation = (
          await sql.query<{ email: string; state: string; member_id: string | null }>(
            'SELECT email,state,member_id FROM customer_team_invites WHERE id=$1 FOR UPDATE',
            [input.id],
          )
        ).rows[0];
        requireCondition(
          invitation && invitation.state !== 'revoked',
          404,
          'invitation_unavailable',
          'This invitation is unavailable.',
        );
        if (invitation.state === 'accepted')
          return { accepted: true, mode: 'exercise', userId: invitation.member_id };
        const directory = await this.scenario(sql),
          limit = await this.limit(sql, actor.workspaceId);
        requireCondition(
          limit === null || directory.members.length < limit,
          409,
          'seat_limit',
          'The plan has no remaining seat.',
        );
        const userId = 'exercise_' + randomUUID().replaceAll('-', '');
        await sql.query(
          "INSERT INTO customer_team_scenarios(workspace_id,user_id,email,role) VALUES($1,$2,$3,'member')",
          [actor.workspaceId, userId, invitation.email],
        );
        await sql.query("UPDATE customer_team_invites SET state='accepted',member_id=$2 WHERE id=$1", [
          input.id,
          userId,
        ]);
        return { accepted: true, mode: 'exercise', userId };
      });
    }
    if (name === 'teamLifecycle.reconcile') {
      const intent = await this.db.tenant(
        actor.workspaceId,
        async (sql) =>
          (await sql.query<TeamIntent>('SELECT * FROM customer_team_intents WHERE id=$1', [input.id]))
            .rows[0],
      );
      requireCondition(intent, 404, 'operation_unavailable', 'This team operation is unavailable.');
      requireCondition(
        intent.mode === this.options.mode,
        409,
        'operation_mode_changed',
        'This operation belongs to a different team mode.',
      );
      if (this.options.mode === 'exercise') return { id: intent.id, state: intent.state, mode: 'exercise' };
      return this.reconcile(actor, intent, () => this.owner(actor));
    }
    const action = name.slice('teamLifecycle.'.length) as TeamAction;
    const payload = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'operationKey'));
    const hash = digest(JSON.stringify([action, payload]));
    const inspected =
      this.options.mode === 'clerk' && this.options.port
        ? await this.options.port.inspect(actor.workspaceId)
        : undefined;
    const reservation = await this.locked(actor.workspaceId, async (sql) => {
      await this.owner(actor);
      if (this.options.mode === 'clerk') await this.retained(sql);
      const prior = (
        await sql.query<TeamIntent & { request_hash: string }>(
          'SELECT * FROM customer_team_intents WHERE actor_id=$1 AND operation_key=$2',
          [actor.actorId, input.operationKey],
        )
      ).rows[0];
      if (prior) {
        requireCondition(
          prior.request_hash === hash && prior.mode === this.options.mode,
          409,
          'operation_conflict',
          'Retry the original team request in its original mode.',
        );
        return { intent: prior, fresh: false };
      }
      const directory = inspected ?? (await this.scenario(sql));
      requireCondition(
        directory.members.length > 0,
        422,
        'team_not_initialized',
        'Start the team exercise first.',
      );
      const held = Number(
        (
          await sql.query(
            "SELECT count(*) n FROM customer_team_intents WHERE mode=$1 AND action='invite' AND state IN ('prepared','submitting','uncertain')",
            [this.options.mode],
          )
        ).rows[0].n,
      );
      const maximum = await this.limit(sql, actor.workspaceId);
      this.verify(actor, action, payload, directory, maximum, held);
      const intent: TeamIntent = {
        id: randomUUID(),
        action,
        payload,
        issuer_id: actor.userId,
        state: 'prepared',
        phase: 'initial',
        reference: randomUUID(),
        mode: this.options.mode === 'clerk' ? 'clerk' : 'exercise',
        seat_limit: maximum,
      };
      await sql.query(
        `INSERT INTO customer_team_intents(workspace_id,id,operation_key,actor_id,issuer_id,action,payload,request_hash,state,reference,mode,seat_limit)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'prepared',$9,$10,$11)`,
        [
          actor.workspaceId,
          intent.id,
          input.operationKey,
          actor.actorId,
          actor.userId,
          action,
          JSON.stringify(payload),
          hash,
          intent.reference,
          intent.mode,
          intent.seat_limit,
        ],
      );
      if (this.options.mode === 'exercise') {
        await this.applyExercise(sql, actor, intent);
        await this.finish(sql, actor, intent, 'completed');
        return { intent: { ...intent, state: 'completed' }, fresh: false };
      }
      await sql.query("UPDATE customer_team_intents SET state='submitting' WHERE id=$1", [intent.id]);
      return { intent: { ...intent, state: 'submitting' }, fresh: true };
    });
    if (this.options.mode === 'exercise')
      return { id: reservation.intent.id, state: reservation.intent.state, mode: 'exercise' };
    requireCondition(
      this.options.port,
      503,
      'team_provider_required',
      'Configure the Clerk lifecycle provider.',
    );
    if (reservation.fresh) {
      try {
        await this.externalMutation(actor.workspaceId, reservation.intent, () => this.owner(actor));
      } catch {
        /* Resolve by reading the same provider reference. */
      }
    }
    return this.reconcile(actor, reservation.intent, () => this.owner(actor));
  }
  private async applyExercise(sql: Sql, actor: Actor, intent: TeamIntent) {
    const { action, payload } = intent;
    if (action === 'invite')
      await sql.query(
        "INSERT INTO customer_team_invites(workspace_id,id,email,state,reference) VALUES($1,$2,$3,'pending',$4)",
        [actor.workspaceId, randomUUID(), payload.email, intent.reference],
      );
    else if (action === 'remove')
      await sql.query('DELETE FROM customer_team_scenarios WHERE user_id=$1', [payload.userId]);
    else if (action === 'revokeInvite')
      await sql.query("UPDATE customer_team_invites SET state='revoked' WHERE id=$1", [payload.id]);
    else {
      await sql.query("UPDATE customer_team_scenarios SET role='owner' WHERE user_id=$1", [payload.userId]);
      await sql.query("UPDATE customer_team_scenarios SET role='member' WHERE user_id=$1", [actor.userId]);
    }
  }
  private async finish(sql: Sql, actor: TeamContext, intent: TeamIntent, state: string) {
    await sql.query('UPDATE customer_team_intents SET state=$2,updated_at=now() WHERE id=$1', [
      intent.id,
      state,
    ]);
    await sql.query('INSERT INTO audit(workspace_id,id,actor_id,action,resource_id) VALUES($1,$2,$3,$4,$5)', [
      actor.workspaceId,
      randomUUID(),
      actor.actorId,
      'teamLifecycle.' + intent.action,
      intent.id,
    ]);
    // Real revocation cannot leave the brand projection authorizing a removed member.
    if (state === 'completed' && intent.action === 'remove' && intent.mode === 'clerk') {
      await sql.query('DELETE FROM team_grant_brands WHERE user_id=$1', [intent.payload.userId]);
      await sql.query('DELETE FROM team_grants WHERE user_id=$1', [intent.payload.userId]);
    }
  }
  async tickWorkspace(workspace: string) {
    if (this.options.mode !== 'clerk' || !this.options.port) return { processed: 0 };
    const intents = await this.db.tenant(
      workspace,
      async (sql) =>
        (
          await sql.query<TeamIntent>(
            "SELECT * FROM customer_team_intents WHERE mode='clerk' AND state IN ('submitting','uncertain') ORDER BY created_at LIMIT 20",
          )
        ).rows,
    );
    for (const intent of intents) {
      const context: TeamContext = {
        workspaceId: workspace,
        userId: intent.issuer_id,
        actorId: 'worker:team-reconciliation',
      };
      await this.reconcile(context, intent, async () => {
        requireCondition(
          await this.options.checkOwner(intent.issuer_id, workspace),
          403,
          'owner_required',
          'The original issuer must still own this workspace before another transfer phase.',
        );
      });
    }
    return { processed: intents.length };
  }
  private async reconcile(actor: TeamContext, intent: TeamIntent, authorize: () => Promise<void>) {
    if (intent.state === 'completed' || intent.state === 'rejected')
      return { id: intent.id, state: intent.state, mode: this.options.mode };
    const port = this.options.port;
    requireCondition(port, 503, 'team_provider_required', 'Configure Clerk lifecycle access.');
    let verified = false;
    try {
      const directory = await port.inspect(actor.workspaceId);
      if (intent.action === 'invite')
        verified = directory.invitations.some(
          (i) => i.reference === intent.reference && i.email === intent.payload.email,
        );
      if (intent.action === 'remove')
        verified = !directory.members.some((m) => m.userId === intent.payload.userId);
      if (intent.action === 'revokeInvite')
        verified = !directory.invitations.some((i) => i.id === intent.payload.id && i.state === 'pending');
      if (intent.action === 'transfer') {
        const successor = directory.members.some(
          (m) => m.userId === intent.payload.userId && m.role === 'owner',
        );
        verified =
          successor && directory.members.some((m) => m.userId === intent.issuer_id && m.role === 'member');
        if (
          successor &&
          !verified &&
          directory.members.some((m) => m.userId === intent.issuer_id && m.role === 'owner')
        ) {
          const advance = await this.locked(actor.workspaceId, async (sql) => {
            if ((await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount) return 0;
            return (
              await sql.query(
                "UPDATE customer_team_intents SET phase='demoting',updated_at=now() WHERE id=$1 AND phase='initial' AND state IN ('submitting','uncertain') RETURNING id",
                [intent.id],
              )
            ).rowCount;
          });
          if (advance) {
            try {
              await this.externalMutation(actor.workspaceId, { ...intent, phase: 'demoting' }, authorize);
            } catch {
              /* A later inspection reconciles this phase. */
            }
            const updated = await port.inspect(actor.workspaceId);
            verified =
              updated.members.some((m) => m.userId === intent.payload.userId && m.role === 'owner') &&
              updated.members.some((m) => m.userId === intent.issuer_id && m.role === 'member');
          }
        }
      }
    } catch {
      /* A failed lookup cannot establish success. */
    }
    return this.locked(actor.workspaceId, async (sql) => {
      const current = (
        await sql.query<{ state: string }>('SELECT state FROM customer_team_intents WHERE id=$1 FOR UPDATE', [
          intent.id,
        ])
      ).rows[0];
      if (current?.state === 'completed')
        return { id: intent.id, state: 'completed', mode: this.options.mode };
      const state = verified ? 'completed' : 'uncertain';
      await this.finish(sql, actor, intent, state);
      return { id: intent.id, state, mode: this.options.mode };
    });
  }
}
export const customerTeamTables = [
  {
    name: 'customer_team_scenarios',
    scope: 'workspace',
    permissions: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  },
  { name: 'customer_team_invites', scope: 'workspace', permissions: ['SELECT', 'INSERT', 'UPDATE'] },
  { name: 'customer_team_intents', scope: 'workspace', permissions: ['SELECT', 'INSERT', 'UPDATE'] },
] as const;
