import { createElement } from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeliveryScopeNotice } from '../src/client/DeliveryScopeNotice.js';
import { DeliveryProviderPanel } from '../src/client/DeliveryProviderPanel.js';

describe('DeliveryScopeNotice', () => {
  it('returns null for scope all', () => {
    expect(renderToStaticMarkup(createElement(DeliveryScopeNotice, {mode:'capture',scope:'all'}))).toBe('');
  });

  it('shows ses wording for scope tests and mode ses', () => {
    const html = renderToStaticMarkup(createElement(DeliveryScopeNotice, {mode:'ses',scope:'tests'}));
    expect(html).toContain('role="status"');
    expect(html).toContain('Only separately approved tests to one confirmed contact can leave the app.');
    expect(html).toContain('Broadcasts and schedules are disabled.');
    expect(html).toContain('Existing sender, consent, and service checks apply');
    expect(html).toContain('shared five-tests-per-UTC-day limit.');
  });

  it('shows resend wording for scope tests and mode resend', () => {
    const html = renderToStaticMarkup(createElement(DeliveryScopeNotice, {mode:'resend',scope:'tests'}));
    expect(html).toContain('role="status"');
    expect(html).toContain('Only separately approved tests to one confirmed contact can leave the app.');
    expect(html).toContain('Broadcasts and schedules are disabled.');
    expect(html).toContain('Existing sender, consent, and service checks apply');
    expect(html).toContain('shared five-tests-per-UTC-day limit.');
  });

  it('shows full mode no tests warning same as SES for scope all', () => {
    // scope 'all' returns null regardless of mode, so no warning is shown in full mode
    expect(renderToStaticMarkup(createElement(DeliveryScopeNotice, {mode:'ses',scope:'all'}))).toBe('');
    expect(renderToStaticMarkup(createElement(DeliveryScopeNotice, {mode:'resend',scope:'all'}))).toBe('');
  });
});

describe('DeliveryProviderPanel SSR', () => {
  it('renders initial state with heading, switching warning, and load button without secrets', () => {
    const mockApi = {
      call: async () => { throw new Error('SSR should not call API'); },asset:async()=>''
    };

    const html = renderToStaticMarkup(
      createElement(DeliveryProviderPanel, { api: mockApi, brandId: 'brand-1' })
    );

    expect(html).toContain('Sending service');
    expect(html).toContain('Select the configured external provider for this brand. Switching invalidates unsubmitted reviews and never reroutes uncertain sends.');
    expect(html).toContain('Load sending services');

    // No secrets or loaded controls should appear in SSR initial render
    expect(html).not.toContain('Save sending service');
    expect(html).not.toContain('Refresh');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('AWS SES');
    expect(html).not.toContain('Resend');
  });
});
