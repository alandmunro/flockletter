import { useLayoutEffect, useRef, useState } from 'react';
import type { AssetSummary } from '../../shared/contracts.js';
import {
  studioLeaves,
  studioProblem,
  type StudioBlock,
  type StudioDocument,
  type StudioLeaf,
} from '../../shared/studio.js';
import type { Api } from '../api.js';
import { BlockPalette, type PaletteKind } from './BlockPalette.js';
import { BlockInspector } from './BlockInspector.js';
import { BlockPreview } from './BlockPreview.js';
import {
  listAt,
  makeBlock,
  positionKey,
  relocateLeaf,
  replaceList,
  type ColumnAddress,
  type Position,
} from './blocks.js';
import { MoveBlock } from './MoveBlock.js';
import './studio.css';

type Props = {
  document: StudioDocument;
  assets: AssetSummary[];
  api: Api;
  disabled: boolean;
  onChange: (next: StudioDocument) => void;
  onValidity: (message: string) => void;
};
const title: Record<StudioBlock['type'], string> = {
  paragraph: 'Paragraph',
  heading: 'Heading',
  button: 'Button',
  image: 'Image',
  spacer: 'Spacer',
  divider: 'Divider',
  columns: 'Two columns',
};

export default function StudioCanvas({ document, assets, api, disabled, onChange, onValidity }: Props) {
  const [selection, setSelection] = useState<Position | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [issue, setIssue] = useState('');
  const [generation, remount] = useState(0);
  const canvas = useRef<HTMLElement>(null);
  const focusAfterChange = useRef<string | null>(null);
  const incomingProblem = studioProblem(document);
  useLayoutEffect(() => {
    onValidity(incomingProblem || issue);
  }, [incomingProblem, issue, onValidity]);
  useLayoutEffect(() => {
    const key = focusAfterChange.current;
    if (key === null) return;
    const target = key
      ? `[data-studio-position="${key}"] > .studio-block-bar .studio-select-block`
      : '.studio-insert button:not(:disabled)';
    canvas.current?.querySelector<HTMLButtonElement>(target)?.focus();
    focusAfterChange.current = null;
  }, [generation]);
  function report(message: string) {
    setIssue(message);
    onValidity(incomingProblem || message);
  }
  const locked = disabled || Boolean(issue);
  function accept(next: StudioDocument): boolean {
    if (disabled) return false;
    const problem = studioProblem(next);
    if (problem) {
      report(problem);
      return false;
    }
    report('');
    onChange(next);
    return true;
  }
  function select(position: Position) {
    if (locked) return;
    setSelection(position);
    setRemoving(null);
  }
  function acceptStructure(nextDocument: StudioDocument, next: Position | null) {
    if (locked || !accept(nextDocument)) return;
    focusAfterChange.current = next ? positionKey(next) : '';
    setSelection(next);
    setRemoving(null);
    remount((x) => x + 1);
  }
  function structure(column: ColumnAddress | null, list: StudioBlock[], next: Position | null) {
    acceptStructure(replaceList(document, column, list), next);
  }
  function add(column: ColumnAddress | null, kind: PaletteKind) {
    const list = listAt(document, column);
    if (column && kind === 'columns') return;
    const block = makeBlock(kind, assets[0]);
    structure(column, [...list, block], { column, index: list.length });
  }
  function move(position: Position, direction: -1 | 1) {
    const list = [...listAt(document, position.column)],
      index = position.index + direction;
    if (index < 0 || index >= list.length) return;
    const item = list[position.index]!;
    list[position.index] = list[index]!;
    list[index] = item;
    structure(position.column, list, { ...position, index });
  }
  function remove(position: Position) {
    const list = listAt(document, position.column).filter((_, i) => i !== position.index);
    structure(
      position.column,
      list,
      list.length ? { ...position, index: Math.min(position.index, list.length - 1) } : null,
    );
  }
  function change(position: Position, block: StudioLeaf) {
    const list = listAt(document, position.column).map((item, i) => (i === position.index ? block : item));
    return accept(replaceList(document, position.column, list));
  }
  function restore() {
    report('');
    remount((x) => x + 1);
  }
  if (incomingProblem)
    return (
      <section className="studio" aria-label="Newsletter Studio">
        <h2>Email content</h2>
        <p role="alert" className="studio-error">
          {incomingProblem}
        </p>
      </section>
    );

  const used = studioLeaves(document);
  const count = used.length + document.blocks.filter((b) => b.type === 'columns').length;
  const imageLimit = used.filter((b) => b.type === 'image').length >= 6;
  function listView(column: ColumnAddress | null) {
    const blocks = listAt(document, column);
    return (
      <div className="studio-list">
        {blocks.map((block, index) => {
          const position = { column, index },
            key = positionKey(position),
            active = selection && positionKey(selection) === key;
          return (
            <article
              key={key}
              data-studio-position={key}
              aria-label={title[block.type] + ' block ' + (index + 1)}
              className={'studio-block' + (active ? ' studio-block-active' : '')}
            >
              <div className="studio-block-bar">
                <button
                  className="studio-select-block"
                  type="button"
                  aria-label={'Edit ' + block.type + ' block'}
                  aria-pressed={!!active}
                  disabled={locked}
                  onClick={() => select(position)}
                >
                  <span className="studio-kind">{title[block.type]}</span>
                </button>
                {active && (
                  <div className="studio-move">
                    <button
                      type="button"
                      aria-label="Move block up"
                      title="Move up"
                      disabled={locked || index === 0}
                      onClick={() => move(position, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label="Move block down"
                      title="Move down"
                      disabled={locked || index === blocks.length - 1}
                      onClick={() => move(position, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label="Remove block"
                      disabled={locked}
                      onClick={() => setRemoving(key)}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
              {active && removing === key && (
                <div className="studio-confirm" role="group" aria-label="Confirm block removal">
                  <span>
                    {block.type === 'columns'
                      ? 'Remove both columns and their content?'
                      : 'Remove this block?'}
                  </span>
                  <button
                    className="btn danger"
                    disabled={locked}
                    type="button"
                    onClick={() => remove(position)}
                  >
                    Confirm removal
                  </button>
                  <button
                    className="btn secondary"
                    disabled={locked}
                    type="button"
                    onClick={() => setRemoving(null)}
                  >
                    Keep block
                  </button>
                </div>
              )}
              {block.type === 'columns' ? (
                <div className="studio-cols">
                  {([0, 1] as const).map((i) => (
                    <section aria-label={'Column ' + (i + 1)} key={i}>
                      <h3>Column {i + 1}</h3>
                      {listView({ parent: index, column: i })}
                    </section>
                  ))}
                </div>
              ) : (
                <div className={'studio-block-content' + (active ? '' : ' studio-clickable')}>
                  {active ? (
                    <BlockInspector
                      key={key + '-' + generation}
                      block={block}
                      assets={assets}
                      api={api}
                      disabled={disabled}
                      onChange={(next) => change(position, next)}
                      onIssue={report}
                    />
                  ) : (
                    <>
                      <BlockPreview block={block} assets={assets} api={api} />
                      <button
                        type="button"
                        tabIndex={-1}
                        className="studio-preview-hit"
                        aria-label={'Edit ' + block.type + ' content'}
                        disabled={locked}
                        onClick={() => select(position)}
                      />
                    </>
                  )}
                </div>
              )}
              {active && block.type !== 'columns' && (
                <MoveBlock
                  key={key + '-move-' + generation}
                  document={document}
                  position={position}
                  disabled={locked}
                  onMove={(target) => {
                    const moved = relocateLeaf(document, position, target);
                    acceptStructure(moved.document, moved.position);
                  }}
                />
              )}
            </article>
          );
        })}
        {!blocks.length && (
          <p className="studio-empty">
            {column ? 'Add the first block to this column.' : 'Add a block to start your newsletter.'}
          </p>
        )}
        <div className="studio-insert">
          <span>Add a block</span>
          <BlockPalette
            allowColumns={!column}
            hasImages={!!assets.length}
            atImageLimit={imageLimit}
            disabled={locked || count >= 60 || Boolean(column && blocks.length >= 30)}
            onAdd={(kind) => add(column, kind)}
          />
        </div>
      </div>
    );
  }
  return (
    <section ref={canvas} className="studio" aria-label="Newsletter Studio">
      <header className="studio-heading">
        <h2>Email content</h2>
        <span>
          {count} {count === 1 ? 'block' : 'blocks'}
        </span>
      </header>
      {issue && (
        <div className="studio-warning">
          <p role="alert">{issue}</p>
          <button type="button" className="btn secondary" disabled={disabled} onClick={restore}>
            Restore last valid block
          </button>
        </div>
      )}
      <div className="studio-sheet">{listView(null)}</div>
      {imageLimit && (
        <p className="studio-note">The newsletter contains all six available image placements.</p>
      )}
      {!assets.length && (
        <p className="studio-note">Add a photo to this brand’s image library to use it here.</p>
      )}
    </section>
  );
}
