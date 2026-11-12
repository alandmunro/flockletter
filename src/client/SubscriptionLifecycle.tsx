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

export function SubscriptionLifecycle({ api, initialPlan, returnedFromStripe=false, onPlanChange }: {
  api: BillingApi;
  initialPlan?: CustomerPlan;
  returnedFromStripe?: boolean;
  onPlanChange?: (plan:CustomerPlan)=>void;
}) {
  const [status, setStatus] = useState<CustomerBillingStatus>();
  const [chosenPlan, setPlan] = useState<CustomerPlan>(initialPlan??'starter');
  const initializedPlan = useRef(false);
  const boundSetup = status?.source==='preparation' && status.trialSetup &&
    !['expired','denied'].includes(status.trialSetup.state) ? status.trialSetup : undefined;
  const plan = boundSetup?.plan ?? (!initializedPlan.current&&!initialPlan&&status?.plan ? status.plan : chosenPlan);
  useEffect(()=>{
    if(!status)return;
    if(boundSetup){
      initializedPlan.current=true;
      setPlan(boundSetup.plan);
    }else if(!initializedPlan.current){
      initializedPlan.current=true;
      if(!initialPlan&&status.plan)setPlan(status.plan);
    }
  },[boundSetup,initialPlan,status]);
  const [cardConfirmed, setCardConfirmed] = useState(false);
  const [days, setDays] = useState('6');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(returnedFromStripe ? 'Welcome back from Stripe. Review your saved billing status and complete any remaining card or trial steps below.' : '');
  const [checkoutExpired, setCheckoutExpired] = useState(false);
  const [trialAccepted, setTrialAccepted] = useState(false);
  const [paidAccepted, setPaidAccepted] = useState(false);
  const review = status?.trialSetup?.review;
  useEffect(() => setTrialAccepted(false), [review?.hash]);
  useEffect(() => setPaidAccepted(false), [plan]);
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
    const operationKey =
      typeof input.operationKey === 'string'
        ? input.operationKey
        : (keys.current.get(signature) ?? crypto.randomUUID());
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
        if (
          target.protocol !== 'https:' ||
          target.hostname !== host ||
          target.username ||
          target.password
        )
          throw Error('The billing provider returned an unexpected link.');
        window.location.assign(target.href);
        return;
      }
      if (result.state === 'trial_unavailable') {
        keys.current.delete(signature);
        setNotice(
          'A free trial is unavailable for this setup. No paid subscription was created. You may explicitly choose the normal paid plan below, or contact support.',
        );
      } else if (result.state === 'trial_setup_expired') {
        keys.current.delete(signature);
        setNotice(
          'The card-only setup expired. You can start a new setup after its short reservation ends. No trial or paid subscription was started.',
        );
      } else if (result.state === 'card_setup_complete') {
        setNotice(
          'Your card-only setup is complete. Review the trial terms below before starting the subscription.',
        );
      } else if (result.state === 'trial_review_ready') {
        keys.current.delete(signature);
        setNotice('Review the first-charge date and monthly price, then accept to start the trial.');
      } else if (result.state === 'checkout_expired') {
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
        Your companies and brands share one subscription allowance. Accepted messages count once,
        including messages that later bounce. Pending delivery outcomes remain reserved.
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
              Staging exercise: every payment and card confirmation here is simulated. No charge is made.
              The exercise uses a saved subscription and its own clock.
            </p>
          ) : status.mode === 'off' ? (
            <p className="notice">
              Billing activation is not enabled. You can continue preparing your workspace.
            </p>
          ) : (
            <p>
              Card details and subscription changes are handled on Stripe’s hosted pages. Returning here
              does not establish payment success.
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
                  disabled={busy || Boolean(boundSetup)}
                  onChange={(event) => {
                    const next=event.target.value as CustomerPlan;
                    setPlan(next);
                    onPlanChange?.(next);
                  }}
                >
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — ${(p.priceMinor / 100).toFixed(0)}/month
                    </option>
                  ))}
                </select>
              </label>
              {boundSetup && <p className="help">Card setup is in progress for {plans.find(p=>p.id===boundSetup.plan)?.name}. Resume or review this saved setup before choosing another plan.</p>}
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
                            void run(
                              status.cancelAt ? 'customerBilling.resume' : 'customerBilling.cancel',
                            )
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
                        Upgrades apply immediately. Downgrades start at renewal. Usage stays recorded
                        when you change plans. Sending pauses on day six of unsuccessful payment; the
                        account closes on day thirty.
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
                      disabled={
                        busy ||
                        (status.source === 'preparation' &&
                          ((!status.trialProtectionReady && !status.legacyCheckout) ||
                            ['activation_pending', 'active'].includes(status.trialSetup?.state ?? '')))
                      }
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
                          : status.legacyCheckout
                            ? 'Resume Stripe checkout'
                            : 'Verify card with Stripe'}
                    </button>
                    {status.source === 'stripe' && (
                      <>
                        <button className="btn secondary" type="button" disabled={busy || plan === status.plan}
                          onClick={() => void run('customerBilling.portal', { plan })}>
                          Review selected plan with Stripe
                        </button>
                        <p>Stripe shows the final price and timing before you confirm. Upgrades are prorated;
                          downgrades take effect at renewal. Opening the review changes no plan.</p>
                      </>
                    )}
                    {status.source === 'preparation' && (
                      <>
                        <p>
                          Card setup alone starts no subscription and collects no payment. After setup,
                          review and explicitly accept your 14-day trial and recurring monthly price.
                        </p>
                        {!status.trialProtectionReady && !status.legacyCheckout && (
                          <p className="notice">
                            New free trials are waiting for approved eligibility and retention
                            configuration. You can prepare your workspace.
                          </p>
                        )}
                        {status.trialSetup &&
                          ['pending', 'card_verified', 'reviewed'].includes(status.trialSetup.state) && (
                            <button
                              className="btn secondary"
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void run('customerBilling.trialReview', {
                                  setupId: status.trialSetup!.id,
                                })
                              }
                            >
                              Review trial terms after card setup
                            </button>
                          )}
                        {review && status.trialSetup?.state === 'reviewed' && (
                          <div className="notice">
                            <p>
                              {plans.find((p) => p.id === review.plan)?.name}: 14 days from acceptance,
                              then ${(review.priceMinor / 100).toFixed(2)} USD per month. First charge
                              date: {review.firstChargeAt.slice(0, 10)} (UTC). Cancel before that date to
                              avoid renewal charges. This review expires at {date(review.expiresAt)}.
                            </p>
                            <p>Read how lifetime trial-eligibility history is retained in the <a href="/privacy">privacy notice</a>.</p>
                            <label>
                              <input
                                type="checkbox"
                                checked={trialAccepted}
                                disabled={busy}
                                onChange={(event) => setTrialAccepted(event.target.checked)}
                              />
                              I accept this 14-day trial and the displayed recurring monthly
                              subscription.
                            </label>
                            <button
                              className="btn"
                              type="button"
                              disabled={busy || !trialAccepted}
                              onClick={() =>
                                void run('customerBilling.activateTrial', {
                                  setupId: review.setupId,
                                  expectedRevision: review.revision,
                                  reviewHash: review.hash,
                                  accepted: true,
                                })
                              }
                            >
                              Accept and start 14-day trial
                            </button>
                          </div>
                        )}
                        {status.trialSetup?.state === 'activation_pending' && (
                          <p className="notice">
                            Your approved activation is being reconciled. Check the original activation
                            before starting another agreement. If no provider result can be found,
                            contact support; a second subscription will not be created automatically.
                          </p>
                        )}
                        {review && status.trialSetup?.state === 'activation_pending' && (
                          <button
                            className="btn secondary"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void run('customerBilling.activateTrial', {
                                operationKey: status.trialSetup?.activationKey,
                                setupId: review.setupId,
                                expectedRevision: review.revision,
                                reviewHash: review.hash,
                                accepted: true,
                              })
                            }
                          >
                            Check approved trial activation
                          </button>
                        )}
                        {status.trialSetup?.state === 'active' && (
                          <>
                            <p>
                              Your approved agreement is waiting for its verified subscription event. You
                              can manage or cancel it on Stripe after an independent provider check.
                              Opening billing management does not activate sending.
                            </p>
                            <button
                              className="btn secondary"
                              type="button"
                              disabled={busy}
                              onClick={() => void run('customerBilling.portal')}
                            >
                              Manage pending agreement with Stripe
                            </button>
                          </>
                        )}
                        {(!status.trialSetup ||
                          ['denied', 'expired'].includes(status.trialSetup.state)) && (
                          <>
                            <label>
                              <input
                                type="checkbox"
                                checked={paidAccepted}
                                disabled={busy}
                                onChange={(event) => setPaidAccepted(event.target.checked)}
                              />
                              I choose {plans.find((p) => p.id === plan)?.name} at $
                              {((plans.find((p) => p.id === plan)?.priceMinor ?? 0) / 100).toFixed(2)}{' '}
                              USD per month, with no free trial.
                            </label>
                            <button
                              className="btn secondary"
                              type="button"
                              disabled={busy || !paidAccepted}
                              onClick={() =>
                                void run('customerBilling.paidCheckout', {
                                  plan,
                                  accepted: true,
                                  priceMinor: plans.find((p) => p.id === plan)!.priceMinor,
                                })
                              }
                            >
                              Continue with normal paid plan
                            </button>
                          </>
                        )}
                      </>
                    )}
                    {status.source === 'stripe' && ['canceled', 'closed'].includes(status.state) && (
                      <>
                        <p>
                          Rejoin with the selected monthly plan after the provider confirms your previous
                          service ended. This opens normal paid checkout using your existing billing
                          account, with no free trial.
                        </p>
                        <button
                          className="btn"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run('customerBilling.rejoin', {
                              plan,
                              expectedRevision: status.revision,
                            })
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
