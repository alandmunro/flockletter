import { describe, expect, it } from 'vitest';
import { customerPreparation } from '../src/server/customer-preparation.js';

function trialEnv(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    APP_ENV: 'production',
    FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT: 'acct_SYNTHETIC',
    FLOCKLETTER_TRIAL_HMAC_KEY: 'x'.repeat(64),
    FLOCKLETTER_TRIAL_POLICY_ID: 'approved-v1',
    FLOCKLETTER_TRIAL_POLICY_VERSION: '1',
    FLOCKLETTER_TRIAL_RETENTION_APPROVED: 'true',
    FLOCKLETTER_TRIAL_HISTORY_BASELINE: 'verified-empty',
    ...overrides,
  };
}

describe('customerPreparation', () => {
  it('describes the temporary operator exception without claiming MFA or activating access',()=>{
    const result=customerPreparation({FLOCKLETTER_OPERATOR_MFA_POLICY:'pre-revenue'});
    expect(result.find(c=>c.area==='Administrator sign-in')).toMatchObject({state:'settings_recorded',detail:expect.stringContaining('Temporary single-factor exception')});
    expect(result.find(c=>c.area==='Administrator sign-in')?.detail).toContain('does not activate operator access');
    expect(customerPreparation({FLOCKLETTER_OPERATOR_MFA_POLICY:'required'}).some(c=>c.area==='Administrator sign-in')).toBe(false);
  });
  it('reports all groups missing when env is empty', () => {
    const result = customerPreparation({});
    expect(result.every((c) => c.state === 'settings_missing')).toBe(true);
  });

  it('treats whitespace-only values as missing', () => {
    const env: Record<string, string> = {};
    for (const k of [
      'FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT',
      'FLOCKLETTER_TRIAL_HMAC_KEY',
      'FLOCKLETTER_SUPPORT_RESEND_KEY',
    ]) {
      env[k] = '   ';
    }
    const result = customerPreparation(env);
    expect(result.find((c) => c.area === 'Billing provider')?.state).toBe(
      'settings_missing',
    );
  });

  it('records complete billing group with synthetic keys while billing remains off', () => {
    const env: Record<string, string> = {
      FLOCKLETTER_CUSTOMER_BILLING:'off',
      FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT: 'acct_SYNTHETIC',
      FLOCKLETTER_CUSTOMER_STRIPE_KEY: 'sk_test_synthetic_billing_key_0123456789',
      FLOCKLETTER_CUSTOMER_STRIPE_WEBHOOK: 'whsec_synthetic_webhook_abcdef',
      FLOCKLETTER_CUSTOMER_STRIPE_CARD_CONFIG: 'card_config_v1',
      FLOCKLETTER_CUSTOMER_STRIPE_PORTAL_CONFIG: 'portal_config_v1',
      FLOCKLETTER_CUSTOMER_STARTER_PORTAL_CONFIG: 'starter_portal_v1',
      FLOCKLETTER_CUSTOMER_GROWTH_PORTAL_CONFIG: 'growth_portal_v1',
      FLOCKLETTER_CUSTOMER_PRO_PORTAL_CONFIG: 'pro_portal_v1',
      FLOCKLETTER_CUSTOMER_STARTER_PRICE: 'price_starter_001',
      FLOCKLETTER_CUSTOMER_GROWTH_PRICE: 'price_growth_001',
      FLOCKLETTER_CUSTOMER_PRO_PRICE: 'price_pro_001',
    };
    const snapshot = JSON.stringify(env);
    const result = customerPreparation(env);
    expect(JSON.stringify(env)).toBe(snapshot);
    const billing = result.find((c) => c.area === 'Billing provider');
    expect(billing?.state).toBe('settings_recorded');
  });

  it('excludes synthetic secret values from output', () => {
    const env: Record<string, string> = {
      FLOCKLETTER_CUSTOMER_BILLING:'off',
      FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT: 'acct_SYNTHETIC',
      FLOCKLETTER_CUSTOMER_STRIPE_KEY: 'sk_test_synthetic_billing_key_0123456789',
      FLOCKLETTER_CUSTOMER_STRIPE_WEBHOOK: 'whsec_synthetic_webhook_abcdef',
      FLOCKLETTER_CUSTOMER_STRIPE_CARD_CONFIG: 'card_config_v1',
      FLOCKLETTER_CUSTOMER_STRIPE_PORTAL_CONFIG: 'portal_config_v1',
      FLOCKLETTER_CUSTOMER_STARTER_PORTAL_CONFIG: 'starter_portal_v1',
      FLOCKLETTER_CUSTOMER_GROWTH_PORTAL_CONFIG: 'growth_portal_v1',
      FLOCKLETTER_CUSTOMER_PRO_PORTAL_CONFIG: 'pro_portal_v1',
      FLOCKLETTER_CUSTOMER_STARTER_PRICE: 'price_starter_001',
      FLOCKLETTER_CUSTOMER_GROWTH_PRICE: 'price_growth_001',
      FLOCKLETTER_CUSTOMER_PRO_PRICE: 'price_pro_001',
    };
    const output = JSON.stringify(customerPreparation(env));
    expect(output).not.toContain('sk_test_synthetic_billing_key_0123456789');
    expect(output).not.toContain('whsec_synthetic_webhook_abcdef');
  });

  it('returns settings_recorded with verification disclaimer for valid trial config', () => {
    const result = customerPreparation(trialEnv());
    const trial = result.find((c) => c.area === 'Trial protection');
    expect(trial?.state).toBe('settings_recorded');
    expect(trial?.detail).toContain('do not verify permissions, provider acceptance');
  });

  it('yields settings_invalid for short HMAC key', () => {
    const result = customerPreparation(
      trialEnv({ FLOCKLETTER_TRIAL_HMAC_KEY: 'short' }),
    );
    const trial = result.find((c) => c.area === 'Trial protection');
    expect(trial?.state).toBe('settings_invalid');
  });

  it('yields settings_invalid for false retention approval', () => {
    const result = customerPreparation(
      trialEnv({ FLOCKLETTER_TRIAL_RETENTION_APPROVED: 'false' }),
    );
    const trial = result.find((c) => c.area === 'Trial protection');
    expect(trial?.state).toBe('settings_invalid');
  });

  it.each([
    {FLOCKLETTER_TRIAL_HISTORY_BASELINE:'unknown'},
    {FLOCKLETTER_TRIAL_POLICY_VERSION:'0'},
    {FLOCKLETTER_TRIAL_POLICY_VERSION:'1.5'},
    {FLOCKLETTER_CUSTOMER_STRIPE_ACCOUNT:'unconfigured'},
  ])('rejects an invalid trial setting independently: %j',overrides=>{
    const trial=customerPreparation(trialEnv(overrides)).find(c=>c.area==='Trial protection');
    expect(trial?.state).toBe('settings_invalid');
  });
});
