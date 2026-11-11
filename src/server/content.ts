import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { limits, type Campaign, type Gap } from '../shared/contracts.js';
import { AppError } from './errors.js';
import {renderStudio,studioContentGaps} from './studio-render.js';
import { renderAuthoringLayout } from './authoring-layout.js';
import { staticSvg } from './svg-import.js';

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
  if(c.studio!==undefined)return [...gaps,...studioContentGaps(c.studio)];
  if (!c.heading || !c.body.trim()) add('message_incomplete', 'Add a heading and message', 'The email needs a readable heading and message.');
  if (Boolean(c.ctaLabel) !== Boolean(c.ctaUrl)) add('link_incomplete', 'Complete the button', 'Supply both a button label and an HTTPS link, or leave both empty.');
  if (c.ctaUrl && !safeLink(c.ctaUrl)) add('link_invalid', 'Use a public HTTPS link', 'Private addresses, credentials, custom ports and unsafe link types are not supported.');
  return gaps;
}
export function deliveryGaps(): Gap[] {
  return [
    { code: 'sender_not_verified', title: 'Verify a sending domain', detail: 'Sender verification will be connected in the delivery workstream.', area: 'sender' },
    { code: 'audience_not_ready', title: 'Review recipients before sending', detail: 'Sending requires a reviewed recipient snapshot and a fresh suppression check.', area: 'audience' },
    { code: 'entitlement_not_active', title: 'Activate service access', detail: 'Drafting does not start a trial or grant a paid or complimentary entitlement.', area: 'billing' },
    { code: 'delivery_not_configured', title: 'Campaign delivery is disabled', detail: 'Campaign test sends and broadcasts require the campaign delivery workstream.', area: 'delivery' },
  ];
}
export function preflight(campaign: Campaign) {
  const content = contentGaps(campaign);
  const gaps = [...content, ...deliveryGaps()];
  return { campaignId: campaign.id, version: campaign.version, canSend: false as const, contentReady: content.length === 0, gaps };
}
type PreviewImage = {name:string;mime:string;bytes:Buffer}|{name:string;sha256:string};
function previewSource(image:PreviewImage) {
  if ('bytes' in image) return `data:${image.mime};base64,${image.bytes.toString('base64')}`;
  if (!/^[a-f0-9]{64}$/.test(image.sha256)) throw new Error('Invalid stored image digest.');
  return 'cid:'+image.sha256;
}
export function renderPreview(campaign: Campaign, images: PreviewImage[]) {
  const c = campaign.content;
  if(c.studio!==undefined){
    const pictures=new Map(c.assetIds.flatMap((id,i)=>images[i] ? [[id,{src:previewSource(images[i]!),name:images[i]!.name}] as const] : []));
    return renderStudio(campaign,c.studio,pictures);
  }
  const text = [c.heading, c.body, c.ctaLabel && safeLink(c.ctaUrl) ? `${c.ctaLabel}: ${c.ctaUrl}` : ''].filter(Boolean).join('\n\n');
  const heading = `<h1 style="font:36px Georgia;color:#4a0a1e">${escapeHtml(c.heading)}</h1>`;
  const photos = images.map(i => `<img alt="${escapeHtml(i.name)}" style="width:100%;height:auto;margin:12px 0" src="${previewSource(i)}">`).join('');
  const story = `<div style="white-space:pre-wrap">${escapeHtml(c.body)}</div>`;
  const link = c.ctaLabel && safeLink(c.ctaUrl)
    ? `<p><a rel="noopener noreferrer" href="${escapeHtml(c.ctaUrl)}" style="color:#a41f2d">${escapeHtml(c.ctaLabel)}</a></p>`: '';
  const layoutBody = renderAuthoringLayout(c.layout, { heading, photos, story, link });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(c.subject || 'Campaign preview')}</title></head><body style="margin:0;background:#fff7f8;color:#1b1d21;font:16px/1.65 system-ui"><main style="max-width:600px;margin:auto;background:white;padding:30px;overflow-wrap:anywhere"><p style="color:#69515d">${escapeHtml(c.fromName)}</p><p>${escapeHtml(c.preheader)}</p>${layoutBody}<hr><p style="font-size:12px;color:#69515d">Preview only. Verified sender details and unsubscribe controls are required before delivery.</p></main></body></html>`;
  return { campaignId: campaign.id, version: campaign.version, html, text };
}
export async function inspectImage(base64: string) {
  // Check size before decoding; a repeated-group regex can exhaust the JS stack on large input.
  if (base64.length > Math.ceil(limits.fileBytes / 3) * 4) throw new AppError(422, 'image_size', 'Each image must be no larger than 5 MiB.');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > limits.fileBytes) throw new AppError(422, 'image_size', 'Each image must be no larger than 5 MiB.');
  if (bytes.toString('base64') !== base64) throw new AppError(422, 'invalid_image', 'Supply canonical base64 image bytes.');
  try {
    const raster = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      /^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii')) ||
      (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP');
    if (!raster) {
      const image = sharp(staticSvg(bytes), { limitInputPixels: limits.imagePixels, failOn: 'warning' });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height) throw Error('Missing SVG dimensions.');
      const png = await image.png().toBuffer();
      if (png.length > limits.fileBytes) throw Error('Converted SVG exceeds the image limit.');
      return { bytes: png, sha256: digest(png), mime: 'image/png', width: metadata.width, height: metadata.height,
        converted: true, notice: 'SVG converted to PNG for safe, compatible email display.' };
    }
    const image = sharp(bytes, { animated: true, limitInputPixels: limits.imagePixels, failOn: 'warning' });
    const metadata = await image.metadata();
    const frames = metadata.pages ?? 1, height = metadata.pageHeight ?? metadata.height;
    if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format) || !metadata.width || !height ||
      frames > 100 || metadata.width * height * frames > limits.imagePixels) throw Error('Unsupported image or animation limit.');
    // APNG is not decoded as animation by this renderer: reject instead of silently flattening it.
    if (metadata.format === 'png' && hasPngAnimation(bytes)) throw Error('Use GIF or WebP for animation.');
    // Decode every bounded frame, including late corruption, then retain the original file byte-for-byte.
    await image.raw().toBuffer();
    return { bytes, sha256: digest(bytes), mime: `image/${metadata.format}`, width: metadata.width, height,
      converted: false, notice: frames > 1 ? 'Animation preserved. Some email apps display only the first frame.' : undefined };
  } catch { throw new AppError(422, 'invalid_image', 'Use a valid JPEG, PNG, GIF, WebP or static SVG. Animations: GIF/WebP, up to 100 frames and 25 million total decoded pixels. SVG must contain only self-contained static artwork.'); }
}

function hasPngAnimation(bytes: Buffer) {
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw Error('Invalid PNG chunk.');
    if (bytes.subarray(offset + 4, offset + 8).toString('ascii') === 'acTL') return true;
    offset += length + 12;
  }
  return false;
}
