import { useEffect, useRef, useState } from 'react';
import type { Brand } from '../shared/contracts.js';
import type { ExportPage } from '../shared/audience-export.js';
import type { Api } from './api.js';
import { collectContactCsv } from './contact-export.js';

export function AudienceExport({ api, brand }: { api: Api; brand: Brand }) {
  const operation = useRef<AbortController | null>(null);
  const fileUrl = useRef<string | null>(null);
  const [ready, setReady] = useState<{ url: string; contacts: number }>();
  const [loading, setLoading] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  useEffect(
    () => () => {
      operation.current?.abort();
      if (fileUrl.current) URL.revokeObjectURL(fileUrl.current);
    },
    [],
  );
  function clear() {
    operation.current?.abort();
    if (fileUrl.current) {
      URL.revokeObjectURL(fileUrl.current);
      fileUrl.current = null;
    }
    setReady(undefined);
    setLoading(false);
    setMessage('');
    setError('');
  }
  async function prepare() {
    clear();
    const run = new AbortController();
    operation.current = run;
    setLoading(true);
    setMessage('Preparing the export…');
    try {
      const { file, contacts } = await collectContactCsv(
        (cursor, revision) =>
          api.call<ExportPage>('audience.exportPage', { brandId: brand.id, cursor, revision }),
        run.signal,
        (count, total) =>
          setMessage('Prepared ' + count.toLocaleString() + ' of ' + total.toLocaleString() + ' contacts.'),
      );
      if (!run.signal.aborted) {
        fileUrl.current = URL.createObjectURL(file);
        setReady({ url: fileUrl.current, contacts });
        setMessage('The complete file is ready.');
      }
    } catch (cause) {
      if (!run.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'The export failed. Begin again.');
        setMessage('');
      }
    } finally {
      if (!run.signal.aborted) {
        setLoading(false);
        operation.current = null;
      }
    }
  }
  return (
    <details
      className="card"
      onToggle={(event) => {
        if (!event.currentTarget.open) clear();
      }}
    >
      <summary>Export brand contacts</summary>
      <p>
        Download up to 10,000 email addresses for {brand.name}, with their current status, date added and
        confirmation date. Keep this private file with the people authorized to manage this brand.
      </p>
      {!ready && (
        <button type="button" className="btn secondary" onClick={() => void prepare()} disabled={loading}>
          Prepare export
        </button>
      )}
      {loading && (
        <button type="button" className="btn secondary" onClick={clear}>
          Cancel export
        </button>
      )}
      {message && <p role="status">{message}</p>}
      {ready && (
        <div className="actions">
          <a
            className="btn"
            href={ready.url}
            download={'flockletter-contacts-' + new Date().toISOString().slice(0, 10) + '.csv'}
          >
            Download CSV ({ready.contacts.toLocaleString()} contacts)
          </a>
          <button type="button" className="btn secondary" onClick={clear}>
            Discard file
          </button>
        </div>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
