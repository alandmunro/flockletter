import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { expect, it, vi } from 'vitest';
import { studioFixtureImage } from '../scripts/studio-fixture-image.js';
import type { DeliveryEnvelope } from '../src/server/campaign/delivery-provider.js';
import {
  createSesSimulatorPort,
  SesSimulatorProvider,
  simulatorDestination,
  type SesSimulationBinding,
} from '../src/server/campaign/ses-simulator.js';

const binding: SesSimulationBinding = {
  workspaceId: 'org_fixture',
  brandId: 'test-brand',
  region: 'us-east-1',
  accountId: '123456789012',
  tenant: 'fixture-tenant',
  configurationSet: 'fixture-events',
  from: 'sender@example.test',
  identityArn: 'arn:aws:ses:us-east-1:123456789012:identity/example.test',
};
const envelope: DeliveryEnvelope = {
  workspaceId: binding.workspaceId,
  brandId: binding.brandId,
  operationKey: 'e62ad182-3d82-4cb1-a000-5d921101cb5d',
  to: 'reader@campaign.test',
  subject: 'Field notes {{ .Subscriber.Email }}',
  text: 'Sunrise on the ridge.',
  html: '<p>Sunrise on the ridge.</p>',
  images: [],
};

it('limits the SDK port itself to an explicit Flockletter credential, one simulator recipient and server attribution', async () => {
  expect(() => createSesSimulatorPort(binding, { accessKeyId: '', secretAccessKey: '' })).toThrow(
    'Dedicated',
  );
  const wire = vi.spyOn(SESv2Client.prototype, 'send').mockImplementation(() => {
    throw new Error('offline SDK boundary');
  });
  const port = createSesSimulatorPort(binding, { accessKeyId: 'SYNTHETIC', secretAccessKey: 'TEST-ONLY' });
  const simple = {
    Subject: { Data: 'Field notes' },
    Body: { Text: { Data: 'Example' } },
    Headers: [{ Name: 'Reply-To', Value: 'fake@example.test' }],
  };
  const request: SendEmailCommandInput = {
    Content: { Simple: simple },
    Destination: { ToAddresses: ['success@simulator.amazonses.com'] },
    EmailTags: [{ Name: 'fl_operation', Value: envelope.operationKey }],
    TenantName: 'untrusted',
    FeedbackForwardingEmailAddress: 'untrusted@example.test',
    ReplyToAddresses: ['untrusted@example.test'],
  };
  try {
    await expect(
      port.send({ ...request, Destination: { ToAddresses: ['untrusted@example.test'] } }),
    ).rejects.toThrow('simulator');
    await expect(
      port.send({
        ...request,
        Destination: { ...request.Destination, BccAddresses: ['untrusted@example.test'] },
      }),
    ).rejects.toThrow('simulator');
    expect(wire).not.toHaveBeenCalled();
    await expect(port.send(request)).rejects.toThrow('offline SDK boundary');
    expect(wire).toHaveBeenCalledTimes(1);
    const client = wire.mock.contexts[0] as SESv2Client;
    expect(await client.config.maxAttempts()).toBe(1);
    expect(client.config.ignoreConfiguredEndpointUrls).toBe(true);
    expect(await client.config.credentials()).toMatchObject({
      accessKeyId: 'SYNTHETIC',
      secretAccessKey: 'TEST-ONLY',
    });
    const [command, options] = wire.mock.calls[0] as unknown as [
      SendEmailCommand,
      { abortSignal: AbortSignal },
    ];
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(command.input).toMatchObject({
      TenantName: binding.tenant,
      ConfigurationSetName: binding.configurationSet,
      FromEmailAddressIdentityArn: binding.identityArn,
      Destination: { ToAddresses: ['success@simulator.amazonses.com'] },
    });
    expect(command.input.FeedbackForwardingEmailAddress).toBeUndefined();
    expect(command.input.ReplyToAddresses).toBeUndefined();
    expect(command.input.Content?.Simple?.Headers).toBeUndefined();
  } finally {
    port.destroy();
    wire.mockRestore();
  }
});

it('serializes the reviewed alternative bodies and original inline photo through the real SDK without network access', async () => {
  const bytes = await studioFixtureImage('#8b4764');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const img = { name: 'Skyline.png', mime: 'image/png', sha256: digest, bytes };
  const message = {
    ...envelope,
    html: `<img src="cid:${digest}" alt="Sunrise"><img alt="Ridge" src="cid:${digest}">`,
    images: [img, { ...img, name: 'same-photo.png' }],
  };
  const accepted = new Map<string, string>();
  const wire: Record<string, unknown>[] = [];
  const client = new SESv2Client({
    region: binding.region,
    maxAttempts: 1,
    credentials: { accessKeyId: 'SYNTHETIC', secretAccessKey: 'OFFLINE-FIXTURE' },
    requestHandler: {
      handle: async (request: { body: string | Uint8Array }) => {
        wire.push(JSON.parse(Buffer.from(request.body).toString('utf8')));
        return {
          response: {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: Readable.from([Buffer.from('{"MessageId":"ses-fixture-id"}')]),
          },
        };
      },
    },
  });
  const provider = new SesSimulatorProvider(
    binding,
    { send: (input) => client.send(new SendEmailCommand(input)) },
    {
      lookup: async (key) => accepted.has(key),
      record: async (key, id) => {
        accepted.set(key, id);
      },
    },
  );
  try {
    expect(await provider.submit(message)).toBe('accepted');
    expect(await provider.submit(message)).toBe('accepted');
    expect(wire).toHaveLength(1);
    expect(wire[0]).toEqual({
      ConfigurationSetName: binding.configurationSet,
      ConfigurationOverrides: {
        Tracking: { OpenTrackingEnabled: 'DISABLED', ClickTrackingEnabled: 'DISABLED' },
      },
      TenantName: binding.tenant,
      FromEmailAddress: binding.from,
      FromEmailAddressIdentityArn: binding.identityArn,
      Destination: { ToAddresses: ['success@simulator.amazonses.com'] },
      EmailTags: [
        { Name: 'fl_operation', Value: message.operationKey },
        { Name: 'fl_tenant', Value: binding.tenant },
      ],
      Content: {
        Simple: {
          Subject: { Charset: 'UTF-8', Data: message.subject },
          Body: {
            Html: { Charset: 'UTF-8', Data: message.html },
            Text: { Charset: 'UTF-8', Data: message.text },
          },
          Attachments: [
            {
              ContentDisposition: 'INLINE',
              ContentTransferEncoding: 'BASE64',
              ContentId: digest,
              ContentType: 'image/png',
              FileName: 'Skyline.png',
              RawContent: bytes.toString('base64'),
            },
          ],
        },
      },
    });
    const content = wire[0]!.Content as { Simple: { Attachments: { RawContent: string }[] } };
    expect(Buffer.from(content.Simple.Attachments[0]!.RawContent, 'base64')).toEqual(bytes);
    expect(accepted.get(message.operationKey)).toBe('ses-fixture-id');
  } finally {
    client.destroy();
  }
});

it('maps only exact practice aliases and rejects foreign bindings, missing CIDs and altered images before contact with SES', async () => {
  const send = vi.fn(async (_input: SendEmailCommandInput) => ({ MessageId: 'fixture' }));
  const provider = new SesSimulatorProvider(
    binding,
    { send },
    { record: vi.fn(), lookup: async () => false },
  );
  expect(simulatorDestination('bounce@delivery.test')).toBe('bounce@simulator.amazonses.com');
  expect(simulatorDestination('complaint@delivery.test')).toBe('complaint@simulator.amazonses.com');
  for (const to of [
    'reader@business.invalid',
    'success@simulator.amazonses.com',
    'reader@campaign.test\r\nBcc: x@example.test',
    'reader+tag@campaign.test',
    'constructor',
  ]) {
    expect(simulatorDestination(to)).toBeUndefined();
    expect(await provider.submit({ ...envelope, to })).toBe('rejected');
  }
  expect(await provider.submit({ ...envelope, workspaceId: 'org_other' })).toBe('rejected');
  expect(await provider.submit({ ...envelope, brandId: 'another-brand' })).toBe('rejected');
  const digest = '0'.repeat(64);
  const broken = { ...envelope, html: `<img src="cid:${digest}">` };
  expect(await provider.submit(broken)).toBe('rejected');
  expect(
    await provider.submit({
      ...broken,
      images: [{ name: 'bad.png', mime: 'image/png', sha256: digest, bytes: Buffer.from('changed') }],
    }),
  ).toBe('rejected');
  expect(send).not.toHaveBeenCalled();
});

it('keeps a network timeout, a missing SES message ID or a failed receipt write unresolved', async () => {
  const send = vi
    .fn<() => Promise<{ MessageId?: string }>>()
    .mockRejectedValueOnce(new Error('connection closed'))
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ MessageId: 'observed' });
  const record = vi.fn(async () => {
    throw new Error('receipt write unavailable');
  });
  const provider = new SesSimulatorProvider(binding, { send }, { lookup: async () => false, record });
  for (const key of ['fixture-timeout', 'fixture-missing-id', 'fixture-persistence']) {
    expect(await provider.submit({ ...envelope, operationKey: key })).toBe('unknown');
    expect(await provider.lookup(key)).toBe('unknown');
  }
  expect(record).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(3);
  const offline = new SesSimulatorProvider(
    binding,
    { send },
    {
      lookup: async () => {
        throw Error('receipts unavailable');
      },
      record,
    },
  );
  expect(await offline.submit(envelope)).toBe('unknown');
  expect(await offline.lookup(envelope.operationKey)).toBe('unknown');
  expect(send).toHaveBeenCalledTimes(3);
});
