import { useEffect, useRef, useState } from 'react';
import type { Api } from './api.js';
import { operationKey } from './api.js';
import type { CustomerOperationsStatus } from '../shared/customer-operations.js';

export function CustomerOperations({ api }: { api: Api }) {
  const requestKey=useRef(operationKey());
  const [status, setStatus] = useState<CustomerOperationsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadStatus = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.call<CustomerOperationsStatus>('operations.status', {});
        if (!cancelled) setStatus(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load status.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const handleRefresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.call<CustomerOperationsStatus>('operations.status', {});
      setStatus(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status.');
    } finally {
      setLoading(false);
    }
  };

  const handleProcess = async () => {
    setProcessing(true);
    setError(null);
    try {
      await api.call<unknown>('operations.process', { operationKey: requestKey.current });
      requestKey.current=operationKey();
      const result = await api.call<CustomerOperationsStatus>('operations.status', {});
      setStatus(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process jobs.');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="card" aria-labelledby="customer-operations-heading">
      <h2 id="customer-operations-heading">Customer Operations</h2>

      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}

      <p className="help">
        Captured outcomes are simulations. Review the worker, workflow modes and activation gaps below for current service readiness.
      </p>

      {!status && !loading && <button type="button" className="btn secondary" onClick={()=>void handleRefresh()}>Retry status</button>}
      {loading && !status ? (
        <p>Loading status…</p>
      ) : status ? (
        <>
          <div className="actions">
            <button type="button" className="btn secondary" onClick={handleRefresh} disabled={loading || processing}>
              Refresh
            </button>
            <button type="button" className="btn" onClick={handleProcess} disabled={loading || processing}>
              {processing ? 'Processing…' : 'Run saved jobs'}
            </button>
          </div>

          <section aria-labelledby="worker-heading">
            <h3 id="worker-heading" className="badge">Worker</h3>
            <dl>
              <dt>Running</dt>
              <dd>{status.worker.running ? 'Yes' : 'No'}</dd>
              <dt>Dedicated</dt>
              <dd>{status.worker.dedicated ? 'Yes' : 'No'}</dd>
              <dt>Last Pass</dt>
              <dd>{status.worker.lastPass ?? '—'}</dd>
              <dt>Last Failure</dt>
              <dd>{status.worker.lastFailure ?? '—'}</dd>
            </dl>
          </section>

          <section aria-labelledby="modes-heading">
            <h3 id="modes-heading" className="badge">Modes</h3>
            <dl>
              <dt>Billing</dt>
              <dd>{status.modes.billing}</dd>
              <dt>Delivery</dt>
              <dd>{status.modes.delivery}</dd>
              <dt>Audience</dt>
              <dd>{status.modes.audience}</dd>
              <dt>Team</dt>
              <dd>{status.modes.team}</dd>
              <dt>Support</dt>
              <dd>{status.modes.support}</dd>
              <dt>Retention</dt>
              <dd>{status.modes.retention}</dd>
              <dt>Sender infrastructure</dt>
              <dd>{status.modes.infrastructure??'off'}</dd>
            </dl>
          </section>

          <section aria-labelledby="queue-heading">
            <h3 id="queue-heading" className="badge">Queue</h3>
            <dl>
              <dt>Delivery</dt>
              <dd>{status.queue.delivery}</dd>
              <dt>Confirmations</dt>
              <dd>{status.queue.confirmations}</dd>
              <dt>Team</dt>
              <dd>{status.queue.team}</dd>
              <dt>Support</dt>
              <dd>{status.queue.support}</dd>
              <dt>Retention</dt>
              <dd>{status.queue.retention}</dd>
              <dt>Sender infrastructure</dt>
              <dd>{status.queue.infrastructure??0}</dd>
              <dt>Unknown</dt>
              <dd>{status.queue.unknown}</dd>
            </dl>
          </section>

          <section aria-labelledby="gaps-heading">
            <h3 id="gaps-heading" className="badge">Setup Gaps</h3>
            {status.gaps.length === 0 ? (
              <p>No setup gaps detected.</p>
            ) : (
              <ul>
                {status.gaps.map((gap) => (
                  <li key={`${gap.area}-${gap.code}-${gap.detail}`}>
                    <strong>{gap.area}</strong> ({gap.code}): {gap.detail}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : (
        <p>No status available.</p>
      )}
    </div>
  );
}
