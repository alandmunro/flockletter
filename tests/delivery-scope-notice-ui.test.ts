import { createElement } from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeliveryScopeNotice } from '../src/client/DeliveryScopeNotice.js';

describe('DeliveryScopeNotice', () => {
  it('returns null for scope all', () => {
    expect(renderToStaticMarkup(createElement(DeliveryScopeNotice, {mode:'capture',scope:'all'}))).toBe('');
  });

  it('shows capture wording for scope tests and mode capture', () => {
    const html = renderToStaticMarkup(createElement(DeliveryScopeNotice, {mode:'capture',scope:'tests'}));
    expect(html).toContain('role="status"');
    expect(html).toContain('Only reviewed one-recipient tests are allowed.');
    expect(html).toContain('Broadcasts and schedules are disabled.');
    expect(html).toContain('Messages remain captured in staging.');
  });

  it('shows ses wording for scope tests and mode ses', () => {
    const html = renderToStaticMarkup(createElement(DeliveryScopeNotice, {mode:'ses',scope:'tests'}));
    expect(html).toContain('role="status"');
    expect(html).toContain('Only separately approved tests to one confirmed contact can leave the app.');
    expect(html).toContain('Broadcasts and schedules are disabled.');
    expect(html).toContain('Existing sender, consent, and service checks apply');
    expect(html).toContain('shared five-tests-per-UTC-day limit.');
  });

  it('shows off wording for scope tests and mode off', () => {
    const html = renderToStaticMarkup(createElement(DeliveryScopeNotice, {mode:'off',scope:'tests'}));
    expect(html).toContain('role="status"');
    expect(html).toContain('Delivery is off.');
    expect(html).toContain('No email leaves.');
    expect(html).not.toContain('enabled');
  });
});
