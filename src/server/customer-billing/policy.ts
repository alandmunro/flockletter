import type { CustomerAllowance, CustomerBillingState, CustomerPlan } from '../../shared/customer-billing.js';
import { hostedTrial } from '../../shared/trial.js';
import { plans } from '../../shared/contracts.js';

export const trialAllowance: CustomerAllowance = {
  contacts: hostedTrial.activeContacts,
  recipients: hostedTrial.activeContacts,
  campaigns: 2,
  emails: hostedTrial.totalEmails,
  companies: 1,
  brands: 1,
  users: 1,
};
export const millisecondsPerDay = 86400000;
export function planAllowance(plan: CustomerPlan): CustomerAllowance {
  const p = plans.find((p) => p.id === plan)!;
  return {
    contacts: p.contacts,
    recipients: p.recipients,
    campaigns: p.campaigns,
    emails: p.emails,
    companies: p.companies,
    brands: p.brands,
    users: p.users,
  };
}
export function dueState(
  state: CustomerBillingState,
  failedSince: Date | null,
  now: Date,
): CustomerBillingState {
  if (!failedSince || !['past_due', 'suspended'].includes(state)) return state;
  const days = (now.getTime() - failedSince.getTime()) / millisecondsPerDay;
  return days >= 30 ? 'closed' : days >= 6 ? 'suspended' : 'past_due';
}
export function utcMonth(now: Date) {
  return now.toISOString().slice(0, 7);
}
export function nextMonth(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
