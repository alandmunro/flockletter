import type { CustomerBillingStatus } from '../shared/customer-billing.js';

export function SubscriptionUsage({ status }: { status: CustomerBillingStatus }) {
  if (status.limits === null) return null;

  const fmt = (n: number): string => n.toLocaleString('en-US');
  const usage = status.usage;
  const limits = status.limits;

  const campaignsRemaining = Math.max(0, limits.campaigns - usage.campaigns - usage.reservedCampaigns);
  const emailsRemaining = Math.max(0, limits.emails - usage.emails - usage.reservedEmails);

  let resetText = 'Reset unavailable';
  if (status.state === 'trialing') {
    const trialEnd = status.trialEnd ? new Date(status.trialEnd) : null;
    if (trialEnd && !isNaN(trialEnd.getTime())) {
      const trialEndDate = trialEnd.toLocaleString('en-US', { timeZone: 'UTC' });
      resetText = `Trial allowance covers the whole trial and ends on ${trialEndDate} UTC`;
    } else {
      resetText = 'Reset unavailable';
    }
  } else if (typeof status.usage.period === 'string') {
    const match = /^(\d{4})-(\d{2})$/.exec(status.usage.period);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      if (year >= 1000 && month >= 1 && month <= 12) {
        const nextMonth = new Date(Date.UTC(year, month, 1));
        if (!isNaN(nextMonth.getTime())) {
          const resetDate = nextMonth.toLocaleDateString('en-US', { timeZone: 'UTC' });
          resetText = `Resets on ${resetDate} UTC`;
        } else {
          resetText = 'Reset unavailable';
        }
      } else {
        resetText = 'Reset unavailable';
      }
    } else {
      resetText = 'Reset unavailable';
    }
  }

  return (
    <div className="field-grid">
      <p>
        Campaigns: {fmt(usage.campaigns)} / {fmt(limits.campaigns)} used, {fmt(usage.reservedCampaigns)}{' '}
        reserved, {fmt(campaignsRemaining)} remaining
      </p>
      <p>
        Recipient emails: {fmt(usage.emails)} / {fmt(limits.emails)} used, {fmt(usage.reservedEmails)}{' '}
        reserved, {fmt(emailsRemaining)} remaining
      </p>
      <p>
        Active contacts: {fmt(limits.contacts)}; Recipient-per-campaign cap: {fmt(limits.recipients)}
      </p>
      <p>
        Companies: {fmt(limits.companies)}; Brands: {fmt(limits.brands)}; Users:{' '}
        {limits.users === null ? 'Unlimited' : fmt(limits.users)}
      </p>
      <p>{resetText}</p>
    </div>
  );
}
