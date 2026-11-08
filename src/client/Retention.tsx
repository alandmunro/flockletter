import { useEffect, useState } from 'react';
import type { Api } from './api.js';
type Result = { status: string; effectiveEnd: string | null; reviewAt: string | null; purgeEnabled: false };
export function Retention({ api }: { api: Api }) {
  const [data, setData] = useState<Result>(),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api
      .call<Result>('workspace.retention', {})
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api]);
  return (
    <section className="card">
      <h2>Account retention preview</h2>
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p>Loading retention status…</p>
      ) : !data.reviewAt ? (
        <p>No verified end of sandbox service is recorded.</p>
      ) : (
        <>
          <p>
            Sandbox service ended {new Date(data.effectiveEnd!).toLocaleDateString()}. The 90-day review falls
            on {new Date(data.reviewAt).toLocaleDateString()}.
          </p>
          <p>
            {data.status === 'operator_review_due'
              ? 'Ready for operator review.'
              : 'Within the retention period.'}{' '}
            This preview does not delete data.
          </p>
        </>
      )}
    </section>
  );
}
