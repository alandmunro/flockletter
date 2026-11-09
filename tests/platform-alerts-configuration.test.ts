import { describe, expect, it } from 'vitest';
import {platformAlertsConfiguration} from '../src/server/platform/alerts-configuration.js';

describe('platformAlertsConfiguration', () => {
  const envBase: NodeJS.ProcessEnv = {};

  function buildEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== undefined) env[k] = v;
    }
    return { ...envBase, ...env };
  }

  it('returns undefined when flag is absent', () => {
    const env = buildEnv({});
    expect(platformAlertsConfiguration(env, 'live')).toBeUndefined();
  });

  it('returns undefined when flag is off', () => {
    const env = buildEnv({ FLOCKLETTER_PLATFORM_ALERTS_ENABLED: 'off' });
    expect(platformAlertsConfiguration(env, 'live')).toBeUndefined();
  });

  it('rejects unknown activation flag', () => {
    const env = buildEnv({ FLOCKLETTER_PLATFORM_ALERTS_ENABLED: 'maybe' });
    expect(() => platformAlertsConfiguration(env, 'live')).toThrow();
  });

  it('rejects blank activation flag', () => {
    const env = buildEnv({ FLOCKLETTER_PLATFORM_ALERTS_ENABLED: '   ' });
    expect(() => platformAlertsConfiguration(env, 'live')).toThrow();
  });

  it('rejects approved in capture mode', () => {
    const env = buildEnv({ FLOCKLETTER_PLATFORM_ALERTS_ENABLED: 'approved',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_KEY:'send-fixture',FLOCKLETTER_PLATFORM_ALERT_RESEND_RETRIEVE_KEY:'retrieval-fixture',
      FLOCKLETTER_PLATFORM_ALERT_FROM:'sender@example.test',FLOCKLETTER_PLATFORM_ALERT_TO:'recipient@example.test' });
    expect(() => platformAlertsConfiguration(env, 'capture')).toThrow('verified operator');
  });

  it('rejects whitespace-only send key', () => {
    const env = buildEnv({
      FLOCKLETTER_PLATFORM_ALERTS_ENABLED: 'approved',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_KEY: '   ',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_RETRIEVE_KEY: 'retrieval-key-abc123',
      FLOCKLETTER_PLATFORM_ALERT_FROM: 'sender@example.test',
      FLOCKLETTER_PLATFORM_ALERT_TO: 'recipient@example.test'
    });
    expect(() => platformAlertsConfiguration(env, 'live')).toThrow();
  });

  it('rejects whitespace-only retrieval key', () => {
    const env = buildEnv({
      FLOCKLETTER_PLATFORM_ALERTS_ENABLED: 'approved',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_KEY: 'send-key-xyz789',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_RETRIEVE_KEY: '   ',
      FLOCKLETTER_PLATFORM_ALERT_FROM: 'sender@example.test',
      FLOCKLETTER_PLATFORM_ALERT_TO: 'recipient@example.test'
    });
    expect(() => platformAlertsConfiguration(env, 'live')).toThrow();
  });

  it('rejects equal-after-trim keys', () => {
    const env = buildEnv({
      FLOCKLETTER_PLATFORM_ALERTS_ENABLED: 'approved',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_KEY: 'same-key-value',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_RETRIEVE_KEY: '  same-key-value  ',
      FLOCKLETTER_PLATFORM_ALERT_FROM: 'sender@example.test',
      FLOCKLETTER_PLATFORM_ALERT_TO: 'recipient@example.test'
    });
    expect(() => platformAlertsConfiguration(env, 'live')).toThrow();
  });

  it('valid padded distinct keys return trimmed values', () => {
    const env = buildEnv({
      FLOCKLETTER_PLATFORM_ALERTS_ENABLED: 'approved',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_KEY: '  send-key-padded-123  ',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_RETRIEVE_KEY: '  retrieval-key-padded-456  ',
      FLOCKLETTER_PLATFORM_ALERT_FROM: 'sender@example.test',
      FLOCKLETTER_PLATFORM_ALERT_TO: 'recipient@example.test'
    });
    const result = platformAlertsConfiguration(env, 'live');
    expect(result).toEqual({
      sending: 'send-key-padded-123',
      retrieval: 'retrieval-key-padded-456',
      from: 'sender@example.test',
      to: 'recipient@example.test'
    });
  });

  it('rejects invalid FROM email', () => {
    const env = buildEnv({
      FLOCKLETTER_PLATFORM_ALERTS_ENABLED: 'approved',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_KEY: 'send-key-aaa111',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_RETRIEVE_KEY: 'retrieve-key-bbb222',
      FLOCKLETTER_PLATFORM_ALERT_FROM: 'not-an-email',
      FLOCKLETTER_PLATFORM_ALERT_TO: 'recipient@example.test'
    });
    expect(() => platformAlertsConfiguration(env, 'live')).toThrow();
  });

  it('rejects invalid TO email', () => {
    const env = buildEnv({
      FLOCKLETTER_PLATFORM_ALERTS_ENABLED: 'approved',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_KEY: 'send-key-ccc333',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_RETRIEVE_KEY: 'retrieve-key-ddd444',
      FLOCKLETTER_PLATFORM_ALERT_FROM: 'sender@example.test',
      FLOCKLETTER_PLATFORM_ALERT_TO: 'bad-email-@'
    });
    expect(() => platformAlertsConfiguration(env, 'live')).toThrow();
  });

  it('rejects missing FROM', () => {
    const env = buildEnv({
      FLOCKLETTER_PLATFORM_ALERTS_ENABLED: 'approved',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_KEY: 'send-key-eee555',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_RETRIEVE_KEY: 'retrieve-key-fff666',
      FLOCKLETTER_PLATFORM_ALERT_TO: 'recipient@example.test'
    });
    expect(() => platformAlertsConfiguration(env, 'live')).toThrow();
  });

  it('rejects missing TO', () => {
    const env = buildEnv({
      FLOCKLETTER_PLATFORM_ALERTS_ENABLED: 'approved',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_KEY: 'send-key-ggg777',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_RETRIEVE_KEY: 'retrieve-key-hhh888',
      FLOCKLETTER_PLATFORM_ALERT_FROM: 'sender@example.test'
    });
    expect(() => platformAlertsConfiguration(env, 'live')).toThrow();
  });

  it('rejects missing send key', () => {
    const env = buildEnv({
      FLOCKLETTER_PLATFORM_ALERTS_ENABLED: 'approved',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_RETRIEVE_KEY: 'retrieve-key-iii999',
      FLOCKLETTER_PLATFORM_ALERT_FROM: 'sender@example.test',
      FLOCKLETTER_PLATFORM_ALERT_TO: 'recipient@example.test'
    });
    expect(() => platformAlertsConfiguration(env, 'live')).toThrow();
  });

  it('rejects missing retrieval key', () => {
    const env = buildEnv({
      FLOCKLETTER_PLATFORM_ALERTS_ENABLED: 'approved',
      FLOCKLETTER_PLATFORM_ALERT_RESEND_KEY: 'send-key-jjj000',
      FLOCKLETTER_PLATFORM_ALERT_FROM: 'sender@example.test',
      FLOCKLETTER_PLATFORM_ALERT_TO: 'recipient@example.test'
    });
    expect(() => platformAlertsConfiguration(env, 'live')).toThrow();
  });
});
