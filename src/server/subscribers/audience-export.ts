import { exportLimits, type ExportPage, type ExportPageInput } from '../../shared/audience-export.js';
import type { Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import { listContacts } from './audience.js';

async function exportRevision(sql: Sql, brandId: string) {
  // A changing row version invalidates a multi-request download. Aggregate only
  // opaque IDs and row versions, and stop scanning as soon as the brand is over its cap.
  const { rows } = await sql.query<{ total: number; revision: string }>(
    `
    SELECT count(*)::int AS total,
      encode(sha256(convert_to(coalesce(string_agg(id::text || ':' || version, ',' ORDER BY id), ''), 'UTF8')), 'hex') AS revision
    FROM (SELECT id, xmin::text AS version FROM subscribers WHERE brand_id=$1 LIMIT $2) AS bounded`,
    [brandId, exportLimits.contacts + 1],
  );
  const snapshot = rows[0]!;
  requireCondition(
    snapshot.total <= exportLimits.contacts,
    422,
    'export_limit',
    'This brand has more than 10,000 contacts and exceeds the CSV export limit.',
  );
  return snapshot;
}

// The caller establishes both the owner session and active brand's RLS context.
export async function exportPage(sql: Sql, input: ExportPageInput): Promise<ExportPage> {
  requireCondition(
    Boolean(input.cursor) === Boolean(input.revision),
    422,
    'invalid_export_page',
    'Begin the export again.',
  );
  const before = await exportRevision(sql, input.brandId);
  const changed = 'The audience changed during the export. Begin again to download the current records.';
  requireCondition(!input.revision || before.revision === input.revision, 409, 'export_changed', changed);
  const page = await listContacts(sql, { cursor: input.cursor, limit: exportLimits.page });
  // Reads run at READ COMMITTED. Check again after fetching so changes even within this
  // request cannot be accepted alongside a row set from a different revision.
  const after = await exportRevision(sql, input.brandId);
  requireCondition(before.revision === after.revision, 409, 'export_changed', changed);
  const rows = page.items.map(({ email, state, createdAt, confirmedAt }) => ({
    email,
    state,
    createdAt,
    confirmedAt,
  }));
  return { ...before, rows, nextCursor: page.nextCursor };
}
