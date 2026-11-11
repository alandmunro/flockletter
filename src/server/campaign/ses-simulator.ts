import { createHash } from 'node:crypto';
import {
  SESv2Client,
  SendEmailCommand,
  type Message,
  type SendEmailCommandInput,
} from '@aws-sdk/client-sesv2';
import type { DeliveryEnvelope, DeliveryOutcome, DeliveryProvider } from './delivery-provider.js';

export type SesSimulationBinding = Readonly<{
  workspaceId: string;
  brandId: string;
  region: string;
  accountId: string;
  tenant: string;
  configurationSet: string;
  from: string;
  identityArn: string;
}>;

export type SesSimulatorPort = {
  send(input: SendEmailCommandInput): Promise<{ MessageId?: string }>;
};
export type SesSimulatorReceipts = {
  record(operationKey: string, messageId: string): Promise<void>;
  lookup(operationKey: string): Promise<boolean>;
};
export type SesSimulatorCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

const simulatorAddresses = new Map([
  ['reader@campaign.test', 'success@simulator.amazonses.com'],
  ['bounce@delivery.test', 'bounce@simulator.amazonses.com'],
  ['complaint@delivery.test', 'complaint@simulator.amazonses.com'],
]);
const destinations = new Set(simulatorAddresses.values());
const validOperationKey = /^[a-zA-Z0-9_-]{1,256}$/;

export function simulatorDestination(alias: string): string | undefined {
  return simulatorAddresses.get(alias);
}

function simulatorRequest(
  binding: SesSimulationBinding,
  destination: string,
  key: string,
  simple: Message,
  unsubscribe?: string,
): SendEmailCommandInput {
  return {
    TenantName: binding.tenant,
    ConfigurationSetName: binding.configurationSet,
    ConfigurationOverrides: {
      Tracking: { OpenTrackingEnabled: 'DISABLED', ClickTrackingEnabled: 'DISABLED' },
    },
    FromEmailAddress: binding.from,
    FromEmailAddressIdentityArn: binding.identityArn,
    Destination: { ToAddresses: [destination] },
    EmailTags: [
      { Name: 'fl_operation', Value: key },
      { Name: 'fl_tenant', Value: binding.tenant },
    ],
    Content: {
      Simple: {
        Subject: simple.Subject,
        Body: simple.Body,
        Attachments: simple.Attachments,
        ...(unsubscribe
          ? {
              Headers: [
                { Name: 'List-Unsubscribe', Value: '<' + unsubscribe + '>' },
                { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
              ],
            }
          : {}),
      },
    },
  };
}

export function createSesSimulatorPort(
  binding: SesSimulationBinding,
  credentials: SesSimulatorCredentials,
  unsubscribeOrigin?: string,
): SesSimulatorPort & { destroy(): void } {
  if (!credentials?.accessKeyId?.trim() || !credentials.secretAccessKey?.trim()) {
    throw new Error('Dedicated Flockletter simulator credentials are required.');
  }
  const fixed = { ...binding };
  const client = new SESv2Client({
    region: binding.region,
    credentials: { ...credentials },
    maxAttempts: 1,
    ignoreConfiguredEndpointUrls: true,
  });
  return {
    async send(input) {
      const to = input.Destination?.ToAddresses;
      const key = input.EmailTags?.find((tag) => tag.Name === 'fl_operation')?.Value;
      const simple = input.Content?.Simple;
      if (
        to?.length !== 1 ||
        !destinations.has(to[0]!) ||
        input.Destination?.CcAddresses?.length ||
        input.Destination?.BccAddresses?.length ||
        !key ||
        !validOperationKey.test(key) ||
        !simple
      ) {
        throw new Error('Invalid SES mailbox simulator request.');
      }
      // Rebuild the final request from approved fields so the port cannot forward mail
      // or feedback to additional destinations through raw headers or optional API fields.
      // Reconstruct these two platform-owned headers. Never pass arbitrary engine or draft headers through.
      const list =
        simple.Headers?.filter((h) =>
          ['list-unsubscribe', 'list-unsubscribe-post'].includes(h.Name?.toLowerCase() ?? ''),
        ) ?? [];
      let unsubscribe: string | undefined;
      if (list.length) {
        const value = list.find((h) => h.Name === 'List-Unsubscribe')?.Value;
        const candidate = value?.startsWith('<') && value.endsWith('>') ? value.slice(1, -1) : '';
        const base = unsubscribeOrigin && unsubscribeOrigin + '/mail/unsubscribe?t=';
        if (
          list.length !== 2 ||
          !base ||
          !base.startsWith('https://') ||
          !candidate.startsWith(base) ||
          !/^v1\.[\w-]{22}\.[a-f\d-]{36}\.[\w-]{43}$/.test(candidate.slice(base.length)) ||
          !list.some((h) => h.Name === 'List-Unsubscribe-Post' && h.Value === 'List-Unsubscribe=One-Click')
        )
          throw Error('Invalid simulator unsubscribe headers.');
        unsubscribe = candidate;
      }
      const request = simulatorRequest(fixed, to[0]!, key, simple, unsubscribe);
      return client.send(new SendEmailCommand(request), { abortSignal: AbortSignal.timeout(5000) });
    },
    destroy: () => client.destroy(),
  };
}

export function inlineOriginals(message: DeliveryEnvelope) {
  const referenced = new Set(
    Array.from(
      message.html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*(?:"cid:([^"]+)"|'cid:([^']+)'|cid:([^\s>]+))/gi),
      (match) => (match[1] ?? match[2] ?? match[3])!,
    ),
  );
  const files = new Map<string, DeliveryEnvelope['images'][number]>();
  for (const image of message.images) {
    if (
      !referenced.has(image.sha256) ||
      createHash('sha256').update(image.bytes).digest('hex') !== image.sha256 ||
      !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(image.mime) ||
      /[\p{Cc}]/u.test(image.name)
    ) {
      return null;
    }
    if (!files.has(image.sha256)) files.set(image.sha256, image);
  }
  if (files.size !== referenced.size) return null;
  return Array.from(files.values(), (image) => ({
    ContentId: image.sha256,
    ContentDisposition: 'INLINE' as const,
    ContentTransferEncoding: 'BASE64' as const,
    ContentType: image.mime,
    FileName: image.name,
    RawContent: new Uint8Array(image.bytes),
  }));
}

export class SesSimulatorProvider implements DeliveryProvider {
  private readonly binding: SesSimulationBinding;
  constructor(
    binding: SesSimulationBinding,
    private port: SesSimulatorPort,
    private receipts: SesSimulatorReceipts,
  ) {
    this.binding = { ...binding };
  }

  async submit(message: DeliveryEnvelope): Promise<DeliveryOutcome> {
    const destination = simulatorDestination(message.to);
    if (
      !destination ||
      this.binding.workspaceId !== message.workspaceId ||
      this.binding.brandId !== message.brandId ||
      !validOperationKey.test(message.operationKey)
    )
      return 'rejected';
    const attachments = inlineOriginals(message);
    if (!attachments) return 'rejected';
    const input = simulatorRequest(
      this.binding,
      destination,
      message.operationKey,
      {
        Subject: { Charset: 'UTF-8', Data: message.subject },
        Body: {
          Html: { Charset: 'UTF-8', Data: message.html },
          Text: { Charset: 'UTF-8', Data: message.text },
        },
        Attachments: attachments,
      },
      message.unsubscribe?.url,
    );
    try {
      if (await this.receipts.lookup(message.operationKey)) return 'accepted';
      const { MessageId } = await this.port.send(input);
      if (!MessageId?.trim()) return 'unknown';
      await this.receipts.record(message.operationKey, MessageId);
      return 'accepted';
    } catch {
      return 'unknown';
    }
  }

  async lookup(operationKey: string): Promise<DeliveryOutcome> {
    try {
      return (await this.receipts.lookup(operationKey)) ? 'accepted' : 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
