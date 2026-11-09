import { describe, expect, it } from 'vitest';
import { createElement,type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmedTestRecipientPicker } from '../src/client/ConfirmedTestRecipientPicker.js';
import type { AudienceContact } from '../src/shared/audience.js';

const noop = () => {};
const base: AudienceContact[] = [
  { id: 'id1', email: 'confirmed@example.test', state: 'confirmed', createdAt: '2025-01-01T00:00:00Z', confirmedAt: '2025-01-02T00:00:00Z' },
  { id: 'id2', email: 'pending@example.test', state: 'pending', createdAt: '2025-01-01T00:00:00Z',confirmedAt:null },
  { id:'id3',email:'unsubscribed@example.test',state:'unsubscribed',createdAt:'2025-01-01T00:00:00Z',confirmedAt:'2025-01-02T00:00:00Z' },
];

function render(props: Partial<ComponentProps<typeof ConfirmedTestRecipientPicker>>) {
  return renderToStaticMarkup(
    createElement(ConfirmedTestRecipientPicker, {
      prefix: 'test',
      contacts: [],
      selectedId: '',
      busy: false,
      search: '',
      hasMore: false,
      onSelect: noop,
      onSearchChange: noop,
      onSearch: noop,
      onNext: noop,
      onRefresh: noop,
      ...props,
    }),
  );
}

describe('ConfirmedTestRecipientPicker SSR', () => {
  it('shows only confirmed email options; no pending/unsubscribed email', () => {
    const html = render({ contacts: base });
    expect(html).toContain('confirmed@example.test');
    expect(html).not.toContain('pending@example.test');
    expect(html).not.toContain('unsubscribed@example.test');
  });

  it('default selects placeholder, not first contact', () => {
    const html = render({ contacts: base });
    expect(html).toMatch(/<option value="" selected="">Choose one confirmed contact/);
  });

  it('retains disabled option when selectedId is unavailable', () => {
    const html = render({ contacts: base, selectedId: 'ghost' });
    expect(html).toMatch(/<option(?=[^>]*value="ghost")(?=[^>]*disabled)(?=[^>]*selected)[^>]*>/);
  });

  it('empty contacts shows actionable message', () => {
    const html = render({});
    expect(html).toContain('No confirmed contacts found.');
  });

  it('busy disables search input, select, and Find contact button', () => {
    const html = render({ contacts: base, busy: true });
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).toMatch(/<select[^>]*disabled/);
    expect(html).toMatch(/<button(?=[^>]*type="submit")(?=[^>]*disabled)[^>]*>Find contact/);
  });

  it('lookup labels say existing confirmed; no signup/send mutation wording', () => {
    const html = render({ contacts: base });
    expect(html).toContain('Find an existing confirmed contact');
    expect(html).not.toMatch(/>\s*(?:Send test|Approve test|Create subscriber)\s*</i);
  });

  it('error is visible', () => {
    const html = render({ error: 'boom' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('boom');
  });
});
