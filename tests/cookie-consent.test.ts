import { describe, expect, it } from 'vitest';
import {
  COOKIE_NOTICE_VERSION,
  COOKIE_OPTIONAL_PURPOSES,
  newCookieChoice,
  optionalCookieAllowed,
  savedCookieChoice,
} from '../src/shared/cookie-consent.js';

const T = 1800_000_000_000;
const DAY = 86_400_000;

describe('cookie-consent', () => {
  it('roundtrips accept and reject through savedCookieChoice', () => {
    for (const choice of ['accept', 'reject'] as const) {
      const raw = JSON.stringify(newCookieChoice(choice, T));
      expect(savedCookieChoice(raw, T)).toEqual({
        version: COOKIE_NOTICE_VERSION,
        choice,
        at: T,
        purposes: [...COOKIE_OPTIONAL_PURPOSES],
      });
    }
  });

  it('accepts a preference immediately before expiry', () => {
    const raw = JSON.stringify(newCookieChoice('accept', T - 180 * DAY + 1));
    expect(savedCookieChoice(raw, T)).not.toBeNull();
  });

  it('rejects a preference exactly at the 180-day boundary', () => {
    const raw = JSON.stringify(newCookieChoice('accept', T - 180 * DAY));
    expect(savedCookieChoice(raw, T)).toBeNull();
  });

  it('rejects a future timestamp', () => {
    const raw = JSON.stringify({ version: COOKIE_NOTICE_VERSION, choice: 'accept', at: T + 1, purposes: [] });
    expect(savedCookieChoice(raw, T)).toBeNull();
  });

  it.each([
    ['non-integer', { at: T + 0.5 }],
    ['negative', { at: -1 }],
    ['NaN', { at: NaN }],
  ])('rejects invalid timestamp %s', (_label, patch) => {
    const raw = JSON.stringify({ version: COOKIE_NOTICE_VERSION, choice: 'accept', at: patch.at, purposes: [] });
    expect(savedCookieChoice(raw, T)).toBeNull();
  });

  it('rejects an unknown version', () => {
    const raw = JSON.stringify({ version: 'other-v1', choice: 'accept', at: T, purposes: [] });
    expect(savedCookieChoice(raw, T)).toBeNull();
  });

  it('rejects extra fields', () => {
    const raw = JSON.stringify({ version: COOKIE_NOTICE_VERSION, choice: 'accept', at: T, purposes: [], extra: true });
    expect(savedCookieChoice(raw, T)).toBeNull();
  });

  it('rejects missing purposes', () => {
    const raw = JSON.stringify({ version: COOKIE_NOTICE_VERSION, choice: 'accept', at: T });
    expect(savedCookieChoice(raw, T)).toBeNull();
  });

  it('rejects purposes containing a non-empty optional purpose', () => {
    const raw = JSON.stringify({ version: COOKIE_NOTICE_VERSION, choice: 'accept', at: T, purposes: ['analytics'] });
    expect(savedCookieChoice(raw, T)).toBeNull();
  });

  it.each([['array', ['accept']], ['object', { value: 'accept' }]])('rejects choice as %s', (_label, choice) => {
    const raw = JSON.stringify({ version: COOKIE_NOTICE_VERSION, choice, at: T, purposes: [] });
    expect(savedCookieChoice(raw, T)).toBeNull();
  });

  it('rejects an unknown choice', () => {
    const raw = JSON.stringify({ version: COOKIE_NOTICE_VERSION, choice: 'maybe', at: T, purposes: [] });
    expect(savedCookieChoice(raw, T)).toBeNull();
  });

  it.each([['malformed', '{not json'], ['scalar', '42'], ['array', '[1]'], ['null-record', 'null']])(
    'rejects %s record',
    (_label, raw) => {
      expect(savedCookieChoice(raw as string | null, T)).toBeNull();
    },
  );

  it('never grants optional purposes when the list is empty', () => {
    const accepted = JSON.stringify(newCookieChoice('accept', T));
    for (const purpose of ['analytics', 'advertising', 'unknown']) {
      expect(optionalCookieAllowed(accepted, purpose, false, T)).toBe(false);
    }
  });

  it('never grants optional purposes under a browser privacy signal even when accepted', () => {
    const accepted = JSON.stringify(newCookieChoice('accept', T));
    for (const purpose of ['analytics', 'advertising', 'unknown']) {
      expect(optionalCookieAllowed(accepted, purpose, true, T)).toBe(false);
    }
  });

  it('never grants optional purposes for a rejected choice', () => {
    const rejected = JSON.stringify(newCookieChoice('reject', T));
    for (const purpose of ['analytics', 'advertising', 'unknown']) {
      expect(optionalCookieAllowed(rejected, purpose, false, T)).toBe(false);
    }
  });
});
