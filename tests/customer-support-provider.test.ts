import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ResendSupportProvider } from '../src/server/customer-support/provider.js';

const validEnvelope = () => ({
  operationKey: randomUUID(),
  workspaceId: 'org_test',
  to: 'recipient@example.test',
  from: 'Support <support@example.test>',
  subject: 'Test Subject',
  text: 'Test Body',
});

it('submits successfully with correct headers and body', async () => {
  const providerId = randomUUID();
  const envelope = validEnvelope();
  const fakeFetch: typeof fetch = vi.fn(async (input, init) => {
    expect(input).toBe('https://api.resend.com/emails');
    const req = new Request(input, init as RequestInit);
    expect(req.redirect).toBe('error');
    expect(req.method).toBe('POST');
    expect(req.headers.get('authorization')).toBe('Bearer test-key');
    expect(req.headers.get('idempotency-key')).toBe('flockletter-support/' + envelope.operationKey);
    const body = JSON.parse(await req.text());
    expect(body).toMatchObject({
      to: [envelope.to],
      from: envelope.from,
      subject: envelope.subject,
      text: envelope.text,
    });
    return new Response(JSON.stringify({ id: providerId }), { status: 201 });
  }) as typeof fetch;

  const provider = new ResendSupportProvider('test-key', fakeFetch);
  const result = await provider.submit(envelope);

  expect(result).toEqual({ state: 'accepted', id: providerId });
  expect(fakeFetch).toHaveBeenCalledTimes(1);
});

it('returns unknown on network failure', async () => {
  const fakeFetch: typeof fetch = vi.fn(async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;

  const provider = new ResendSupportProvider('test-key', fakeFetch);
  const result = await provider.submit(validEnvelope());

  expect(result).toEqual({ state: 'unknown' });
});

it('returns unknown for 429 and 500, rejected for 422', async () => {
  const makeProvider = (status: number) => {
    const fakeFetch: typeof fetch = vi.fn(async () => new Response(null, { status })) as typeof fetch;
    return new ResendSupportProvider('test-key', fakeFetch, 'retrieve-key');
  };

  expect(await makeProvider(429).submit(validEnvelope())).toEqual({ state: 'unknown' });
  expect(await makeProvider(500).submit(validEnvelope())).toEqual({ state: 'unknown' });
  expect(await makeProvider(422).submit(validEnvelope())).toEqual({ state: 'rejected' });
});

it('lookup with null or invalid id never calls fetch', async () => {
  const fakeFetch: typeof fetch = vi.fn() as unknown as typeof fetch;
  const provider = new ResendSupportProvider('test-key', fakeFetch);

  await provider.lookup(randomUUID(), null);
  await provider.lookup(randomUUID(), 'not-a-uuid');

  expect(fakeFetch).not.toHaveBeenCalled();
});

it('lookup returns accepted only for exact matching id', async () => {
  const providerId = randomUUID();

  const makeLookupProvider = (responseId: string) => {
    const fakeFetch: typeof fetch = vi.fn(async (input, init) => {
      expect(input).toBe('https://api.resend.com/emails/' + providerId);
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer retrieve-key');
      return new Response(JSON.stringify({ id: responseId }), { status: 200 });
    }) as typeof fetch;
    return new ResendSupportProvider('test-key', fakeFetch, 'retrieve-key');
  };

  const matching = await makeLookupProvider(providerId).lookup(randomUUID(), providerId);
  expect(matching).toEqual({ state: 'accepted', id: providerId });

  const nonMatching = await makeLookupProvider(randomUUID()).lookup(randomUUID(), providerId);
  expect(nonMatching).toEqual({ state: 'unknown' });
});

it('uses distinct sending and retrieval keys for submit and lookup', async () => {
  const providerId = randomUUID();
  const envelope = validEnvelope();
  const sendKey = 'send-credential';
  const retrieveKey = 'retrieve-credential';

  const fakeFetch: typeof fetch = vi.fn(async (input, init) => {
    if (input === 'https://api.resend.com/emails' && init?.method === 'POST') {
      const req = new Request(input, init as RequestInit);
      expect(req.headers.get('authorization')).toBe('Bearer ' + sendKey);
      return new Response(JSON.stringify({ id: providerId }), { status: 201 });
    }
    if (input === 'https://api.resend.com/emails/' + providerId) {
      const req = new Request(input, init as RequestInit);
      expect(req.headers.get('authorization')).toBe('Bearer ' + retrieveKey);
      return new Response(JSON.stringify({ id: providerId }), { status: 200 });
    }
    throw new Error('Unexpected fetch call: ' + String(input));
  }) as typeof fetch;

  const provider = new ResendSupportProvider(sendKey, fakeFetch, retrieveKey);
  const submitResult = await provider.submit(envelope);
  expect(submitResult).toEqual({ state: 'accepted', id: providerId });

  const lookupResult = await provider.lookup(envelope.operationKey, providerId);
  expect(lookupResult).toEqual({ state: 'accepted', id: providerId });

  expect(fakeFetch).toHaveBeenCalledTimes(2);
});

it('returns unknown and makes no request when retrieveKey is absent', async () => {
  const providerId = randomUUID();
  const fakeFetch: typeof fetch = vi.fn(async () => new Response(JSON.stringify({ id: providerId }), { status: 200 })) as typeof fetch;

  const provider = new ResendSupportProvider('send-credential', fakeFetch);
  const result = await provider.lookup(randomUUID(), providerId);

  expect(result).toEqual({ state: 'unknown' });
  expect(fakeFetch).not.toHaveBeenCalled();
});

it('returns unknown on lookup 403 and never retries with sending key', async () => {
  const providerId = randomUUID();
  const calls: Array<{ url: string; auth: string | null }> = [];

  const fakeFetch: typeof fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), auth: new Request(input, init as RequestInit).headers.get('authorization') });
    return new Response(null, { status: 403 });
  }) as typeof fetch;

  const provider = new ResendSupportProvider('send-credential', fakeFetch, 'retrieve-credential');
  const result = await provider.lookup(randomUUID(), providerId);

  expect(result).toEqual({ state: 'unknown' });
  expect(fakeFetch).toHaveBeenCalledTimes(1);
  expect(calls[0]?.url).toBe('https://api.resend.com/emails/' + providerId);
  expect(calls[0]?.auth).toBe('Bearer retrieve-credential');
});
