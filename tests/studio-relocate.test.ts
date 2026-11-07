import { describe, it, expect } from 'vitest';
import type { StudioDocument, StudioLeaf } from '../src/shared/studio.js';
import { listAt, relocateLeaf } from '../src/client/studio/blocks.js';

describe('visual block relocation', () => {
  it('moves an original photo from before its layout into either column and back to the main body', () => {
    const photo: StudioLeaf = {
      type: 'image',
      assetId: '0c3c83cf-60a4-4948-8c5b-22b000837af9',
      alt: 'Alpine shirt',
    };
    const story: StudioLeaf = {
      type: 'paragraph',
      runs: [{ text: 'Original text', bold: true, href: 'https://example.org/' }],
    };
    const original: StudioDocument = {
      version: 1,
      blocks: [photo, { type: 'columns', columns: [[story], []] }],
    };
    const first = relocateLeaf(original, { column: null, index: 0 }, { parent: 1, column: 1 });
    expect(first.position).toEqual({ column: { parent: 0, column: 1 }, index: 0 });
    expect(listAt(first.document, { parent: 0, column: 1 })[0]).toBe(photo);
    expect(listAt(first.document, { parent: 0, column: 0 })).toEqual([story]);
    expect(original.blocks[0]).toBe(photo);
    const second = relocateLeaf(first.document, first.position, { parent: 0, column: 0 });
    expect(listAt(second.document, { parent: 0, column: 0 })).toEqual([story, photo]);
    expect(listAt(second.document, { parent: 0, column: 1 })).toEqual([]);
    const body = relocateLeaf(second.document, second.position, null);
    expect(body.document.blocks).toEqual([{ type: 'columns', columns: [[story], []] }, photo]);
  });
  it('does not move a layout into another layout', () => {
    const doc: StudioDocument = { version: 1, blocks: [{ type: 'columns', columns: [[], []] }] };
    expect(() => relocateLeaf(doc, { column: null, index: 0 }, { parent: 0, column: 1 })).toThrow(/single/);
    expect(doc.blocks).toEqual([{ type: 'columns', columns: [[], []] }]);
  });
});
