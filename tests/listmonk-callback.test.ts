import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { reviewedListmonkMessage } from '../src/server/campaign/listmonk-callback.js';
import type { DeliveryEnvelope } from '../src/server/campaign/delivery-provider.js';

const bytes = Buffer.from([5, 54, 254, 0]),
  sha256 = createHash('sha256').update(bytes).digest('hex');
const reviewed: DeliveryEnvelope = {
  workspaceId: 'org_test',
  brandId: randomUUID(),
  operationKey: randomUUID(),
  to: 'reader@campaign.test',
  subject: 'Ski report',
  html: '<img src="cid:' + sha256 + '">',
  text: 'A very different plain-text alternative.',
  images: [{ name: 'report.png', mime: 'image/png', bytes, sha256 }],
};
const reference =
  'fl-' +
  createHash('sha224')
    .update(JSON.stringify([reviewed.workspaceId, reviewed.brandId, reviewed.operationKey]))
    .digest('hex') +
  '@receipt.test';
const attachment = {
  name: 'report.png',
  header: { 'Content-Type': ['image/png; name=report.png'] },
  content: bytes.toString('base64'),
};
const callback = {
  from_email: reference,
  recipients: [{ email: reviewed.to }],
  content_type: 'html',
  subject: reviewed.subject,
  body: reviewed.html,
  attachments: [attachment],
};
describe('private Listmonk messenger review', () => {
  it('restores missing text and inline IDs only from the frozen Flockletter envelope', () => {
    const result = reviewedListmonkMessage(
      { ...callback, altbody: 'unreviewed alternative', email_headers: { Cc: 'someone@example.test' } },
      reviewed,
    );
    expect(result).toBe(reviewed);
    expect(result.text).toEqual(reviewed.text);
  });
  it('rejects added recipients, a different reference, edited HTML and any attachment change', () => {
    for (const delta of [
      { from_email: 'other@receipt.test' },
      { recipients: [...callback.recipients, { email: 'another@example.test' }] },
      { body: 'modified' },
      { attachments: [] },
      { attachments: [{ ...attachment, name: 'other.png' }] },
      { attachments: [{ ...attachment, content: Buffer.from('altered').toString('base64') }] },
      { attachments: [{ ...attachment, header: { 'Content-Type': ['text/html'] } }] },
    ])
      expect(() => reviewedListmonkMessage({ ...callback, ...delta }, reviewed)).toThrow();
    expect(() => reviewedListmonkMessage(callback, { ...reviewed, brandId: randomUUID() })).toThrow();
  });
});
