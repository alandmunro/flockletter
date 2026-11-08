import { afterEach, expect, it, vi } from 'vitest';
import { ListmonkTestProvider } from '../src/server/campaign/listmonk-test-provider.js';
import type { DeliveryEnvelope } from '../src/server/campaign/delivery-provider.js';

const message: DeliveryEnvelope = {
  operationKey: 'fixture-recipient',
  workspaceId: 'org_fixture',
  brandId: 'fixture-brand',
  to: 'reader@example.test',
  subject: 'A literal {{ .Subscriber.Email }}',
  html: '<p>Original</p>',
  text: 'Original',
  images: [],
};
afterEach(() => vi.restoreAllMocks());

it('requires a matching private messenger receipt and never repeats a reserved submission', async () => {
  const tx = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"data":true}'));
  let reserved: string | undefined;
  const receipts = new Set<string>();
  const fixture = {
    workspaceId: message.workspaceId,
    brandId: message.brandId,
    templateId: 24,
    session: 'session=synthetic',
    reserve: async (key: string, envelope: DeliveryEnvelope) => {
      if (reserved === key && envelope.subject !== message.subject) throw Error('Conflicting registration');
      if (reserved === key) return false;
      reserved = key;
      return true;
    },
    accepted: async (key: string) => receipts.has(key),
  };
  const provider = new ListmonkTestProvider(fixture);
  expect(await provider.submit({ ...message, brandId: 'another-brand' })).toBe('rejected');
  expect(await provider.submit({ ...message, to: 'reader@business.invalid' })).toBe('rejected');
  expect(tx).not.toHaveBeenCalled();
  expect(await provider.submit(message)).toBe('unknown');
  const [url, init] = tx.mock.calls[0]!;
  expect(url).toBe('http://engine:9000/api/tx');
  expect(init?.redirect).toBe('error');
  const data = JSON.parse(String((init?.body as FormData).get('data')));
  expect(data).toMatchObject({
    from_email: reserved,
    subscriber_email: message.to,
    messenger: 'fixture',
    template_id: 24,
    data: { subject: message.subject, html: message.html, text: message.text },
    altbody: '{{ .Tx.Data.text }}',
  });
  expect(await provider.submit(message)).toBe('unknown');
  expect(await provider.lookup(message.operationKey)).toBe('unknown');
  expect(reserved).toBeDefined();
  receipts.add(reserved!);
  expect(await provider.lookup(message.operationKey)).toBe('accepted');
  expect(await provider.submit({ ...message, subject: 'Different revision' })).toBe('unknown');
  expect(
    await new ListmonkTestProvider({ ...fixture, workspaceId: 'org_other' }).lookup(message.operationKey),
  ).toBe('unknown');
  expect(tx).toHaveBeenCalledOnce();
});
