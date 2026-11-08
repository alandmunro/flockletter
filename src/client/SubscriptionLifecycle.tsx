import { useCallback, useEffect, useRef, useState } from 'react';
import { plans } from '../shared/contracts.js';
import { SubscriptionUsage } from './SubscriptionUsage.js';
import type {
  CustomerBillingCommandName,
  CustomerBillingStatus,
  CustomerPlan,
} from '../shared/customer-billing.js';

type BillingApi = {
  call<T>(name: CustomerBillingCommandName, input: unknown): Promise<T>;
};
const date = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');

export function SubscriptionLifecycle({ api }: { api: BillingApi }) {
  const [status, setStatus] = useState<CustomerBillingStatus>();
  const [plan, setPlan] = useState<CustomerPlan>('starter');
  const [cardConfirmed, setCardConfirmed] = useState(false);
  const [days, setDays] = useState('6');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [checkoutExpired, setCheckoutExpired] = useState(false);
  const keys = useRef(new Map<string, string>());
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++sequence.current;
    const next = await api.call<CustomerBillingStatus>('customerBilling.status', {});
    if (ticket === sequence.current) setStatus(next);
  }, [api]);
  useEffect(() => {
    void refresh().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : 'Unable to load billing.'),
    );
    return () => {
      sequence.current++;
    };
  }, [refresh]);

  async function run(name: CustomerBillingCommandName, input: Record<string, unknown> = {}) {
    if (busy) return;
    const signature = JSON.stringify([name, input]);
    const operationKey = keys.current.get(signature) ?? crypto.randomUUID();
    keys.current.set(signature, operationKey);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api.call<{ url?: string; state?: string }>(name, {
        ...input,
        operationKey,
      });
      if (result.url) {
        const target = new URL(result.url);
        const host = name === 'customerBilling.portal' ? 'billing.stripe.com' : 'checkout.stripe.com';
        if (target.protocol !== 'https:' || target.hostname !== host || target.username || target.password)
          throw Error('The billing provider returned an unexpected link.');
        window.location.assign(target.href);
        return;
      }
      if (result.state === 'checkout_expired') {
        keys.current.delete(signature);
        setCheckoutExpired(true);
        setNotice(
          name === 'customerBilling.rejoin'
            ? 'The paid rejoin checkout expired. Rejoin again to verify expiry and open a replacement paid checkout. No free trial is included.'
            : 'The previous checkout has expired and its trial opportunity was reserved. Restart opens normal paid checkout for the selected monthly plan after the provider rechecks expiry; it does not start another free trial.',
        );
      } else if (result.state === 'awaiting_verification') {
        setNotice(
          'Checkout is complete. We are waiting for the verified subscription event before activating service.',
        );
      } else if (result.state === 'awaiting_reconciliation') {
        setNotice(
          'The provider outcome is still being checked. Retry this action to reconcile the same request.',
        );
      } else {
        keys.current.delete(signature);
        setNotice('Saved. Your current subscription and allowance are shown below.');
      }
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'This action did not finish. Retry to resume the same request.',
      );
    } finally {
      setBusy(false);
    }
  }
  const exercise = status?.mode === 'exercise' && status.source !== 'complimentary';
  return (
    <section className="card" aria-labelledby="subscription-heading" aria-busy={busy}>
      <div className="actions">
        <h2 id="subscription-heading">Subscription and usage</h2>
        <button
          type="button"
          className="btn secondary"
          disabled={busy}
          onClick={() =>
            void refresh().catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : 'Unable to refresh billing.'),
            )
          }
        >
          Refresh
        </button>
      </div>
      <p>
        Your companies and brands share one subscription allowance. Accepted messages count once, including
        messages that later bounce. Pending delivery outcomes remain reserved.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {!status ? (
        <p>Loading subscription…</p>
      ) : (
        <>
          {status.source === 'complimentary' ? (
            <p className="notice">
              Complimentary service is assigned by the operator. No card or Stripe payment is required.
            </p>
          ) : exercise ? (
            <p className="notice">
              Staging exercise: every payment and card confirmation here is simulated. No charge is made. The
              exercise uses a saved subscription and its own clock.
            </p>
          ) : status.mode === 'off' ? (
            <p className="notice">
              Billing activation is not enabled. You can continue preparing your workspace.
            </p>
          ) : (
            <p>
              Card details and subscription changes are handled on Stripe’s hosted pages. Returning here does
              not establish payment success.
            </p>
          )}
          <dl className="plan-details">
            <div>
              <dt>Status</dt>
              <dd>{status.state.replace('_', ' ')}</dd>
            </div>
            <div>
              <dt>Plan</dt>
              <dd>{plans.find((p) => p.id === status.plan)?.name ?? 'Not selected'}</dd>
            </div>
            {status.pendingPlan && (
              <div>
                <dt>At renewal</dt>
                <dd>{plans.find((p) => p.id === status.pendingPlan)?.name}</dd>
              </div>
            )}
            <div>
              <dt>Current allowance period</dt>
              <dd>{status.state === 'trialing' ? 'Complete 14-day trial' : status.usage.period}</dd>
            </div>
            <div>
              <dt>Trial ends</dt>
              <dd>{date(status.trialEnd)}</dd>
            </div>
            <div>
              <dt>Period ends</dt>
              <dd>{date(status.periodEnd)}</dd>
            </div>
            {status.cancelAt && (
              <div>
                <dt>Cancellation takes effect</dt>
                <dd>{date(status.cancelAt)}</dd>
              </div>
            )}
            {exercise && (
              <div>
                <dt>Exercise clock</dt>
                <dd>{date(status.now)}</dd>
              </div>
            )}
          </dl>
          <SubscriptionUsage status={status} />
          <p role="status">
            {status.eligible
              ? 'Subscription eligibility is satisfied. Sender, audience and campaign checks still apply.'
              : status.reasons.join(' ')}
          </p>
          {status.source !== 'complimentary' && (
            <>
              <label>
                Plan
                <select
                  value={plan}
                  disabled={busy}
                  onChange={(event) => setPlan(event.target.value as CustomerPlan)}
                >
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — ${(p.priceMinor / 100).toFixed(0)}/month
                    </option>
                  ))}
                </select>
              </label>
              {exercise ? (
                <>
                  {status.source === 'preparation' ? (
                    <>
                      <label>
                        <input
                          type="checkbox"
                          checked={cardConfirmed}
                          disabled={busy}
                          onChange={(event) => setCardConfirmed(event.target.checked)}
                        />
                        Simulate confirming the required card for this 14-day trial.
                      </label>
                      <button
                        className="btn"
                        type="button"
                        disabled={busy || !cardConfirmed}
                        onClick={() =>
                          void run('customerBilling.startTrial', {
                            plan,
                            simulatedCardConfirmed: true,
                          })
                        }
                      >
                        Start captured trial
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="actions">
                        <button
                          className="btn"
                          type="button"
                          disabled={busy || !['trialing', 'active', 'past_due'].includes(status.state)}
                          onClick={() => void run('customerBilling.changePlan', { plan })}
                        >
                          Save plan choice
                        </button>
                        <button
                          className="btn secondary"
                          type="button"
                          disabled={busy || ['closed', 'canceled'].includes(status.state)}
                          onClick={() =>
                            void run(status.cancelAt ? 'customerBilling.resume' : 'customerBilling.cancel')
                          }
                        >
                          {status.cancelAt ? 'Keep subscription' : 'Cancel at period end'}
                        </button>
                        <button
                          className="btn secondary"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run('customerBilling.exercisePayment', {
                              result: 'succeeded',
                            })
                          }
                        >
                          Simulate successful payment
                        </button>
                        <button
                          className="btn secondary"
                          type="button"
                          disabled={busy || ['closed', 'canceled'].includes(status.state)}
                          onClick={() =>
                            void run('customerBilling.exercisePayment', {
                              result: 'failed',
                            })
                          }
                        >
                          Simulate unsuccessful payment
                        </button>
                      </div>
                      <p>
                        Upgrades apply immediately. Downgrades start at renewal. Usage stays recorded when you
                        change plans. Sending pauses on day six of unsuccessful payment; the account closes on
                        day thirty.
                      </p>
                      <label>
                        Advance only this workspace’s exercise clock
                        <select
                          value={days}
                          disabled={busy}
                          onChange={(event) => setDays(event.target.value)}
                        >
                          {[1, 6, 14, 30, 90, 120].map((day) => (
                            <option key={day} value={day}>
                              {day} days
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="btn secondary"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run('customerBilling.advanceExercise', {
                            days: Number(days),
                          })
                        }
                      >
                        Advance captured clock
                      </button>
                    </>
                  )}
                </>
              ) : (
                status.mode === 'stripe' && (
                  <>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          status.source === 'stripe'
                            ? 'customerBilling.portal'
                            : checkoutExpired
                              ? 'customerBilling.restartCheckout'
                              : 'customerBilling.checkout',
                          status.source === 'stripe' ? {} : { plan },
                        )
                      }
                    >
                      {status.source === 'stripe'
                        ? 'Manage billing with Stripe'
                        : checkoutExpired
                          ? 'Restart paid checkout'
                          : 'Start trial with Stripe'}
                    </button>
                    {status.source === 'stripe' && ['canceled', 'closed'].includes(status.state) && (
                      <>
                        <p>
                          Rejoin with the selected monthly plan after the provider confirms your previous
                          service ended. This opens normal paid checkout using your existing billing account,
                          with no free trial.
                        </p>
                        <button
                          className="btn"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run('customerBilling.rejoin', { plan, expectedRevision: status.revision })
                          }
                        >
                          Rejoin with paid plan
                        </button>
                      </>
                    )}
                  </>
                )
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
