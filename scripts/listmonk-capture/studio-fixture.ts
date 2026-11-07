import { studioFixtureImage } from '../studio-fixture-image.js';
import { createHash } from 'node:crypto';
import { emptyContent, type Campaign } from '../../src/shared/contracts.js';
import { withStudio } from '../../src/shared/studio-legacy.js';
import { renderPreview } from '../../src/server/content.js';

// Only fictional recipients and a synthetic original landscape enter this proof.
const bytes = await studioFixtureImage('#8b4764');
const digest = createHash('sha256').update(bytes).digest('hex');
const id = 'a13388f1-8075-42e5-a18b-c6e94e5105c3';
const content = withStudio(
  {
    ...emptyContent(),
    subject: 'Field notes {{ .Subscriber.Email }}',
    fromName: 'Alpine Field Notes',
    preheader: 'From the November collection',
  },
  {
    version: 1,
    blocks: [
      { type: 'heading', level: 1, runs: [{ text: 'November at the trailhead' }] },
      {
        type: 'paragraph',
        runs: [
          { text: 'The sky is clear. ' },
          { text: 'See the trail report', href: 'https://example.org/trails' },
        ],
      },
      { type: 'image', assetId: id, alt: 'Mountain skyline at the trailhead' },
      { type: 'divider' },
      { type: 'spacer', size: 'small' },
      {
        type: 'columns',
        columns: [
          [{ type: 'paragraph', runs: [{ text: 'Breck pickup', bold: true }] }],
          [{ type: 'paragraph', runs: [{ text: 'A literal {{ .Subscriber.Email }} remains text.' }] }],
        ],
      },
      { type: 'button', label: 'Browse the collection', href: 'https://example.org/collection' },
    ],
  },
);
const campaign: Campaign = {
  id: '32b94bd4-5ea2-4ace-9cb8-138b96d729df',
  brandId: '0a42d824-4765-45fd-856e-388648ddfb30',
  version: 2,
  status: 'draft',
  createdAt: '2026-11-07T00:00:00.000Z',
  updatedAt: '2026-11-07T00:00:00.000Z',
  content,
};
const rendered = renderPreview(campaign, [{ name: 'Trailhead.png', sha256: digest }]);
if (!process.argv.includes('--eml'))
  console.log(JSON.stringify({ subject: content.subject, html: rendered.html, text: rendered.text, digest }));
else {
  const encoded = (value: Buffer | string) =>
    Buffer.from(value)
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? '';
  const alt = 'fl-alternative-studio-preview',
    related = 'fl-related-studio-preview';
  const lines = [
    'From: Alpine Field Notes <sender@example.test>',
    'To: Reader <reader@example.test>',
    'Subject: ' + content.subject,
    'Date: Sat, 07 Nov 2026 12:00:00 +0000',
    'Message-ID: <studio-example@newsletter.example.test>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + alt + '"',
    '',
    '--' + alt,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encoded(rendered.text),
    '--' + alt,
    'Content-Type: multipart/related; boundary="' + related + '"',
    '',
    '--' + related,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encoded(rendered.html),
    '--' + related,
    'Content-Type: image/png',
    'Content-ID: <' + digest + '>',
    'Content-Disposition: inline; filename="sample.png"',
    'Content-Transfer-Encoding: base64',
    '',
    encoded(bytes),
    '--' + related + '--',
    '--' + alt + '--',
    '',
  ];
  process.stdout.write(lines.join('\r\n'));
}
