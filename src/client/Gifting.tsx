import { useCallback, useEffect, useRef, useState } from 'react';
import type { GiftAction, GiftStatus } from '../shared/gifting.js';
import { operationKey, type Api } from './api.js';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (cents: number) => usd.format(cents / 100);

function GiftBalance({
  available,
  reserved,
  spent,
}: Pick<GiftStatus, 'available' | 'reserved' | 'spent'>) {
  return (
    <dl className="gift-balance" aria-label="Simulated gift balance">
      <div>
        <dt>Available</dt>
        <dd>{money(available)}</dd>
      </div>
      <div>
        <dt>Reserved</dt>
        <dd>{money(reserved)}</dd>
      </div>
      <div>
        <dt>Spent</dt>
        <dd>{money(spent)}</dd>
      </div>
    </dl>
  );
}
export function Gifting({ api }: { api: Api }) {
  const [status, setStatus] = useState<GiftStatus>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [days, setDays] = useState<15 | 30 | 60>(30),
    [products, setProducts] = useState(5);
  const [person, setPerson] = useState(1),
    [link, setLink] = useState('');
  const retry = useRef<{ payload: string; key: string } | null>(null);
  const refresh = useCallback(
    async () => setStatus(await api.call<GiftStatus>('gifting.captureStatus', {})),
    [api],
  );
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The exercise could not load.');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(refresh);
  }, [refresh]);
  async function act(action: GiftAction) {
    await run(async () => {
      const payload = JSON.stringify(action);
      if (retry.current?.payload !== payload) retry.current = { payload, key: operationKey() };
      await api.call('gifting.captureAction', { operationKey: retry.current.key, action });
      await refresh();
      retry.current = null;
    });
  }
  const action = (label: string, item: GiftAction) => (
    <button className="btn" disabled={busy} onClick={() => void act(item)}>
      {label}
    </button>
  );
  return (
    <section className="card">
      <h1>Gift lab</h1>
      <p>
        Practice with simulated USD and 100 fictional recipients. Each recipient appears in both email
        and SMS.
      </p>
      {error && <p role="alert">{error}</p>}
      <button className="btn" disabled={busy} onClick={() => void run(refresh)}>
        Refresh balances
      </button>
      {status && (
        <>
          <GiftBalance {...status} />
          {!status.funded && action('Simulate $550 purchase for $500 credit', { kind: 'fund' })}
          {status.funded && !status.closed && (
            <details>
              <summary>Simulate a payment dispute</summary>
              <p>
                Dispute {status.dispute} · Account {status.access}
              </p>
              {status.dispute === 'none' && action('Open dispute', { kind: 'disputeOpen' })}
              {status.dispute === 'open' && (
                <>
                  {action('Resolve as won', { kind: 'disputeWon' })}{' '}
                  {action('Resolve as lost', { kind: 'disputeLost' })}
                </>
              )}
            </details>
          )}
          {status.funded && !status.days && (
            <fieldset disabled={busy}>
              <legend>Reserve 100 gifts of $5</legend>
              <label>
                Offer duration{' '}
                <select value={days} onChange={(e) => setDays(Number(e.target.value) as 15 | 30 | 60)}>
                  {[15, 30, 60].map((n) => (
                    <option key={n} value={n}>
                      {n} days
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Product choices{' '}
                <select value={products} onChange={(e) => setProducts(Number(e.target.value))}>
                  {[1, 5, 6, 7, 8, 9, 10].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              {action('Reserve $500', { kind: 'reserve', days, products })}
            </fieldset>
          )}
          {status.days > 0 && (
            <>
              <h2>Recipient offers</h2>
              <p>
                Lab day {status.day} · {status.offers.filter((o) => o.state === 'claimed').length}{' '}
                claimed · {status.offers.filter((o) => o.state === 'pending').length} pending ·{' '}
                {status.offers.filter((o) => o.state === 'expired').length} expired
              </p>
              <label>
                Recipient{' '}
                <select
                  value={person}
                  onChange={(e) => {
                    setPerson(Number(e.target.value));
                    setLink('');
                  }}
                  disabled={busy}
                >
                  {status.offers.map((o) => (
                    <option key={o.person} value={o.person}>
                      {o.person} · {o.state}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    setLink((await api.call<{ path: string }>('gifting.captureLink', { person })).path),
                  )
                }
              >
                Get recipient link
              </button>
              {link && (
                <a href={link} target="_blank" rel="noreferrer">
                  Open simulated gift
                </a>
              )}
              {!status.closed && (
                <>
                  <h2>Exercise controls</h2>
                  {action('Simulate provider timeout', { kind: 'timeout' })}{' '}
                  {action('Recover pending orders', { kind: 'recover' })}
                  {action('Advance to expiry', { kind: 'expire' })}{' '}
                  {action('Close and refund unused credit', { kind: 'refund' })}
                </>
              )}
              {status.closed && (
                <p>
                  Exercise closed. Simulated refund including the unused fee was {money(status.refunded)}
                  .
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
