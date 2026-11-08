import type { SubscriberState } from '../../shared/audience.js';
import {
  importLimits,
  readImportCsv,
  type ImportIssue,
  type ImportPreviewInput,
  type ImportPreviewResult,
} from '../../shared/import-preview.js';
import { normalizedEmail } from '../../shared/subscriber.js';
import type { Sql } from '../db.js';
import { AppError, requireCondition } from '../errors.js';

type CsvRow = { row: number; address: string } | { row: number; issue: ImportIssue };

export function importRows(input: ImportPreviewInput): CsvRow[] {
  const bytes = Buffer.from(input.csvBase64, 'base64');
  requireCondition(
    bytes.length <= importLimits.bytes,
    413,
    'csv_too_large',
    'Choose a CSV file of 256 KiB or less.',
  );
  requireCondition(
    bytes.toString('base64') === input.csvBase64,
    422,
    'invalid_csv',
    'Upload a valid UTF-8 CSV file.',
  );
  let csv;
  try {
    csv = readImportCsv(bytes);
  } catch (error) {
    // Shared parser errors describe syntax or limits and never include file contents.
    throw new AppError(422, 'invalid_csv', error instanceof Error ? error.message : 'Review the CSV format.');
  }
  const heading = csv.headers[input.emailColumn]?.trim();
  requireCondition(
    heading && !normalizedEmail.safeParse(heading).success,
    422,
    'invalid_email_column',
    'Choose an email column from a CSV with a named header row.',
  );
  const unique = new Set<string>();
  return csv.rows.map((cells, index): CsvRow => {
    const row = index + 2; // Spreadsheet row number, with the header at row one.
    if (cells.length !== csv.headers.length) return { row, issue: 'column_count' };
    const address = normalizedEmail.safeParse(cells[input.emailColumn]);
    if (!address.success) return { row, issue: 'invalid_email' };
    if (unique.has(address.data)) return { row, issue: 'duplicate' };
    unique.add(address.data);
    return { row, address: address.data };
  });
}

export async function previewImport(sql: Sql, input: ImportPreviewInput): Promise<ImportPreviewResult> {
  const parsed = importRows(input);
  const result: ImportPreviewResult = {
    rows: parsed.length, invalid: 0, duplicates: 0, newContacts: 0,
    confirmed: 0, pending: 0, suppressed: 0, examples: [],
  };
  const addresses: string[] = [];
  for (const item of parsed) {
    if ('address' in item) addresses.push(item.address);
    else {
      if (item.issue === 'duplicate') result.duplicates++;
      else result.invalid++;
      if (result.examples.length < importLimits.issueExamples) result.examples.push(item);
    }
  }
  result.newContacts = addresses.length;
  if (!addresses.length) return result;
  // Called only inside the authorized workspace and brand's RLS transaction.
  const { rows } = await sql.query<{ state: SubscriberState; count: number }>(
    `
    SELECT state, count(*)::int AS count FROM subscribers
    WHERE brand_id=$1 AND email_normalized=ANY($2::text[]) GROUP BY state`,
    [input.brandId, addresses],
  );
  for (const { state, count } of rows) {
    result.newContacts -= count;
    if (state === 'confirmed' || state === 'pending') result[state] += count;
    else result.suppressed += count;
  }
  return result;
}
