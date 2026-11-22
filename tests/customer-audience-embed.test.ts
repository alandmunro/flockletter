import { once } from 'node:events';
import { request, type Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { customerAudienceRoutes, embedAncestors } from '../src/server/customer-audience/routes.js';
import type { CustomerAudience } from '../src/server/customer-audience/service.js';
import { AppError } from '../src/server/errors.js';
import { defaultDesign } from '../src/shared/signup-design.js';

// FL-BRD-002: the compact framed form for a brand's own website.
const origin = 'https://flockletter.example.com';
let sourceDomain = 'stay.example.com';
const signup = vi.fn(async (..._args: unknown[]): Promise<{ status: string; message: string }> => ({
  status: 'pending_confirmation',
  message: 'Check your email for a confirmation if this address is eligible.',
}));
const form = async () => ({
  brandName: 'Fixture',
  design: defaultDesign,
  consentText: 'Email me newsletters and offers from Fixture. I can unsubscribe at any time.',
  policyVersion: 'v1',
  sourceDomain,
  mode: 'live',
  confirmationMode: 'double_opt_in',
  texting: null,
});
let server: Server, port: number;
beforeAll(async () => {
  const app = express();
  // Stands in for the application-wide helmet header the embed must lift.
  app.use((_req, res, next) => { res.set('X-Frame-Options', 'SAMEORIGIN'); next(); });
  app.use('/newsletter', customerAudienceRoutes({ options: { origin }, publicSignup: signup, publicForm: form } as unknown as CustomerAudience));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const problem = error as { status?: number; code?: string };
    res.status(problem.status ?? 500).json({ code: problem.code });
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Expected isolated form test port.');
  port = address.port;
});
afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => { sourceDomain = 'stay.example.com'; });

type Result = { status: number; body: string; headers: Record<string, string | string[] | undefined> };
function send(method: 'GET' | 'POST', path: string, headers: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const body = method === 'POST'
      ? new URLSearchParams({ email: 'synthetic@example.test', policyVersion: 'v1', consentAffirmed: 'yes' }).toString()
      : '';
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: method === 'POST'
      ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), ...headers }
      : headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const sameOrigin = { origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' };

it('limits framing to the brand source domain and its www twin', () => {
  expect(embedAncestors('stay.example.com')).toEqual(['https://stay.example.com', 'https://www.stay.example.com']);
  expect(embedAncestors('www.stay.example.com')).toEqual(['https://stay.example.com', 'https://www.stay.example.com']);
  for (const bad of ['', undefined, 'localhost', 'https://stay.example.com', 'stay.example.com/path', "a.com 'unsafe-inline'", '*.example.com'])
    expect(embedAncestors(bad)).toEqual([]);
});

it('serves the compact form framable only by the brand site', async () => {
  const result = await send('GET', '/newsletter/fixture?embed=1');
  expect(result.status).toBe(200);
  expect(result.headers['x-frame-options']).toBeUndefined();
  const csp = String(result.headers['content-security-policy']);
  expect(csp).toContain('frame-ancestors https://stay.example.com https://www.stay.example.com;');
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("form-action 'self'");
  expect(result.body).toContain('data-flockletter-status="ready"');
  expect(result.body).toContain('/signup-embed.js');
  expect(result.body).toContain('name="consentAffirmed"');
  expect(result.body).not.toContain('postcard-head');
});

it('keeps every ordinary page unframable', async () => {
  const result = await send('GET', '/newsletter/fixture');
  expect(result.headers['x-frame-options']).toBe('SAMEORIGIN');
  expect(String(result.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  expect(String(result.headers['content-security-policy'])).not.toContain('script-src');
});

it('stays unframable when the brand has no valid source domain', async () => {
  sourceDomain = '';
  const result = await send('GET', '/newsletter/fixture?embed=1');
  expect(String(result.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
});

it('records a framed sign-up as the embed channel and reports submission to the host page', async () => {
  const before = signup.mock.calls.length;
  const result = await send('POST', '/newsletter/fixture?embed=1', sameOrigin);
  expect(result.status).toBe(200);
  expect(signup).toHaveBeenCalledTimes(before + 1);
  expect(signup.mock.calls.at(-1)![1]).toMatchObject({ channel: 'embed', consentAffirmed: true, policyVersion: 'v1' });
  expect(result.body).toContain('data-flockletter-status="submitted"');
  expect(result.body).toContain('Check your email');
  expect(result.headers['x-frame-options']).toBeUndefined();
});

it('does not mark ordinary hosted sign-ups as embedded', async () => {
  await send('POST', '/newsletter/fixture', sameOrigin);
  expect(signup.mock.calls.at(-1)![1]).not.toHaveProperty('channel');
});

it('still refuses a post from the framing site itself', async () => {
  const before = signup.mock.calls.length;
  const result = await send('POST', '/newsletter/fixture?embed=1', {
    origin: 'https://stay.example.com', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate',
  });
  expect(result.status).toBe(403);
  expect(signup).toHaveBeenCalledTimes(before);
});

it('explains an ordinary refusal inside the frame and offers the form again', async () => {
  signup.mockRejectedValueOnce(new AppError(409, 'consent_changed', 'Reload the current consent wording.'));
  const result = await send('POST', '/newsletter/fixture?embed=1', sameOrigin);
  expect(result.status).toBe(409);
  expect(result.body).toContain('Reload the current consent wording.');
  expect(result.body).toContain('data-flockletter-status="error"');
  expect(result.body).toContain('name="email"');
});
