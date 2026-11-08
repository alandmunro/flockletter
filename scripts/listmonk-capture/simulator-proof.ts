import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { DeliveryEnvelope } from '../../src/server/campaign/delivery-provider.js';
import { SesSimulatorProvider } from '../../src/server/campaign/ses-simulator.js';

// Real AWS SDK serialization. The only request handler is memory; no network socket or AWS account.
export function isolatedSimulator(workspaceId: string, brandId: string) {
  const receipts = new Map<string, string>();
  const wire: Record<string, unknown>[] = [];
  const client = new SESv2Client({
    region: 'us-west-2',
    credentials: { accessKeyId: 'SYNTHETIC', secretAccessKey: 'FIXTURE-ONLY' },
    maxAttempts: 1,
    requestHandler: {
      handle: async (req: { body: string | Uint8Array }) => {
        const body = JSON.parse(Buffer.from(req.body).toString('utf8'));
        wire.push(body);
        const key = body.EmailTags.find((tag: { Name: string }) => tag.Name === 'fl_operation')?.Value;
        assert(key);
        return {
          response: {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: Readable.from([Buffer.from(JSON.stringify({ MessageId: 'offline-ses-' + key }))]),
          },
        };
      },
    },
  });
  const provider = new SesSimulatorProvider(
    {
      workspaceId,
      brandId,
      region: 'us-west-2',
      accountId: '123456789012',
      tenant: 'fixture',
      configurationSet: 'fixture-configuration',
      from: 'sender@shop.example.com',
      identityArn: 'arn:aws:ses:us-west-2:123456789012:identity/shop.example.com',
    },
    { send: (input) => client.send(new SendEmailCommand(input)) },
    {
      lookup: async (key) => receipts.has(key),
      record: async (key, id) => {
        receipts.set(key, id);
      },
    },
  );
  return {
    provider,
    count: () => wire.length,
    receipt: (key: string) => receipts.get(key),
    close: () => client.destroy(),
    verify(original: DeliveryEnvelope) {
      assert.equal(wire.length, 1, 'Exactly one simulated SES request may leave the messenger');
      const output = wire[0]!;
      assert.deepEqual(output.Destination, { ToAddresses: ['success@simulator.amazonses.com'] });
      const simple = (
        output.Content as {
          Simple: {
            Subject: { Data: string };
            Body: { Html: { Data: string }; Text: { Data: string } };
            Attachments: {
              ContentId: string;
              RawContent: string;
              ContentDisposition: string;
              ContentType: string;
            }[];
          };
        }
      ).Simple;
      assert.equal(simple.Subject.Data, original.subject);
      assert.equal(simple.Body.Html.Data, original.html);
      assert.equal(simple.Body.Text.Data, original.text);
      assert.equal(simple.Attachments.length, original.images.length);
      for (const [i, image] of original.images.entries()) {
        const file = simple.Attachments[i]!;
        assert.equal(file.ContentId, image.sha256);
        assert.equal(file.ContentDisposition, 'INLINE');
        assert.equal(file.ContentType, image.mime);
        assert(original.html.includes('cid:' + file.ContentId));
        assert.deepEqual(Buffer.from(file.RawContent, 'base64'), image.bytes);
      }
    },
  };
}
