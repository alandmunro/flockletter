import { describe, it, expect } from 'vitest';
import { sitePresentation } from '../src/shared/site-presentation.js';

describe('sitePresentation', () => {
  it.each([undefined, null, {}, [], 'toString', 'constructor', '__proto__', 'PRODUCTION', 'future'])('returns unknown for %p', (val) => {
    const r = sitePresentation(val);
    expect(r.environment).toBe('unknown');
    expect(r.workspaceNotice.toLowerCase()).toContain('not been verified');
  });

  it.each(['local', 'test', 'staging'])('keeps %s as exercise/preparation, signup not paid trial', (env) => {
    const r = sitePresentation(env);
    expect(r.environment).toBe(env);
    expect(r.workspaceNotice.toLowerCase()).toMatch(/exercise|sample data/);
    expect(r.pricingNote).toMatch(/no charge/i);
    expect(r.trialNote).toMatch(/No trial or paid plan starts in this exercise/);
  });

  it('production: no staging/simulated, account creation does not enable delivery/start subscription', () => {
    const r = sitePresentation('production');
    expect(r.environment).toBe('production');
    [r.workspaceNotice, r.pricingNote, r.accountLabel].forEach(s => {
      expect(s.toLowerCase()).not.toContain('staging');
      expect(s.toLowerCase()).not.toContain('simulated');
    });
    expect(r.workspaceNotice).toMatch(/does not enable delivery|does not start a subscription/i);
    expect(r.trialNote).toMatch(/not automatic|before accepting/i);
  });

});
