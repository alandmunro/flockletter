import type { Sql } from '../db.js';
import type { WorkspaceAccess, Usage, PlanId } from '../../shared/rehearsal.js';
import { plans } from '../../shared/contracts.js';
import { requireCondition } from '../errors.js';

export async function workspaceAccess(sql: Sql): Promise<WorkspaceAccess> {
  const row = (
    await sql.query<{ plan: PlanId | null; revision: number; recorded_at: Date }>(
      'SELECT plan,revision,recorded_at FROM workspace_access_events ORDER BY revision DESC LIMIT 1',
    )
  ).rows[0];
  return {
    status: row?.plan ? 'complimentary' : 'preparation',
    plan: row?.plan ?? null,
    revision: row?.revision ?? 0,
    effectiveAt: row?.recorded_at.toISOString() ?? null,
  };
}

export async function practiceUsage(sql: Sql, period: string): Promise<Usage> {
  const row = (
    await sql.query<{
      campaigns: number;
      messages: number;
      reserved_campaigns: number;
      reserved_messages: number;
    }>(
      `
    SELECT coalesce(sum(slots) FILTER (WHERE settled),0)::int AS campaigns,
           coalesce(sum(messages) FILTER (WHERE settled),0)::int AS messages,
           coalesce(sum(slots) FILTER (WHERE NOT settled),0)::int AS reserved_campaigns,
           coalesce(sum(messages) FILTER (WHERE NOT settled),0)::int AS reserved_messages
    FROM rehearsal_reservations WHERE period=$1`,
      [period],
    )
  ).rows[0]!;
  return {
    period,
    campaigns: row.campaigns,
    messages: row.messages,
    reservedCampaigns: row.reserved_campaigns,
    reservedMessages: row.reserved_messages,
  };
}
export function utcPeriod(date: Date) {
  return date.toISOString().slice(0, 7) + '-01';
}

export async function reservePractice(
  sql: Sql,
  workspaceId: string,
  brand: string,
  id: string,
  period: string,
  messages: number,
  access: WorkspaceAccess,
  audience: 'test' | 'confirmed',
) {
  const plan = plans.find((item) => item.id === access.plan);
  requireCondition(
    audience === 'test' || plan,
    422,
    'access_required',
    'A complimentary plan is required to rehearse a brand audience.',
  );
  const used = await practiceUsage(sql, period);
  const slots = audience === 'confirmed' ? 1 : 0;
  requireCondition(
    used.messages + used.reservedMessages + messages <= (plan?.emails ?? 25) &&
      (!slots ||
        (plan &&
          used.campaigns + used.reservedCampaigns + slots <= plan.campaigns &&
          messages <= plan.recipients)),
    422,
    'practice_limit',
    'This rehearsal exceeds the available practice allowance for its scheduled month.',
  );
  await sql.query(
    'INSERT INTO rehearsal_reservations(workspace_id,brand_id,rehearsal_id,period,slots,messages) VALUES($1,$2,$3,$4,$5,$6)',
    [workspaceId, brand, id, period, slots, messages],
  );
}
