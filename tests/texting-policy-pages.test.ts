import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { hostedBusinessUrls, makeHostedPolicySnapshot } from '../src/shared/texting-policy-pages.js';
import { hostedPolicyRoutes, renderHostedPolicy } from '../src/server/texting/hosted-policy-routes.js';
import { enrollmentPageReader, isPublicPageAddress } from '../src/server/texting/public-page-reader.js';
import { scanEnrollmentPages } from '../src/server/texting/website-preflight.js';
import type { CustomerAudience } from '../src/server/customer-audience/service.js';

const sample = {
  legalName: 'Elm & Pine', publicContact: 'support@elm.example', description: 'Seasonal business news.',
  revision: 2, acceptedAt: '2026-11-25T12:00:00.000Z',
};
const external = {
  website: 'https://elm.example', privacyPolicyUrl: 'https://elm.example/privacy', smsTermsUrl: 'https://elm.example/terms',
  signupUrl: 'https://staging.example/signup/Elm',
};
function optIn(privacy: string, terms: string) {
  return '<label><input type="checkbox" name="smsConsent">Receive texts. Frequency varies. Msg &amp; data rates may apply.' +
    ' Reply STOP to opt out or HELP for help.</label><a href="' + privacy + '">Privacy</a><a href="' + terms + '">Terms</a>';
}

describe('public enrollment documents', () => {
  it('uses only pinned public addresses, including after a same-site redirect', async () => {
    const origin = 'https://staging.example';
    const address = '93.184.216.34';
    const resolve = vi.fn(async () => [address]);
    const get = vi.fn(async (url: URL, destination: string) => {
      expect(destination).toBe(address);
      return url.pathname === '/' ? { redirect: '/home' } : { html: 'public page' };
    });
    const read = enrollmentPageReader(origin, new Set(), resolve, get);
    expect(await read('https://elm.example/')).toBe('public page');
    expect(resolve).toHaveBeenCalledTimes(2);
    get.mockClear();
    resolve.mockResolvedValueOnce([address, '127.0.0.1']);
    await expect(read('https://elm.example/')).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
    get.mockResolvedValueOnce({ redirect: 'https://unrelated.example/' });
    await expect(read('https://elm.example/')).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(1);
    await expect(read(origin + '/api/config')).rejects.toThrow();
    await expect(read('http://elm.example/')).rejects.toThrow();
    for (const addr of ['169.254.169.254', '100.100.100.200', '224.0.0.1', '::1', 'fe80::1', '::ffff:127.0.0.1', '2002:7f00:1::'])
      expect(isPublicPageAddress(addr)).toBe(false);
    expect(isPublicPageAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('reports missing disclosures, consent and wrong policy links separately and ignores nonvisible copy', async () => {
    const read = async (url: string) => {
      if (url === external.website) return '<p>Elm &amp; Pine</p>';
      if (url === external.privacyPolicyUrl) return '<p>Mobile privacy policy.</p><div hidden>We do not share mobile data for marketing.</div>';
      if (url === external.smsTermsUrl) return '<p>Reply STOP to cancel.</p>';
      return optIn(external.privacyPolicyUrl, 'https://other.example/terms').replace('type="checkbox"', 'checked type="checkbox"');
    };
    const result = await scanEnrollmentPages(external, read);
    expect(result.issues.map(issue => issue.page)).toEqual(['privacy', 'terms', 'terms', 'signup', 'signup']);
    const wrong = await scanEnrollmentPages({ ...external, hostedPages: true }, vi.fn());
    expect(wrong.issues[0]?.message).toContain('for this company');
  });
  it('bounds concurrent website checks without queuing additional requests to the same domain', async () => {
    let finish!: (body: string) => void;
    const delayed = new Promise<string>(resolve => { finish = resolve; });
    const read = vi.fn(async () => delayed);
    const first = scanEnrollmentPages(external, read);
    const second = scanEnrollmentPages(external, read);
    const busy = await scanEnrollmentPages(external, read);
    expect(busy.issues[0]?.message).toContain('busy');
    expect(read).toHaveBeenCalledTimes(8);
    finish('<p>fixture</p>');
    await Promise.all([first, second]);
    await scanEnrollmentPages(external, read);
    expect(read).toHaveBeenCalledTimes(12);
  });
});

describe('public hosted pages and preflight', () => {
  let server: Server;
  let origin: string;
  let signupUrl: string;
  const load = vi.fn<CustomerAudience['publicTextingPolicy']>();
  beforeAll(async () => {
    const app = express();
    app.use('/business', hostedPolicyRoutes({
      publicTextingPolicy: load, resolveSignupSlug: async () => 'fixture',
      publicForm: async () => ({ consentText: 'Email me updates.', policyVersion: 'v1', texting: null }),
    } as unknown as CustomerAudience));
    app.get('/signup/Elm', (req, res) => {
      if (req.query.preview !== 'sms') throw new Error('Not the signup preview.');
      const urls = hostedBusinessUrls(signupUrl);
      res.type('html').send(optIn(urls.privacyPolicyUrl, urls.smsTermsUrl));
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    signupUrl = origin + '/signup/Elm';
    load.mockImplementation(async (_slug, revision) => makeHostedPolicySnapshot({ ...sample, signupUrl, revision: revision ?? 2 }));
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

  it('reads the actually served business, terms, privacy and signup pages together', async () => {
    const urls = hostedBusinessUrls(signupUrl);
    await expect(scanEnrollmentPages({ ...urls, signupUrl, hostedPages: true })).resolves.toEqual({ issues: [] });
    expect(await (await fetch(urls.website)).text()).toContain('action="/signup/Elm"');
    expect(load).toHaveBeenCalledWith('Elm', undefined);
    expect((await fetch(urls.privacyPolicyUrl + '?revision=1')).status).toBe(200);
    expect(load).toHaveBeenCalledWith('Elm', 1);
    expect((await fetch(urls.privacyPolicyUrl + '?revision=-1')).status).toBe(404);
    expect((await fetch(urls.website + '/draft')).status).toBe(404);
    expect((await fetch(origin + '/business/@practice-elm/Elm', { redirect: 'manual' })).headers.get('location')).toBe('/business/Elm');
    expect(load).toHaveBeenCalledWith('Elm', undefined, 'practice-elm');
    const snapshot = makeHostedPolicySnapshot({ ...sample, signupUrl, legalName: 'Elm <Pine>' });
    const html = renderHostedPolicy(snapshot, 'business');
    expect(html).toContain('Elm &lt;Pine&gt;');
    expect(html).toContain(urls.smsTermsUrl + '?revision=2');
  });
});
