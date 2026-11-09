import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingProgress, PlanCards, PublicPlans } from '../src/client/PublicPlans.js';
import type { OnboardingProgressProps } from '../src/client/OnboardingProgress.js';

const renderProgress = (facts: Partial<OnboardingProgressProps> = {}) =>
  renderToStaticMarkup(createElement(OnboardingProgress, { workspace: null, onNavigate: vi.fn(), ...facts }));

describe('public hosted pricing and staging setup', () => {
  it('renders the accepted plan limits with accessible price and allowance labels', () => {
    const cards = renderToStaticMarkup(createElement(PlanCards)).match(
      /<article\b[^>]*>[\s\S]*?<\/article>/g,
    );
    expect(cards).toHaveLength(3);
    const rows = [
      ['Starter', '$15', '2,500', '2,500', '2', '5,000', '1', '1', '1'],
      ['Growth', '$25', '5,000', '5,000', '5', '25,000', '3', '3', '3'],
      ['Pro', '$39', '10,000', '10,000', '20', '100,000', '5', '5', 'Unlimited'],
    ];
    for (const [index, values] of rows.entries()) {
      const [name, price, ...allowances] = values;
      const card = cards![index]!;
      expect(card).toContain(name);
      expect(card).toContain(price);
      const definitions = [...card.matchAll(/<dd>(.*?)<\/dd>/g)].map((match) => match[1]);
      expect(definitions).toEqual(allowances);
      expect(card).toMatch(/<dt>Recipients per campaign<\/dt>/);
      expect(card).toMatch(/<dt>Recipient emails per month<\/dt>/);
      expect(card).toMatch(/aria-labelledby="[^"]+"/);
    }
  });
  it('explains the future card trial and provides working staging account links', () => {
    const page = renderToStaticMarkup(createElement(PublicPlans,{environment:'staging'}));
    expect(page.match(/<main\b/g)).toHaveLength(1);
    expect(page.match(/<h1\b/g)).toHaveLength(1);
    for (const phrase of [
      /14.day/i,
      /250 active contacts/i,
      /500 total recipient emails/i,
      /card/i,
      /staging/i,
      /does not charge|no payment|without a charge|no charge/i,
    ])
      expect(page).toMatch(phrase);
    expect(page).toContain('href="/sign-up"');
    expect(page).toContain('href="/"');
    expect(page).not.toContain('<form');
    expect(page).not.toMatch(/>(?:choose this plan|buy now|start (?:your |a )?(?:14-day )?trial)[^<]*<\/a>/i);
  });
  it('describes production preparation without staging labels or claiming live paid signup', () => {
    const page=renderToStaticMarkup(createElement(PublicPlans,{environment:'production'}));
    const text=page.replace(/<[^>]+>/g,' ');
    expect(text).not.toMatch(/staging|simulated/i);
    expect(text).toContain('Create an account');
    expect(text).toMatch(/Account creation does not start a trial/);
    expect(text).toMatch(/before paid service or sending begins/);
    expect(page).not.toMatch(/>(?:buy now|start (?:your |a )?trial)[^<]*<\/a>/i);
  });
  it('uses neutral preparation copy when service environment is unavailable', () => {
    const page=renderToStaticMarkup(createElement(PublicPlans,{}));
    expect(page).toMatch(/shown for review/);
    expect(page).toMatch(/availability must be verified/);
    expect(page.replace(/<[^>]+>/g,' ')).not.toMatch(/staging/i);
  });
  it('shows upcoming milestones from unknown facts and only exposes available destinations', () => {
    const unknown = renderProgress();
    expect(unknown).toContain('Upcoming');
    expect(unknown).not.toContain('Complete');
    expect(unknown).not.toContain('<button');
    const facts = {
      workspace: {
        name: 'Field Notes',
        brands: [{ id: '1', name: 'Alpine Studio' }],
        entitlement: 'not_activated' as const,
      },
    };
    const before = renderProgress(facts);
    expect(before).toContain('Alpine Studio');
    expect(before).not.toContain('Ready to start');
    expect(renderProgress({ ...facts, hasDraft: false })).toContain('Ready to start');
    const after = renderProgress({
      workspace: { ...facts.workspace, entitlement: 'complimentary' },
      hasDraft: true,
    });
    expect(after).toContain('A campaign draft is saved');
    expect(after).toContain('Not checked');
    expect(after).not.toContain('Complimentary');
    expect(after).toContain('type="button"');
    expect(after).toContain('Open campaigns');
  });
});
