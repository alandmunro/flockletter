import type { Sql } from './db.js';
const retentionDays = 90;
export function reviewDate(effectiveEnd: Date) {
  return new Date(effectiveEnd.getTime() + retentionDays * 86400000);
}
export async function retentionPreview(sql: Sql, now = new Date()) {
  const found = (
    await sql.query<{ effective_end_at: Date | null; status: string }>(
      'SELECT effective_end_at,status FROM sandbox_checkouts WHERE observed_at IS NOT NULL',
    )
  ).rows[0];
  if (!found?.effective_end_at || found.status !== 'canceled')
    return {
      source: 'sandbox',
      status: 'no_verified_closure',
      effectiveEnd: null,
      reviewAt: null,
      purgeEnabled: false,
    };
  const due = reviewDate(found.effective_end_at);
  return {
    source: 'sandbox',
    status: due <= now ? 'operator_review_due' : 'retained',
    effectiveEnd: found.effective_end_at.toISOString(),
    reviewAt: due.toISOString(),
    purgeEnabled: false,
  };
}
