import {publicSubscriptionOffers,proEnrollmentNotice} from '../shared/subscription-offers.js';
import { useEffect, useId, useState } from 'react';
import {sitePresentation} from '../shared/site-presentation.js';
import './public-plans.css';
import { plans } from '../shared/contracts.js';
import { hostedTrial } from '../shared/trial.js';
import { subscriptionSignupUrl } from './subscription-navigation.js';

export { OnboardingProgress } from './OnboardingProgress.js';

const numberFormatter = new Intl.NumberFormat('en-US');

function formatCount(value: number): string {
  return numberFormatter.format(value);
}

function formatUsers(users: number | null): string {
  return users === null ? 'Unlimited' : numberFormatter.format(users);
}

function formatPrice(priceMinor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(priceMinor / 100);
}

export function PlanCards({
  catalog = plans,
  headingLevel = 2,
  signupLinks = false,
}: { catalog?: typeof plans; headingLevel?: 2 | 3; signupLinks?: boolean } = {}) {
  const group = useId();
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <div className="plan-cards">
      {catalog.map((plan) => {
        const titleId = `${group}-${plan.id}`;

        return (
          <article className="card plan-card" aria-labelledby={titleId} key={plan.id}>
            <Heading id={titleId}>{plan.name}</Heading>
            <p className="plan-price">
              {formatPrice(plan.priceMinor, plan.currency)}
              <small> / month USD</small>
            </p>
            <dl className="plan-details">
              <div>
                <dt>Active contacts</dt>
                <dd>{formatCount(plan.contacts)}</dd>
              </div>

              <div>
                <dt>Recipients per campaign</dt>
                <dd>{formatCount(plan.recipients)}</dd>
              </div>

              <div>
                <dt>Campaigns per month</dt>
                <dd>{formatCount(plan.campaigns)}</dd>
              </div>

              <div>
                <dt>Recipient emails per month</dt>
                <dd>{formatCount(plan.emails)}</dd>
              </div>

              <div>
                <dt>Companies</dt>
                <dd>{formatCount(plan.companies)}</dd>
              </div>

              <div>
                <dt>Brands</dt>
                <dd>{formatCount(plan.brands)}</dd>
              </div>

              <div>
                <dt>Users</dt>
                <dd>{formatUsers(plan.users)}</dd>
              </div>
            </dl>
            {signupLinks && (publicSubscriptionOffers[plan.id]?<a className="btn secondary" href={subscriptionSignupUrl(plan.id)}>Choose {plan.name}</a>:<p className="notice">{proEnrollmentNotice}</p>)}
          </article>
        );
      })}
    </div>
  );
}

export function PublicPricingPage() {
  const [settings,setSettings]=useState<{environment?:unknown;customerWorkflows?:{billing?:unknown}}>();
  useEffect(()=>{
    const controller=new AbortController();
    void fetch('/api/config',{signal:controller.signal}).then(async response=>{
      if(!response.ok) return;
      const config=await response.json() as typeof settings;
      if(!controller.signal.aborted) setSettings(config);
    }).catch(()=>{/* Unknown availability never becomes a paid-service claim. */});
    return ()=>controller.abort();
  },[]);
  return <PublicPlans environment={settings?.environment} billingMode={settings?.customerWorkflows?.billing}/>;
}

export function PublicPlans({environment,billingMode}:{environment?:unknown;billingMode?:unknown}) {
  const presentation=sitePresentation(environment,billingMode);
  return (
    <main id="main" className="public-plans">
      <header>
        <div>
          <h1 className="page-heading">Plans and pricing</h1>
          <p>
            Hosted plans include delivery once activated. Allowances are shared across all companies
            and brands. Prices below are in USD before applicable tax; review service availability in your workspace.
          </p>
        </div>
        <div className="plan-staging">
          <p>
            {presentation.pricingNote}
          </p>
          <div className="actions">
            <a className="btn" href="/sign-up">
              {presentation.accountLabel}
            </a>
            <a className="btn secondary" href="/">
              Sign in
            </a>
          </div>
        </div>
      </header>
      <PlanCards signupLinks />
      <p className="notice">A new workspace can queue its first newsletter for up to 2,500 confirmed contacts after verifying its sending domain. Daily and trial allowances are shared across brands. You can close the page once your newsletter is queued and follow its progress in Delivery.</p>
      <section className="card public-trial" aria-labelledby="trial-heading">
        <h2 id="trial-heading">{formatCount(hostedTrial.days)}-day hosted trial</h2>
        <p>
          2 campaigns, 1 user, 1 company and 1 brand for the whole trial.{' '}
          {formatCount(hostedTrial.activeContacts)} active contacts and {formatCount(hostedTrial.totalEmails)}{' '}
          total recipient emails for the trial, including test messages.
          {hostedTrial.cardRequired ? ' A card is required before activating the hosted trial.' : ''}
          {' '}{presentation.trialNote}
        </p>
        <p>Lifetime trial eligibility is checked for the owner, workspace and card. Reopening an account or changing plans does not renew free-trial eligibility. Read how minimal eligibility history is retained in the <a href="/privacy">privacy notice</a>.</p>
      </section>
      <a href="/help">Email support</a>
    </main>
  );
}
