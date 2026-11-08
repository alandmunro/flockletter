import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RecipientList } from '../src/client/ProviderOutcomes.js';
import type { RecipientOutcome } from '../src/shared/rehearsal.js';

const accepted: RecipientOutcome = {
  id: 'bd420c00-4636-407d-82da-05ae2793a341',
  state: 'accepted',
  reason: null,
  attempts: 1,
};
const render = (recipient: RecipientOutcome) =>
  renderToStaticMarkup(createElement(RecipientList, { recipients: [recipient] }));

describe('provider submission and later delivery feedback', () => {
  it('keeps an earlier acceptance distinct from later feedback or a missing delivery report', () => {
    const historical = render(accepted);
    expect(render({ ...accepted, feedback: null })).toBe(historical);
    expect(historical).toContain('Accepted by the test provider');
    expect(historical).not.toMatch(/confirmed delivery|reported delivery|delivered/i);

    const delivered = render({ ...accepted, feedback: 'delivered' });
    expect(delivered).toContain('Accepted by the test provider');
    expect(delivered).toMatch(/confirm\w* delivery|report\w* delivery|delivered/i);
    expect(delivered).toContain(accepted.id);
  });

  it('explains brand suppression for a permanent bounce and a complaint without calling a temporary bounce permanent', () => {
    const temporary = render({ ...accepted, feedback: 'temporary_bounce' });
    expect(temporary).toMatch(/temporary bounce/i);
    expect(temporary).not.toMatch(/suppress|exclud|block/i);

    for (const feedback of ['permanent_bounce', 'complaint'] as const) {
      const html = render({ ...accepted, feedback });
      expect(html).toContain('Accepted by the test provider');
      expect(html).toMatch(feedback === 'complaint' ? /complaint/i : /permanent bounce/i);
      expect(html).toMatch(/suppress|exclud|block/i);
      expect(html).toMatch(/brand/i);
    }
  });
});
