import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SignupFields } from '../../shared/SignupPostcard.js';
import type { HostedPolicySnapshot } from '../../shared/texting-policy-pages.js';
import { hostedBusinessUrls } from '../../shared/texting-policy-pages.js';
import type { CustomerAudience } from '../customer-audience/service.js';
import { escapeHtml } from '../content.js';

type Page = 'business' | 'privacy' | 'sms-terms';
type Signup = Pick<Awaited<ReturnType<CustomerAudience['publicForm']>>, 'texting' | 'consentText' | 'policyVersion'>;
export function renderHostedPolicy(policy: HostedPolicySnapshot, page: Page, signup?: Signup) {
  const urls = hostedBusinessUrls(policy.signupUrl);
  const name = escapeHtml(policy.legalName);
  const version = '?revision=' + policy.revision;
  const heading = page === 'privacy' ? name + ' privacy policy' : page === 'sms-terms' ? name + ' SMS terms' : name;
  const copy = escapeHtml(page === 'privacy' ? policy.privacy : page === 'sms-terms' ? policy.terms : policy.description);
  const form = signup ? '<h2>Sign up for updates</h2>' + renderToStaticMarkup(createElement(SignupFields, {
    action: new URL(policy.signupUrl).pathname, consent: signup.consentText, version: signup.policyVersion, texting: signup.texting ?? undefined,
  })) : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    heading + '</title><link rel="stylesheet" href="/subscriber-action.css"></head><body><main><p>Staging practice</p><h1>' + heading +
    '</h1><p>' + copy + '</p><p>Public contact: ' + escapeHtml(policy.publicContact) + '</p>' + form + '<nav><a href="' +
    escapeHtml(policy.signupUrl) + '">Sign up for updates</a> · <a href="' + escapeHtml(policy.signupUrl + '?preview=sms') +
    '">Preview SMS opt-in</a> · <a href="' + escapeHtml(urls.privacyPolicyUrl + version) + '">Privacy policy</a> · <a href="' +
    escapeHtml(urls.smsTermsUrl + version) + '">SMS terms</a></nav><p>Version ' + policy.revision + ' · Accepted ' +
    escapeHtml(policy.acceptedAt.slice(0, 10)) + '</p></main></body></html>';
}

export function hostedPolicyRoutes(audience?: CustomerAudience) {
  const router = Router();
  router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
  router.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    next();
  });
  // Resolve the published company through the existing public signup route before checking its
  // current tenant's short name. Released names and another company's slug cannot redirect here.
  router.get(['/@:shortName/:slug', '/@:shortName'], async (req, res) => {
    const { shortName, slug } = req.params;
    if (!audience || typeof shortName !== 'string' || !/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(shortName) ||
        (slug !== undefined && typeof slug !== 'string')) {
      res.status(404).type('text').send('This business page is unavailable.');
      return;
    }
    const policy = await audience.publicTextingPolicy(slug ?? shortName, undefined, shortName);
    res.redirect(302, new URL(hostedBusinessUrls(policy.signupUrl).website).pathname);
  });
  router.get(['/:slug','/:slug/:page'], async (req, res) => {
    const { slug, page } = req.params;
    const revision = req.query.revision;
    if (!audience || typeof slug !== 'string' || (page !== undefined && page !== 'privacy' && page !== 'sms-terms') ||
        (revision !== undefined && (typeof revision !== 'string' || !/^[1-9]\d{0,8}$/.test(revision)))) {
      res.status(404).type('text').send('This business page is unavailable.');
      return;
    }
    const policy = await audience.publicTextingPolicy(slug, revision ? Number(revision) : undefined);
    const signup = !page && revision === undefined ? await audience.publicForm(await audience.resolveSignupSlug(slug)) : undefined;
    res.type('html').send(renderHostedPolicy(policy, page === 'privacy' || page === 'sms-terms' ? page : 'business', signup));
  });
  router.use((_req, res) => { res.status(404).type('text').send('This business page is unavailable.'); });
  return router;
}
