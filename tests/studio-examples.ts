import type { StudioDocument } from '../src/shared/studio.js';

export const productUrl = 'https://retailer.example.com/products/field-tee';

export function sampleStudio(photoId: string): StudioDocument {
  return {
    version: 1,
    blocks: [
      {
        type: 'heading',
        level: 2,
        runs: [
          { text: 'Field Notes <script>never()</script>', bold: true },
          { text: ' See the new drop', italic: true, href: productUrl },
        ],
      },
      { type: 'paragraph', runs: [{ text: 'A new layer for the trail.' }] },
      { type: 'image', assetId: photoId, alt: 'Field tee' },
      { type: 'spacer', size: 'medium' },
      { type: 'divider' },
      { type: 'button', label: 'View product', href: productUrl },
      {
        type: 'columns',
        columns: [
          [{ type: 'paragraph', runs: [{ text: 'Left label' }] }],
          [{ type: 'paragraph', runs: [{ text: 'Right label' }] }],
        ],
      },
    ],
  };
}

// Each document retains all the otherwise valid blocks. Only the indicated feature is invalid.
export function malformedStudio(original: StudioDocument): { name: string; document: unknown }[] {
  const insert = (block: unknown) => ({ ...original, blocks: [...original.blocks, block] });
  const photo = original.blocks.find((b) => b.type === 'image');
  if (!photo) throw Error('Studio fixture needs an image.');
  return [
    {
      name: 'unknown root block mixed with otherwise good text',
      document: insert({ type: 'unknown', runs: [{ text: 'good' }] }),
    },
    { name: 'future document version', document: { ...original, version: 2 } },
    {
      name: 'nested unknown child',
      document: insert({
        type: 'columns',
        columns: [[{ type: 'paragraph', runs: [{ text: 'good' }] }], [{ type: 'unknown' }]],
      }),
    },
    {
      name: 'unsafe javascript link in a run',
      document: insert({ type: 'paragraph', runs: [{ text: 'Click', href: 'javascript:alert(1)' }] }),
    },
    {
      name: 'foreign remote image src',
      document: insert({ ...photo, src: 'https://evil.example.com/image.png' }),
    },
    {
      name: 'unsupported heading level',
      document: insert({ type: 'heading', level: 4, runs: [{ text: 'bad' }] }),
    },
  ];
}
