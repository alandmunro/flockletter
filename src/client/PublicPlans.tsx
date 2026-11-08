import { useId } from 'react';
import './public-plans.css';
import { plans } from '../shared/contracts.js';
import { hostedTrial } from '../shared/trial.js';

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
}: { catalog?: typeof plans; headingLevel?: 2 | 3 } = {}) {
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
          </article>
        );
      })}
    </div>
  );
}

export function PublicPlans() {
  return (
    <main id="main" className="public-plans">
      <header>
        <div>
          <h1 className="page-heading">Plans and pricing</h1>
          <p>
            Every hosted plan includes delivery. Your subscription shares its allowances across all companies
            and brands. Prices are in USD before applicable tax.
          </p>
        </div>
        <div className="plan-staging">
          <p>
            Create a staging workspace to draft and preview campaigns. There is no charge and staging signup
            does not start a trial.
          </p>
          <div className="actions">
            <a className="btn" href="/sign-up">
              Create a staging account
            </a>
            <a className="btn secondary" href="/">
              Sign in
            </a>
          </div>
        </div>
      </header>
      <PlanCards />
      <section className="card public-trial" aria-labelledby="trial-heading">
        <h2 id="trial-heading">{formatCount(hostedTrial.days)}-day hosted trial</h2>
        <p>
          {formatCount(hostedTrial.activeContacts)} active contacts and {formatCount(hostedTrial.totalEmails)}{' '}
          total recipient emails for the trial, including test messages.
          {hostedTrial.cardRequired ? ' The hosted trial requires a card at signup.' : ''}
        </p>
      </section>
      <a href="/help">Email support</a>
    </main>
  );
}
