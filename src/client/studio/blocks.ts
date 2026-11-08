import type { StudioBlock, StudioDocument, StudioLeaf } from '../../shared/studio.js';
import type { PaletteKind } from './BlockPalette.js';

export type ColumnAddress = { parent: number; column: 0 | 1 };
export type Position = { column: ColumnAddress | null; index: number };
export const positionKey = ({ column, index }: Position) =>
  column ? `column-${column.parent}-${column.column}-${index}` : `block-${index}`;

export function listAt(document: StudioDocument, column: ColumnAddress | null): StudioBlock[] {
  if (!column) return document.blocks;
  const parent = document.blocks[column.parent];
  if (parent?.type !== 'columns') throw Error('This column has changed. Reopen its block.');
  return parent.columns[column.column];
}

export function replaceList(
  document: StudioDocument,
  column: ColumnAddress | null,
  list: StudioBlock[],
): StudioDocument {
  if (!column) return { ...document, blocks: list };
  const parent = document.blocks[column.parent];
  if (parent?.type !== 'columns' || list.some((item) => item.type === 'columns'))
    throw Error('Each column holds individual content blocks.');
  const columns: [StudioLeaf[], StudioLeaf[]] = [...parent.columns];
  columns[column.column] = list as StudioLeaf[];
  return {
    ...document,
    blocks: document.blocks.map((block, index) => (index === column.parent ? { ...parent, columns } : block)),
  };
}

export function relocateLeaf(document: StudioDocument, source: Position, target: ColumnAddress | null) {
  const from = listAt(document, source.column),
    leaf = from[source.index];
  if (!leaf || leaf.type === 'columns') throw Error('Select a single content block to move.');
  const removed = replaceList(
    document,
    source.column,
    from.filter((_, i) => i !== source.index),
  );
  // Removing a body block can shift the target column layout one position earlier.
  const destination =
    !source.column && target && source.index < target.parent
      ? { ...target, parent: target.parent - 1 }
      : target;
  const to = listAt(removed, destination);
  return {
    document: replaceList(removed, destination, [...to, leaf]),
    position: { column: destination, index: to.length },
  };
}

export function makeBlock(kind: PaletteKind, image?: { id: string; name: string }): StudioBlock {
  switch (kind) {
    case 'paragraph':
      return { type: kind, runs: [] };
    case 'heading':
      return { type: kind, level: 2, runs: [] };
    case 'button':
      return { type: kind, label: '', href: '' };
    case 'image':
      if (!image) throw Error('Add an image to the brand library first.');
      return { type: kind, assetId: image.id, alt: '' };
    case 'divider':
      return { type: kind };
    case 'spacer':
      return { type: kind, size: 'medium' };
    case 'columns':
      return { type: kind, columns: [[], []] };
  }
}
