import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';

const SHA = 'a'.repeat(40);

async function version(env: NodeJS.ProcessEnv) {
  const server = createApp(loadConfig(env)).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The test requires a TCP port.');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health/version`);
    return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe('release version endpoint', () => {
  it('reports the exact Render commit and the environment, without authentication', async () => {
    const result = await version({ APP_ENV: 'staging', APP_ORIGIN: 'https://staging.example.com', RENDER_GIT_COMMIT: SHA.toUpperCase() });
    expect(result.status).toBe(200);
    expect(result.cache).toBe('no-store');
    expect(result.body).toEqual({ appId: 'flockletter', surface: 'app', environment: 'staging', buildSha: SHA });
  });

  it('prefers Render over BUILD_SHA and never reports a malformed identity', async () => {
    expect((await version({ BUILD_SHA: SHA })).body.buildSha).toBe(SHA);
    expect((await version({ BUILD_SHA: 'main' })).body.buildSha).toBeNull();
    expect((await version({ RENDER_GIT_COMMIT: `${SHA}\nextra` })).body.buildSha).toBeNull();
    expect((await version({})).body.buildSha).toBeNull();
  });
});
