import { z } from 'zod';
import { Database } from '../src/server/db.js';
import { workspaceIdentifier } from '../src/server/campaign/rehearsal.js';

const input = z
  .object({
    workspaceId: workspaceIdentifier,
    plan: z.enum(['starter', 'growth', 'pro']).nullable(),
    operator: z.string().trim().min(1).max(100),
    reason: z.string().trim().min(1).max(240),
    operationKey: z.uuid(),
  })
  .strict();
export async function recordAccess(db: Database, target: string, raw: unknown) {
  const change = input.parse(raw);
  if (change.workspaceId !== target)
    throw Error('The operator target must match the configured complimentary workspace.');
  return db.tenant(target, async (sql) => {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [target]);
    if (!(await sql.query('SELECT workspace_id FROM workspaces WHERE workspace_id=$1', [target])).rowCount)
      throw Error('Initialize the target workspace first.');
    const prior = (
      await sql.query('SELECT * FROM workspace_access_events WHERE workspace_id=$1 AND operation_key=$2', [
        target,
        change.operationKey,
      ])
    ).rows[0];
    if (prior) {
      if (
        prior.plan !== change.plan ||
        prior.operator_name !== change.operator ||
        prior.reason !== change.reason
      )
        throw Error('Operation key already used for a different grant.');
      return { revision: Number(prior.revision), plan: prior.plan };
    }
    if (
      change.plan &&
      (await sql.query('SELECT id FROM sandbox_checkouts WHERE workspace_id=$1', [target])).rowCount
    )
      throw Error(
        'A workspace with billing history cannot be enrolled as a Stripe-bypassing complimentary account.',
      );
    const row = (
      await sql.query(
        `INSERT INTO workspace_access_events(workspace_id,revision,operation_key,plan,operator_name,reason)
      SELECT $1,coalesce(max(revision),0)+1,$2,$3,$4,$5 FROM workspace_access_events WHERE workspace_id=$1 RETURNING revision,plan`,
        [target, change.operationKey, change.plan, change.operator, change.reason],
      )
    ).rows[0]!;
    return { revision: Number(row.revision), plan: row.plan };
  });
}
