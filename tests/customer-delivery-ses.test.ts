import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import type { DeliveryEnvelope } from '../src/server/campaign/delivery-provider.js';
import { CustomerSesProvider, customerSesRuntime } from '../src/server/customer-delivery/ses.js';
import { parseSesRoute } from '../src/server/campaign/ses-runtime.js';

const workspaceId = 'org_customer';
const brandId = randomUUID();
const accountId = '123456789012';
const region = 'us-west-2';
const tenant = 'customer_tenant';
const configurationSet = 'cs_customer';
const from = 'news@brand.example.com';
const domain = 'brand.example.com';
const identityArn = `arn:aws:ses:${region}:${accountId}:identity/${domain}`;
const topicArn = `arn:aws:sns:${region}:${accountId}:customer_topic`;

function validRoute() {
  return parseSesRoute({
    workspaceId,
    brandId,
    region,
    accountId,
    tenant,
    configurationSet,
    from,
    identityArn,
    topicArn,
  });
}

const origin = 'https://flockletter.example.com';

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
    images: [
      {
        name: 'photo',
        mime: 'image/png',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes,
      },
    ],
    ...overrides,
  };
}

function makeProvider(
  send: (input: SendEmailCommandInput) => Promise<{ MessageId?: string }>,
  ready = vi.fn(async () => true),
) {
  return new CustomerSesProvider(validRoute(), origin, send, ready);
}

it('builds valid SES request with exact fields', async () => {
  const send = vi.fn(async (_input: SendEmailCommandInput) => ({ MessageId: 'mid-1' }));
  const provider = makeProvider(send);
  const envelope = validEnvelope();

  await expect(provider.submit(envelope)).resolves.toEqual({ outcome: 'accepted', messageId: 'mid-1' });

  expect(send).toHaveBeenCalledTimes(1);
  const input = send.mock.calls[0]![0];

  expect(input.TenantName).toBe(tenant);
  expect(input.ConfigurationSetName).toBe(configurationSet);
  expect(input.Destination?.ToAddresses).toEqual([envelope.to]);
  expect(input.Destination?.CcAddresses ?? []).toHaveLength(0);
  expect(input.Destination?.BccAddresses ?? []).toHaveLength(0);
  expect(input.FromEmailAddress).toBe(from);
  expect(input.FromEmailAddressIdentityArn).toBe(identityArn);
  expect(input.ConfigurationOverrides?.Tracking?.OpenTrackingEnabled).toBe('DISABLED');
  expect(input.ConfigurationOverrides?.Tracking?.ClickTrackingEnabled).toBe('DISABLED');

  const headers = input.Content?.Simple?.Headers ?? [];
  expect(headers.find((h) => h.Name === 'List-Unsubscribe')?.Value).toBe(`<${envelope.unsubscribe!.url}>`);
  expect(headers.find((h) => h.Name === 'List-Unsubscribe-Post')?.Value).toBe('List-Unsubscribe=One-Click');

  const attachments = input.Content?.Simple?.Attachments ?? [];
  expect(attachments).toHaveLength(1);
  const attachment = attachments[0]!;
  expect(attachment.ContentId).toBe(envelope.images[0]!.sha256);
  expect(attachment.ContentType).toBe('image/png');
  expect(new Uint8Array(attachment.RawContent as Uint8Array)).toEqual(
    new Uint8Array(envelope.images[0]!.bytes),
  );
});

it.each([
  ['wrong workspace', { workspaceId: 'org_other' }],
  ['wrong brand', { brandId: randomUUID() }],
])('rejects %s without send', async (_label, overrides) => {
  const send = vi.fn(async (_input: SendEmailCommandInput) => ({ MessageId: 'unexpected-send' }));
  const provider = makeProvider(send);

  await expect(provider.submit(validEnvelope(overrides))).resolves.toEqual({ outcome: 'rejected' });
  expect(send).not.toHaveBeenCalled();
});

it.each([
  ['invalid to', { to: 'not-an-email' }],
  ['CRLF in to', { to: 'reader@example.com\r\nBcc:spy@example.com' }],
  ['Unicode subject controls', { subject: 'Hello\u200Bworld' }],
  ['CRLF in subject', { subject: 'Hello\r\nInjection' }],
  ['invalid operation key', { operationKey: 'not-a-uuid' }],
])('rejects %s without send', async (_label, overrides) => {
  const send = vi.fn(async (_input: SendEmailCommandInput) => ({ MessageId: 'unexpected-send' }));
  const provider = makeProvider(send);

  await expect(provider.submit(validEnvelope(overrides))).resolves.toEqual({ outcome: 'rejected' });
  expect(send).not.toHaveBeenCalled();
});

it.each([
  ['wrong origin', `${origin.replace('https://', 'http://')}/newsletter/opt-out?t=abc_123`],
  ['wrong path', `${origin}/other/opt-out?t=abc_123`],
  ['credentials in unsubscribe', 'https://user:pass@flockletter.example.com/newsletter/opt-out?t=abc_123'],
  ['hash in unsubscribe', `${origin}/newsletter/opt-out?t=abc_123#section`],
  ['empty t', `${origin}/newsletter/opt-out?t=`],
  ['duplicate t', `${origin}/newsletter/opt-out?t=abc_123&t=def`],
  ['extra query parameter', `${origin}/newsletter/opt-out?t=abc_123&x=y`],
])('rejects unsubscribe with %s', async (_label, url) => {
  const send = vi.fn(async (_input: SendEmailCommandInput) => ({ MessageId: 'unexpected-send' }));
  const provider = makeProvider(send);

  await expect(provider.submit(validEnvelope({ unsubscribe: { url } }))).resolves.toEqual({
    outcome: 'rejected',
  });
  expect(send).not.toHaveBeenCalled();
});

it('rejects missing referenced photo', async () => {
  const send = vi.fn(async (_input: SendEmailCommandInput) => ({ MessageId: 'unexpected-send' }));
  const provider = makeProvider(send);
  const bytes = Buffer.from('photo');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const envelope = validEnvelope({
    html: `<img src="cid:${sha256}"><img src="cid:${randomUUID()}">`,
  });

  await expect(provider.submit(envelope)).resolves.toEqual({ outcome: 'rejected' });
  expect(send).not.toHaveBeenCalled();
});

it('rejects changed photo bytes', async () => {
  const send = vi.fn(async (_input: SendEmailCommandInput) => ({ MessageId: 'unexpected-send' }));
  const provider = makeProvider(send);
  const bytes = Buffer.from('photo');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const envelope = validEnvelope({
    images: [
      {
        name: 'photo',
        mime: 'image/png',
        sha256,
        bytes: Buffer.from('tampered'),
      },
    ],
  });

  await expect(provider.submit(envelope)).resolves.toEqual({ outcome: 'rejected' });
  expect(send).not.toHaveBeenCalled();
});

it('returns not_submitted when ready is false without send', async () => {
  const send = vi.fn(async (_input: SendEmailCommandInput) => ({ MessageId: 'unexpected-send' }));
  const provider = makeProvider(
    send,
    vi.fn(async () => false),
  );

  await expect(provider.submit(validEnvelope())).resolves.toEqual({ outcome: 'not_submitted' });
  expect(send).not.toHaveBeenCalled();
});

it('returns unknown on network throw and lookup without new send', async () => {
  const send = vi.fn(async () => {
    throw Object.assign(new Error('Network'), { name: 'TimeoutError' });
  });
  const provider = makeProvider(send);

  await expect(provider.submit(validEnvelope())).resolves.toEqual({ outcome: 'unknown' });
  await expect(provider.lookup('some-key')).resolves.toEqual({ outcome: 'unknown' });
  expect(send).toHaveBeenCalledTimes(1);
});

it('returns unknown when no MessageId', async () => {
  const send = vi.fn(async () => ({}));
  const provider = makeProvider(send);

  await expect(provider.submit(validEnvelope())).resolves.toEqual({ outcome: 'unknown' });
});

it('customerSesRuntime rejects non-production', () => {
  expect(() =>
    customerSesRuntime(origin, {
      APP_ENV: 'staging',
      FLOCKLETTER_CUSTOMER_DELIVERY: 'ses',
      FLOCKLETTER_LIVE_MAILING_APPROVED: 'true',
    }),
  ).toThrow();
});

it('customerSesRuntime rejects unapproved', () => {
  expect(() =>
    customerSesRuntime(origin, { APP_ENV: 'production', FLOCKLETTER_CUSTOMER_DELIVERY: 'ses' }),
  ).toThrow();
});

it('customerSesRuntime rejects incomplete credentials', () => {
  expect(() =>
    customerSesRuntime(origin, {
      APP_ENV: 'production',
      FLOCKLETTER_CUSTOMER_DELIVERY: 'ses',
      FLOCKLETTER_LIVE_MAILING_APPROVED: 'true',
    }),
  ).toThrow();
});

it('customerSesRuntime returns undefined when off', () => {
  expect(customerSesRuntime(origin, {})).toBeUndefined();
});

it('rejects raw CRLF unsubscribe header injection', async () => {
  const send = vi.fn(async (_input: SendEmailCommandInput) => ({ MessageId: 'unexpected-send' }));
  const provider = makeProvider(send);

  await expect(
    provider.submit(
      validEnvelope({ unsubscribe: { url: `${origin}/newsletter/opt-out?t=abc_123\r\nX-Injected: true` } }),
    ),
  ).resolves.toEqual({ outcome: 'rejected' });
  expect(send).not.toHaveBeenCalled();
});

it('freezes the reviewed sender and tenant binding against caller mutation', async () => {
  const route = { ...validRoute() },
    fingerprint = route.fingerprint;
  const send = vi.fn(async (_input: SendEmailCommandInput) => ({ MessageId: 'snapshot-message' }));
  const provider = new CustomerSesProvider(route, origin, send, async () => true);
  route.from = 'changed@other.example.com';
  route.tenant = 'changed-tenant';
  route.configurationSet = 'changed-config';
  expect(provider.fingerprint).toBe(fingerprint);
  expect(await provider.submit(validEnvelope())).toEqual({
    outcome: 'accepted',
    messageId: 'snapshot-message',
  });
  expect(send.mock.calls[0]![0]).toMatchObject({
    FromEmailAddress: from,
    TenantName: tenant,
    ConfigurationSetName: configurationSet,
  });
});

it('honors the configured from address with bounded sender presentation and rejects header injection', async () => {
  const send = vi.fn(async (_input: SendEmailCommandInput) => ({ MessageId: 'sender-message' }));
  const provider = makeProvider(send);
  const sender = {
    name: 'Trail Store',
    replyTo: 'help@brand.example.com',
    from,
    legalName: 'Trail Store LLC',
    postal: '123 Trail Road, Denver, CO 80202, US',
  };
  expect(await provider.submit(validEnvelope({ sender }))).toMatchObject({ outcome: 'accepted' });
  expect(send.mock.calls[0]![0]).toMatchObject({
    FromEmailAddress: '"Trail Store" <' + from + '>',
    ReplyToAddresses: [sender.replyTo],
  });
  send.mockClear();
  for (const value of [
    { ...sender, name: 'Trail\r\nBcc:spy@example.com' },
    { ...sender, replyTo: 'help@brand.example.com\r\nBcc:spy@example.com' },
  ]) {
    expect(await provider.submit(validEnvelope({ sender: value }))).toEqual({ outcome: 'rejected' });
    expect(send).not.toHaveBeenCalled();
  }
});

it('rejects cross-workspace SES tenant or sender identity reuse before constructing transports', () => {
  const raw = {
    workspaceId,
    brandId,
    region,
    accountId,
    tenant,
    configurationSet,
    from,
    identityArn,
    topicArn,
  };
  const env = {
    APP_ENV: 'production',
    FLOCKLETTER_CUSTOMER_DELIVERY: 'ses',
    FLOCKLETTER_LIVE_MAILING_APPROVED: 'true',
    FLOCKLETTER_CUSTOMER_SES_ACCESS_KEY_ID: 'synthetic-not-a-key',
    FLOCKLETTER_CUSTOMER_SES_SECRET_ACCESS_KEY: 'synthetic-not-a-secret',
  };
  for (const override of [
    {
      tenant,
      from: 'news@neighbor.example.com',
      identityArn: `arn:aws:ses:${region}:${accountId}:identity/neighbor.example.com`,
    },
    { tenant: 'other-tenant', from, identityArn },
  ]) {
    const second = {
      ...raw,
      ...override,
      workspaceId: 'org_neighbor',
      brandId: randomUUID(),
      configurationSet: 'other-config',
      topicArn: `arn:aws:sns:${region}:${accountId}:other-topic`,
    };
    try {
      const runtime = customerSesRuntime(origin, {
        ...env,
        FLOCKLETTER_CUSTOMER_SES_BINDINGS: JSON.stringify([raw, second]),
      });
      runtime?.close();
      throw Error('An unsafe cross-workspace binding was accepted.');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('distinct SES tenants and sender identities');
    }
  }
});

it('reconstructs one-recipient destination and only platform-owned headers from untrusted extra fields', async () => {
  const send = vi.fn(async (_input: SendEmailCommandInput) => ({ MessageId: 'rebuilt-message' }));
  const provider = makeProvider(send);
  const envelope = {
    ...validEnvelope(),
    cc: ['spy@example.com'],
    bcc: ['spy@example.com'],
    headers: [{ Name: 'Bcc', Value: 'spy@example.com' }],
  };
  expect(await provider.submit(envelope)).toHaveProperty('outcome', 'accepted');
  expect(send.mock.calls[0]![0].Destination).toEqual({ ToAddresses: [envelope.to] });
  expect(send.mock.calls[0]![0].Content?.Simple?.Headers).toHaveLength(2);
});

it('fails closed before submission when readiness cannot be verified', async () => {
  const send = vi.fn(async (_input: SendEmailCommandInput) => ({ MessageId: 'unexpected-send' }));
  const provider = makeProvider(
    send,
    vi.fn(async () => {
      throw Error('Inspector unavailable');
    }),
  );
  expect(await provider.submit(validEnvelope())).toEqual({ outcome: 'unknown' });
  expect(send).not.toHaveBeenCalled();
});

it('registers observed routes for feedback while keeping unverified provisioning out of delivery',()=>{
  const runtime=customerSesRuntime(origin,{APP_ENV:'production',FLOCKLETTER_CUSTOMER_DELIVERY:'ses',
    FLOCKLETTER_LIVE_MAILING_APPROVED:'true',FLOCKLETTER_CUSTOMER_INFRASTRUCTURE:'aws',
    FLOCKLETTER_INFRASTRUCTURE_ACTIVATION_APPROVED:'true',FLOCKLETTER_INFRASTRUCTURE_AWS_ACCOUNT_ID:accountId,
    FLOCKLETTER_INFRASTRUCTURE_AWS_REGION:region,FLOCKLETTER_CUSTOMER_SES_ACCESS_KEY_ID:'synthetic-only',
    FLOCKLETTER_CUSTOMER_SES_SECRET_ACCESS_KEY:'synthetic-only'});
  expect(runtime).toBeDefined();
  try {
    const route=validRoute();runtime!.register(route,false);
    expect(runtime!.entries).toHaveLength(1);expect(runtime!.provider(workspaceId,brandId)).toBeUndefined();
    runtime!.register(route,true);expect(runtime!.provider(workspaceId,brandId)?.fingerprint).toBe(route.fingerprint);
    runtime!.deactivate(workspaceId);expect(runtime!.provider(workspaceId,brandId)).toBeUndefined();
    const foreign=parseSesRoute({workspaceId,brandId,region,accountId:'999999999999',tenant,configurationSet,from,
      identityArn:identityArn.replace(accountId,'999999999999'),topicArn:topicArn.replace(accountId,'999999999999')});
    expect(()=>runtime!.register(foreign,true)).toThrow();
  }finally{runtime!.close();}
});
