import { normalizeUsPhone } from '../../shared/texting.js';
import { contactUpdate } from '../../shared/audience.js';
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

type ImportedDate = { month: number; day: number; year?: number };
type ImportProfile = { firstName?: string; lastName?: string; phone?: string; birthday?: ImportedDate; anniversary?: ImportedDate };
type CsvRow = { row: number; address: string; profile?: ImportProfile } | { row: number; issue: ImportIssue };

function parseDate(raw: string, anniversary: boolean) {
  const match = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(raw);
  if (!match || (!anniversary && match[1])) return null;
  const [year, month, day] = [match[1] ? Number(match[1]) : undefined, Number(match[2]), Number(match[3])];
  const date = { month, day, ...(year ? { year } : {}) };
  const parsed = (anniversary ? contactUpdate.anniversary : contactUpdate.birthday).safeParse(date);
  if (!parsed.success || (match[1] && (!year || new Date(Date.UTC(year, month - 1, day)).getUTCMonth() !== month - 1))) return null;
  return date;
}

function parseProfile(cells: string[], columns: NonNullable<ImportPreviewInput['profileColumns']>): ImportProfile | ImportIssue {
  const value = (key: keyof typeof columns) => columns[key] === undefined ? '' : cells[columns[key]]!.trim();
  const profile: ImportProfile = {};
  for (const field of ['firstName', 'lastName'] as const) {
    const name = value(field);
    if (!name) continue;
    if (!contactUpdate[field].safeParse(name).success || /[\p{Cc}\p{Cf}]/u.test(name)) return 'invalid_name';
    profile[field] = name;
  }
  const inputPhone = value('phone');
  if (inputPhone) {
    const phone = normalizeUsPhone(inputPhone);
    if (!phone) return 'invalid_phone';
    profile.phone = phone;
  }
  for (const field of ['birthday', 'anniversary'] as const) {
    const raw = value(field);
    if (!raw) continue;
    const date = parseDate(raw, field === 'anniversary');
    if (!date) return 'invalid_date';
    profile[field] = date;
  }
  return profile;
}

export function importRows(input: ImportPreviewInput): CsvRow[] {
  const bytes = Buffer.from(input.csvBase64, 'base64');
  requireCondition(
    bytes.length <= importLimits.bytes,
    413,
    'csv_too_large',
    'Choose a CSV file of 1 MiB or less.',
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
  const mapped = [input.emailColumn, ...Object.values(input.profileColumns ?? {})];
  requireCondition(mapped.every(index => index !== undefined && csv.headers[index]?.trim()) &&
    new Set(mapped).size === mapped.length, 422, 'invalid_profile_columns', 'Map each field to a different named column.');
  const unique = new Set<string>();
  return csv.rows.map((cells, index): CsvRow => {
    const row = index + 2; // Spreadsheet row number, with the header at row one.
    if (cells.length !== csv.headers.length) return { row, issue: 'column_count' };
    const address = normalizedEmail.safeParse(cells[input.emailColumn]);
    if (!address.success) return { row, issue: 'invalid_email' };
    if (unique.has(address.data)) return { row, issue: 'duplicate' };
    const profile = input.profileColumns ? parseProfile(cells, input.profileColumns) : undefined;
    if (typeof profile === 'string') return { row, issue: profile };
    unique.add(address.data);
    return { row, address: address.data, ...(profile ? { profile } : {}) };
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
