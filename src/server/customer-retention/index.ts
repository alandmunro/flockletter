import {lockWorkspace} from '../workspace-lock.js';
import { createHash, randomUUID } from 'node:crypto';
import tables from '../../shared/runtime-tables.json' with { type: 'json' };
import type { Database, Sql } from '../db.js';
import type { Actor } from '../service.js';
import { requireCondition } from '../errors.js';
import {
  customerRetentionCommands,
  type RetentionCase,
  type RetentionJob,
  type RetentionStatus,
  type ServiceEnd,
} from '../../shared/customer-retention.js';
import { reviewDate } from '../retention.js';

type Options = {
  mode: 'off' | 'capture' | 'live';
  isOwner?: (user: string, workspace: string) => Promise<boolean>;
  currentOwner?: (workspace: string) => Promise<string | null>;
  serviceEnd?: (workspace: string) => Promise<ServiceEnd>;
  serviceEndSql?: (sql: Sql, workspace: string) => Promise<ServiceEnd>;
  now?: () => Date;
  clock?: (workspace: string) => Promise<Date>;
  clockSql?: (sql: Sql, workspace: string) => Promise<Date>;
};
type Row = {
  id: string;
  source: ServiceEnd['source'];
  source_version: string;
  effective_end_at: Date;
  due_at: Date;
  state: RetentionCase['state'];
  version: number;
  hold_reason: string | null;
  inventory: Record<string, number>;
  inventory_digest: string | null;
  updated_at: Date;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tableNames = tables.map((t) => t.name).sort();
export const retentionManifestDigest = () => hash(tableNames);

export class CustomerRetention {
  constructor(
    readonly db: Database,
    readonly options: Options = { mode: 'off' },
  ) {}
  private async now(workspace: string) {
    if (this.options.mode === 'capture' && this.options.clock) return this.options.clock(workspace);
    return this.options.now?.() ?? new Date();
  }
  private async clock(sql: Sql, workspace: string, fallback: Date) {
    return this.options.mode === 'capture' && this.options.clockSql
      ? this.options.clockSql(sql, workspace)
      : fallback;
  }
  private async owner(actor: Actor) {
    requireCondition(
      actor.kind === 'session' &&
        actor.owner &&
        (await this.options.isOwner?.(actor.userId, actor.workspaceId)),
      403,
      'owner_required',
      'Use a current workspace owner session.',
    );
    await this.db.tenant(actor.workspaceId, (sql) => this.retained(sql));
    requireCondition(
      this.options.mode !== 'off',
      503,
      'retention_unavailable',
      'Account retention is not configured.',
    );
  }
  private async retained(sql: Sql) {
    requireCondition(
      !(await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount,
      410,
      'workspace_erased',
      'This account has completed retention erasure. Restore reconciliation is required.',
    );
  }
  private async facts(workspace: string) {
    requireCondition(
      this.options.serviceEnd,
      503,
      'retention_service_unavailable',
      'The current verified service end is unavailable.',
    );
    const fact = await this.options.serviceEnd(workspace);
    requireCondition(
      fact.version &&
        ['stripe', 'exercise', 'complimentary'].includes(fact.source) &&
        (!fact.effectiveEnd || Number.isFinite(Date.parse(fact.effectiveEnd))),
      503,
      'retention_service_unavailable',
      'The verified service-end record is incomplete.',
    );
    return fact;
  }
  private async locked<T>(workspace: string, run: (sql: Sql) => Promise<T>) {
    return this.db.tenant(workspace, async (sql) => {
      await lockWorkspace(sql,workspace);
      return run(sql);
    });
  }
  private async mutate<T>(
    actor: Actor,
    name: string,
    input: { operationKey: string },
    run: (sql: Sql) => Promise<T>,
  ) {
    return this.locked(actor.workspaceId, async (sql) => {
      const key = 'customer-retention:' + actor.actorId,
        fingerprint = hash([name, input]);
      const prior = (
        await sql.query<{ request_hash: string; result: T }>(
          'SELECT request_hash,result FROM operations WHERE actor_id=$1 AND operation_key=$2',
          [key, input.operationKey],
        )
      ).rows[0];
      if (prior) {
        requireCondition(
          prior.request_hash === fingerprint,
          409,
          'operation_conflict',
          'Retry the original retention request.',
        );
        return prior.result;
      }
      const result = await run(sql);
      await sql.query(
        'INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4,$5)',
        [actor.workspaceId, key, input.operationKey, fingerprint, JSON.stringify(result)],
      );
      await sql.query('INSERT INTO audit(workspace_id,id,actor_id,action) VALUES($1,$2,$3,$4)', [
        actor.workspaceId,
        randomUUID(),
        actor.actorId,
        name,
      ]);
      return result;
    });
  }
  private view(r: Row): RetentionCase {
    return {
      id: r.id,
      source: r.source,
      sourceVersion: r.source_version,
      effectiveEnd: r.effective_end_at.toISOString(),
      dueAt: r.due_at.toISOString(),
      state: r.state,
      version: r.version,
      holdReason: r.hold_reason,
      inventory: r.inventory,
      inventoryDigest: r.inventory_digest,
      updatedAt: r.updated_at.toISOString(),
    };
  }
  async status(workspace: string): Promise<RetentionStatus> {
    const service = await this.facts(workspace);
    return this.db.tenant(workspace, async (sql) => {
      const cases = (
        await sql.query<Row>('SELECT * FROM customer_retention_cases ORDER BY created_at DESC,id LIMIT 20')
      ).rows;
      const jobs = (
        await sql.query<{
          id: string;
          case_id: string;
          state: string;
          manifest_digest: string;
          created_at: Date;
          result: RetentionJob['result'];
        }>('SELECT * FROM customer_retention_jobs ORDER BY created_at DESC,id LIMIT 20')
      ).rows;
      return {
        mode: this.options.mode,
        service,
        cases: cases.map((r) => this.view(r)),
        jobs: jobs.map((j) => ({
          id: j.id,
          caseId: j.case_id,
          state: j.state,
          manifestDigest: j.manifest_digest,
          createdAt: j.created_at.toISOString(),
          result: j.result,
        })),
        purgeEnabled: false,
        retentionDays: 90,
      };
    });
  }
  private async row(sql: Sql, id: string, version: number) {
    const row = (await sql.query<Row>('SELECT * FROM customer_retention_cases WHERE id=$1 FOR UPDATE', [id]))
      .rows[0];
    requireCondition(row, 404, 'retention_case_unavailable', 'This retention case is unavailable.');
    requireCondition(row.version === version, 409, 'version_conflict', 'Reload the current retention case.');
    return row;
  }
  private eligible(row: Row, fact: ServiceEnd) {
    return (
      fact.source !== 'complimentary' &&
      fact.version === row.source_version &&
      fact.effectiveEnd !== null &&
      Date.parse(fact.effectiveEnd) === row.effective_end_at.getTime() &&
      ['cancelled', 'canceled', 'closed'].includes(fact.status)
    );
  }
  private async current(sql: Sql, workspace: string, fallback: ServiceEnd) {
    if (this.options.serviceEndSql) return this.options.serviceEndSql(sql, workspace);
    requireCondition(
      this.options.mode === 'capture',
      503,
      'retention_service_unavailable',
      'Locked service-end verification is required for hosted retention.',
    );
    return fallback;
  }
  private async inventory(sql: Sql, workspace: string) {
    const result: Record<string, number> = {};
    const brands = (await sql.query<{ id: string }>('SELECT id FROM brands ORDER BY id')).rows;
    // Identifiers are exclusively the checked-in, migration-reviewed manifest.
    for (const entry of tables) {
      if (entry.scope === 'brand') {
        let count = 0;
        for (const brand of brands) {
          await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [brand.id]);
          count += Number(
            (
              await sql.query('SELECT count(*) FROM public."' + entry.name + '" WHERE workspace_id=$1', [
                workspace,
              ])
            ).rows[0].count,
          );
        }
        result[entry.name] = count;
      } else
        result[entry.name] = Number(
          (
            await sql.query('SELECT count(*) FROM public."' + entry.name + '" WHERE workspace_id=$1', [
              workspace,
            ])
          ).rows[0].count,
        );
    }
    return result;
  }
  private async reconcile(sql: Sql, workspace: string, current: ServiceEnd, now: Date, refresh: boolean) {
    const cancellable =
      current.source !== 'complimentary' &&
      current.effectiveEnd &&
      ['cancelled', 'canceled', 'closed'].includes(current.status);
    await sql.query(
      "UPDATE customer_retention_cases SET state='cancelled',version=version+1,updated_at=now() WHERE source_version<>$1 AND state<>'cancelled'",
      [current.version],
    );
    await sql.query(
      "UPDATE customer_retention_jobs SET state='cancelled',updated_at=now() WHERE state IN ('awaiting_operator','authorized') AND case_id IN (SELECT id FROM customer_retention_cases WHERE state='cancelled')",
    );
    if (!cancellable) {
      await sql.query(
        "UPDATE customer_retention_cases SET state='cancelled',version=version+1,updated_at=now() WHERE state<>'cancelled'",
      );
      return { id: null };
    }
    const end = new Date(current.effectiveEnd!),
      due = reviewDate(end);
    requireCondition(
      end <= now,
      409,
      'retention_not_ended',
      'Service must end before a retention case starts.',
    );
    if (!refresh) {
      const existing = (
        await sql.query<Row>('SELECT * FROM customer_retention_cases WHERE source_version=$1', [
          current.version,
        ])
      ).rows[0];
      if (existing) {
        if (existing.state === 'retained' && existing.due_at <= now)
          await sql.query(
            "UPDATE customer_retention_cases SET state='due',version=version+1,updated_at=now() WHERE id=$1",
            [existing.id],
          );
        return { id: existing.id };
      }
    }
    const inventory = await this.inventory(sql, workspace),
      digest = hash(inventory),
      id = randomUUID();
    const row = (
      await sql.query<{ id: string }>(
        `INSERT INTO customer_retention_cases(workspace_id,id,source,source_version,effective_end_at,due_at,state,inventory,inventory_digest)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT(workspace_id,source_version) DO UPDATE SET inventory=excluded.inventory,inventory_digest=excluded.inventory_digest,
              state=CASE WHEN customer_retention_cases.state IN ('retained','due') THEN excluded.state ELSE customer_retention_cases.state END,
              version=customer_retention_cases.version+1,updated_at=now() RETURNING id`,
        [
          workspace,
          id,
          current.source,
          current.version,
          end,
          due,
          due <= now ? 'due' : 'retained',
          inventory,
          digest,
        ],
      )
    ).rows[0]!;
    return { id: row.id };
  }
  async tickWorkspace(workspace: string) {
    if (this.options.mode === 'off') return { reconciled: false };
    const owner = await this.options.currentOwner?.(workspace);
    requireCondition(
      owner && (await this.options.isOwner?.(owner, workspace)),
      403,
      'owner_required',
      'Verify a current workspace owner before retention scheduling.',
    );
    const fact = await this.facts(workspace),
      clock = await this.now(workspace);
    return this.locked(workspace, async (sql) => {
      if ((await sql.query('SELECT FROM customer_retention_receipts LIMIT 1')).rowCount)
        return { reconciled: false, caseId: null };
      const current = await this.current(sql, workspace, fact),
        now = await this.clock(sql, workspace, clock);
      const before = (await sql.query('SELECT id,state,version FROM customer_retention_cases ORDER BY id'))
        .rows;
      const result = await this.reconcile(sql, workspace, current, now, false);
      const after = (await sql.query('SELECT id,state,version FROM customer_retention_cases ORDER BY id'))
        .rows;
      if (hash(before) !== hash(after))
        await sql.query('INSERT INTO audit(workspace_id,id,actor_id,action) VALUES($1,$2,$3,$4)', [
          workspace,
          randomUUID(),
          'system:retention-scheduler',
          'retention.scheduled_reconcile',
        ]);
      return { reconciled: true, caseId: result.id };
    });
  }
  /** Scheduled reconciliation creates or cancels review cases; execution remains separately authorized. */
  async tick(actor: Actor) {
    return this.execute('retention.inspect', { operationKey: randomUUID() }, actor);
  }
  async execute(name: string, raw: unknown, actor: Actor): Promise<unknown> {
    await this.owner(actor);
    switch (name) {
      case 'retention.status':
        return this.status(actor.workspaceId);
      case 'retention.inspect': {
        const input = customerRetentionCommands[name].schema.parse(raw),
          fact = await this.facts(actor.workspaceId),
          initialNow = await this.now(actor.workspaceId);
        await this.mutate(actor, name, input, async (sql) => {
          const current = await this.current(sql, actor.workspaceId, fact);
          const now = await this.clock(sql, actor.workspaceId, initialNow);
          return this.reconcile(sql, actor.workspaceId, current, now, true);
        });
        return this.status(actor.workspaceId);
      }
      case 'retention.hold':
      case 'retention.release': {
        const input =
          name === 'retention.hold'
            ? customerRetentionCommands[name].schema.parse(raw)
            : customerRetentionCommands[name].schema.parse(raw);
        const fact = await this.facts(actor.workspaceId),
          initialNow = await this.now(actor.workspaceId);
        await this.mutate(actor, name, input, async (sql) => {
          const current = await this.current(sql, actor.workspaceId, fact);
          const now = await this.clock(sql, actor.workspaceId, initialNow);
          const row = await this.row(sql, input.id, input.expectedVersion);
          requireCondition(
            !['captured', 'cancelled'].includes(row.state),
            409,
            'retention_state',
            'This retention case is already finalized.',
          );
          const state =
            name === 'retention.hold'
              ? 'held'
              : !this.eligible(row, current)
                ? 'cancelled'
                : row.due_at <= now
                  ? 'due'
                  : 'retained';
          await sql.query(
            'UPDATE customer_retention_cases SET state=$2,hold_reason=$3,version=version+1,updated_at=now() WHERE id=$1',
            [row.id, state, 'reason' in input ? input.reason : null],
          );
          await sql.query(
            "UPDATE customer_retention_jobs SET state='cancelled',updated_at=now() WHERE case_id=$1 AND state IN ('awaiting_operator','authorized')",
            [row.id],
          );
          return { id: row.id };
        });
        return this.status(actor.workspaceId);
      }
      case 'retention.request': {
        const input = customerRetentionCommands[name].schema.parse(raw),
          fact = await this.facts(actor.workspaceId),
          initialNow = await this.now(actor.workspaceId);
        await this.mutate(actor, name, input, async (sql) => {
          const current = await this.current(sql, actor.workspaceId, fact);
          const now = await this.clock(sql, actor.workspaceId, initialNow);
          const row = await this.row(sql, input.id, input.expectedVersion);
          requireCondition(
            this.eligible(row, current) && row.state === 'due' && row.due_at <= now && !row.hold_reason,
            409,
            'retention_ineligible',
            'A current, due case without a hold is required.',
          );
          requireCondition(
            row.inventory_digest === input.inventoryDigest,
            409,
            'retention_inventory_changed',
            'Inspect the current retention inventory before requesting execution.',
          );
          const manifest = retentionManifestDigest();
          await sql.query(
            "INSERT INTO customer_retention_jobs(workspace_id,id,case_id,case_version,state,requested_by,manifest_digest) VALUES($1,$2,$3,$4,'awaiting_operator',$5,$6)",
            [actor.workspaceId, randomUUID(), row.id, row.version, actor.userId, manifest],
          );
          await sql.query(
            "UPDATE customer_retention_cases SET state='awaiting_operator',version=version+1,updated_at=now() WHERE id=$1",
            [row.id],
          );
          return { id: row.id };
        });
        return this.status(actor.workspaceId);
      }
      case 'retention.exercise': {
        const input = customerRetentionCommands[name].schema.parse(raw),
          fact = await this.facts(actor.workspaceId),
          initialNow = await this.now(actor.workspaceId);
        requireCondition(
          this.options.mode === 'capture' && fact.source === 'exercise',
          403,
          'retention_executor_required',
          'Hosted erasure requires separate operator authority.',
        );
        await this.mutate(actor, name, input, async (sql) => {
          const current = await this.current(sql, actor.workspaceId, fact);
          const now = await this.clock(sql, actor.workspaceId, initialNow);
          const row = await this.row(sql, input.id, input.expectedVersion);
          requireCondition(
            this.eligible(row, current) &&
              row.state === 'awaiting_operator' &&
              row.due_at <= now &&
              !row.hold_reason,
            409,
            'retention_ineligible',
            'The due exercise case changed or was held.',
          );
          const job = (
            await sql.query<{ id: string; manifest_digest: string }>(
              "SELECT * FROM customer_retention_jobs WHERE case_id=$1 AND state='awaiting_operator' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
              [row.id],
            )
          ).rows[0];
          requireCondition(
            job && job.manifest_digest === retentionManifestDigest(),
            409,
            'retention_inventory_changed',
            'The retention manifest changed. Request a new review.',
          );
          await sql.query(
            "UPDATE customer_retention_jobs SET state='captured',result=$2,updated_at=now() WHERE id=$1",
            [
              job.id,
              {
                captured: true,
                deletedRows: 0,
                reason: 'The staging executor captured the due job. Account records are retained.',
              },
            ],
          );
          await sql.query(
            "UPDATE customer_retention_cases SET state='captured',version=version+1,updated_at=now() WHERE id=$1",
            [row.id],
          );
          return { id: row.id };
        });
        return this.status(actor.workspaceId);
      }
    }
    requireCondition(false, 404, 'unknown_command', 'Unknown retention action.');
  }
}
