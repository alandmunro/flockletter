import type { ApplyImportResult, ApplyOutcome } from '../shared/import-preview.js';

const outcomeLabel: Record<ApplyOutcome, string> = {
  pending_added: 'Added as pending',
  kept_pending: 'Already pending',
  kept_confirmed: 'Already confirmed',
  kept_suppressed: 'Suppression preserved',
  duplicate: 'Duplicate in this file',
  invalid_email: 'Invalid email address',
  column_count: 'Column count differs from the header',
  reserved_domain_required: 'Skipped domain outside .test',
  contact_limit: 'Workspace practice storage is full',
};

export function ApplyImportResults({ result }: { result: ApplyImportResult }) {
  const added = result.rows.filter((row) => row.outcome === 'pending_added').length;
  return <section aria-label="Practice import results">
    <h3>Practice import results</h3>
    <p role="status">{added} {added === 1 ? 'contact added' : 'contacts added'} as pending. No email was sent.</p>
    <details>
      <summary>View all {result.rows.length} row outcomes</summary>
      <table aria-label="Applied import row outcomes">
        <thead><tr><th scope="col">Row</th><th scope="col">Result</th></tr></thead>
        <tbody>{result.rows.map((item) => (
          <tr key={item.row}><td>{item.row}</td><td>{outcomeLabel[item.outcome]}</td></tr>
        ))}</tbody>
      </table>
    </details>
  </section>;
}
