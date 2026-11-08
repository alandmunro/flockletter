import { describe, expect, it } from 'vitest';
import { makeBlock, replaceList } from '../src/client/studio/blocks.js';
import type { StudioDocument } from '../src/shared/studio.js';

const assetId = '0f8e5a7c-6b4d-4e1a-9c2f-3d5e7f8a9b0c';

const paragraph = (text: string) => ({ type: 'paragraph' as const, runs: [{ text }] });

const fixture = (): StudioDocument => ({
  version: 1,
  blocks: [{ type: 'columns', columns: [[paragraph('First column')], [paragraph('Second column')]] }],
});

describe('client studio block operations', () => {
  it('replaces items in the second column while preserving the first column and input', () => {
    const original = fixture();
    const before = structuredClone(original);

    const replacement = [
      { type: 'heading' as const, level: 2 as const, runs: [{ text: 'Replaced heading' }] },
      { type: 'divider' as const },
    ];

    const next = replaceList(original, { parent: 0, column: 1 }, replacement);

    expect(next).not.toBe(original);
    expect(next.blocks[0]).toEqual({ type: 'columns', columns: [[paragraph('First column')], replacement] });

    expect(original).toEqual(before);
  });

  it('fails when nesting a columns block and leaves the original unchanged', () => {
    const original = fixture();
    const before = structuredClone(original);

    expect(() =>
      replaceList(original, { parent: 0, column: 1 }, [{ type: 'columns' as const, columns: [[], []] }]),
    ).toThrow('Each column holds individual content blocks.');

    expect(original).toEqual(before);
  });

  it('requires an asset for image blocks and preserves the supplied id with empty alt', () => {
    expect(() => makeBlock('image')).toThrow('Add an image to the brand library first.');

    const block = makeBlock('image', { id: assetId, name: 'Fictional asset' });
    expect(block).toEqual({ type: 'image', assetId, alt: '' });
  });
});
