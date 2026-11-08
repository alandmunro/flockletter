export type AudienceImportRow = { row: number; outcome: string; subscriberId?: string };

export function AudienceImportResults({
  rows,
  disabled,
  onRequestConfirmation,
}: {
  rows: AudienceImportRow[];
  disabled: boolean;
  onRequestConfirmation: (id: string) => void;
}) {
  const counts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.outcome] = (acc[row.outcome] ?? 0) + 1;
    return acc;
  }, {});

  if (!rows.length) {
    return (
      <div role="region" aria-label="Import results" tabIndex={0} style={{ overflowX: 'auto' }}>
        <p>No data rows to import.</p>
      </div>
    );
  }

  return (
    <div role="region" aria-label="Import results" tabIndex={0} style={{ overflowX: 'auto' }}>
      <p role="status">
        {Object.entries(counts)
          .map(([outcome, count]) => `${count} ${outcome.replaceAll('_', ' ')}`)
          .join(' · ')}
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">CSV row</th>
            <th scope="col">Result</th>
            <th scope="col">Next step</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.row}>
              <td>{row.row}</td>
              <td>{row.outcome.replaceAll('_', ' ')}</td>
              <td>
                {row.subscriberId && ['pending_added', 'kept_pending'].includes(row.outcome) ? (
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={disabled}
                    onClick={() => onRequestConfirmation(row.subscriberId!)}
                  >
                    Request confirmation
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
