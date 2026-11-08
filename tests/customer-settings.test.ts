import { expect, it } from 'vitest';
import { customerSettings } from '../src/server/customer-settings.js';
import type { Config } from '../src/server/config.js';
const config = (environment: Config['environment'] = 'staging'): Config => ({
  environment,
  origin: 'https://flockletter.example.com',
  browserOrigins: ['https://flockletter.example.com'],
  host: '127.0.0.1',
  port: 4310,
  localIdentity: false,
});
it('starts all customer workflows disabled and bounds embedded engine capacity', () => {
  expect(customerSettings(config(), {})).toEqual({
    billing: 'off',
    delivery: 'off',
    audience: 'off',
    team: 'off',
    support: 'off',
    retention: 'off',
    infrastructure: 'off',
    provisioningMonthlyLimit: 0,
    dedicated: false,
    renderer: false,
    engineCount: 1,
  });
  expect(
    customerSettings(config(), {
      FLOCKLETTER_CUSTOMER_WORKER: 'dedicated',
      FLOCKLETTER_PRIVATE_ENGINE: 'embedded',
      FLOCKLETTER_CUSTOMER_ENGINE_COUNT: '5',
    }),
  ).toMatchObject({ dedicated: true, renderer: true, engineCount: 5 });
  for (const count of ['0', '6', '1.5', 'not-a-number'])
    expect(() => customerSettings(config(), { FLOCKLETTER_CUSTOMER_ENGINE_COUNT: count })).toThrow();
});
it.each(['BILLING', 'DELIVERY', 'AUDIENCE', 'TEAM', 'SUPPORT', 'RETENTION', 'INFRASTRUCTURE'])(
  'rejects unknown %s modes rather than enabling defaults',
  (area) => {
    expect(() => customerSettings(config(), { ['FLOCKLETTER_CUSTOMER_' + area]: 'enabled' })).toThrow();
  },
);
it.each([
  ['BILLING', 'exercise'],
  ['DELIVERY', 'capture'],
  ['AUDIENCE', 'exercise'],
  ['TEAM', 'exercise'],
  ['SUPPORT', 'capture'],
  ['RETENTION', 'capture'],
  ['INFRASTRUCTURE', 'capture'],
])('rejects %s %s exercise in production', (area, mode) => {
  expect(() => customerSettings(config('production'), { ['FLOCKLETTER_CUSTOMER_' + area]: mode })).toThrow(
    'Captured exercises',
  );
});
it('keeps captured exercises usable on staging without external activation flags', () => {
  expect(
    customerSettings(config(), {
      FLOCKLETTER_CUSTOMER_BILLING: 'exercise',
      FLOCKLETTER_CUSTOMER_DELIVERY: 'capture',
      FLOCKLETTER_CUSTOMER_AUDIENCE: 'exercise',
      FLOCKLETTER_CUSTOMER_TEAM: 'exercise',
      FLOCKLETTER_CUSTOMER_SUPPORT: 'capture',
      FLOCKLETTER_CUSTOMER_RETENTION: 'capture',
    }),
  ).toMatchObject({
    billing: 'exercise',
    delivery: 'capture',
    audience: 'exercise',
    team: 'exercise',
    support: 'capture',
    retention: 'capture',
  });
});
it('requires exact live-mail approval and production together', () => {
  for (const environment of ['local', 'test', 'staging'] as const)
    expect(() =>
      customerSettings(config(environment), {
        FLOCKLETTER_CUSTOMER_DELIVERY: 'ses',
        FLOCKLETTER_LIVE_MAILING_APPROVED: 'true',
      }),
    ).toThrow('production');
  for (const approved of [undefined, 'false', 'TRUE', '1'])
    expect(() =>
      customerSettings(config('production'), {
        FLOCKLETTER_CUSTOMER_DELIVERY: 'ses',
        FLOCKLETTER_LIVE_MAILING_APPROVED: approved,
      }),
    ).toThrow();
  expect(
    customerSettings(config('production'), {
      FLOCKLETTER_CUSTOMER_DELIVERY: 'ses',
      FLOCKLETTER_LIVE_MAILING_APPROVED: 'true',
    }).delivery,
  ).toBe('ses');
});
it('requires separate approval for confirmation and support and credentials for Clerk administration', () => {
  for (const [key, flag] of [
    ['FLOCKLETTER_CUSTOMER_AUDIENCE', 'FLOCKLETTER_CONFIRMATION_ACTIVATION_APPROVED'],
    ['FLOCKLETTER_CUSTOMER_SUPPORT', 'FLOCKLETTER_SUPPORT_ACTIVATION_APPROVED'],
  ]) {
    expect(() => customerSettings(config(), { [key!]: 'live' })).toThrow();
    expect(customerSettings(config(), { [key!]: 'live', [flag!]: 'true' })).toBeDefined();
  }
  expect(() => customerSettings(config(), { FLOCKLETTER_CUSTOMER_TEAM: 'clerk' })).toThrow('verified Clerk');
  expect(
    customerSettings(
      { ...config(), clerkSecretKey: 'sk_test_fixture', clerkPublishableKey: 'pk_test_fixture' },
      { FLOCKLETTER_CUSTOMER_TEAM: 'clerk' },
    ).team,
  ).toBe('clerk');
  expect(customerSettings(config('production'), { FLOCKLETTER_CUSTOMER_RETENTION: 'live' }).retention).toBe(
    'live',
  );
});

it('gates cloud infrastructure independently and defaults its bounded monthly allowance to zero', () => {
  for (const environment of ['local', 'test', 'staging'] as const)
    expect(() =>
      customerSettings(config(environment), {
        FLOCKLETTER_CUSTOMER_INFRASTRUCTURE: 'aws',
        FLOCKLETTER_INFRASTRUCTURE_ACTIVATION_APPROVED: 'true',
      }),
    ).toThrow('production');
  for (const approved of [undefined, 'false', 'TRUE', '1'])
    expect(() =>
      customerSettings(config('production'), {
        FLOCKLETTER_CUSTOMER_INFRASTRUCTURE: 'aws',
        FLOCKLETTER_INFRASTRUCTURE_ACTIVATION_APPROVED: approved,
      }),
    ).toThrow();
  expect(
    customerSettings(config('production'), {
      FLOCKLETTER_CUSTOMER_INFRASTRUCTURE: 'aws',
      FLOCKLETTER_INFRASTRUCTURE_ACTIVATION_APPROVED: 'true',
    }),
  ).toMatchObject({ infrastructure: 'aws', provisioningMonthlyLimit: 0 });
  for (const maximum of ['-1', '21', '2.5', 'unlimited'])
    expect(() => customerSettings(config(), { FLOCKLETTER_INFRASTRUCTURE_MONTHLY_LIMIT: maximum })).toThrow();
});
