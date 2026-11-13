import {describe, expect, it, vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

import {SendingTrustNotice} from '../src/client/SendingTrustNotice.js';
import {OperatorSendingTrust} from '../src/client/OperatorSendingTrust.js';
import {SenderSetupDetails} from '../src/client/SenderSetupDetails.js';

import type {SendingTrustStatus} from '../src/shared/sending-safeguards.js';
import type {SenderSetupView} from '../src/shared/sender-setup.js';

const baseStatus: SendingTrustStatus = {
  phase: 'new',
  dailyLimit: null,
  usedToday: 0,
  held: false,
  warning: false,
  codes: [],
  reasons: [],
  observedAt: '2026-01-15T08:30:00Z',
  revision: 42,
  ageDays: 3,
  delivered: 10,
};

const baseSetupView: SenderSetupView = {
  enabled: true,
  captured: false,
  alreadyConfigured: false,
  brandId: '00000000-0000-4000-8000-000000000001',
  ownershipVerified: false,
  senderRevision: 7,
  setup: null,
  gaps: [],
};

describe('launch-ui SSR', () => {
  it('renders held trust notice with safe HTML escaping and pause alert', () => {
    const status: SendingTrustStatus = {
      ...baseStatus,
      held: true,
      reasons: ['<script>alert("xss")</script> bounce spike'],
    };

    const html = renderToStaticMarkup(createElement(SendingTrustNotice, {status}));

    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; bounce spike');
    expect(html).not.toContain('<script>alert("xss")</script>');

    expect(html).toContain('role="alert"');
    expect(html).toContain('Sending is paused pending operator review.');

    expect(html).toContain('New sender');
  });

  it('full phase copy does not say unlimited', () => {
    const status: SendingTrustStatus = {
      ...baseStatus,
      phase: 'full',
      dailyLimit: 5000,
      usedToday: 120,
    };

    const html = renderToStaticMarkup(createElement(SendingTrustNotice, {status}));

    expect(html).toContain('Full plan access');
    expect(html.toLowerCase()).not.toContain('unlimited');
  });

  it('operator limited restart stays enabled when held but higher phases are disabled', () => {
    const status: SendingTrustStatus = {
      ...baseStatus,
      phase: 'limited',
      held: true,
      ageDays: 20,
      delivered: 600,
    };

    const html = renderToStaticMarkup(
      createElement(OperatorSendingTrust, {
        status,
        busy: false,
        onRefresh: vi.fn(),
        onReview: vi.fn(),
      }),
    );

    const limitedBtn = html.match(/<button\b[^>]*>Review limited restart<\/button>/);
    expect(limitedBtn).not.toBeNull();
    expect(limitedBtn![0]).not.toContain('disabled');

    const establishedBtn = html.match(/<button\b[^>]*>Review established limit<\/button>/);
    expect(establishedBtn).not.toBeNull();
    expect(establishedBtn![0]).toContain('disabled');

    const fullBtn = html.match(/<button\b[^>]*>Review full plan access<\/button>/);
    expect(fullBtn).not.toBeNull();
    expect(fullBtn![0]).toContain('disabled');

    expect(html).toContain('Sending is paused pending operator review.');
  });

  it('captured sender setup clearly labels unusable DNS records', () => {
    const view: SenderSetupView = {
      ...baseSetupView,
      captured: true,
      alreadyConfigured: false,
      setup: {
        id: 'a1b2c3d4-0000-4000-8000-000000000001',
        domain: 'example.invalid',
        fromEmail: 'noreply@example.invalid',
        senderRevision: 7,
        state: 'awaiting_dns',
        reason: null,
        dns: [
          {name: 'example.invalid', type: 'TXT', value: 'v=spf1 include:_spf.example.invalid ~all'},
          {name: 'default._domainkey.example.invalid', type: 'TXT', value: 'k=rsa;p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC7'},
        ],
      },
    };

    const html = renderToStaticMarkup(
      createElement(SenderSetupDetails, {
        view,
        busy: false,
        onReview: vi.fn(),
        onApprove: vi.fn(),
        onRefresh: vi.fn(),
      }),
    );

    expect(html).toContain('Captured staging exercise');
    expect(html).toContain('do not add them to your domain');

    expect(html).toContain('example.invalid');
    expect(html).toContain('default._domainkey.example.invalid');
    expect(html).toContain('v=spf1 include:_spf.example.invalid ~all');

    expect(html).toContain('No real domain or email is created.');
  });

  it('uncertain domain shows do-not-recreate guidance and no Review or Approve controls', () => {
    const view: SenderSetupView = {
      ...baseSetupView,
      setup: {
        id: 'b2c3d4e5-0000-4000-8000-000000000002',
        domain: 'pending-domain.example.com',
        fromEmail: 'mailer@pending-domain.example.com',
        senderRevision: 7,
        state: 'uncertain',
        reason: null,
        dns: [],
      },
    };

    const html = renderToStaticMarkup(
      createElement(SenderSetupDetails, {
        view,
        busy: false,
        onReview: vi.fn(),
        onApprove: vi.fn(),
        onRefresh: vi.fn(),
      }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain(
      'This setup is in an uncertain state. Do not create another domain or submit a new review.',
    );

    expect(html).not.toContain('Review sender setup');

    expect(html).not.toContain('Approve reviewed setup');

  });

  it('reviewed setup Approve disabled without ownership and enabled with it', () => {
    const reviewedNoOwnership: SenderSetupView = {
      ...baseSetupView,
      ownershipVerified: false,
      setup: {
        id: 'c3d4e5f6-0000-4000-8000-000000000003',
        domain: 'verified.example.com',
        fromEmail: 'team@verified.example.com',
        senderRevision: 7,
        state: 'reviewed',
        reason: null,
        dns: [],
      },
    };

    const htmlNoOwnership = renderToStaticMarkup(
      createElement(SenderSetupDetails, {
        view: reviewedNoOwnership,
        busy: false,
        onReview: vi.fn(),
        onApprove: vi.fn(),
        onRefresh: vi.fn(),
      }),
    );

    const approveBtnNoOwnership = htmlNoOwnership.match(/<button\b[^>]*>Approve reviewed setup<\/button>/);
    expect(approveBtnNoOwnership).not.toBeNull();
    expect(approveBtnNoOwnership![0]).toContain('disabled');

    const reviewedWithOwnership: SenderSetupView = {
      ...baseSetupView,
      ownershipVerified: true,
      setup: reviewedNoOwnership.setup,
    };

    const htmlWithOwnership = renderToStaticMarkup(
      createElement(SenderSetupDetails, {
        view: reviewedWithOwnership,
        busy: false,
        onReview: vi.fn(),
        onApprove: vi.fn(),
        onRefresh: vi.fn(),
      }),
    );

    const approveBtnWithOwnership = htmlWithOwnership.match(/<button\b[^>]*>Approve reviewed setup<\/button>/);
    expect(approveBtnWithOwnership).not.toBeNull();
    expect(approveBtnWithOwnership![0]).not.toContain('disabled');
  });

  it('callbacks are never invoked by SSR rendering', () => {
    const onRefresh = vi.fn();
    const onReview = vi.fn();
    const onApprove = vi.fn();

    const status: SendingTrustStatus = {...baseStatus};
    const view: SenderSetupView = {
      ...baseSetupView,
      setup: {
        id: 'd4e5f6a7-0000-4000-8000-000000000004',
        domain: 'ssr-test.example.com',
        fromEmail: 'test@ssr-test.example.com',
        senderRevision: 7,
        state: 'reviewed',
        reason: null,
        dns: [],
      },
    };

    renderToStaticMarkup(createElement(SendingTrustNotice, {status}));
    renderToStaticMarkup(
      createElement(OperatorSendingTrust, {status, busy: false, onRefresh, onReview}),
    );
    renderToStaticMarkup(
      createElement(SenderSetupDetails, {view, busy: false, onReview, onApprove, onRefresh}),
    );

    expect(onRefresh).not.toHaveBeenCalled();
    expect(onReview).not.toHaveBeenCalled();
    expect(onApprove).not.toHaveBeenCalled();
  });
});
