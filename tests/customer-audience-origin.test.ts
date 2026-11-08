import { once } from 'node:events';
import { request, type Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { customerAudienceRoutes } from '../src/server/customer-audience/routes.js';
import type { CustomerAudience } from '../src/server/customer-audience/service.js';
const origin = 'https://flockletter.example.com';
const signup = vi.fn(async () => ({ received: true }));
let server: Server, port: number;
beforeAll(async () => {
  const app = express();
  app.use(
    '/newsletter',
    customerAudienceRoutes({ options: { origin }, publicSignup: signup } as unknown as CustomerAudience),
  );
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
async function post(headers: Record<string, string | undefined>) {
  return new Promise<{ status: number; body: string; referrerPolicy: string | undefined }>(
    (resolve, reject) => {
      const body = new URLSearchParams({
        email: 'synthetic@example.test',
        policyVersion: 'v1',
        consentAffirmed: 'yes',
      }).toString();
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/newsletter/fixture',
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(body),
            ...headers,
          },
        },
        (res) => {
          let response = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (response += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: response,
              referrerPolicy: res.headers['referrer-policy'] as string | undefined,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    },
  );
}
it('accepts native same-origin form navigation with opaque Origin while retaining no-referrer policy', async () => {
  const before = signup.mock.calls.length;
  const result = await post({
    origin: 'null',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
  });
  expect(result.status).toBe(200);
  expect(result.referrerPolicy).toBe('no-referrer');
  expect(result.body).toContain('Check your email');
  expect(signup).toHaveBeenCalledTimes(before + 1);
});
it.each([
  { origin: 'null', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
  { origin: 'null', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' },
  { origin: 'null', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
  { origin: 'null', 'sec-fetch-site': 'same-origin' },
  { origin: 'null', 'sec-fetch-mode': 'navigate' },
  { origin: 'null' },
  { origin: 'https://attacker.example.com', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' },
])(
  'rejects opaque or foreign origin without exact browser same-origin navigation metadata: %j',
  async (headers) => {
    const before = signup.mock.calls.length,
      result = await post(headers);
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ code: 'origin_rejected' });
    expect(signup).toHaveBeenCalledTimes(before);
  },
);
it('retains explicit same-origin browser form posts', async () => {
  expect((await post({ origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' })).status).toBe(
    200,
  );
});
