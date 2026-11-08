import { exportLimits, type ExportPage } from '../shared/audience-export.js';

function csvCell(value: string) {
  // Spreadsheet programs can interpret formula markers in quoted CSV fields.
  const safe = /^[\t\r\n]/u.test(value) || /^\s*[=+\-@＝＋－＠]/u.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export async function collectContactCsv(
  readPage: (cursor?: string, revision?: string) => Promise<ExportPage>,
  signal: AbortSignal,
  progress: (prepared: number, total: number) => void = () => {},
): Promise<{ file: Blob; contacts: number }> {
  const parts = ['\uFEFF"Email","Status","Added at (UTC)","Confirmed at (UTC)"\r\n'];
  const cursors = new Set<string>();
  let cursor: string | undefined,
    revision: string | undefined,
    total: number | undefined,
    count = 0;
  do {
    signal.throwIfAborted();
    const page = await readPage(cursor, revision);
    signal.throwIfAborted();
    if (page.total > exportLimits.contacts)
      throw new Error('This brand exceeds the 10,000-contact export limit.');
    if (
      !Number.isInteger(page.total) ||
      page.total < 0 ||
      page.rows.length > exportLimits.page ||
      (revision !== undefined && (revision !== page.revision || total !== page.total))
    ) {
      throw new Error('The export changed during preparation. Begin again.');
    }
    revision = page.revision;
    total = page.total;
    for (const row of page.rows)
      parts.push(
        [row.email, row.state, row.createdAt, row.confirmedAt ?? ''].map(csvCell).join(',') + '\r\n',
      );
    count += page.rows.length;
    if (
      count > total ||
      (page.nextCursor &&
        (cursors.has(page.nextCursor) || page.rows.length !== exportLimits.page || count >= total))
    ) {
      throw new Error('The export page is incomplete. Begin again.');
    }
    progress(count, total);
    cursor = page.nextCursor ?? undefined;
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (count !== total) throw new Error('The export is incomplete. Begin again.');
  return { file: new Blob(parts, { type: 'text/csv;charset=utf-8' }), contacts: count };
}
