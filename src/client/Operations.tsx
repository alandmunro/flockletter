import { useEffect, useState } from 'react';
import type { Api } from './api.js';
type Activity = { id: string; action: string; actor: 'owner' | 'connection'; at: string };
type Overview = {
  events: Activity[];
  captures: { queued: number; blocked: number; captured: number; overdue: number };
  emailDelivery: 'off';
};
export function Operations({ api }: { api: Api }) {
  const [data, setData] = useState<Overview>(),
    [error, setError] = useState(''),
    [load, reload] = useState(0);
  useEffect(() => {
    let active = true;
    api
      .call<Overview>('workspace.operations', {})
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api, load]);
  return (
    <section className="card">
      <h2>Workspace activity</h2>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p>
            {data.captures.queued} queued rehearsals · {data.captures.overdue} due for over 15 minutes ·{' '}
            {data.captures.blocked} blocked · {data.captures.captured} captured messages
          </p>
          {data.events.length ? (
            <ol>
              {data.events.map((item) => (
                <li key={item.id}>
                  <time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time> · {item.action} ·{' '}
                  {item.actor}
                </li>
              ))}
            </ol>
          ) : (
            <p>No workspace activity yet.</p>
          )}
        </>
      )}
      <button
        className="btn secondary"
        onClick={() => {
          setError('');
          reload((v) => v + 1);
        }}
      >
        Refresh activity
      </button>
    </section>
  );
}
