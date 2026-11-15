import { useEffect, useState, type ReactNode } from 'react';
import type { StudioLeaf, StudioRun } from '../../shared/studio.js';
import type { AssetSummary } from '../../shared/contracts.js';
import type { Api } from '../api.js';

export function BrandImage({
  assetId,
  name,
  alt,
  api,
}: {
  assetId: string;
  name?: string;
  alt: string;
  api: Api;
}) {
  const [result, setResult] = useState<{ id: string; url?: string } | null>(null);
  useEffect(() => {
    if (!name) return;
    let active = true,
      url: string | undefined;
    api
      .asset(assetId)
      .then((value) => {
        if (active) {
          url = value;
          setResult({ id: assetId, url: value });
        } else URL.revokeObjectURL(value);
      })
      .catch(() => {
        if (active) setResult({ id: assetId });
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, assetId, name]);
  if (!name || (result?.id === assetId && !result.url))
    return <span className="studio-image-state">The selected brand image is unavailable.</span>;
  if (result?.id !== assetId) return <span className="studio-image-state">Loading {name}…</span>;
  return (
    <figure className="studio-photo">
      <img src={result.url} alt={alt} />
      <figcaption>{name}</figcaption>
    </figure>
  );
}

function previewRuns(runs: StudioRun[]) {
  return runs.map((run, index) => {
    let content: ReactNode = run.text;
    if (run.bold) content = <strong>{content}</strong>;
    if (run.italic) content = <em>{content}</em>;
    return (
      <span key={index} className={run.href ? 'studio-link-preview' : undefined}>
        {content}
      </span>
    );
  });
}

export function BlockPreview({
  block,
  assets,
  api,
}: {
  block: StudioLeaf;
  assets: AssetSummary[];
  api: Api;
}) {
  if (block.type === 'heading' || block.type === 'paragraph') {
    const Element = block.type === 'heading' ? (['h1', 'h2', 'h3'] as const)[block.level - 1]! : 'p';
    return (
      <Element className="studio-sample-text">
        {block.runs.length ? (
          previewRuns(block.runs)
        ) : (
          <span className="studio-placeholder">
            {block.type === 'heading' ? 'Write a heading' : 'Write a paragraph'}
          </span>
        )}
      </Element>
    );
  }
  switch (block.type) {
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul';
      return (
        <List>
          {block.items.map((runs, i) => (
            <li key={i}>{previewRuns(runs)}</li>
          ))}
        </List>
      );
    }
    case 'callout':
      return (
        <aside className="studio-callout">
          {block.icon && <span>{block.icon} </span>}
          {previewRuns(block.runs)}
        </aside>
      );
    case 'button':
      return <span className="studio-button-preview">{block.label || 'Button text'}</span>;
    case 'image':
      return (
        <BrandImage
          assetId={block.assetId}
          alt={block.alt}
          name={assets.find((a) => a.id === block.assetId)?.name}
          api={api}
        />
      );
    case 'divider':
      return <hr className="studio-divider" />;
    case 'spacer':
      return <div className={'studio-space studio-space-' + block.size} aria-label={block.size + ' space'} />;
  }
}
