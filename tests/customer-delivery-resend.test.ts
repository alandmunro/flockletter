import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { DeliveryEnvelope } from '../src/server/campaign/delivery-provider.js';
import { CustomerResendProvider } from '../src/server/customer-delivery/resend.js';
import { parseResendRoute } from '../src/server/customer-delivery/resend-route.js';

const workspaceId = 'org_test';
const brandId = randomUUID();
const domainId = randomUUID();
const webhookId = randomUUID();
const from = 'news@brand.example.com';

function validRoute() {
  return parseResendRoute({ workspaceId, brandId, from, domainId, webhookId, region: 'us-east-1' });
}

const origin = 'https://flockletter.example.com';
const key = 'test-send-key';
const retrieveKey = 'test-retrieve-key';

function validEnvelope(overrides: Partial<DeliveryEnvelope> = {}): DeliveryEnvelope {
  const bytes = Buffer.from('photo');
  return {
    operationKey: randomUUID(),
    workspaceId,
    brandId,
    to: 'reader@example.com',
    subject: 'Hello',
    html: `<img src="cid:${createHash('sha256').update(bytes).digest('hex')}">`,
    text: 'Hello',
    unsubscribe: { url: `${origin}/newsletter/opt-out?t=abc_123` },
    images: [{ name: 'photo', mime: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), bytes }],
    ...overrides,
  };
}

function makeProvider(
  send: typeof fetch = vi.fn<typeof fetch>(),
  ready: () => Promise<boolean> = async () => true,
) {
  return new CustomerResendProvider(validRoute(), origin, key, ready, 'all', send, retrieveKey);
}

it('submits exact one-recipient payload with platform tags and headers', async () => {
  const opKey = randomUUID();
  const bytes = Buffer.from('photo');
  const cid = createHash('sha256').update(bytes).digest('hex');
  const messageId = randomUUID();
  const send = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(init?.method).toBe('POST');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.to).toEqual([validEnvelope({ operationKey: opKey }).to]);
    expect(body.from).toBe(from);
    expect(body.subject).toBe('Hello');
    expect(body.tags.find((t: {name:string;value:string}) => t.name === 'fl_kind')).toEqual({ name: 'fl_kind', value: 'customer' });
    expect(body.tags.find((t: {name:string;value:string}) => t.name === 'fl_operation')).toEqual({ name: 'fl_operation', value: opKey });
    expect(body.headers['List-Unsubscribe']).toBe(`<${origin}/newsletter/opt-out?t=abc_123>`);
    expect(body.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const att = body.attachments[0];
    expect(att.filename).toBe('photo');
    expect(att.content_type).toBe('image/png');
    expect(att.content_id).toBe(cid);
    expect(Buffer.from(att.content, 'base64').equals(bytes)).toBe(true);
    return new Response(JSON.stringify({ id: messageId }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const provider = makeProvider(send);
  const envelope = validEnvelope({ operationKey: opKey });
  await expect(provider.submit(envelope)).resolves.toEqual({ outcome: 'accepted', messageId });
  expect(send).toHaveBeenCalledTimes(1);
});

it('ignores injected cc/bcc and uses idempotency key', async () => {
  const opKey = randomUUID();
  const messageId = randomUUID();
  let capturedBody: Record<string,unknown>={};
  const send = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    capturedBody = JSON.parse((init?.body as string) ?? '{}');
    expect(init?.headers).toMatchObject({ 'Idempotency-Key': `flockletter-customer/${opKey}` });
    return new Response(JSON.stringify({ id: messageId }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const provider = makeProvider(send);
  const envelope = { ...validEnvelope({ operationKey: opKey }), cc: ['spy@example.com'], bcc: ['spy@example.com'] } as DeliveryEnvelope;
  await expect(provider.submit(envelope)).resolves.toEqual({ outcome: 'accepted', messageId });
  expect(capturedBody.to).toEqual([envelope.to]);
  expect(capturedBody.cc).toBeUndefined();
  expect(capturedBody.bcc).toBeUndefined();
});

it('handles sender name and replyTo', async () => {
  const messageId = randomUUID();
  let capturedBody: Record<string,unknown>={};
  const send = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    capturedBody = JSON.parse((init?.body as string) ?? '{}');
    return new Response(JSON.stringify({ id: messageId }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const provider = makeProvider(send);
  const sender = { name: 'Trail Store', replyTo: 'help@brand.example.com' };
  await expect(provider.submit(validEnvelope({ sender }))).resolves.toEqual({ outcome: 'accepted', messageId });
  expect(capturedBody.from).toBe(`"Trail Store" <${from}>`);
  expect(capturedBody.reply_to).toBe(sender.replyTo);
});

it('tests scope rejects missing or broadcast purpose', async () => {
  const send = vi.fn<typeof fetch>();
  const provider = new CustomerResendProvider(validRoute(), origin, key, async () => true, 'tests', send);
  await expect(provider.submit(validEnvelope({ purpose: undefined }))).resolves.toEqual({ outcome: 'rejected' });
  await expect(provider.submit(validEnvelope({ purpose: 'broadcast', subject: '[TEST] Hello' }))).resolves.toEqual({ outcome: 'rejected' });
  expect(send).not.toHaveBeenCalled();
});

it.each([
  ['wrong workspace', { workspaceId: 'org_other' }],
  ['wrong brand', { brandId: randomUUID() }],
  ['invalid recipient', { to: 'not-an-email' }],
  ['subject control', { subject: 'Hello\u200Bworld' }],
])('rejects %s without network', async (_label, overrides) => {
  const send = vi.fn<typeof fetch>();
  const provider = makeProvider(send);
  await expect(provider.submit(validEnvelope(overrides))).resolves.toEqual({ outcome: 'rejected' });
  expect(send).not.toHaveBeenCalled();
});

it.each([
  ['wrong origin', `http://flockletter.example.com/newsletter/opt-out?t=abc_123`],
  ['wrong path', `${origin}/other/opt-out?t=abc_123`],
  ['hash in unsubscribe', `${origin}/newsletter/opt-out?t=abc_123#section`],
])('rejects malformed unsubscribe %s', async (_label, url) => {
  const send = vi.fn<typeof fetch>();
  const provider = makeProvider(send);
  await expect(provider.submit(validEnvelope({ unsubscribe: { url } }))).resolves.toEqual({ outcome: 'rejected' });
  expect(send).not.toHaveBeenCalled();
});

it('rejects missing CID or changed bytes without network', async () => {
  const send = vi.fn<typeof fetch>();
  const provider = makeProvider(send);
  const bytes = Buffer.from('photo');
  const cid = createHash('sha256').update(bytes).digest('hex');

  await expect(provider.submit(validEnvelope({ html: `<img src="cid:${randomUUID()}">` }))).resolves.toEqual({ outcome: 'rejected' });
  await expect(
    provider.submit(validEnvelope({ images: [{ name: 'photo', mime: 'image/png', sha256: cid, bytes: Buffer.from('tampered') }] })),
  ).resolves.toEqual({ outcome: 'rejected' });
  expect(send).not.toHaveBeenCalled();
});

it('returns not_submitted when ready is false', async () => {
  const send = vi.fn<typeof fetch>();
  const provider = makeProvider(send, async () => false);
  await expect(provider.submit(validEnvelope())).resolves.toEqual({ outcome: 'not_submitted' });
  expect(send).not.toHaveBeenCalled();
});

it('returns not_submitted when readiness fails before POST', async () => {
  const send = vi.fn<typeof fetch>();
  const provider = makeProvider(send, async () => { throw Error('unavailable'); });
  await expect(provider.submit(validEnvelope())).resolves.toEqual({ outcome: 'not_submitted' });
  expect(send).not.toHaveBeenCalled();
});

it.each([
  ['network throw', async () => { throw Error('Network'); }],
  ['HTTP 500', async () => new Response('', { status: 500 })],
  ['HTTP 409', async () => new Response('', { status: 409 })],
  ['HTTP 429', async () => new Response('', { status: 429 })],
  ['malformed response', async () => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } })],
])('returns unknown on %s', async (_label, responder) => {
  const send = vi.fn(responder);
  const provider = makeProvider(send);
  await expect(provider.submit(validEnvelope())).resolves.toEqual({ outcome: 'unknown' });
});

it('returns rejected on HTTP 422', async () => {
  const send = vi.fn(async () => new Response('', { status: 422 }));
  const provider = makeProvider(send);
  await expect(provider.submit(validEnvelope())).resolves.toEqual({ outcome: 'rejected' });
});

it('lookup without messageId returns unknown and no POST', async () => {
  const send = vi.fn<typeof fetch>();
  const provider = makeProvider(send);
  await expect(provider.lookup('some-key')).resolves.toEqual({ outcome: 'unknown' });
  await expect(provider.lookup('some-key', null)).resolves.toEqual({ outcome: 'unknown' });
  expect(send).not.toHaveBeenCalled();
});

it('lookup mismatched route receipt returns unknown', async () => {
  const messageId = randomUUID();
  const foreignRoute = parseResendRoute({ workspaceId: 'org_other', brandId, from, domainId, webhookId, region: 'us-east-1' });
  const receipt = {
    id: messageId,
    from,
    to: ['reader@example.com'],
    tags: [
      { name: 'fl_route', value: foreignRoute.fingerprint },
      { name: 'fl_workspace', value: foreignRoute.workspaceId },
      { name: 'fl_brand', value: brandId },
      { name: 'fl_kind', value: 'customer' },
      { name: 'fl_operation', value: 'some-key' },
    ],
  };
  const send = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 200, headers: { 'content-type': 'application/json' } }));
  const provider = makeProvider(send);
  await expect(provider.lookup('some-key', messageId)).resolves.toEqual({ outcome: 'unknown' });
});
