import { useState } from 'react';
import type { StudioDocument } from '../../shared/studio.js';
import type { ColumnAddress, Position } from './blocks.js';

export function MoveBlock({
  document,
  position,
  disabled,
  onMove,
}: {
  document: StudioDocument;
  position: Position;
  disabled: boolean;
  onMove: (target: ColumnAddress | null) => void;
}) {
  const [choice, setChoice] = useState('');
  const destinations: { key: string; label: string; address: ColumnAddress | null }[] = [];
  if (position.column) destinations.push({ key: 'body', label: 'Main newsletter', address: null });
  document.blocks.forEach((block, parent) => {
    if (block.type === 'columns')
      ([0, 1] as const).forEach((column) => {
        if (parent === position.column?.parent && column === position.column.column) return;
        if (block.columns[column].length < 30)
          destinations.push({
            key: parent + '-' + column,
            label: `Block ${parent + 1}, column ${column + 1}`,
            address: { parent, column },
          });
      });
  });
  if (!destinations.length) return null;
  const selected = destinations.find((item) => item.key === choice);
  return (
    <details className="studio-relocate">
      <summary>Move to another area</summary>
      <div>
        <label>
          Move block to
          <select
            aria-label="Move block to"
            disabled={disabled}
            value={selected?.key ?? ''}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value="">Choose a location</option>
            {destinations.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn secondary"
          disabled={disabled || !selected}
          onClick={() => selected && onMove(selected.address)}
        >
          Move block
        </button>
      </div>
    </details>
  );
}
