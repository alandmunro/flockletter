import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SubscriptionUsage } from '../src/client/SubscriptionUsage.js';
import type { CustomerBillingStatus } from '../src/shared/customer-billing.js';

const baseStatus: CustomerBillingStatus = {
  mode: 'exercise',
  source: 'exercise',
  state: 'active',
  plan: 'pro',
  pendingPlan: null,
  revision: 1,
  eligible: true,
  reasons: [],
  now: '2026-11-27T00:00:00.000Z',
  trialEnd: null,
  periodStart: '2026-11-01T00:00:00.000Z',
  periodEnd: '2026-12-01T00:00:00.000Z',
  cancelAt: null,
  failedSince: null,
  limits: {
    contacts: 250,
    recipients: 250,
    campaigns: 2,
    emails: 500,
    companies: 1,
    brands: 1,
    users: null,
  },
  usage: {
    period: '2026-11',
    campaigns: 1,
    emails: 17,
    reservedCampaigns: 0,
    reservedEmails: 11,
  },
  exerciseEnabled: true,
};

describe('SubscriptionUsage', () => {
  it('renders empty markup when limits is null', () => {
    const status: CustomerBillingStatus = { ...baseStatus, limits: null };
    const html = renderToStaticMarkup(React.createElement(SubscriptionUsage, { status }));
    expect(html).toBe('');
  });

  it('displays email usage against cap and recipient cap', () => {
    const status: CustomerBillingStatus = baseStatus;
    const html = renderToStaticMarkup(React.createElement(SubscriptionUsage, { status }));

    expect(html).toContain('Recipient emails: 17 / 500 used');
    expect(html).toContain('Recipient-per-campaign cap: 250');
  });

  it('renders Unlimited when users limit is null', () => {
    const status: CustomerBillingStatus = baseStatus;
    const html = renderToStaticMarkup(React.createElement(SubscriptionUsage, { status }));

    expect(html).toContain('Unlimited');
  });
});

it('shows remaining allowance and a validated UTC reset without exposing a trial identifier', () => {
  const html = renderToStaticMarkup(React.createElement(SubscriptionUsage, { status: baseStatus }));
  expect(html).toContain('472 remaining');
  expect(html).toContain('Resets on 12/1/2026 UTC');
  const trial = {
    ...baseStatus,
    state: 'trialing' as const,
    usage: { ...baseStatus.usage, period: 'trial:synthetic-internal-id' },
    trialEnd: '2026-11-22T15:00:00Z',
  };
  const trialHtml = renderToStaticMarkup(React.createElement(SubscriptionUsage, { status: trial }));
  expect(trialHtml).toContain('Trial allowance covers the whole trial and ends on');
  expect(trialHtml).not.toContain('trial:synthetic-internal-id');
  expect(trialHtml).not.toContain('resets on');
  const missing = renderToStaticMarkup(
    React.createElement(SubscriptionUsage, { status: { ...trial, trialEnd: null } }),
  );
  expect(missing).toContain('Reset unavailable');
  expect(missing).not.toContain('1970');
});
