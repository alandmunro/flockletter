import { expect, it } from 'vitest';
import { emptyContent, type Campaign } from '../src/shared/contracts.js';
import type { StudioDocument } from '../src/shared/studio.js';
import { renderStudio } from '../src/server/studio-render.js';

it('renders the same original at the available width of each image placement', () => {
  const assetId = '8f14e45f-ceea-467d-a9f3-b2c8a1d0e5b7';
  const source = 'cid:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const doc: StudioDocument = {
    version: 1,
    blocks: [
      { type: 'image', assetId, alt: 'Root image' },
      {
        type: 'columns',
        columns: [
          [{ type: 'image', assetId, alt: 'Left image' }],
          [{ type: 'image', assetId, alt: 'Right image' }],
        ],
      },
    ],
  };
  const campaign: Campaign = {
    id: '32b94bd4-5ea2-4ace-9cb8-138b96d729df',
    brandId: '0a42d824-4765-45fd-856e-388648ddfb30',
    status: 'draft',
    version: 1,
    createdAt: '2026-11-07T00:00:00Z',
    updatedAt: '2026-11-07T00:00:00Z',
    content: emptyContent(),
  };

  const { html } = renderStudio(campaign, doc, new Map([[assetId, { src: source, name: 'fixture.png' }]]));
  const tags = html.match(/<img\b[^>]*>/g) ?? [];
  const attributes = (name: string) => tags.map((tag) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]);
  expect(attributes('width')).toEqual(['552', '268', '268']);
  expect(attributes('src')).toEqual([source, source, source]);
  expect(attributes('alt')).toEqual(['Root image', 'Left image', 'Right image']);
});
