import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';

async function fetchPolicy(env: NodeJS.ProcessEnv) {
  const server = createApp(loadConfig(env)).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The test requires a TCP port.');
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    await response.text();
    expect(response.status).toBe(200);
    const policy = response.headers.get('content-security-policy');
    if (!policy) throw new Error('The response has no content security policy.');
    return Object.fromEntries(policy.split(';').map(directive => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe('Clerk signup browser policy', () => {
  it('allows the Clerk frontend, Protect and Turnstile only where the signup flow needs them', async () => {
    const host = 'fixture.clerk.accounts.dev';
    const frontend = `https://${host}`;
    const policy = await fetchPolicy({
      APP_ENV: 'staging',
      APP_ORIGIN: 'https://staging.example.com',
      CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from(`${host}$`).toString('base64')}`,
    });
    const scriptsAndFrames = ["'self'", frontend, 'https://challenges.cloudflare.com', 'https://*.protect.clerk.com'];
    expect(policy['script-src']).toEqual(scriptsAndFrames);
    expect(policy['frame-src']).toEqual(scriptsAndFrames);
    expect(policy['connect-src']).toEqual(["'self'", frontend, 'https://*.protect.clerk.com:*']);
    expect(policy['worker-src']).toEqual(["'self'", 'blob:']);
  });

  it('keeps script, frame, connection and worker sources local without Clerk', async () => {
    const policy = await fetchPolicy({ APP_ENV: 'local' });
    for (const directive of ['script-src', 'frame-src', 'connect-src', 'worker-src']) {
      expect(policy[directive]).toEqual(["'self'"]);
    }
  });
});
