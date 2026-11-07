import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';

describe('loadConfig staging browser origins', () => {
  const base = {
    APP_ENV: 'staging' as const,
    APP_ORIGIN: 'https://staging.example.com',
  };

  it('returns canonical origin plus exact HTTPS aliases with duplicates removed', () => {
    const config = loadConfig({
      ...base,
      APP_ADDITIONAL_ORIGINS:
        'https://mail.example.com, https://flock.example.ts.net:8443, https://staging.example.com, https://mail.example.com',
    });

    expect(config.browserOrigins).toEqual([
      'https://staging.example.com',
      'https://mail.example.com',
      'https://flock.example.ts.net:8443',
    ]);
  });

  const invalidAliases: Array<[string, string]> = [
    ['wildcard host', 'https://*.example.com'],
    ['userinfo', 'https://user@example.com'],
    ['path', 'https://mail.example.com/inbox'],
    ['query', 'https://mail.example.com?x=1'],
    ['HTTP origin', 'http://mail.example.com'],
  ];

  it.each(invalidAliases)('rejects invalid alias: %s', (_label, alias) => {
    expect(() => loadConfig({ ...base, APP_ADDITIONAL_ORIGINS: alias })).toThrow();
  });
});

describe('loadConfig local browser origins', () => {
  it('throws when synthetic identity is combined with additional origins', () => {
    expect(() => loadConfig({
      APP_ENV: 'local' as const,
      LOCAL_TEST_IDENTITY: 'true',
      APP_ADDITIONAL_ORIGINS: 'https://mail.example.com',
    })).toThrow();
  });

  it('leaves only canonical loopback origin when alias setting is empty', () => {
    const config = loadConfig({
      APP_ENV: 'local' as const,
      APP_ADDITIONAL_ORIGINS: '',
    });

    expect(config.browserOrigins).toEqual(['http://127.0.0.1:4310']);
  });
});
