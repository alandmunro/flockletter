import { SignupDesignStudio } from './SignupDesignStudio.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { base64, operationKey, type Api } from './api.js';
import { AudienceImportResults, type AudienceImportRow } from './AudienceImportResults.js';
import { importLimits, readImportCsv, type ImportPreviewResult } from '../shared/import-preview.js';
import type { AudienceSettingsView } from '../shared/customer-audience.js';
import { PendingContactApproval } from './PendingContactApproval.js';

type ImportResult = { id: string; rows: AudienceImportRow[] };
type Capture = {
  id: string;
  to: string;
  state: string;
  text: string;
  confirmationUrl: string;
  unsubscribeUrl: string;
};
const explain = (error: unknown) =>
  error instanceof Error ? error.message : 'The audience request could not be completed.';

export function AudienceOnboarding({
  api,
  brandId,
  onChanged,
}: {
  api: Api;
  brandId: string;
  onChanged?: () => void;
}) {
  const [view, setView] = useState<AudienceSettingsView>();
  const [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false),
    [enabled, setEnabled] = useState(false),
    [purpose, setPurpose] = useState('brand_marketing');
  const [version, setVersion] = useState('v1'),
    [consent, setConsent] = useState(''),
    [domain, setDomain] = useState('');
  const [confirmationMode, setConfirmationMode] = useState<'double_opt_in' | 'single_opt_in'>('double_opt_in');
  const [confirmImport, setConfirmImport] = useState(false);
  const [csv, setCsv] = useState(''),
    [headers, setHeaders] = useState<string[]>([]),
    [column, setColumn] = useState(0);
  const [preview, setPreview] = useState<ImportPreviewResult>(),
    [reading, setReading] = useState(false);
  const selection = useRef(0);
  const [source, setSource] = useState(''),
    [permission, setPermission] = useState(false),
    [result, setResult] = useState<ImportResult>();
  const [email, setEmail] = useState(''),
    [affirmed, setAffirmed] = useState(false),
    [capture, setCapture] = useState<Capture>();
  const inFlight = useRef(false),
    pending = useRef(new Map<string, { signature: string; key: string }>());
  useEffect(() => {
    let active = true;
    api
      .call<AudienceSettingsView>('audienceOnboarding.status', { brandId })
      .then((next) => {
        if (!active) return;
        setView(next);
        setEnabled(next.enabled);
        setPurpose(next.purpose);
        setVersion(next.policyVersion);
        setConsent(next.consentText || `Email me newsletters and offers from ${next.brandName}. I can unsubscribe at any time.`);
        setDomain(next.sourceDomain);
        setConfirmationMode(next.confirmationMode ?? 'double_opt_in');
      })
      .catch((cause) => {
        if (active) setError(explain(cause));
      });
    return () => {
      active = false;
    };
  }, [api, brandId, revision]);
  async function change(
    command:
      | 'audienceOnboarding.configure'
      | 'audienceOnboarding.import'
      | 'audienceOnboarding.signup'
      | 'audienceOnboarding.exerciseConfirm'
      | 'audienceOnboarding.requestConfirmation',
    input: Record<string, unknown>,
    message: string,
  ) {
    if (inFlight.current || (command === 'audienceOnboarding.import' && (!preview || !permission || reading)))
      return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const signature = JSON.stringify(input),
      slot = command + ':' + String(input.id ?? input.subscriberId ?? 'form');
    const previous = pending.current.get(slot),
      key = previous?.signature === signature ? previous.key : operationKey();
    pending.current.set(slot, { signature, key });
    try {
      const value = await api.call<ImportResult>(command, { brandId, ...input, operationKey: key });
      pending.current.delete(slot);
      if (command === 'audienceOnboarding.import') setResult(value);
      setNotice(message);
      setRevision((n) => n + 1);
      onChanged?.();
      if (command === 'audienceOnboarding.exerciseConfirm') setCapture(undefined);
    } catch (cause) {
      setError(explain(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function chooseFile(file?: File) {
    const request = ++selection.current;
    setError('');
    setCsv('');
    setHeaders([]);
    setResult(undefined);
    setPermission(false);
    setConfirmImport(false);
    setPreview(undefined);
    setReading(Boolean(file));
    if (!file) return;
    try {
      if (file.size > importLimits.bytes) throw new Error('Choose a CSV file of 1 MiB or less.');
      const parsed = readImportCsv(new Uint8Array(await file.arrayBuffer()));
      const encoded = await base64(file);
      if (request !== selection.current) return;
      setHeaders(parsed.headers);
      setColumn(
        Math.max(
          0,
          parsed.headers.findIndex((header) => /email/i.test(header)),
        ),
      );
      setCsv(encoded);
    } catch (cause) {
      if (request === selection.current) setError(explain(cause));
    } finally {
      if (request === selection.current) setReading(false);
    }
  }
  async function previewFile() {
    if (inFlight.current || !csv) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      setPreview(
        await api.call<ImportPreviewResult>('audience.previewImport', {
          brandId,
          csvBase64: csv,
          emailColumn: column,
        }),
      );
    } catch (cause) {
      setError(explain(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function readCapture(id: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      setCapture(await api.call<Capture>('audienceOnboarding.confirmation', { brandId, id }));
    } catch (cause) {
      setError(explain(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function readImport(id: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      setResult(await api.call<ImportResult>('audienceOnboarding.importResult', { brandId, id }));
    } catch (cause) {
      setError(explain(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const submit = (event: FormEvent, work: () => void) => {
    event.preventDefault();
    work();
  };
  if (!view)
    return (
      <section className="card">
        <h2>Grow your audience</h2>
        {error ? (
          <p role="alert">
            {error}{' '}
            <button
              className="btn secondary"
              onClick={() => {
                setError('');
                setRevision((n) => n + 1);
              }}
            >
              Retry audience setup
            </button>
          </p>
        ) : (
          <p role="status">Loading audience setup…</p>
        )}
      </section>
    );
  return (
    <section className="card audience-onboarding" aria-labelledby="audience-onboarding-heading">
      <h2 id="audience-onboarding-heading">Grow your audience</h2>
      <p>
        Configure a signup page for {view.brandName} and import contacts with permission. Choose whether
        subscribers must confirm by email. Existing unsubscribe and suppression choices are preserved.
      </p>
      {view.mode === 'exercise' && (
        <p className="notice" role="status">
          Staging exercise: confirmation messages are captured here. Exercise confirmations cannot authorize
          production sending. No email is sent.
        </p>
      )}
      {view.mode === 'off' && <p className="notice">Audience onboarding is currently disabled.</p>}
      {error && (
        <p role="alert" className="notice error">
          {error} Retry with the same details to check the original request.
        </p>
      )}
      {notice && (
        <p role="status" className="notice success">
          {notice}
        </p>
      )}
      <details open={!view.enabled}>
        <summary>1. Signup page and consent</summary>
        <form
          onSubmit={(event) =>
            submit(
              event,
              () =>
                void change(
                  'audienceOnboarding.configure',
                  { enabled, purpose, policyVersion: version, consentText: consent, sourceDomain: domain, confirmationMode },
                  'Signup settings saved.',
                ),
            )
          }
        >
          <fieldset disabled={busy || reading || view.mode === 'off'}>
            <label>
              Marketing purpose
              <input
                required
                minLength={3}
                maxLength={120}
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
              />
            </label>
            <label>
              Consent version
              <input required maxLength={80} value={version} onChange={(e) => setVersion(e.target.value)} />
            </label>
            <label>
              Consent shown next to the signup checkbox
              <textarea
                required
                minLength={20}
                maxLength={2000}
                value={consent}
                onChange={(e) => setConsent(e.target.value)}
              />
            </label>
            <p className="help">
              Name the brand and what subscribers will receive. Change the version whenever the wording or
              purpose or confirmation choice changes.
            </p>
            <label>
              <input type="checkbox" checked={confirmationMode === 'double_opt_in'} onChange={e => setConfirmationMode(e.target.checked ? 'double_opt_in' : 'single_opt_in')}/>{' '}
              Require email confirmation for new signups
            </label>
            <p className="help">When off, people who affirm the signup consent are subscribed immediately. No confirmation email is sent and their mailbox is not verified. This does not change existing pending contacts.</p>
            <label>
              Source website domain
              <input
                required
                placeholder="yourstore.com"
                maxLength={253}
                value={domain}
                onChange={(e) => setDomain(e.target.value.toLowerCase())}
              />
            </label>
            <label>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{' '}
              Enable this brand’s signup form
            </label>
            <button className="btn" type="submit">
              Save signup settings
            </button>
          </fieldset>
        </form>
        <p className="help">Saved signup choice: {view.confirmationMode === 'single_opt_in' ? 'subscribe immediately, without email verification' : 'require email confirmation'}. Email open and click tracking is off.</p>
        {view.publicUrl && view.enabled && (
          <a className="btn secondary" href={view.publicUrl} target="_blank" rel="noreferrer">
            Open signup page
          </a>
        )}
      </details>
      <details>
        <summary>2. Import contacts</summary>
        <p>
          Import up to 2,500 rows (1 MiB) from a list that opted in to newsletters from {view.brandName}.
          Record where people signed up, then choose immediate subscription or keep them pending for email confirmation.
        </p>
        <form
          onSubmit={(event) =>
            submit(
              event,
              () =>
                void change(
                  'audienceOnboarding.import',
                  { csvBase64: csv, emailColumn: column, source, permissionAffirmed: true, confirmWithoutEmail: confirmImport, ...(confirmImport ? {consentPolicyVersion: view.policyVersion} : {}) },
                  confirmImport ? 'Import finished. Permission recorded; no confirmation emails sent.' : 'Import finished. Review the results and request confirmations for pending contacts.',
                ),
            )
          }
        >
          <fieldset disabled={busy || reading || view.mode === 'off'}>
            <label>
              CSV with a header row
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => void chooseFile(e.target.files?.[0])}
              />
            </label>
            {headers.length > 0 && (
              <label>
                Email column
                <select
                  value={column}
                  onChange={(e) => {
                    setColumn(Number(e.target.value));
                    setPreview(undefined);
                    setPermission(false);
                    setConfirmImport(false);
                  }}
                >
                  {headers.map((header, index) => (
                    <option key={index} value={index}>
                      {index + 1}. {header || 'Unnamed column'}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              type="button"
              className="btn secondary"
              disabled={!csv}
              onClick={() => void previewFile()}
            >
              Preview import
            </button>
            {preview && (
              <p role="status">
                {preview.rows} rows · {preview.newContacts} new · {preview.pending} pending ·{' '}
                {preview.confirmed} confirmed · {preview.suppressed} suppressed · {preview.duplicates}{' '}
                duplicate · {preview.invalid} invalid. Existing choices are preserved.
              </p>
            )}
            <label>
              How did these contacts give permission?
              <input
                required
                minLength={3}
                maxLength={250}
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="In-store newsletter signup, November 2026"
              />
            </label>
            <label>
              <input
                type="checkbox"
                required
                checked={permission}
                onChange={(e) => setPermission(e.target.checked)}
              />{' '}
              I have permission to contact these people on behalf of this brand.
            </label>
            <label><input type="checkbox" checked={confirmImport} disabled={!view.enabled} onChange={e => setConfirmImport(e.target.checked)}/>{' '}
              Subscribe imported contacts immediately without a confirmation email
            </label>
            <p className="help">{view.enabled
              ? <>Your certification uses {view.brandName}’s saved consent policy ({view.policyVersion}). Previously unsubscribed, bounced or complained addresses stay excluded.</>
              : 'To certify contacts during import, save and enable this brand’s consent policy in step 1 first.'}</p>
            <button className="btn" disabled={!csv || !permission || !preview || (confirmImport && !view.enabled)} type="submit">
              {confirmImport ? 'Import and subscribe without email' : 'Import as pending'}
            </button>
          </fieldset>
        </form>
        {(view.imports ?? []).length > 0 && (
          <>
            <h3>Recent imports</h3>
            <ul>
              {view.imports.map((item) => (
                <li key={item.id}>
                  {item.source} · {item.rows} rows{' '}
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => void readImport(item.id)}
                  >
                    Review saved import
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {result && (
          <AudienceImportResults
            key={result.id}
            rows={result.rows}
            disabled={busy || !view.enabled}
            onRequestConfirmation={(subscriberId) =>
              void change(
                'audienceOnboarding.requestConfirmation',
                { subscriberId },
                'Confirmation prepared for this pending contact.',
              )
            }
          />
        )}
      </details>
      <PendingContactApproval key={brandId} api={api} brandId={brandId} policyVersion={view.policyVersion} enabled={view.enabled && view.mode !== 'off'} onChanged={() => { setRevision(n => n + 1); onChanged?.(); }}/>
      <SignupDesignStudio key={brandId} api={api} view={view}/>
      {view.mode === 'exercise' && (
        <details>
          <summary>3. Exercise signup and confirmation</summary>
          <form
            onSubmit={(event) =>
              submit(
                event,
                () =>
                  void change(
                    'audienceOnboarding.signup',
                    { email, policyVersion: view.policyVersion, consentAffirmed: true },
                    'Signup received. If eligible, its confirmation appears below.',
                  ),
              )
            }
          >
            <fieldset disabled={busy || !view.enabled}>
              <label>
                Test email address
                <input
                  type="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  required
                  checked={affirmed}
                  onChange={(e) => setAffirmed(e.target.checked)}
                />{' '}
                {view.consentText || 'Save the consent wording first.'}
              </label>
              <button className="btn" type="submit" disabled={!affirmed}>
                Exercise signup
              </button>
            </fieldset>
          </form>
          <h3>{view.mode==='exercise'?'Captured confirmations':'Confirmation delivery'}</h3>
          {!view.messages.length && <p>No confirmation messages yet.</p>}
          <ul>
            {view.messages.map((message) => (
              <li key={message.id}>
                {message.email} · {message.state}{' '}
                {message.transport&&<span>· Mail: {message.transport.kind.replaceAll('_',' ')} <time dateTime={message.transport.occurredAt}>{new Date(message.transport.occurredAt).toLocaleString()}</time>{' '}</span>}
                {message.mode === 'exercise' && (
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy}
                    onClick={() => void readCapture(message.id)}
                  >
                    Inspect captured message
                  </button>
                )}
              </li>
            ))}
          </ul>
          {capture && (
            <section aria-label="Captured confirmation" className="notice">
              <h3>To {capture.to}</h3>
              <p>{capture.text}</p>
              <p>Status: {capture.state}</p>
              <div className="actions">
                <a className="btn secondary" href={capture.confirmationUrl} target="_blank" rel="noreferrer">
                  Open confirmation page
                </a>
                <a className="btn secondary" href={capture.unsubscribeUrl} target="_blank" rel="noreferrer">
                  Open unsubscribe page
                </a>
                <button
                  className="btn"
                  disabled={busy || capture.state === 'confirmed' || capture.state === 'cancelled'}
                  onClick={() =>
                    void change(
                      'audienceOnboarding.exerciseConfirm',
                      { id: capture.id },
                      'Exercise subscription confirmed. It remains excluded from production sending.',
                    )
                  }
                >
                  Confirm as an exercise
                </button>
                <button className="btn secondary" onClick={() => setCapture(undefined)}>
                  Close captured message
                </button>
              </div>
            </section>
          )}
        </details>
      )}
    </section>
  );
}
