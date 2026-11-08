import { useEffect, useId, useRef, useState } from 'react';
import { operationKey, type Api } from './api.js';
import type { Brand } from '../shared/contracts.js';
import type { DeliveryReadiness, SenderStatus } from '../shared/sender.js';
export function SenderDomain({ api, brand }: { api: Api; brand: Brand }) {
  const [value, setValue] = useState(''),
    [status, setStatus] = useState<SenderStatus>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const input = useId(),
    key = useRef(operationKey());
  const [report, setReport] = useState<DeliveryReadiness>();
  const selected = useRef(brand.id);
  useEffect(() => {
    selected.current = brand.id;
    setReport(undefined);
    let current = true;
    api
      .call<SenderStatus>('sender.status', { brandId: brand.id })
      .then((item) => {
        if (current) {
          setStatus(item);
          setValue(item.domain ?? '');
        }
      })
      .catch(() => {
        if (current) setError('Could not load the domain.');
      });
    return () => {
      current = false;
    };
  }, [api, brand.id]);
  async function apply(check: boolean) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api.call<SenderStatus & { lookupUnavailable?: boolean }>(
        check ? 'sender.verify' : 'sender.register',
        check
          ? { brandId: brand.id, operationKey: key.current }
          : { brandId: brand.id, domain: value, operationKey: key.current },
      );
      key.current = operationKey();
      setStatus(next);
      setReport(undefined);
      setValue(next.domain ?? '');
      if (next.lookupUnavailable) setError('The DNS lookup was unavailable. Retry in one minute.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check the domain.');
    } finally {
      setBusy(false);
    }
  }
  async function checkProvider() {
    setBusy(true);
    setError('');
    try {
      const result = await api.call<DeliveryReadiness>('sender.deliveryReadiness', { brandId: brand.id });
      if (selected.current === brand.id) setReport(result);
    } catch (err) {
      if (selected.current === brand.id)
        setError(err instanceof Error ? err.message : 'Could not inspect delivery setup.');
    } finally {
      if (selected.current === brand.id) setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>Sending domain for {brand.name}</h2>
      <p>
        Prove ownership by adding the TXT record below to your DNS. Delivery-provider authentication is a
        separate step.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void apply(false);
        }}
      >
        <label htmlFor={input}>Domain name</label>
        <input
          id={input}
          required
          maxLength={253}
          value={value}
          placeholder="yourshop.com"
          onChange={(e) => {
            setValue(e.target.value);
            key.current = operationKey();
          }}
        />
        <button type="submit" className="btn secondary" disabled={busy}>
          Save domain
        </button>
      </form>
      {status?.domain && (
        <>
          <p>
            <strong>
              {status.status === 'ownership_verified' ? 'Ownership verified' : 'Awaiting ownership record'}
            </strong>
          </p>
          {status.checkedAt && <p>Last DNS check {new Date(status.checkedAt).toLocaleString()}.</p>}
          <dl>
            <dt>TXT record name</dt>
            <dd>
              <code>{status.recordName}</code>
            </dd>
            <dt>TXT record value</dt>
            <dd>
              <code>{status.recordValue}</code>
            </dd>
          </dl>
          <button type="button" className="btn" disabled={busy} onClick={() => void apply(true)}>
            Check DNS record
          </button>
        </>
      )}
      <h3>Delivery readiness</h3>
      <button type="button" className="btn secondary" disabled={busy} onClick={() => void checkProvider()}>
        Check delivery setup
      </button>
      {report && (
        <div>
          <p role="status">
            {report.simulatorConfigured
              ? 'Configured for an AWS simulator test.'
              : 'Setup is incomplete for the AWS simulator.'}{' '}
            Customer delivery is disabled on staging.
          </p>
          {report.providerCheckedAt && (
            <p>Provider checked {new Date(report.providerCheckedAt).toLocaleString()}.</p>
          )}
          <ul>
            {report.checks.map((check) => (
              <li key={check.label}>
                <strong>{check.label}</strong> ·{' '}
                {check.state === 'ready'
                  ? 'Ready'
                  : check.state === 'unverified'
                    ? 'Unverified'
                    : 'Action needed'}
                {check.state !== 'ready' && <div>{check.detail}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
