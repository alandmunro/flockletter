export type SiteEnvironment = 'local' | 'test' | 'staging' | 'production' | 'unknown';

export function sitePresentation(value: unknown, billingMode?: unknown): {
  environment: SiteEnvironment;
  workspaceNotice: string;
  accountLabel: string;
  pricingNote: string;
  trialNote: string;
} {
  const environment:SiteEnvironment = typeof value==='string' &&
    ['local','test','staging','production'].includes(value) ? value as SiteEnvironment : 'unknown';

  const presentation: Record<SiteEnvironment, { workspaceNotice: string; accountLabel: string; pricingNote: string; trialNote: string }> = {
    local: {
      workspaceNotice: 'Local development · disposable sample data. Captured exercises do not send email or charge cards.',
      accountLabel: 'Create a staging account',
      pricingNote: 'Create a staging workspace to draft and preview campaigns. There is no charge and staging signup does not start a trial.',
      trialNote: 'Hosted trial terms are shown for review. No trial or paid plan starts in this exercise.'
    },
    test: {
      workspaceNotice: 'Local development · disposable sample data. Captured exercises do not send email or charge cards.',
      accountLabel: 'Create a staging account',
      pricingNote: 'Create a staging workspace to draft and preview campaigns. There is no charge and staging signup does not start a trial.',
      trialNote: 'Hosted trial terms are shown for review. No trial or paid plan starts in this exercise.'
    },
    staging: {
      workspaceNotice: 'Staging · Captured exercises are labeled throughout the app. Check Delivery and Subscription for the configured service status.',
      accountLabel: 'Create a staging account',
      pricingNote: 'Create a staging workspace to draft and preview campaigns. There is no charge and staging signup does not start a trial.',
      trialNote: 'Hosted trial terms are shown for review. No trial or paid plan starts in this exercise.'
    },
    production: {
      workspaceNotice: "Check Delivery and Subscription for your workspace’s current service status. Account creation alone does not enable delivery or start a subscription.",
      accountLabel: 'Create an account',
      pricingNote: 'Create your workspace to prepare and preview campaigns. Subscription and delivery checks are completed in your workspace before paid service or sending begins.',
      trialNote: 'Account creation does not start a trial. Review current eligibility and the exact card, price and charge-date terms in Subscription before accepting a trial.'
    },
    unknown: {
      workspaceNotice: 'Service availability has not been verified. Check Delivery and Subscription before starting paid service or sending.',
      accountLabel: 'Create an account',
      pricingNote: 'Plan prices and limits are shown for review. Creating an account does not start a paid plan or a trial.',
      trialNote: 'Trial availability must be verified in your workspace before card setup or acceptance.'
    }
  };

  if (environment === 'production' && billingMode === 'stripe_live') {
    return {...presentation.production, environment, accountLabel: 'Start your 14-day trial',
      pricingNote: 'Choose Starter or Growth, sign in, then save your card with Stripe. You will see your first charge date before you accept the trial.'};
  }
  return { environment, ...presentation[environment] };
}
