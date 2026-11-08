import type { RetentionCase } from '../shared/customer-retention.js';

export function RetentionInventory({ record }: { record: RetentionCase }) {
  const entries = Object.entries(record.inventory).sort(([a], [b]) => a.localeCompare(b));
  return (
    <details>
      <summary>Review stored account records</summary>
      {entries.length === 0 ? (
        <p>No application records were listed in the last inventory.</p>
      ) : (
        <table>
          <caption>Application inventory at last review</caption>
          <thead>
            <tr>
              <th scope="col">Record store</th>
              <th scope="col">Records</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([store, count]) => (
              <tr key={store}>
                <td>{store.replaceAll('_', ' ')}</td>
                <td>{count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        Provider, engine and export copies require separate operator review. The inventory includes tenant
        data, drafts, images, consent records and durable operation history.
      </p>
    </details>
  );
}
