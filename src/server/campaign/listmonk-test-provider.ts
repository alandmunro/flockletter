import { createHash } from 'node:crypto';
import type { DeliveryEnvelope, DeliveryOutcome, DeliveryProvider } from './delivery-provider.js';

// The disposable engine runs on an internal Docker network. No application input selects an endpoint,
// template, sender or messenger. Only this fixture's authenticated callback can confirm acceptance.
const engineTx = 'http://engine:9000/api/tx';
const reservedRecipient =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9-]+\.)+(?:test)$|^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@example\.(?:com|org|net)$/i;

type Fixture = {
  workspaceId: string;
  brandId: string;
  session: string;
  templateId: number;
  // Return false only for an existing, identical registration. A conflicting envelope is an error.
  reserve(reference: string, message: DeliveryEnvelope): Promise<boolean>;
  accepted(reference: string): Promise<boolean>;
};

export class ListmonkTestProvider implements DeliveryProvider {
  private readonly fixture: Fixture;

  constructor(fixture: Fixture) {
    if (!Number.isSafeInteger(fixture.templateId) || fixture.templateId < 1 || !fixture.session) {
      throw new Error('Configure the private Listmonk test template and session.');
    }
    this.fixture = fixture;
  }

  // Listmonk's transactional postback omits custom headers. The synthetic sender carries the
  // operation reference across this one isolated hop without altering the reviewed subject or HTML.
  private reference(key: string) {
    const scope = JSON.stringify([this.fixture.workspaceId, this.fixture.brandId, key]);
    return 'fl-' + createHash('sha224').update(scope).digest('hex') + '@receipt.test';
  }

  async lookup(operationKey: string): Promise<DeliveryOutcome> {
    try {
      return (await this.fixture.accepted(this.reference(operationKey))) ? 'accepted' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async submit(message: DeliveryEnvelope): Promise<DeliveryOutcome> {
    if (
      message.workspaceId !== this.fixture.workspaceId ||
      message.brandId !== this.fixture.brandId ||
      !reservedRecipient.test(message.to) ||
      /\s/.test(message.to)
    )
      return 'rejected';
    if (
      message.images.some((image) => createHash('sha256').update(image.bytes).digest('hex') !== image.sha256)
    ) {
      return 'rejected';
    }
    const reference = this.reference(message.operationKey);
    try {
      // A lost response must never initiate another Listmonk POST for the same recipient.
      if (!(await this.fixture.reserve(reference, message))) return this.lookup(message.operationKey);
      const body = new FormData();
      body.set(
        'data',
        JSON.stringify({
          subscriber_email: message.to,
          template_id: this.fixture.templateId,
          messenger: 'fixture',
          content_type: 'html',
          from_email: reference,
          subject: '{{ .Tx.Data.subject }}',
          altbody: '{{ .Tx.Data.text }}',
          data: { subject: message.subject, text: message.text, html: message.html },
        }),
      );
      for (const image of message.images) {
        body.append('file', new Blob([new Uint8Array(image.bytes)], { type: image.mime }), image.name);
      }
      const response = await fetch(engineTx, {
        method: 'POST',
        body,
        headers: { cookie: this.fixture.session },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      await response.body?.cancel();
    } catch {
      return 'unknown';
    }
    return this.lookup(message.operationKey);
  }
}
