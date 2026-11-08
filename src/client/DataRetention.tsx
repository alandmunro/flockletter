import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandName } from '../shared/contracts.js';
import type { RetentionCase, RetentionStatus } from '../shared/customer-retention.js';
import { operationKey, type Api } from './api.js';
import { RetentionInventory } from './RetentionInventory.js';

export function DataRetention({ api }: { api: Api }) {
  const [data, setData] = useState<RetentionStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hold, setHold] = useState('');
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const reload = useCallback(
    async () => setData(await api.call<RetentionStatus>('retention.status', {})),
    [api],
  );
  useEffect(() => {
    let active = true;
    api
      .call<RetentionStatus>('retention.status', {})
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api]);
  async function act(name: CommandName, row?: RetentionCase) {
    const input = row
      ? {
          id: row.id,
          expectedVersion: row.version,
          ...(name === 'retention.hold' ? { reason: hold } : {}),
          ...(name === 'retention.request' ? { inventoryDigest: row.inventoryDigest } : {}),
        }
      : {};
    const signature = JSON.stringify([name, input]);
    if (pending.current?.signature !== signature) pending.current = { signature, key: operationKey() };
    setBusy(true);
    setError('');
    try {
      setData(await api.call<RetentionStatus>(name, { ...input, operationKey: pending.current.key }));
      pending.current = null;
      setHold('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update retention.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-labelledby="retention-title">
      <h2 id="retention-title">Account data and retention</h2>
      <p>
        Account records are retained for 90 days after verified service end. A reinstatement or review hold
        blocks erasure.
      </p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">Loading retention status…</p>}
      {data && (
        <>
          <p>
            <strong>{data.mode === 'capture' ? 'Captured staging exercise' : 'Retention review'}</strong> ·{' '}
            {data.service.status.replaceAll('_', ' ')}
          </p>
          <p>
            {data.service.source === 'complimentary'
              ? 'Complimentary access has no scheduled service end.'
              : data.service.effectiveEnd
                ? `Verified service end: ${new Date(data.service.effectiveEnd).toLocaleString()}`
                : 'Service has not ended. No erasure is eligible.'}
          </p>
          {data.mode === 'capture' && (
            <p>Exercise outcomes are saved for review. Capturing a job leaves account records intact.</p>
          )}
          <div className="actions">
            <button className="btn secondary" disabled={busy} onClick={() => void act('retention.inspect')}>
              Review current inventory
            </button>
            <button
              className="btn secondary"
              disabled={busy}
              onClick={() => void reload().catch((e) => setError(e.message))}
            >
              Refresh status
            </button>
          </div>
          {data.cases.length === 0 && (
            <p>No retention cases. If service has ended, review the inventory to create its 90-day plan.</p>
          )}
          {data.cases.map((row) => (
            <article key={row.id} className="card">
              <h3>{row.state.replaceAll('_', ' ')}</h3>
              <p>
                Service ended {new Date(row.effectiveEnd).toLocaleDateString()}. Review due{' '}
                {new Date(row.dueAt).toLocaleDateString()}.
              </p>
              {row.holdReason && <p>Hold: {row.holdReason}</p>}
              <RetentionInventory record={row} />
              {!['captured', 'cancelled'].includes(row.state) && (
                <>
                  <label htmlFor={'retention-hold-' + row.id}>Reason to hold for review</label>
                  <input
                    id={'retention-hold-' + row.id}
                    value={hold}
                    maxLength={500}
                    onChange={(event) => setHold(event.target.value)}
                    disabled={busy}
                  />
                  <div className="actions">
                    <button
                      className="btn secondary"
                      disabled={busy || !hold.trim()}
                      onClick={() => void act('retention.hold', row)}
                    >
                      Place review hold
                    </button>
                    {row.state === 'held' && (
                      <button
                        className="btn secondary"
                        disabled={busy}
                        onClick={() => void act('retention.release', row)}
                      >
                        Release hold and recheck
                      </button>
                    )}
                    {row.state === 'due' && row.inventoryDigest && (
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => void act('retention.request', row)}
                      >
                        Request operator review of this inventory
                      </button>
                    )}
                    {data.mode === 'capture' &&
                      row.source === 'exercise' &&
                      row.state === 'awaiting_operator' && (
                        <button
                          className="btn"
                          disabled={busy}
                          onClick={() => void act('retention.exercise', row)}
                        >
                          Capture exercise outcome
                        </button>
                      )}
                  </div>
                </>
              )}
              {row.state === 'awaiting_operator' && (
                <p>
                  A separate authorized operator and protected recovery checkpoint are required before actual
                  erasure.
                </p>
              )}
            </article>
          ))}
          {data.jobs.length > 0 && (
            <>
              <h3>Execution history</h3>
              <ul>
                {data.jobs.map((job) => (
                  <li key={job.id}>
                    {job.state.replaceAll('_', ' ')} · {new Date(job.createdAt).toLocaleString()}
                    {job.result && (
                      <p>
                        {job.result.reason} Records deleted: {job.result.deletedRows}.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p>
            Hosted erasure is unavailable from this screen. Contact support for export or deletion assistance.
          </p>
        </>
      )}
    </section>
  );
}
