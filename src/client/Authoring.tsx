import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { limits, type AssetSummary, type Brand, type Campaign } from '../shared/contracts.js';
import { type TemplateId, type TemplateSummary } from '../shared/authoring.js';
import { operationKey, type Api } from './api.js';
import { TemplatePicker } from './TemplatePicker.js';
import './authoring.css';

type Props = { api: Api; brands: Brand[]; open: (campaign: Campaign) => void };
const explain = (error: unknown) =>
  error instanceof Error ? error.message : 'The draft could not be prepared. Please retry.';

export function Authoring({ api, brands, open }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [brandId, setBrandId] = useState(brands[0]?.id ?? '');
  const brand = brands.find((item) => item.id === brandId);
  const control = useId();
  return (
    <details className="card authoring" onToggle={(e) => setExpanded(e.currentTarget.open)}>
      <summary>Start with a template or product</summary>
      {expanded && brand && (
        <>
          {brands.length > 1 && (
            <div className="field">
              <label htmlFor={control}>Sending brand</label>
              <select id={control} value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                {brands.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <DraftComposer key={brandId} api={api} brand={brand} open={open} />
        </>
      )}
    </details>
  );
}

function DraftComposer({ api, brand, open }: { api: Api; brand: Brand; open: Props['open'] }) {
  const [mode, setMode] = useState<'template' | 'product'>('template');
  const [template, setTemplate] = useState<TemplateId>('announcement');
  const [catalog, setCatalog] = useState<TemplateSummary[]>([]);
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [assetIds, setIds] = useState<string[]>([]);
  const [productName, setName] = useState('');
  const [productUrl, setUrl] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const id = useId();
  const last = useRef<{ payload: string; key: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setLoadError('');
    setLoading(true);
    async function load() {
      if (mode === 'template') {
        const list = await api.call<TemplateSummary[]>('template.list', {});
        if (current) setCatalog(list);
      } else {
        const list = await api.call<AssetSummary[]>('asset.list', { brandId: brand.id });
        if (current) setAssets(list);
      }
    }
    load()
      .catch((e) => {
        if (current) setLoadError(explain(e));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, brand.id, mode, retry]);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || loading || loadError) return;
    setBusy(true);
    setError('');
    const name = mode === 'template' ? 'campaign.fromTemplate' : 'campaign.fromProduct';
    const data =
      mode === 'template'
        ? { brandId: brand.id, templateId: template }
        : { brandId: brand.id, productName, productUrl, excerpt, assetIds };
    const payload = JSON.stringify([name, data]);
    if (last.current?.payload !== payload) last.current = { payload, key: operationKey() };
    try {
      const draft = await api.call<Campaign>(name, { ...data, operationKey: last.current.key });
      if (mounted.current) open(draft);
    } catch (e) {
      if (mounted.current) setError(explain(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void create(event)}>
      <fieldset disabled={busy}>
        <div className="field">
          <label htmlFor={id + '-type'}>Draft source</label>
          <select
            id={id + '-type'}
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as typeof mode);
              setLoading(true);
              setLoadError('');
              setError('');
            }}
          >
            <option value="template">Newsletter template</option>
            <option value="product">Published product</option>
          </select>
        </div>
        {mode === 'product' && (
          <>
            <div className="field">
              <label htmlFor={id + '-name'}>Product name</label>
              <input
                id={id + '-name'}
                value={productName}
                maxLength={100}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={id + '-link'}>Published product URL</label>
              <input
                id={id + '-link'}
                type="url"
                value={productUrl}
                maxLength={2048}
                required
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={id + '-excerpt'}>Approved product description</label>
              <textarea
                id={id + '-excerpt'}
                rows={3}
                value={excerpt}
                maxLength={2000}
                required
                onChange={(e) => setExcerpt(e.target.value)}
              />
            </div>
          </>
        )}
        {loading ? (
          <p role="status">{mode === 'template' ? 'Loading templates…' : 'Loading brand photos…'}</p>
        ) : loadError ? (
          <div role="alert">
            {loadError}{' '}
            <button type="button" className="btn secondary" onClick={() => setRetry((value) => value + 1)}>
              Retry
            </button>
          </div>
        ) : mode === 'template' ? (
          <TemplatePicker templates={catalog} selected={template} onChange={setTemplate} />
        ) : (
          <fieldset className="field">
            <legend>Brand photos</legend>
            <p className="help">
              {assets.length
                ? 'Photos appear in the order you select them.'
                : 'This brand has no uploaded photos. You can add photos in Image library.'}
            </p>
            {assets.map((asset) => (
              <label key={asset.id} className="asset-option">
                <input
                  type="checkbox"
                  checked={assetIds.includes(asset.id)}
                  disabled={!assetIds.includes(asset.id) && assetIds.length >= limits.campaignImages}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setIds((ids) => (checked ? [...ids, asset.id] : ids.filter((id) => id !== asset.id)));
                  }}
                />
                {asset.name}
              </label>
            ))}
          </fieldset>
        )}
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        <button
          className="btn"
          type="submit"
          disabled={loading || Boolean(loadError) || (mode === 'template' && !catalog.length)}
        >
          {busy ? 'Creating…' : mode === 'template' ? 'Use this template' : 'Create product draft'}
        </button>
      </fieldset>
    </form>
  );
}
