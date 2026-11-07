import { useEffect, useRef, useState } from 'react';
import { plans } from '../shared/contracts.js';
import type { PlanId } from '../shared/rehearsal.js';
import { operationKey, type Api } from './api.js';
type BillingView = {
  mode: 'off' | 'sandbox';
  complimentary: boolean;
  status: string;
  plan: PlanId | null;
  trialEnd: string | null;
  canOpenPortal: boolean;
  restartableId: string | null;
};
export function BillingPanel({ api }: { api: Api }) {
  const [data, setData] = useState<BillingView>(),
    [plan, setPlan] = useState<PlanId>('starter');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const key = useRef(operationKey());
  useEffect(() => {
    let active = true;
    api
      .call<BillingView>('billing.status', {})
      .then((d) => {
        if (active) {
          setData(d);
          if (d.plan) setPlan(d.plan);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api]);
  async function open(portal: boolean) {
    setBusy(true);
    setError('');
    try {
      const result = await api.call<{ url: string | null; status?: string }>(
        portal ? 'billing.portal' : data?.restartableId ? 'billing.restart' : 'billing.checkout',
        portal
          ? { operationKey: key.current }
          : {
              operationKey: key.current,
              plan,
              ...(data?.restartableId ? { expiredId: data.restartableId } : {}),
            },
      );
      key.current = operationKey();
      if (result.url) {
        const url = new URL(result.url);
        if (url.origin !== (portal ? 'https://billing.stripe.com' : 'https://checkout.stripe.com'))
          throw Error('Invalid Stripe destination.');
        window.location.assign(url.href);
      } else setData(await api.call<BillingView>('billing.status', {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open Stripe.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>Billing sandbox</h2>
      {error && <p role="alert">{error}</p>}
      {data &&
        (data.complimentary ? (
          <p>This workspace has complimentary access and bypasses card billing.</p>
        ) : data.mode === 'off' ? (
          <p>
            The Stripe test connection is not configured. You can prepare campaigns without starting a trial.
          </p>
        ) : (
          <>
            <p>
              Test environment · {data.status.replaceAll('_', ' ')}
              {data.trialEnd && ' · Trial ends ' + new Date(data.trialEnd).toLocaleDateString()}
            </p>
            <label htmlFor="billing-plan">Test plan</label>
            <select
              id="billing-plan"
              value={plan}
              disabled={busy || (!!data.plan && !data.restartableId)}
              onChange={(e) => {
                setPlan(e.target.value as PlanId);
                key.current = operationKey();
              }}
            >
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · ${p.priceMinor / 100} per month
                </option>
              ))}
            </select>
            <p>Test card required for a 14-day trial. Use Stripe test data only.</p>
            <div className="actions">
              <button className="btn" disabled={busy} onClick={() => void open(false)}>
                {data.restartableId ? 'Restart expired test checkout' : 'Open test checkout'}
              </button>
              {data.canOpenPortal && (
                <button className="btn secondary" disabled={busy} onClick={() => void open(true)}>
                  Open test billing portal
                </button>
              )}
            </div>
          </>
        ))}
    </section>
  );
}
