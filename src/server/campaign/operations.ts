import type { Sql } from '../db.js';
import { alertGuidance, type RehearsalAlert, type WorkspaceActivity } from '../../shared/workspace-activity.js';

type AlertRow = Pick<RehearsalAlert, 'kind' | 'count' | 'version'> & { rehearsal_id: string; campaign_id: string };

// Every signal is scoped to the current brand's RLS transaction. Only aggregate counts
// and an affected rehearsal are returned. Feedback counts unique recipient operations per kind.
async function brandAlerts(sql: Sql, brand: { id: string; name: string }): Promise<RehearsalAlert[]> {
  const { rows } = await sql.query<AlertRow>(`
    WITH scoped AS (
      SELECT workspace_id,brand_id,id,campaign_id,version,state,due_at,finished_at
      FROM campaign_rehearsals WHERE brand_id=$1
    ), signals AS (
      SELECT 'overdue' AS kind,r.id AS rehearsal_id,r.campaign_id,r.version,r.due_at AS observed,1 AS amount
      FROM scoped r WHERE r.state='queued' AND r.due_at<now()-interval '15 minutes'
      UNION ALL
      SELECT 'blocked',r.id,r.campaign_id,r.version,coalesce(r.finished_at,r.due_at),1 FROM scoped r WHERE r.state='blocked'
      UNION ALL
      SELECT 'held',r.id,r.campaign_id,r.version,coalesce(r.finished_at,r.due_at),1
      FROM scoped r JOIN rehearsal_reservations u ON (u.workspace_id,u.brand_id,u.rehearsal_id)=(r.workspace_id,r.brand_id,r.id)
      WHERE NOT u.settled AND r.state IN ('blocked','cancelled','completed')
      UNION ALL
      SELECT 'uncertain',r.id,r.campaign_id,r.version,r.due_at,count(*)::int
      FROM scoped r JOIN rehearsal_recipients p ON (p.workspace_id,p.brand_id,p.rehearsal_id)=(r.workspace_id,r.brand_id,r.id)
      WHERE p.state='uncertain' OR (p.state='submitting' AND p.attempts>0 AND p.next_check_at<=now())
      GROUP BY r.id,r.campaign_id,r.version,r.due_at
      UNION ALL
      SELECT CASE e.kind WHEN 'complaint' THEN 'complaint' ELSE 'hard_bounce' END,
        r.id,r.campaign_id,r.version,max(e.received_at),count(DISTINCT e.operation_key)::int
      FROM scoped r JOIN campaign_provider_receipts p ON (p.workspace_id,p.brand_id,p.rehearsal_id)=(r.workspace_id,r.brand_id,r.id)
        JOIN campaign_provider_events e ON (e.workspace_id,e.brand_id,e.operation_key)=(p.workspace_id,p.brand_id,p.operation_key)
      WHERE e.kind IN ('permanent_bounce','complaint') GROUP BY r.id,r.campaign_id,r.version,e.kind
    )
    SELECT DISTINCT ON (kind) kind,sum(amount) OVER(PARTITION BY kind)::int AS count,rehearsal_id,campaign_id,version
    FROM signals ORDER BY kind, CASE WHEN kind='overdue' THEN observed END ASC NULLS LAST,observed DESC,rehearsal_id`,[brand.id]);
  return rows.map((item) => ({
    kind:item.kind, count:item.count, brandId:brand.id, brandName:brand.name, campaignId:item.campaign_id,
    rehearsalId:item.rehearsal_id, version:item.version, nextAction:alertGuidance[item.kind].action,
  }));
}

export async function operations(sql: Sql): Promise<WorkspaceActivity> {
  const checkedAt = new Date().toISOString();
  const events = (
    await sql.query<{ id: string; action: string; actor: string; at: Date }>(`SELECT id,action,
    CASE WHEN actor_id LIKE 'connection:%' THEN 'connection' ELSE 'workspace member' END AS actor,created_at AS at
    FROM audit ORDER BY created_at DESC,id DESC LIMIT 12`)
  ).rows;
  const totals = { queued: 0, blocked: 0, captured: 0, overdue: 0 };
  const alerts: RehearsalAlert[] = [];
  const brands = (await sql.query<{ id: string; name: string }>('SELECT id,name FROM brands ORDER BY name,id')).rows;
  for (const brand of brands) {
    const { id } = brand;
    await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [id]);
    const row = (
      await sql.query<{
        queued: number;
        blocked: number;
        overdue: number;
      }>(`SELECT count(*) FILTER(WHERE state='queued')::int queued,
      count(*) FILTER(WHERE state='blocked')::int blocked,
      count(*) FILTER(WHERE state='queued' AND due_at<now()-interval '15 minutes')::int overdue FROM campaign_rehearsals`)
    ).rows[0]!;
    totals.queued += row.queued;
    totals.blocked += row.blocked;
    totals.overdue += row.overdue;
    totals.captured += Number(
      (await sql.query("SELECT count(*) FROM rehearsal_recipients WHERE state='captured'")).rows[0].count,
    );
    alerts.push(...await brandAlerts(sql, brand));
  }
  return {
    events: events.map((e) => ({ ...e, at: e.at.toISOString() })),
    captures: totals,
    emailDelivery: 'off',
    checkedAt,
    alerts,
  };
}
