import type { Sql } from '../db.js';
import type { PlanId } from '../../shared/rehearsal.js';
import { digest } from '../content.js';

const actor = 'system:stripe-sandbox-plan';
type Intent = { id: string; plan: PlanId };
// The checkout intent stays immutable. The ordinal is assigned under the same workspace
// lock as the verified event, so two out-of-order deliveries cannot reorder the observations.
async function lastObservation(sql: Sql, intent: Intent) {
  const { rows } = await sql.query<{ plan: PlanId; revision: number }>(
    "SELECT result->>'plan' AS plan,(result->>'revision')::int AS revision FROM operations WHERE actor_id=$1 AND result->>'checkoutId'=$2 ORDER BY revision DESC LIMIT 1",
    [actor, intent.id],
  );
  return rows[0] ?? { plan: intent.plan, revision: 0 };
}
export async function effectiveSandboxPlan(sql: Sql, intent: Intent) {
  return (await lastObservation(sql, intent)).plan;
}
export async function recordSandboxPlan(
  sql: Sql,
  workspace: string,
  intent: Intent,
  plan: PlanId,
  eventId: string,
) {
  const previous = await lastObservation(sql, intent);
  if (previous.plan === plan) return;
  const result = { checkoutId: intent.id, plan, revision: previous.revision + 1 };
  await sql.query(
    'INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4,$5)',
    [workspace, actor, eventId, digest(JSON.stringify(result)), JSON.stringify(result)],
  );
}
