import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { limits, type Campaign, type Gap } from '../shared/contracts.js';
import { AppError } from './errors.js';

export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export function safeLink(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !isIP(url.hostname) && !url.hostname.startsWith('[') && url.hostname.includes('.') && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname);
  } catch { return false; }
}
export function contentGaps(campaign: Campaign): Gap[] {
  const c = campaign.content;
  const gaps: Gap[] = [];
  const add = (code: string, title: string, detail: string) => gaps.push({ code, title, detail, area: 'content' });
  if (!c.subject) add('subject_missing', 'Add an email subject', 'Give readers a clear reason to open the email.');
  if (!c.fromName) add('from_name_missing', 'Add a sender name', 'Use the business or brand name readers recognize.');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(c.replyTo)) add('reply_to_invalid', 'Add a valid reply address', 'Replies need a monitored email address.');
  if (!c.heading || !c.body.trim()) add('message_incomplete', 'Add a heading and message', 'The email needs a readable heading and message.');
  if (Boolean(c.ctaLabel) !== Boolean(c.ctaUrl)) add('link_incomplete', 'Complete the button', 'Supply both a button label and an HTTPS link, or leave both empty.');
  if (c.ctaUrl && !safeLink(c.ctaUrl)) add('link_invalid', 'Use a public HTTPS link', 'Private addresses, credentials, custom ports and unsafe link types are not supported.');
  return gaps;
}
export function deliveryGaps(): Gap[] {
  return [
    { code: 'sender_not_verified', title: 'Verify a sending domain', detail: 'Sender verification will be connected in the delivery workstream.', area: 'sender' },
    { code: 'audience_not_ready', title: 'Connect a consented audience', detail: 'Audience import and suppression checks are not enabled in this foundation.', area: 'audience' },
    { code: 'entitlement_not_active', title: 'Activate service access', detail: 'Drafting does not start a trial or grant a paid or complimentary entitlement.', area: 'billing' },
    { code: 'delivery_not_configured', title: 'Delivery is not enabled', detail: 'No test email or campaign can be sent by this build.', area: 'delivery' },
  ];
}
export function preflight(campaign: Campaign) {
  const content = contentGaps(campaign);
  const gaps = [...content, ...deliveryGaps()];
  return { campaignId: campaign.id, version: campaign.version, canSend: false as const, contentReady: content.length === 0, gaps };
}
export function renderPreview(campaign: Campaign, images: { name: string; mime: string; bytes: Buffer }[]) {
  const c = campaign.content;
  const text = [c.heading, c.body, c.ctaLabel && safeLink(c.ctaUrl) ? `${c.ctaLabel}: ${c.ctaUrl}` : ''].filter(Boolean).join('\n\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(c.subject || 'Campaign preview')}</title></head><body style="margin:0;background:#fff7f8;color:#1b1d21;font:16px/1.65 system-ui"><main style="max-width:600px;margin:auto;background:white;padding:30px;overflow-wrap:anywhere"><p style="color:#69515d">${escapeHtml(c.fromName)}</p><p>${escapeHtml(c.preheader)}</p><h1 style="font:36px Georgia;color:#4a0a1e">${escapeHtml(c.heading)}</h1>${images.map(i => `<img alt="${escapeHtml(i.name)}" style="width:100%;height:auto;margin:12px 0" src="data:${i.mime};base64,${i.bytes.toString('base64')}">`).join('')}<div style="white-space:pre-wrap">${escapeHtml(c.body)}</div>${c.ctaLabel && safeLink(c.ctaUrl) ? `<p><a rel="noopener noreferrer" href="${escapeHtml(c.ctaUrl)}" style="color:#a41f2d">${escapeHtml(c.ctaLabel)}</a></p>` : ''}<hr><p style="font-size:12px;color:#69515d">Preview only. Verified sender details and unsubscribe controls are required before delivery.</p></main></body></html>`;
  return { campaignId: campaign.id, version: campaign.version, html, text };
}
export async function inspectImage(base64: string) {
  // Check size before decoding; a repeated-group regex can exhaust the JS stack on large input.
  if (base64.length > Math.ceil(limits.fileBytes / 3) * 4) throw new AppError(422, 'image_size', 'Each image must be no larger than 5 MiB.');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > limits.fileBytes) throw new AppError(422, 'image_size', 'Each image must be no larger than 5 MiB.');
  if (bytes.toString('base64') !== base64) throw new AppError(422, 'invalid_image', 'Supply canonical base64 image bytes.');
  try {
    const image = sharp(bytes, { limitInputPixels: limits.imagePixels, failOn: 'warning' });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height) throw new Error('Unsupported image');
    await image.resize(1, 1).raw().toBuffer();
    return { bytes, sha256: digest(bytes), mime: `image/${metadata.format}`, width: metadata.width, height: metadata.height };
  } catch { throw new AppError(422, 'invalid_image', 'Use a valid, nonanimated JPEG, PNG or WebP image up to 25 megapixels.'); }
}
