import { afterEach, describe, expect, it, vi } from 'vitest';
import { client, type TokenGetter } from '../src/client/api.js';

const campaign = { operationKey: 'stable-staging-test', brandId: 'fictional-brand' };
const rejection = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status });

afterEach(() => vi.unstubAllGlobals());

describe('browser session renewal', () => {
  it('sends the identical command once with the renewed bearer after a pre-command rejection', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(rejection(401, 'sign_in_required'))
      .mockResolvedValueOnce(Response.json({ result: 'saved' }));
    vi.stubGlobal('fetch', fetcher);
    const token = vi.fn<TokenGetter>().mockResolvedValueOnce('old').mockResolvedValueOnce('renewed');

    await expect(client(token).call('campaign.create', campaign)).resolves.toBe('saved');
    expect(token.mock.calls).toEqual([[], [true]]);
    expect(fetcher.mock.calls.map(([path, request]) => [
      path, request?.method, request?.body, new Headers(request?.headers).get('authorization'),
    ])).toEqual(['old', 'renewed'].map(value => [
      '/api/v1/commands/campaign.create', 'POST', JSON.stringify(campaign), `Bearer ${value}`,
    ]));
  });

  it.each([
    [401, 'session_revoked'], [403, 'membership_revoked'], [403, 'owner_required'], [500, 'service_error'],
  ] as const)('preserves HTTP %s %s without renewing or retrying', async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(rejection(status, code));
    vi.stubGlobal('fetch', fetcher);
    const token = vi.fn<TokenGetter>().mockResolvedValue('old');
    await expect(client(token).call('campaign.create', campaign)).rejects.toThrow(code);
    expect(token.mock.calls).toEqual([[]]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'old'])('preserves the rejection when the selected session returns %s', async nextToken => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(rejection(401, 'sign_in_required'));
    vi.stubGlobal('fetch', fetcher);
    const token = vi.fn<TokenGetter>().mockResolvedValueOnce('old').mockResolvedValueOnce(nextToken);
    await expect(client(token).call('campaign.create', campaign)).rejects.toThrow('sign_in_required');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stops after a rejected refreshed token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => rejection(401, 'sign_in_required'));
    vi.stubGlobal('fetch', fetcher);
    const token = vi.fn<TokenGetter>().mockResolvedValueOnce('old').mockResolvedValueOnce('renewed');
    await expect(client(token).call('workspace.get', {})).rejects.toThrow('sign_in_required');
    expect(token.mock.calls).toEqual([[], [true]]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('leaves a network error with unknown execution status to the caller', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('network lost'));
    vi.stubGlobal('fetch', fetcher);
    const token = vi.fn<TokenGetter>().mockResolvedValue('old');
    await expect(client(token).call('campaign.create', campaign)).rejects.toThrow('network lost');
    expect(token.mock.calls).toEqual([[]]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('texting enrollment verification', () => {
  it('retries a temporary verification failure with the same code, operation key and workspace bearer', async () => {
    const input = { companyId: 'practice-company', expectedRevision: 2, channel: 'carrier', code: '123456', operationKey: 'practice-verification' };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(rejection(500, 'service_error')).mockResolvedValueOnce(Response.json({result:{verified:true}}));
    vi.stubGlobal('fetch', fetcher);
    const token = vi.fn<TokenGetter>().mockResolvedValue('original-workspace');
    await expect(client(token).call('sms.onboardingVerify', input)).resolves.toEqual({verified:true});
    expect(token).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls).toHaveLength(2);
    for (const [path, request] of fetcher.mock.calls) {
      expect(path).toBe('/api/v1/commands/sms.onboardingVerify');
      expect(request?.body).toBe(JSON.stringify(input));
      expect(new Headers(request?.headers).get('authorization')).toBe('Bearer original-workspace');
    }
  });

  it('bounds status retries and preserves the last service error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => rejection(503, 'membership_unavailable'));
    vi.stubGlobal('fetch', fetcher);
    await expect(client(async () => 'workspace').call('sms.onboardingStatus', {})).rejects.toThrow('membership_unavailable');
    expect(fetcher).toHaveBeenCalledTimes(3);
  }, 10000);

  it.each([
    ['sms.onboardingVerify', 409, 'verification_expired'],
    ['sms.onboardingVerify', 403, 'owner_required'],
    ['sms.onboardingFinish', 500, 'service_error'],
  ] as const)('preserves %s %s %s on the first response', async (name, status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(rejection(status, code));
    vi.stubGlobal('fetch', fetcher);
    await expect(client(async () => 'workspace').call(name, {})).rejects.toThrow(code);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
