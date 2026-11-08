import { z } from 'zod';

export const importLimits = { bytes: 256 * 1024, rows: 1000, columns: 64, issueExamples: 10 } as const;
export const importPreviewInput = z
  .object({
    brandId: z.uuid().toLowerCase(),
    csvBase64: z
      .string()
      .min(4)
      .max(4 * Math.ceil(importLimits.bytes / 3)),
    emailColumn: z
      .number()
      .int()
      .min(0)
      .max(importLimits.columns - 1),
  })
  .strict();
export type ImportPreviewInput = z.infer<typeof importPreviewInput>;
export const practiceImportRows = 250;
export const practiceImportDeclaration = 'fictional-contact-permission-v1' as const;
export const practiceImportDeclarationText = 'I have permission to contact these fictional addresses on behalf of this brand.';
export const applyImportInput = importPreviewInput.extend({
  operationKey: z.uuid(),
  declaration: z.literal(practiceImportDeclaration),
});
export type ApplyImportInput = z.infer<typeof applyImportInput>;
export type ImportIssue = 'invalid_email' | 'column_count' | 'duplicate';
export type ApplyOutcome = ImportIssue | 'pending_added' | 'kept_pending' | 'kept_confirmed' |
  'kept_suppressed' | 'reserved_domain_required' | 'contact_limit';
export type ApplyImportResult = {
  brandId: string;
  source: 'practice_csv';
  declaration: typeof practiceImportDeclaration;
  rows: { row: number; outcome: ApplyOutcome; subscriberId?: string }[];
};
export type ImportPreviewResult = {
  rows: number;
  invalid: number;
  duplicates: number;
  newContacts: number;
  confirmed: number;
  pending: number;
  suppressed: number;
  examples: { row: number; issue: ImportIssue }[];
  practiceRowLimit?: number;
};

export function parseImportCsv(text: string): string[][] {
  if (new TextEncoder().encode(text).length > importLimits.bytes)
    throw new Error('Choose a CSV file of 256 KiB or less.');
  if (text.includes('\0')) throw new Error('The CSV contains an invalid control character.');
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    mode: 'plain' | 'quoted' | 'closed' = 'plain';
  let hasRecord = false;
  function finishCell() {
    if (row.length === importLimits.columns) throw new Error('Use 64 columns or fewer.');
    row.push(cell);
    cell = '';
    mode = 'plain';
  }
  function finishRecord() {
    finishCell();
    if (rows.length === importLimits.rows + 1) throw new Error('Choose a CSV with at most 1,000 data rows.');
    rows.push(row);
    row = [];
    hasRecord = false;
  }
  for (let i = text.startsWith('\uFEFF') ? 1 : 0; i < text.length; i++) {
    const ch = text[i]!;
    if (mode === 'quoted') {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else mode = 'closed';
    } else if (ch === ',') {
      finishCell();
      hasRecord = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      finishRecord();
    } else {
      if (mode === 'closed' || (ch === '"' && cell.length)) throw new Error('Review the quotes in the CSV.');
      hasRecord = true;
      if (ch === '"') mode = 'quoted';
      else cell += ch;
    }
  }
  if (mode === 'quoted') throw new Error('Close every quoted field in the CSV.');
  if (hasRecord) finishRecord();
  return rows;
}

export function readImportCsv(bytes: Uint8Array) {
  if (bytes.byteLength > importLimits.bytes) throw new Error('Choose a CSV file of 256 KiB or less.');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('Save the CSV as UTF-8 and try again.');
  }
  const rows = parseImportCsv(text);
  const headers = rows[0];
  if (!headers || !headers.some((header) => header.trim()))
    throw new Error('Include a header row in the CSV.');
  return { headers, rows: rows.slice(1) };
}
