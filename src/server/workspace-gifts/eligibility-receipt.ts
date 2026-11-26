import type { Sql } from '../db.js';

export async function recordWorkspacePayment(
  sql: Sql,
  workspace: string,
  live: boolean,
  reference: string,
  at: string,
) {
  await sql.query(
    `INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result)
    VALUES($1,$2,$3,$3,jsonb_build_object('at',$4::text)) ON CONFLICT DO NOTHING`,
    [workspace, 'billing:cleared:' + (live ? 'live' : 'test'), reference, at],
  );
}

export async function firstWorkspacePayment(sql: Sql, workspace: string, live: boolean) {
  const { rows } = await sql.query<{ at: string }>(
    `SELECT min(settled_at)::text AS at FROM (
       SELECT (result->>'at')::timestamptz AS settled_at FROM operations WHERE workspace_id=$1 AND actor_id=$2
       UNION ALL
       SELECT at FROM sms_audit WHERE workspace_id=$1 AND $3=false AND actor_id='stripe'
         AND interface='webhook' AND action='onboarding.checkout_verified'
     ) verified`,
    [workspace, 'billing:cleared:' + (live ? 'live' : 'test'), live],
  );
  return rows[0]?.at;
}
