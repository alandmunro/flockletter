import { useEffect, useState } from 'react';
import { validateStudioLink, type StudioLeaf } from '../../shared/studio.js';
import type { AssetSummary } from '../../shared/contracts.js';
import type { Api } from '../api.js';
import { BrandImage } from './BlockPreview.js';
import { InlineEditor } from './InlineEditor.js';

type Props = {
  block: StudioLeaf;
  assets: AssetSummary[];
  api: Api;
  disabled: boolean;
  onChange: (block: StudioLeaf) => boolean;
  onIssue: (message: string) => void;
};
function ButtonFields({
  value,
  disabled,
  onChange,
  onIssue,
}: {
  value: Extract<StudioLeaf, { type: 'button' }>;
  disabled: boolean;
  onChange: Props['onChange'];
  onIssue: Props['onIssue'];
}) {
  const [label, setLabel] = useState(value.label),
    [href, setHref] = useState(value.href);
  useEffect(() => {
    setLabel(value.label);
    setHref(value.href);
  }, [value.label, value.href]);
  function change(nextLabel: string, nextHref: string) {
    setLabel(nextLabel);
    setHref(nextHref);
    if (nextHref && !validateStudioLink(nextHref)) {
      onIssue('Enter a public HTTPS button link, or clear the link to continue editing.');
      return;
    }
    onChange({ type: 'button', label: nextLabel, href: nextHref });
  }
  return (
    <div className="studio-field-pair">
      <label>
        Button label
        <input
          disabled={disabled}
          maxLength={120}
          value={label}
          onChange={(e) => change(e.target.value, href)}
        />
      </label>
      <label>
        Button link
        <input
          disabled={disabled}
          type="url"
          maxLength={2048}
          value={href}
          placeholder="https://"
          onChange={(e) => change(label, e.target.value)}
        />
      </label>
    </div>
  );
}
export function BlockInspector({ block, assets, api, disabled, onChange, onIssue }: Props) {
  const [itemGeneration, resetItemEditors] = useState(0);
  switch (block.type) {
    case 'callout':
    case 'paragraph':
    case 'heading':
      return (
        <>
          {block.type === 'callout' && (
            <label>
              Callout icon (optional)
              <input
                value={block.icon ?? ''}
                maxLength={32}
                disabled={disabled}
                onChange={(e) => onChange({ ...block, icon: e.target.value || undefined })}
              />
            </label>
          )}
          {block.type === 'heading' && (
            <label className="studio-select">
              Heading level
              <select
                aria-label="Heading level"
                disabled={disabled}
                value={block.level}
                onChange={(e) => onChange({ ...block, level: Number(e.target.value) as 1 | 2 | 3 })}
              >
                <option value="1">Heading 1</option>
                <option value="2">Heading 2</option>
                <option value="3">Heading 3</option>
              </select>
            </label>
          )}
          <InlineEditor
            runs={block.runs}
            label={
              { paragraph: 'Paragraph text', heading: 'Heading text', callout: 'Callout text' }[block.type]
            }
            disabled={disabled}
            onIssue={onIssue}
            onRuns={(runs) => onChange({ ...block, runs })}
          />
        </>
      );
    case 'list': {
      const list = block;
      const List = list.ordered ? 'ol' : 'ul';
      return (
        <>
          <label className="studio-select">
            List type
            <select
              aria-label="List type"
              disabled={disabled}
              value={list.ordered ? 'ordered' : 'unordered'}
              onChange={(e) => onChange({ ...list, ordered: e.target.value === 'ordered' })}
            >
              <option value="unordered">Bulleted</option>
              <option value="ordered">Numbered</option>
            </select>
          </label>
          <List className="studio-list-items">
            {list.items.map((runs, i) => (
              <li key={itemGeneration + '-' + i} className="studio-list-item">
                <InlineEditor
                  runs={runs}
                  label={`List item ${i + 1}`}
                  disabled={disabled}
                  onIssue={onIssue}
                  onRuns={(next) => {
                    const items = list.items.slice();
                    items[i] = next;
                    return onChange({ ...list, items });
                  }}
                />
                <button
                  type="button"
                  className="btn secondary studio-remove-item"
                  aria-label={`Remove list item ${i + 1}`}
                  disabled={disabled || list.items.length <= 1}
                  onClick={() => {
                    const items = list.items.filter((_, j) => j !== i);
                    if (onChange({ ...list, items })) resetItemEditors((generation) => generation + 1);
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </List>
          <button
            type="button"
            className="btn secondary"
            disabled={disabled || list.items.length >= 60}
            onClick={() => onChange({ ...list, items: [...list.items, []] })}
          >
            Add item
          </button>
        </>
      );
    }

    case 'button':
      return <ButtonFields value={block} disabled={disabled} onChange={onChange} onIssue={onIssue} />;
    case 'image':
      return (
        <>
          <BrandImage
            api={api}
            assetId={block.assetId}
            name={assets.find((a) => a.id === block.assetId)?.name}
            alt={block.alt}
          />
          <div className="studio-field-pair">
            <label>
              Brand image
              <select
                aria-label="Brand image"
                disabled={disabled}
                value={block.assetId}
                onChange={(e) => onChange({ ...block, assetId: e.target.value, alt: '' })}
              >
                {!assets.some((a) => a.id === block.assetId) && (
                  <option value={block.assetId}>Selected image unavailable</option>
                )}
                {assets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Image description
              <input
                disabled={disabled}
                type="text"
                maxLength={300}
                value={block.alt}
                onChange={(e) => onChange({ ...block, alt: e.target.value })}
              />
            </label>
          </div>
        </>
      );
    case 'spacer':
      return (
        <label className="studio-select">
          Space height
          <select
            aria-label="Space height"
            disabled={disabled}
            value={block.size}
            onChange={(e) => onChange({ ...block, size: e.target.value as typeof block.size })}
          >
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </label>
      );
    case 'divider':
      return <hr className="studio-divider" />;
  }
}
