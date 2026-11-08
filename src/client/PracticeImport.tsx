import { useRef, useState } from 'react';
import { practiceImportDeclaration, practiceImportDeclarationText, type ApplyImportResult } from '../shared/import-preview.js';
import type { Brand } from '../shared/contracts.js';
import { base64, operationKey, type Api } from './api.js';
import { ApplyImportResults } from './ApplyImportResults.js';

export function PracticeImport({ api, brand, file, column, onApplied }: {
  api: Api; brand: Brand; file: File; column: number; onApplied: () => void;
}) {
  const key = useRef<string | null>(null);
  const [permission, setPermission] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<ApplyImportResult>();
  const [error, setError] = useState('');

  async function apply() {
    if (!permission || busy || receipt) return;
    key.current ??= operationKey();
    setBusy(true);
    setError('');
    try {
      const value = await api.call<ApplyImportResult>('audience.applyPracticeImport', {
        brandId: brand.id, csvBase64: await base64(file), emailColumn: column,
        operationKey: key.current, declaration: practiceImportDeclaration,
      });
      setReceipt(value);
      onApplied();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The import did not finish. Retry this file.');
    } finally {
      setBusy(false);
    }
  }
  if (receipt) return <ApplyImportResults result={receipt} />;
  return <section>
    <h3>Practice import</h3>
    <p>For {brand.name}, new addresses ending in .test will appear as pending. Other domains are skipped.
      Existing subscription choices are preserved. This action sends no email.</p>
    <label><input type="checkbox" checked={permission} disabled={busy}
      onChange={(event) => setPermission(event.target.checked)} /> {practiceImportDeclarationText}</label>
    <div className="actions">
      <button type="button" className="btn" disabled={busy || !permission} onClick={() => void apply()}>
        {busy ? 'Applying import…' : 'Apply practice import'}
      </button>
    </div>
    {error && <p role="alert" className="notice error">{error}</p>}
  </section>;
}
