import { Fragment, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  importLimits,
  readImportCsv,
  type ImportIssue,
  type ImportPreviewResult,
} from '../shared/import-preview.js';
import type { Brand } from '../shared/contracts.js';
import { base64, type Api } from './api.js';
import { PracticeImport } from './PracticeImport.js';

const issueLabels: Record<ImportIssue, string> = {
  invalid_email: 'Invalid or missing email address',
  duplicate: 'Duplicate address within this file',
  column_count: 'Column count differs from the header',
};

function PreviewResults({ result }: { result: ImportPreviewResult }) {
  const metrics: [string, number][] = [
    ['Data rows', result.rows],
    ['New addresses', result.newContacts],
    ['Already confirmed', result.confirmed],
    ['Pending confirmation', result.pending],
    ['Already suppressed', result.suppressed],
    ['Duplicate rows', result.duplicates],
    ['Invalid rows', result.invalid],
  ];
  return (
    <section aria-label="CSV preview results">
      <h3>Preview results</h3>
      <dl className="intake-metrics">
        {metrics.map(([name, count]) => (
          <Fragment key={name}>
            <dt>{name}</dt>
            <dd>{count.toLocaleString()}</dd>
          </Fragment>
        ))}
      </dl>
      {result.examples.length > 0 && (
        <>
          <h4>Rows to review</h4>
          <ol>
            {result.examples.map((item) => (
              <li key={item.row}>
                Row {item.row} — {issueLabels[item.issue]}
              </li>
            ))}
          </ol>
          {result.invalid + result.duplicates > result.examples.length && (
            <p>Showing the first {result.examples.length} rows that need attention.</p>
          )}
        </>
      )}
    </section>
  );
}

export function ImportPreview({ api, brand, onApplied }: { api: Api; brand: Brand; onApplied: () => void }) {
  const fileId = useId(),
    columnId = useId();
  const fileControl = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const [selection, setSelection] = useState<{ file: File; headers: string[] }>();
  const [column, setColumn] = useState(0);
  const [reading, setReading] = useState(false),
    [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportPreviewResult>();
  const [error, setError] = useState('');
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  async function chooseFile(file?: File) {
    const attempt = ++request.current;
    setSelection(undefined);
    setColumn(0);
    setResult(undefined);
    setError('');
    setBusy(false);
    setReading(Boolean(file));
    if (!file) return;
    try {
      if (file.size > importLimits.bytes) throw new Error('Choose a CSV file of 1 MiB or less.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { headers } = readImportCsv(bytes);
      if (attempt !== request.current) return;
      const suggested = headers.findIndex((header) =>
        /^(?:e[- ]?mail(?:[ _-]address)?)$/i.test(header.trim()),
      );
      setSelection({ file, headers });
      setColumn(suggested < 0 ? 0 : suggested);
    } catch (cause) {
      if (attempt === request.current)
        setError(cause instanceof Error ? cause.message : 'The CSV file could not be read.');
    } finally {
      if (attempt === request.current) setReading(false);
    }
  }
  function clear() {
    if (fileControl.current) fileControl.current.value = '';
    void chooseFile();
  }
  async function preview(event: FormEvent) {
    event.preventDefault();
    if (!selection || busy) return;
    const attempt = ++request.current;
    setBusy(true);
    setResult(undefined);
    setError('');
    try {
      const contents = await base64(selection.file);
      if (attempt !== request.current) return;
      const value = await api.call<ImportPreviewResult>('audience.previewImport', {
        brandId: brand.id,
        csvBase64: contents,
        emailColumn: column,
      });
      if (attempt === request.current) setResult(value);
    } catch (cause) {
      if (attempt === request.current)
        setError(
          cause instanceof Error ? cause.message : 'The preview could not finish. Retry with the same file.',
        );
    } finally {
      if (attempt === request.current) setBusy(false);
    }
  }
  return (
    <details
      className="card"
      onToggle={(event) => {
        if (!event.currentTarget.open) clear();
      }}
    >
      <summary>Preview a contact CSV</summary>
      <p>
        Choose a UTF-8 CSV with a header and up to 2,500 data rows (1 MiB). Select Preview CSV to send the
        file to Flockletter for a read-only comparison with {brand.name}.
      </p>
      <form onSubmit={preview}>
        <label htmlFor={fileId}>CSV file</label>
        <input
          id={fileId}
          type="file"
          accept=".csv,text/csv"
          ref={fileControl}
          onChange={(event) => void chooseFile(event.target.files?.[0])}
        />
        {reading && <p role="status">Reading the file…</p>}
        {selection && (
          <>
            <label htmlFor={columnId}>Email column</label>
            <select
              id={columnId}
              value={column}
              disabled={busy}
              onChange={(event) => {
                setColumn(Number(event.target.value));
                setResult(undefined);
                setError('');
              }}
            >
              {selection.headers.map((name, index) => (
                <option key={index} value={index}>
                    Column {index + 1} · {name.trim().slice(0, 80) || 'Unnamed'}
                </option>
              ))}
            </select>
          </>
        )}
        <div className="actions">
          <button type="submit" className="btn" disabled={!selection || reading || busy}>
            {busy ? 'Checking…' : 'Preview CSV'}
          </button>
          {(selection || error || reading) && (
            <button type="button" className="btn secondary" onClick={clear}>
              Clear file
            </button>
          )}
        </div>
      </form>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {result && (
        <>
          <p role="status">Preview complete.</p>
          <PreviewResults result={result} />
          {result.practiceRowLimit && selection && (result.rows > 0 && result.rows <= result.practiceRowLimit
            ? <PracticeImport api={api} brand={brand} file={selection.file} column={column} onApplied={onApplied} />
            : <p>Practice imports accept 1 to {result.practiceRowLimit} data rows at a time.</p>)}
        </>
      )}
    </details>
  );
}
