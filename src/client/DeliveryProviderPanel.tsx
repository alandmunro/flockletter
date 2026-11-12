import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Api } from './api.js';
import { operationKey } from './api.js';
import type { DeliveryProviders, SendingProvider } from '../shared/customer-delivery.js';

type Choice = DeliveryProviders['choices'][number];
const providerLabels: Record<SendingProvider, string> = { ses: 'AWS SES', resend: 'Resend' };

export function DeliveryProviderPanel({ api, brandId, onChanged }: { api: Api; brandId: string; onChanged?:()=>void }) {
  const id = useId();
  const [providers, setProviders] = useState<DeliveryProviders | null>(null);
  const [selected, setSelected] = useState<SendingProvider>('ses');
  const [error, setError] = useState('');
  const [notice,setNotice]=useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const attempt = useRef<{ provider: SendingProvider; revision: number; key: string } | null>(null);

  const load = useCallback(async () => {
    const current = ++request.current;
    try {
      const result = await api.call<DeliveryProviders>('delivery.providers', { brandId });
      if (current !== request.current) return;
      setProviders(result);
      setSelected(result.selected ?? 'ses');
      setError('');
    } catch (err) {
      if (current !== request.current) return;
      setError(err instanceof Error ? err.message : 'Sending services could not load.');
    }
  }, [api, brandId]);

  useEffect(() => {
    void load().catch(() => {});
    return () => { request.current++; };
  }, [load]);

  function refresh() {
    setBusy(true);
    setError('');
    void load().finally(() => setBusy(false));
  }

  async function save() {
    if (!providers) return;
    const current = ++request.current;
    setBusy(true);
    setError('');
    const key = attempt.current?.provider === selected && attempt.current.revision === providers.revision ? attempt.current.key : operationKey();
    attempt.current = { provider: selected, revision: providers.revision, key };
    try {
      const result = await api.call<DeliveryProviders>('delivery.selectProvider', {
        operationKey: key, brandId, provider: selected, expectedRevision: providers.revision,
      });
      if (current !== request.current) return;
      setProviders(result);
      setSelected(result.selected ?? selected);
      setNotice('Sending service saved. Prepare a fresh campaign review before sending.');
      onChanged?.();
      attempt.current = null;
    } catch (err) {
      if (current !== request.current) return;
      setError(err instanceof Error ? err.message : 'Sending service could not change. Retry with the same selection.');
    } finally {
      if (current === request.current) setBusy(false);
    }
  }

  function choiceLabel(choice: Choice) {
    const name = providerLabels[choice.provider];
    if (!choice.configured) return `${name} — not configured`;
    if (choice.ready) return `${name} — ready`;
    return `${name} — configured, not ready`;
  }

  const external = providers?.mode === 'ses' || providers?.mode === 'resend';
  const canSave = !!providers && external && selected!==providers.selected && (providers.choices.find(c => c.provider === selected)?.configured ?? false);

  return (
    <section className="card" aria-label="Sending service">
      <h2>Sending service</h2>
      <p>Select the configured external provider for this brand. Switching invalidates unsubmitted reviews and never reroutes uncertain sends.</p>
      {notice&&<p role="status">{notice}</p>}
      {error && <p role="alert" className="notice error">{error}</p>}
      {!providers ? (
        <button className="btn secondary" disabled={busy} onClick={refresh}>Load sending services</button>
      ) : (
        <>
          <div className="field">
            <label htmlFor={id + '-provider'}>Sending service</label>
            <select id={id + '-provider'} value={selected} onChange={(e) => {setSelected(e.target.value as SendingProvider);attempt.current=null;setNotice('');}} disabled={!external || busy}>
              {providers.choices.map((choice) => (
                <option key={choice.provider} value={choice.provider} disabled={!choice.configured}>
                  {choiceLabel(choice)}
                </option>
              ))}
            </select>
          </div>
          <p className="help">
            {external ? `Selected service: ${providers.selected ? providerLabels[providers.selected] : "None"}. Sender setup and campaign approval are still required.` : providers.mode === 'capture'
              ? 'Capture mode is active. External sending is disabled.'
              : 'Delivery is off. Enable external delivery to select a provider.'}
          </p>
          <button className="btn" disabled={!canSave || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save sending service'}
          </button>
          <button className="btn secondary" disabled={busy} onClick={refresh}>Refresh</button>
        </>
      )}
    </section>
  );
}
