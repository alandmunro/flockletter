import { describe, expect, it } from 'vitest';
import { consentPolicy, intakeKey, signupInput } from '../src/shared/subscriber.js';

const base = {
  purpose: 'ffa_product_marketing',
  consentAffirmed: true,
  consentVersion: 'ffa-newsletter-v1',
  consentText: consentPolicy.text,
  source: 'storefront-footer',
  sourceDomain: 'example.com',
} as const;

const valid = (email: string) => ({ ...base, email });

function expectSignupSuccess(input: unknown) {
  const parsed = signupInput.safeParse(input);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('expected signupInput to succeed');
  return parsed.data;
}

function expectSignupFailure(input: unknown) {
  const parsed = signupInput.safeParse(input);
  expect(parsed.success).toBe(false);
}

describe('signupInput', () => {
  it('accepts a valid payload and normalizes email whitespace/domain case', () => {
    const data = expectSignupSuccess(valid('  John.Doe+X@Example.COM '));
    expect(data.email).toBe('John.Doe+X@example.com');
  });

  it('preserves local-part case, plus signs, and dots', () => {
    const data = expectSignupSuccess(valid('MiXeD.Case+Plus@Example.COM'));
    expect(data.email).toBe('MiXeD.Case+Plus@example.com');
  });

  it('rejects invalid, oversized, and control-character emails', () => {
    for (const email of [
      'plainaddress',
      '@example.com',
      'user@',
      'a b@example.com',
      'a\nb@example.com',
      'a\tb@example.com',
      `${'a'.repeat(400)}@example.com`,
    ]) {
      expectSignupFailure(valid(email));
    }
  });

  it('rejects unexpected client authority fields', () => {
    for (const field of ['workspaceId', 'brandId', 'state', 'occurredAt'] as const) {
      expectSignupFailure({ ...valid('a@b.com'), [field]: 'x' });
    }
  });

  it('rejects false or missing consent', () => {
    const { consentAffirmed, ...withoutConsent } = valid('a@b.com');
    void consentAffirmed;

    expectSignupFailure(withoutConsent);
    expectSignupFailure({ ...valid('a@b.com'), consentAffirmed: false });
  });

  it('requires exact purpose, version, and string fields', () => {
    expectSignupFailure({});

    expectSignupFailure({ ...valid('a@b.com'), purpose: 'other' });
    expectSignupFailure({ ...valid('a@b.com'), consentVersion: 'other' });
    expectSignupFailure({ ...valid('a@b.com'), consentText: 1 });
    expectSignupFailure({ ...valid('a@b.com'), source: 1 });
    expectSignupFailure({ ...valid('a@b.com'), sourceDomain: 1 });

    const { email, ...withoutEmail } = valid('a@b.com');
    void email;
    expectSignupFailure(withoutEmail);
  });
});

describe('intakeKey', () => {
  it('accepts allowed characters at boundary lengths', () => {
    for (const value of ['a'.repeat(16), '0'.repeat(16), '-_'.repeat(8), 'A1_b-'.repeat(25) + 'abc']) {
      expect(intakeKey.safeParse(value).success).toBe(true);
    }
  });

  it('rejects out-of-range or invalid keys', () => {
    expect(intakeKey.safeParse('').success).toBe(false);
    expect(intakeKey.safeParse('a'.repeat(15)).success).toBe(false);
    expect(intakeKey.safeParse('a'.repeat(129)).success).toBe(false);

    for (const bad of ['abc def', 'a.b-c_d', 'a/b-c_d', 'a+b-c_d']) {
      expect(intakeKey.safeParse(bad.padEnd(16, 'x')).success).toBe(false);
    }
  });
});
