import type { Sql } from './db.js';
const retentionDays = 90;
export function reviewDate(effectiveEnd: Date) {
  return new Date(effectiveEnd.getTime() + retentionDays * 86400000);
}
export async function verifiedServiceEnd(sql: Sql, workspaceId: string, now: Date) {
  const { rows } = await sql.query<{ effective_end_at: Date }>(
    `SELECT effective_end_at FROM sandbox_checkouts
     WHERE workspace_id=$1 AND status='canceled' AND date_trunc('milliseconds',observed_at) <= $2 AND effective_end_at IS NOT NULL
     AND (SELECT plan FROM workspace_access_events WHERE workspace_id=$1 ORDER BY revision DESC LIMIT 1) IS NULL`,
    [workspaceId, now],
  );
  return rows[0]?.effective_end_at ?? null;
}
export async function retentionPreview(sql: Sql, workspaceId: string, now = new Date()) {
  const effectiveEnd = await verifiedServiceEnd(sql, workspaceId, now);
  if (!effectiveEnd)
    return {
      source: 'sandbox',
      status: 'no_verified_closure',
      effectiveEnd: null,
      reviewAt: null,
      purgeEnabled: false,
    };
  const due = reviewDate(effectiveEnd);
  return {
    source: 'sandbox',
    status: due <= now ? 'operator_review_due' : 'retained',
    effectiveEnd: effectiveEnd.toISOString(),
    reviewAt: due.toISOString(),
    purgeEnabled: false,
  };
}
