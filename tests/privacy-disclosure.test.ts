import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DataRetention } from '../src/client/DataRetention.js';
import { Privacy } from '../src/client/Privacy.js';
import { PublicPlans } from '../src/client/PublicPlans.js';
import {
  COOKIE_NOTICE_VERSION,
  newCookieChoice,
  savedCookieChoice,
} from '../src/shared/cookie-consent.js';
import {
  PRIVACY_NOTICE_UPDATED,
  PRIVACY_NOTICE_VERSION,
} from '../src/shared/privacy-notice.js';

const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('approved trial and account-data disclosure', () => {
  it('discloses the narrow indefinite history without promising anonymous or immediate deletion', () => {
    const page = renderToStaticMarkup(createElement(Privacy));
    const copy = text(page);
    expect(copy).toContain(PRIVACY_NOTICE_VERSION);
    expect(copy).toContain(PRIVACY_NOTICE_UPDATED);
    expect(copy).toContain(
      'retention review 90 days after verified service end',
    );
    expect(copy).toContain(
      'this is not a promise that every record is deleted on day 90',
    );
    expect(copy).toContain('trial owner, card and workspace indefinitely');
    expect(copy).toContain('including after ordinary account erasure');
    expect(copy).toContain('solely to enforce lifetime one-trial eligibility');
    expect(copy).toContain('pseudonymous personal data, not anonymous data');
    expect(copy).toContain(
      'excludes raw sign-in and workspace identifiers, provider card fingerprints, email addresses, card numbers, physical addresses, messages and mailing-list content',
    );
    expect(copy).toContain(
      'Unused eligibility reservations expire after 35 minutes',
    );
    expect(copy).toContain('does not promise physical deletion');
    expect(page).toContain('href="mailto:support@frostyflamingosoftware.com"');
  });

  it('keeps the existing cookie choice valid independently of the new privacy notice', () => {
    const at = Date.UTC(2026, 10, 9);
    const choice = newCookieChoice('reject', at);
    expect(COOKIE_NOTICE_VERSION).toBe('flockletter-cookies-v1');
    expect(PRIVACY_NOTICE_VERSION).not.toBe(COOKIE_NOTICE_VERSION);
    expect(savedCookieChoice(JSON.stringify(choice), at + 1)).toEqual(choice);
    expect(renderToStaticMarkup(createElement(Privacy))).toContain(
      COOKIE_NOTICE_VERSION,
    );
  });

  it('qualifies account erasure even while the private inventory is still loading', () => {
    const call = vi.fn();
    const page = renderToStaticMarkup(
      createElement(DataRetention, { api: { call, asset: vi.fn() } }),
    );
    const copy = text(page);
    expect(copy).toContain(
      'Ordinary account data reaches retention review 90 days',
    );
    expect(copy).toContain('protected review must complete before deletion');
    expect(copy).toContain(
      'trial-eligibility history is retained indefinitely',
    );
    expect(page).toContain('href="/privacy"');
    expect(copy).toContain('Loading retention status');
    expect(call).not.toHaveBeenCalled();
  });

  it.each(['staging', 'production'])(
    'publishes all whole-trial limits and preserves the %s activation disclaimer',
    (environment) => {
      const page = renderToStaticMarkup(
        createElement(PublicPlans, { environment }),
      );
      const copy = text(page);
      expect(copy).toContain('14-day hosted trial');
      expect(copy).toContain(
        '2 campaigns, 1 user, 1 company and 1 brand for the whole trial',
      );
      expect(copy).toContain(
        '250 active contacts and 500 total recipient emails for the trial, including test messages',
      );
      expect(copy).toContain(
        'A card is required before activating the hosted trial',
      );
      expect(copy).toContain(
        'Lifetime trial eligibility is checked for the owner, workspace and card',
      );
      expect(copy).toContain(
        'Reopening an account or changing plans does not renew free-trial eligibility',
      );
      expect(page).toContain('href="/privacy"');
      expect(copy).toContain(
        environment === 'staging'
          ? 'No trial or paid plan starts in this exercise'
          : 'Account creation does not start a trial',
      );
    },
  );
});
