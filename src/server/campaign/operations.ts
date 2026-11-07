import type { Sql } from '../db.js';
export async function operations(sql: Sql) {
  const events = (
    await sql.query<{ id: string; action: string; actor: string; at: Date }>(`SELECT id,action,
    CASE WHEN actor_id LIKE 'connection:%' THEN 'connection' ELSE 'workspace member' END AS actor,created_at AS at
    FROM audit ORDER BY created_at DESC,id DESC LIMIT 12`)
  ).rows;
  const totals = { queued: 0, blocked: 0, captured: 0, overdue: 0 };
  const brands = (await sql.query<{ id: string }>('SELECT id FROM brands ORDER BY id')).rows;
  for (const { id } of brands) {
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
  }
  return {
    events: events.map((e) => ({ ...e, at: e.at.toISOString() })),
    captures: totals,
    emailDelivery: 'off',
  };
}
