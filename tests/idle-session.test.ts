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
