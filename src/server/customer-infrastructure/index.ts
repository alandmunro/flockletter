import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Sql } from '../db.js';
import type { Actor } from '../service.js';
import { requireCondition } from '../errors.js';
import { senderProfile } from '../customer-delivery/sender.js';
import { parseSesRoute, type SesRoute } from '../campaign/ses-runtime.js';
import { senderDomain } from '../../shared/sender.js';
import {
  customerInfrastructureCommands,
  type InfrastructureStatus,
  type InfrastructurePlan,
  type InfrastructureState,
} from '../../shared/customer-infrastructure.js';
import {
  infrastructureSteps,
  type InfrastructureRequest,
  type InfrastructureOptions,
  type InfrastructureFacts,
  type InfrastructureOutcome,
} from './types.js';
export type {
  InfrastructureOptions,
  InfrastructureRequest,
  InfrastructureFacts,
  InfrastructureOutcome,
  InfrastructureProvider,
  InfrastructureStep,
  InfrastructureApplyContext,
} from './types.js';
type Row = {
  id: string;
  brand_id: string;
  created_by: string;
  mode: 'capture' | 'aws';
  request: InfrastructureRequest;
  request_digest: string;
  source_revision: number;
  source_kind: string;
  state: InfrastructureState;
  version: number;
  attempts: number;
  step: string;
  step_attempts: number;
  reason: string | null;
  cancel_requested: boolean;
  facts: InfrastructureFacts | null;
  created_at: Date;
  updated_at: Date;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const factSchema = z
  .object({
    operationKey: z.uuid(),
    domain: z.string().max(253),
    fromEmail: z.email(),
    captured: z.boolean(),
    verified: z.boolean(),
    blockers: z
      .array(z.string().regex(/^[a-z0-9_:-]{1,100}$/))
      .max(20)
      .optional(),
    route: z
      .object({
        region: z.string().max(80).optional(),
        accountId: z.string().max(80).optional(),
        tenant: z.string().max(128).optional(),
        configurationSet: z.string().max(128).optional(),
        from: z.email().optional(),
        identityArn: z.string().max(512).optional(),
        topicArn: z.string().max(512).optional(),
      })
      .strict(),
    progress: z
      .object({
        nextStep: z.enum(infrastructureSteps).nullable(),
        completed: z.array(z.enum(infrastructureSteps)).max(9),
        dnsPending: z.boolean(),
      })
      .strict(),
    dns: z
      .array(
        z
          .object({
            type: z.enum(['TXT', 'CNAME', 'MX']),
            name: z.string().min(1).max(512),
            value: z.string().min(1).max(2048),
            priority: z.number().int().min(0).max(65535).optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export class CustomerInfrastructure {
  constructor(
    readonly db: Database,
    readonly options: InfrastructureOptions,
  ) {
    requireCondition(
      !(options.mode === 'capture' && options.environment === 'production'),
      503,
      'infrastructure_exercise_forbidden',
      'Captured infrastructure cannot run in production.',
    );
  }
  private async owner(actor: Actor) {
    requireCondition(
      actor.kind === 'session' &&
        actor.owner &&
        (await this.options.isOwner(actor.userId, actor.workspaceId)),
      403,
      'owner_required',
      'Use the current workspace owner session.',
    );
  }
  private async scope(sql: Sql, workspace: string, brand: string) {
    requireCondition(
      !(await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount,
      410,
      'workspace_erased',
      'An erased account requires protected restore reconciliation.',
    );
    requireCondition(
      (await sql.query('SELECT FROM brands WHERE id=$1', [brand])).rowCount,
      404,
      'brand_unavailable',
      'This brand is unavailable.',
    );
    await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [brand]);
  }
  private async locked<T>(workspace: string, fn: (sql: Sql) => Promise<T>) {
    return this.db.tenant(workspace, async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [workspace]);
      return fn(sql);
    });
  }
  private binding() {
    return this.options.mode === 'capture'
      ? 'capture-infrastructure-v1'
      : (this.options.provider?.binding ?? 'unconfigured');
  }
  private async event(sql: Sql, workspace: string, id: string, event: string, actor: string) {
    await sql.query(
      'INSERT INTO customer_infrastructure_events(workspace_id,id,intent_id,actor_id,event) VALUES($1,$2,$3,$4,$5)',
      [workspace, randomUUID(), id, actor, event],
    );
    await sql.query('INSERT INTO audit(workspace_id,id,actor_id,action) VALUES($1,$2,$3,$4)', [
      workspace,
      randomUUID(),
      actor,
      'infrastructure.' + event,
    ]);
  }
  private async mutate(
    actor: Actor,
    name: string,
    input: { operationKey: string; brandId: string },
    fn: (sql: Sql) => Promise<{ id: string }>,
  ) {
    return this.locked(actor.workspaceId, async (sql) => {
      await this.scope(sql, actor.workspaceId, input.brandId);
      const key = 'infrastructure:' + actor.actorId,
        hash = digest([name, input]);
      const old = (
        await sql.query<{ request_hash: string; result: { id: string } }>(
          'SELECT request_hash,result FROM operations WHERE actor_id=$1 AND operation_key=$2',
          [key, input.operationKey],
        )
      ).rows[0];
      if (old) {
        requireCondition(
          old.request_hash === hash,
          409,
          'operation_conflict',
          'Retry the original infrastructure action.',
        );
        return { ...old.result, replayed: true };
      }
      const result = await fn(sql);
      await sql.query(
        'INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4,$5)',
        [actor.workspaceId, key, input.operationKey, hash, result],
      );
      await this.event(sql, actor.workspaceId, result.id, name.split('.')[1]!, actor.actorId);
      return { ...result, replayed: false };
    });
  }
  private async row(sql: Sql, id: string, brand: string, version?: number) {
    const row = (
      await sql.query<Row>(
        'SELECT * FROM customer_infrastructure_intents WHERE id=$1 AND brand_id=$2 FOR UPDATE',
        [id, brand],
      )
    ).rows[0];
    requireCondition(row, 404, 'infrastructure_plan_unavailable', 'This infrastructure plan is unavailable.');
    requireCondition(
      version === undefined || row.version === version,
      409,
      'version_conflict',
      'Reload the current infrastructure plan.',
    );
    return row;
  }
  private async eligibility(sql: Sql, workspace: string) {
    if (this.options.eligibilitySql) return this.options.eligibilitySql(sql, workspace);
    requireCondition(
      this.options.mode === 'capture',
      503,
      'infrastructure_billing_unavailable',
      'Locked billing verification is required for provider changes.',
    );
    return this.options.eligibility(workspace);
  }
  private view(row: Row): InfrastructurePlan {
    const facts = row.facts;
    return {
      id: row.id,
      brandId: row.brand_id,
      mode: row.mode,
      domain: row.request.domain,
      fromEmail: row.request.fromEmail,
      senderRevision: row.request.senderRevision,
      state: row.state,
      version: row.version,
      reviewDigest: row.request_digest,
      attempts: row.attempts,
      retryable:
        row.state === 'held' && row.step_attempts === 0 && row.attempts < 27 && !row.cancel_requested,
      reason: row.reason,
      captured: facts?.captured ?? row.mode === 'capture',
      verified: row.state === 'verified' && facts?.verified === true && row.mode === 'aws',
      dns: facts?.dns ?? [],
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      resources: facts
        ? {
            tenant: facts.route.tenant ?? '',
            configurationSet: facts.route.configurationSet ?? '',
            identityArn: facts.route.identityArn ?? '',
            topicArn: facts.route.topicArn ?? '',
          }
        : null,
    };
  }
  async status(workspace: string, brand: string): Promise<InfrastructureStatus> {
    return this.db.tenant(workspace, async (sql) => {
      await this.scope(sql, workspace, brand);
      const rows = (
        await sql.query<Row>(
          'SELECT * FROM customer_infrastructure_intents WHERE brand_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25',
          [brand],
        )
      ).rows;
      const eligibility = await this.eligibility(sql, workspace);
      return {
        mode: this.options.mode,
        profile: await senderProfile(sql, brand),
        eligible: eligibility.eligible,
        plans: rows.map((row) => this.view(row)),
        providerConfigured: this.options.mode === 'capture' || !!this.options.provider,
        budgetApprovalRequired: this.options.mode === 'aws',
        externalChangesEnabled:
          this.options.mode === 'aws' && !!this.options.provider && !!this.options.budgetPermit,
      };
    });
  }
  async execute(name: string, raw: unknown, actor: Actor): Promise<InfrastructureStatus> {
    await this.owner(actor);
    requireCondition(
      name in customerInfrastructureCommands,
      404,
      'unknown_command',
      'Unknown infrastructure action.',
    );
    const definition = customerInfrastructureCommands[name as keyof typeof customerInfrastructureCommands];
    const input = definition.schema.parse(raw) as {
      operationKey: string;
      brandId: string;
      id: string;
      expectedVersion: number;
      senderRevision: number;
      reviewDigest: string;
    };
    if (name === 'infrastructure.status') return this.status(actor.workspaceId, input.brandId);
    requireCondition(
      this.options.mode !== 'off',
      503,
      'infrastructure_unavailable',
      'Sender infrastructure setup is not configured.',
    );
    if (name === 'infrastructure.process') {
      const receipt = await this.mutate(actor, name, input, async (sql) => {
        await this.row(sql, input.id, input.brandId);
        return { id: input.id };
      });
      if (!receipt.replayed) await this.process(actor.workspaceId, input.id);
      return this.status(actor.workspaceId, input.brandId);
    }
    await this.mutate(actor, name, input, async (sql) => {
      if (name === 'infrastructure.review') {
        const profile = await senderProfile(sql, input.brandId),
          source = await this.eligibility(sql, actor.workspaceId);
        requireCondition(
          profile && profile.revision === input.senderRevision,
          409,
          'sender_profile_changed',
          'Save and review the exact current sender profile on Delivery first.',
        );
        requireCondition(
          source.eligible,
          409,
          'subscription_ineligible',
          'Activate eligible service before planning sender infrastructure.',
        );
        const domain = senderDomain.parse(profile.fromEmail.split('@')[1]);
        requireCondition(
          this.options.mode === 'capture' || this.options.provider,
          503,
          'infrastructure_provider_required',
          'Configure the dedicated infrastructure provider.',
        );
        const count = Number(
          (
            await sql.query(
              "SELECT count(*) FROM customer_infrastructure_intents WHERE state NOT IN ('cancelled','verified','captured')",
            )
          ).rows[0].count,
        );
        requireCondition(
          count < 5,
          422,
          'infrastructure_workspace_limit',
          'Complete or cancel a pending infrastructure plan before creating another.',
        );
        requireCondition(
          !(
            await sql.query(
              "SELECT FROM customer_infrastructure_intents WHERE brand_id=$1 AND state NOT IN ('cancelled','verified','captured')",
              [input.brandId],
            )
          ).rowCount,
          409,
          'infrastructure_brand_pending',
          'This brand already has a pending infrastructure plan.',
        );
        const id = randomUUID(),
          request: InfrastructureRequest = {
            workspaceId: actor.workspaceId,
            brandId: input.brandId,
            operationKey: id,
            domain,
            fromEmail: profile.fromEmail,
            senderRevision: profile.revision,
            profile,
            providerBinding: this.binding(),
            policyVersion: 'infrastructure-v1',
            step: 'tenant',
          };
        await sql.query(
          "INSERT INTO customer_infrastructure_intents(workspace_id,brand_id,id,created_by,mode,request,request_digest,source_revision,source_kind,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'reviewed')",
          [
            actor.workspaceId,
            input.brandId,
            id,
            actor.userId,
            this.options.mode,
            request,
            digest(request),
            source.revision,
            source.source,
          ],
        );
        return { id };
      }
      const row = await this.row(sql, input.id, input.brandId, input.expectedVersion);
      if (name === 'infrastructure.cancel') {
        await sql.query(
          "UPDATE customer_infrastructure_intents SET state='cancelled',cancel_requested=true,reason='cancelled_by_owner',version=version+1,updated_at=now() WHERE id=$1",
          [row.id],
        );
        await sql.query(
          'UPDATE customer_provider_routes SET verified=false,updated_at=now() WHERE intent_id=$1',
          [row.id],
        );
      } else if (name === 'infrastructure.approve') {
        requireCondition(
          row.state === 'reviewed' && row.request_digest === input.reviewDigest,
          409,
          'infrastructure_review_changed',
          'Approve the exact current reviewed plan.',
        );
        requireCondition(
          !(await this.block(sql, actor.workspaceId, row)),
          409,
          'infrastructure_review_changed',
          'The sender, subscription or provider changed. Cancel this plan and review a fresh one.',
        );
        await sql.query(
          "UPDATE customer_infrastructure_intents SET state='queued',version=version+1,updated_at=now() WHERE id=$1",
          [row.id],
        );
      } else if (name === 'infrastructure.retry') {
        requireCondition(
          row.state === 'held' && row.step_attempts === 0 && row.attempts < 27 && !row.cancel_requested,
          409,
          'infrastructure_retry_unsafe',
          'An attempted or unknown step requires authoritative reconciliation, not another mutation.',
        );
        requireCondition(
          !(await this.block(sql, actor.workspaceId, row)),
          409,
          'infrastructure_still_held',
          'Resolve the current sender, subscription or authority hold first.',
        );
        await sql.query(
          "UPDATE customer_infrastructure_intents SET state='queued',reason=NULL,version=version+1,updated_at=now() WHERE id=$1",
          [row.id],
        );
      }
      return { id: row.id };
    });
    return this.status(actor.workspaceId, input.brandId);
  }
  private async block(sql: Sql, workspace: string, row: Row) {
    if (row.mode !== this.options.mode || row.request.providerBinding !== this.binding())
      return 'provider_configuration_changed';
    if (!(await this.options.isOwner(row.created_by, workspace))) return 'authority_revoked';
    const profile = await senderProfile(sql, row.brand_id);
    if (!profile || digest(profile) !== digest(row.request.profile)) return 'sender_profile_changed';
    const source = await this.eligibility(sql, workspace);
    if (!source.eligible || source.source !== row.source_kind || source.revision !== row.source_revision)
      return 'subscription_changed';
    return null;
  }
  private capture(request: InfrastructureRequest): InfrastructureFacts {
    return {
      operationKey: request.operationKey,
      domain: request.domain,
      fromEmail: request.fromEmail,
      captured: true,
      verified: false,
      route: {
        region: 'capture',
        accountId: 'capture',
        tenant: 'capture-' + request.operationKey,
        configurationSet: 'capture-only',
        from: request.fromEmail,
        identityArn: 'capture:' + request.operationKey + '.invalid',
        topicArn: 'capture:' + request.operationKey + '.invalid',
      },
      progress: { nextStep: null, completed: [...infrastructureSteps], dnsPending: true },
      dns: [
        {
          type: 'TXT',
          name: '_capture.' + request.domain + '.invalid',
          value: 'capture-' + request.operationKey + '.invalid',
        },
      ],
    };
  }
  private validate(raw: InfrastructureFacts, request: InfrastructureRequest, mode: 'capture' | 'aws') {
    const fact = factSchema.parse(raw);
    requireCondition(
      fact.operationKey === request.operationKey &&
        fact.domain === request.domain &&
        fact.fromEmail === request.fromEmail,
      409,
      'infrastructure_fact_mismatch',
      'The provider facts do not belong to this reviewed plan.',
    );
    requireCondition(
      new Set(fact.progress.completed).size === fact.progress.completed.length,
      409,
      'infrastructure_fact_mismatch',
      'Provider progress repeats an infrastructure step.',
    );
    requireCondition(
      fact.captured === (mode === 'capture') && (!fact.captured || !fact.verified),
      409,
      'infrastructure_fact_mismatch',
      'Captured facts cannot establish live infrastructure.',
    );
    if (fact.verified) {
      requireCondition(
        !fact.progress.nextStep &&
          !fact.progress.dnsPending &&
          infrastructureSteps.every((step) => fact.progress.completed.includes(step)),
        409,
        'infrastructure_fact_mismatch',
        'Infrastructure is incomplete.',
      );
      parseSesRoute({ ...fact.route, workspaceId: request.workspaceId, brandId: request.brandId });
      requireCondition(
        fact.route.from === request.fromEmail,
        409,
        'infrastructure_fact_mismatch',
        'The verified sender does not match the approved profile.',
      );
    }
    for (const record of fact.dns)
      requireCondition(
        !/[\p{Cc}\p{Cf}]/u.test(record.name + record.value),
        409,
        'infrastructure_fact_mismatch',
        'Invalid provider DNS record.',
      );
    return fact;
  }
  private async process(workspace: string, id: string) {
    const claim = await this.locked(workspace, async (sql) => {
      const row = (
        await sql.query<Row>('SELECT * FROM customer_infrastructure_intents WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!row || ['reviewed', 'verified', 'captured', 'held'].includes(row.state)) return null;
      await this.scope(sql, workspace, row.brand_id);
      const reason = await this.block(sql, workspace, row);
      if (reason) {
        await sql.query(
          "UPDATE customer_infrastructure_intents SET state=CASE WHEN step_attempts=0 THEN 'held' ELSE state END,reason=$2,version=version+1,updated_at=now() WHERE id=$1",
          [row.id, reason],
        );
        return null;
      }
      const request = { ...row.request, step: z.enum(infrastructureSteps).parse(row.step) };
      const apply = row.state === 'queued' && row.step_attempts === 0 && !row.cancel_requested;
      if (apply) {
        if (row.attempts >= 27) {
          await sql.query(
            "UPDATE customer_infrastructure_intents SET state='held',reason='attempt_limit',version=version+1,updated_at=now() WHERE id=$1",
            [id],
          );
          return null;
        }
        if (row.mode === 'aws' && !(await this.options.budgetPermit?.(sql, request))) {
          await sql.query(
            "UPDATE customer_infrastructure_intents SET state='held',reason='operator_budget_approval_required',version=version+1,updated_at=now() WHERE id=$1",
            [id],
          );
          await this.event(sql, workspace, id, 'budget_held', 'system:infrastructure');
          return null;
        }
        await sql.query(
          "UPDATE customer_infrastructure_intents SET state='provisioning',attempts=attempts+1,step_attempts=1,version=version+1,updated_at=now() WHERE id=$1",
          [id],
        );
        await this.event(sql, workspace, id, 'step_claimed:' + request.step, 'system:infrastructure');
      }
      return { row, request, apply, claimVersion: row.version + (apply ? 1 : 0) };
    });
    if (!claim) return;
    const { row, request, apply, claimVersion } = claim;
    let outcome: InfrastructureOutcome = { state: 'unknown' };
    try {
      if (row.mode === 'capture') outcome = { state: 'accepted', facts: this.capture(request) };
      else if (this.options.provider) {
        if (apply) {
          const submitted = await this.locked(workspace, async (sql) => {
            const current = (
              await sql.query<Row>('SELECT * FROM customer_infrastructure_intents WHERE id=$1 FOR UPDATE', [
                id,
              ])
            ).rows[0];
            if (
              !current ||
              current.step !== request.step ||
              current.state === 'verified' ||
              current.state === 'captured'
            )
              return null;
            await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [row.brand_id]);
            const erased = !!(await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount;
            const reason = erased
              ? 'workspace_erased'
              : current.cancel_requested
                ? 'cancelled_before_handoff'
                : await this.block(sql, workspace, current);
            if (reason || current.version !== claimVersion || current.state !== 'provisioning') {
              // This unique claimant has not called the provider yet. Other workers only inspect
              // this committed step; cancellation/profile drift must win before handoff.
              await sql.query(
                "UPDATE customer_infrastructure_intents SET state=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'held' END,step_attempts=0,reason=$2,version=version+1,updated_at=now() WHERE id=$1",
                [id, reason ?? 'handoff_changed'],
              );
              await sql.query(
                'UPDATE customer_provider_routes SET verified=false,updated_at=now() WHERE intent_id=$1',
                [id],
              );
              await this.event(sql, workspace, id, 'handoff_held', 'system:infrastructure');
              return null;
            }
            const provider = this.options.provider!;
            return provider.apply(request, {
              domainProof: async () =>
                !!(
                  await sql.query(
                    "SELECT FROM sender_domains WHERE domain=$1 AND verified_at>clock_timestamp()-interval '24 hours'",
                    [request.domain],
                  )
                ).rowCount,
            });
          });
          if (!submitted) return;
          outcome = submitted;
        } else {
          const facts = await this.options.provider.inspect(request);
          outcome = facts ? { state: 'accepted', facts } : { state: 'unknown' };
        }
      }
    } catch {
      outcome = { state: 'unknown' };
    }
    await this.locked(workspace, async (sql) => {
      const current = await this.row(sql, id, row.brand_id);
      await this.scope(sql, workspace, row.brand_id);
      // Another reconciler may already have advanced the durable named step.
      if (current.step !== request.step || ['verified', 'captured'].includes(current.state)) return;
      let fact: InfrastructureFacts | null = null;
      try {
        if (outcome.facts) fact = this.validate(outcome.facts, request, row.mode);
      } catch {
        outcome = { state: 'unknown' };
      }
      let state: InfrastructureState = current.cancel_requested
        ? 'cancelled'
        : outcome.state === 'rejected'
          ? 'held'
          : 'uncertain';
      let next = request.step,
        attempted = current.step_attempts,
        reason: string | null = outcome.state === 'rejected' ? 'provider_rejected' : 'provider_unknown';
      if (outcome.state === 'rejected' && apply) attempted = 0;
      if (fact) {
        const completed = fact.progress.completed.includes(request.step);
        if (fact.progress.nextStep && fact.progress.completed.includes(fact.progress.nextStep)) fact = null;
        if (current.facts?.progress.completed.some((step) => !fact?.progress.completed.includes(step)))
          fact = null;
        if (!fact) {
          await sql.query(
            "UPDATE customer_infrastructure_intents SET state='uncertain',reason='provider_progress_changed',version=version+1,updated_at=now() WHERE id=$1",
            [id],
          );
          return;
        }
        if (!current.cancel_requested) {
          if (row.mode === 'capture') state = 'captured';
          else if (fact.verified) state = 'verified';
          else if (!fact.progress.nextStep) state = 'awaiting_dns';
          else if (completed) {
            state = 'queued';
            next = fact.progress.nextStep;
            attempted = 0;
          } else state = 'uncertain';
        }
        reason = current.cancel_requested
          ? 'cancelled_after_attempt'
          : state === 'uncertain'
            ? 'provider_unknown'
            : (fact.blockers?.[0] ?? null);
        const valid =
          state === 'verified' && !(await this.block(sql, workspace, current)) && !current.cancel_requested;
        if (state === 'verified' && !valid) {
          state = 'held';
          reason = 'review_changed_after_provider';
        }
        await sql.query(
          `INSERT INTO customer_provider_routes(workspace_id,brand_id,intent_id,provider_binding,sender_revision,captured,verified,facts)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,brand_id) DO UPDATE SET intent_id=excluded.intent_id,provider_binding=excluded.provider_binding,sender_revision=excluded.sender_revision,captured=excluded.captured,verified=excluded.verified,facts=excluded.facts,updated_at=now()`,
          [
            workspace,
            row.brand_id,
            id,
            request.providerBinding,
            request.senderRevision,
            row.mode === 'capture',
            valid,
            JSON.stringify(fact),
          ],
        );
      }
      await sql.query(
        'UPDATE customer_infrastructure_intents SET state=$2,step=$3,step_attempts=$4,facts=coalesce($5,facts),reason=$6,version=version+1,updated_at=now() WHERE id=$1',
        [id, state, next, attempted, fact ? JSON.stringify(fact) : null, reason],
      );
      await this.event(sql, workspace, id, 'step_result:' + state, 'system:infrastructure');
    });
  }
  async tickWorkspace(workspace: string) {
    if (this.options.mode === 'off') return { processed: 0 };
    const rows = await this.db.tenant(workspace, async (sql) => {
      if ((await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount) return [];
      return (
        await sql.query<{ id: string }>(
          "SELECT id FROM customer_infrastructure_intents WHERE state IN ('queued','provisioning','uncertain','awaiting_dns') ORDER BY updated_at,id LIMIT 5",
        )
      ).rows;
    });
    for (const row of rows) await this.process(workspace, row.id);
    return { processed: rows.length };
  }
  /** Trusted feedback routing only; these candidates never establish delivery readiness. */
  async routeCandidates(workspace: string): Promise<SesRoute[]> {
    if (this.options.mode !== 'aws' || !this.options.provider) return [];
    return this.db.tenant(workspace, async (sql) => {
      if ((await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount) return [];
      const brands = (await sql.query<{ id: string }>('SELECT id FROM brands ORDER BY id')).rows;
      const result: SesRoute[] = [];
      for (const brand of brands) {
        await this.scope(sql, workspace, brand.id);
        const stored = (
          await sql.query<{ intent_id: string; captured: boolean }>(
            'SELECT intent_id,captured FROM customer_provider_routes',
          )
        ).rows[0];
        if (!stored || stored.captured) continue;
        const row = await this.row(sql, stored.intent_id, brand.id);
        if (
          row.mode !== 'aws' ||
          row.request.providerBinding !== this.binding() ||
          !row.facts ||
          row.facts.captured
        )
          continue;
        try {
          const fact = this.validate(row.facts, row.request, 'aws');
          if (!fact.progress.completed.includes('topic') || !fact.progress.completed.includes('topic_policy'))
            continue;
          if (fact.route.from !== row.request.fromEmail) continue;
          result.push(parseSesRoute({ ...fact.route, workspaceId: workspace, brandId: brand.id }));
        } catch {
          continue;
        }
      }
      return result;
    });
  }
  /** Authorization for signed SNS subscription confirmation, never for ordinary historical feedback. */
  async canConfirmRoute(route: SesRoute): Promise<boolean> {
    if (this.options.mode !== 'aws' || !this.options.provider) return false;
    try {
      return await this.locked(route.workspaceId, async (sql) => {
        await this.scope(sql, route.workspaceId, route.brandId);
        const stored = (
          await sql.query<{ intent_id: string; captured: boolean }>(
            'SELECT intent_id,captured FROM customer_provider_routes',
          )
        ).rows[0];
        if (!stored || stored.captured) return false;
        const row = await this.row(sql, stored.intent_id, route.brandId);
        if (
          row.mode !== 'aws' ||
          row.cancel_requested ||
          !['queued', 'provisioning', 'awaiting_dns', 'uncertain', 'verified'].includes(row.state) ||
          row.request.providerBinding !== this.binding() ||
          !row.facts ||
          row.facts.captured
        )
          return false;
        const fact = this.validate(row.facts, row.request, 'aws');
        if (
          !fact.progress.completed.includes('topic') ||
          !fact.progress.completed.includes('topic_policy') ||
          fact.route.from !== row.request.fromEmail
        )
          return false;
        const expected = parseSesRoute({
          ...fact.route,
          workspaceId: route.workspaceId,
          brandId: route.brandId,
        });
        const supplied = parseSesRoute({
          workspaceId: route.workspaceId,
          brandId: route.brandId,
          region: route.region,
          accountId: route.accountId,
          tenant: route.tenant,
          configurationSet: route.configurationSet,
          from: route.from,
          identityArn: route.identityArn,
          topicArn: route.topicArn,
        });
        if (expected.fingerprint !== route.fingerprint || expected.fingerprint !== supplied.fingerprint)
          return false;
        if (row.step !== 'subscription' && !fact.progress.completed.includes('subscription')) return false;
        return !(await this.block(sql, route.workspaceId, row));
      });
    } catch {
      return false;
    }
  }
  async verifiedRoute(workspace: string, brand: string): Promise<SesRoute | null> {
    if (this.options.mode !== 'aws' || !this.options.provider) return null;
    const row = await this.db.tenant(workspace, async (sql) => {
      await this.scope(sql, workspace, brand);
      const route = (
        await sql.query<{ intent_id: string; captured: boolean; verified: boolean }>(
          'SELECT intent_id,captured,verified FROM customer_provider_routes',
        )
      ).rows[0];
      if (!route || route.captured || !route.verified) return null;
      return this.row(sql, route.intent_id, brand);
    });
    if (!row || row.mode !== 'aws' || row.state !== 'verified') return null;
    const fresh = await this.options.provider.inspect({
      ...row.request,
      step: z.enum(infrastructureSteps).parse(row.step),
    });
    if (!fresh) return null;
    const facts = this.validate(fresh, row.request, 'aws');
    if (!facts.verified) return null;
    return this.locked(workspace, async (sql) => {
      await this.scope(sql, workspace, brand);
      const current = await this.row(sql, row.id, brand);
      if (current.version !== row.version || current.state !== 'verified' || current.cancel_requested)
        return null;
      if (await this.block(sql, workspace, current)) return null;
      return parseSesRoute({ ...facts.route, workspaceId: workspace, brandId: brand });
    });
  }
}
