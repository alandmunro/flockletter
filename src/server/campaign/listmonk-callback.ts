import { createHash } from 'node:crypto';
import type { DeliveryEnvelope } from './delivery-provider.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid private messenger callback.');
  return value as Record<string, unknown>;
}
// The engine omits the alternate body and inline Content-IDs. Only the approved envelope
// supplies those fields and the provider routing; a callback cannot introduce mail headers or recipients.
export function reviewedListmonkMessage(raw: unknown, reviewed: DeliveryEnvelope): DeliveryEnvelope {
  const p = object(raw);
  const reference =
    'fl-' +
    createHash('sha224')
      .update(JSON.stringify([reviewed.workspaceId, reviewed.brandId, reviewed.operationKey]))
      .digest('hex') +
    '@receipt.test';
  if (
    p.from_email !== reference ||
    p.subject !== reviewed.subject ||
    p.content_type !== 'html' ||
    p.body !== reviewed.html ||
    !Array.isArray(p.recipients) ||
    p.recipients.length !== 1 ||
    object(p.recipients[0]).email !== reviewed.to
  )
    throw Error('The Listmonk message does not match its review.');
  const files = p.attachments ?? [];
  if (!Array.isArray(files) || files.length !== reviewed.images.length)
    throw Error('Unexpected Listmonk attachments.');
  for (const [index, img] of reviewed.images.entries()) {
    const f = object(files[index]),
      header = object(f.header),
      type = header['Content-Type'];
    if (
      f.name !== img.name ||
      !Array.isArray(type) ||
      type.length !== 1 ||
      typeof type[0] !== 'string' ||
      type[0].split(';')[0] !== img.mime ||
      typeof f.content !== 'string' ||
      f.content !== img.bytes.toString('base64') ||
      createHash('sha256').update(img.bytes).digest('hex') !== img.sha256
    )
      throw Error('The Listmonk attachment differs from the reviewed original.');
  }
  return reviewed;
}
