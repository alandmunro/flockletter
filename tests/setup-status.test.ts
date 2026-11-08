import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SetupStatus } from '../src/client/SetupStatus.js';

const render = (environment: string, gaps: string[], signedIn = false) =>
  renderToStaticMarkup(createElement(SetupStatus, { environment, gaps, signedIn }));

it('renders SetupStatus for local and staging gaps', () => {
  const localHtml = render('local', ['clerk_not_configured']);
  expect(localHtml).toMatch(/<h[1-6][^>]*>\s*Flockletter setup\s*<\/h[1-6]>/i);
  expect(localHtml).toContain('Clerk');
  expect(localHtml).not.toMatch(/staging|dedicated Flockletter database/i);

  const stagingHtml = render('staging', ['database_not_configured']);
  expect(stagingHtml).toMatch(/<h[1-6][^>]*>\s*Staging setup\s*<\/h[1-6]>/i);
  expect(stagingHtml).toContain('Flockletter database');
  expect(stagingHtml).not.toContain('Clerk');
});

it('shows signed-in owners the remaining setup for their own installation', () => {
  const html = render('local', ['database_not_configured'], true);
  expect(html).toContain('You’re signed in.');
  expect(html).toContain('Flockletter database');
  expect(html).not.toMatch(/staging|Clerk/i);
});
