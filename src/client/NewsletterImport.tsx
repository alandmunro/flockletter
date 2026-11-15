import { useEffect, useMemo, useRef, useState } from 'react';
import { convertNewsletter, newsletterSourceBytes } from '../shared/newsletter-import.js';
import { readNewsletterPackage, newsletterArchiveBytes } from '../shared/newsletter-package.js';
import {
  limits,
  type AssetSummary,
  type Brand,
  type Campaign,
  type CampaignContent,
} from '../shared/contracts.js';
import type { CustomerSenderProfile } from '../shared/customer-delivery.js';
import type { StudioBlock } from '../shared/studio.js';
import { base64, operationKey, type Api } from './api.js';
import { BlockPreview, BrandImage } from './studio/BlockPreview.js';
import { useBrandImages } from './useBrandImages.js';
import './newsletter-import.css';

type Format = 'markdown' | 'html';
type Converted = ReturnType<typeof convertNewsletter>;
type Photo = Extract<Converted['blocks'][number], { type: 'photo' }>;
type LocalPhoto = { file: File; path: string; key: string; asset?: AssetSummary; notice?: string };
type Props = {
  api: Api;
  brand: Brand;
  drafts: Campaign[];
  open: (campaign: Campaign) => void;
  cancel: () => void;
};
type Reviewed = { digest: string; content: CampaignContent };
type UploadResult = {
  itemKey: string;
  ok: boolean;
  asset?: AssetSummary;
  notice?: string;
  error?: { message: string };
};
const explain = (e: unknown) => (e instanceof Error ? e.message : 'The newsletter could not be imported.');
const removePhoto = 'remove';
const localChoice = (photo: LocalPhoto) => 'file:' + photo.key;
const photoAccept = '.jpg,.jpeg,.png,.gif,.webp,.svg';
const uploadTypes = /\.(?:jpe?g|png|gif|webp|svg)$/i;

function matchPhoto(ref: string, files: LocalPhoto[]) {
  const normalized = ref.replace(/^\.\//, '');
  const exact = files.filter((f) => f.path === normalized);
  if (exact.length === 1) return localChoice(exact[0]!);
  if (/^[a-z][a-z0-9+.-]*:|^\/|(?:^|\/)\.\.(?:\/|$)/i.test(normalized)) return '';
  const matches = files.filter((f) => !f.path.includes('/') && f.path === normalized.split('/').pop());
  return matches.length === 1 ? localChoice(matches[0]!) : '';
}

function SectionPreview({ block, assets, api }: { block: StudioBlock; assets: AssetSummary[]; api: Api }) {
  return block.type === 'columns' ? (
    <div className="import-columns">
      {block.columns.map((col, i) => (
        <div key={i}>
          {col.map((item, j) => (
            <BlockPreview key={j} block={item} assets={assets} api={api} />
          ))}
        </div>
      ))}
    </div>
  ) : (
    <BlockPreview block={block} assets={assets} api={api} />
  );
}

const thumbnailExtensions = new Set(['png', 'jpeg', 'jpg', 'gif', 'webp']);
function LocalThumbnail({ file, alt }: { file: File; alt: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!extension || !thumbnailExtensions.has(extension)) {
      setUrl('');
      return;
    }
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return url ? <img className="import-thumb" src={url} alt={alt} /> : null;
}

export function NewsletterImport({ api, brand, drafts, open, cancel }: Props) {
  const [source, setSource] = useState(''),
    [format, setFormat] = useState<Format>('markdown');
  const [stage, setStage] = useState<'source' | 'map' | 'review'>('source');
  const [files, setFiles] = useState<LocalPhoto[]>([]),
    [choices, setChoices] = useState<Record<string, string>>({});
  const [buttons, setButtons] = useState<string[]>([]),
    [acceptMetadata, setAcceptMetadata] = useState(false);
  const [metadata, setMetadata] = useState({ title: '', subject: '', preheader: '' });
  const [sender, setSender] = useState<CustomerSenderProfile | null>(null),
    [useSender, setUseSender] = useState(false),
    [senderStatus, setSenderStatus] = useState('');
  const [replaceId, setReplaceId] = useState(''),
    [ack, setAck] = useState(false);
  const [review, setReview] = useState<Reviewed | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const library = useBrandImages(api, brand.id);
  const [uploaded, setUploaded] = useState<AssetSummary[]>([]);
  const assets = [
    ...library.assets,
    ...uploaded.filter((a) => !library.assets.some((old) => old.id === a.id)),
  ];
  const request = useRef(false),
    alive = useRef(true);
  const ledger = useRef(new Map<string, AssetSummary>());
  const uploadKeys = useRef(new Map<string, string>());
  const commit = useRef<{ input: Record<string, unknown>; operationKey: string } | null>(null);
  const priorCommit = useRef<{ digest: string; key: string } | null>(null);

  useEffect(() => {
    alive.current = true;
    let active = true;
    api
      .call<{ profile: CustomerSenderProfile | null }>('delivery.sender', { brandId: brand.id })
      .then(({ profile }) => {
        if (active) {
          setSender(profile);
          setSenderStatus(profile ? '' : 'No sender profile is configured for this brand.');
        }
      })
      .catch(() => {
        if (active)
          setSenderStatus(
            'The sender profile is unavailable. You can choose sender details later in Studio.',
          );
      });
    return () => {
      active = false;
      alive.current = false;
    };
  }, [api, brand.id]);

  const conversion = useMemo(() => {
    if (stage === 'source') return null;
    try {
      return { value: convertNewsletter({ source, format, acceptMetadata, buttonLinks: buttons }) };
    } catch (e) {
      return { error: explain(e) };
    }
  }, [source, format, acceptMetadata, buttons, stage]);
  const converted = conversion?.value;
  const photos = converted?.blocks.filter((b): b is Photo => b.type === 'photo') ?? [];
  const choice = (p: Photo) => choices[p.key] ?? matchPhoto(p.source, files);
  const unresolved = photos.filter((p) => !choice(p));
  const docDrafts = drafts.filter((d) => d.brandId === brand.id);
  const replacement = docDrafts.find((d) => d.id === replaceId);

  async function perform(action: () => Promise<void>) {
    if (request.current) return;
    request.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      if (alive.current) setError(explain(e));
    } finally {
      request.current = false;
      if (alive.current) setBusy(false);
    }
  }

  function resetReview() {
    setChoices({});
    setButtons([]);
    setAcceptMetadata(false);
    setMetadata({ title: '', subject: '', preheader: '' });
    setAck(false);
    setReview(null);
    setError('');
  }

  async function readDocument(file: File) {
    if (file.size > newsletterArchiveBytes) throw Error('Choose a newsletter package of 21 MiB or less.');
    const isZip = /\.zip$/i.test(file.name);
    if (!isZip && (!/\.(?:md|markdown|html?)$/i.test(file.name) || file.size > newsletterSourceBytes))
      throw Error('Choose a Markdown or HTML file up to 64 KiB, or a newsletter ZIP.');
    let text: string,
      kind: Format,
      local: LocalPhoto[] = [];
    if (isZip) {
      const pkg = await readNewsletterPackage(new Uint8Array(await file.arrayBuffer()));
      text = pkg.source;
      kind = pkg.format;
      local = pkg.photos.map((p) => ({
        file: new File([new Uint8Array(p.bytes)], p.path.split('/').pop()!),
        path: p.path,
        key: operationKey(),
      }));
    } else {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      kind = /\.html?$/i.test(file.name) ? 'html' : 'markdown';
    }
    if (!alive.current) return;
    setSource(text);
    setFormat(kind);
    if (isZip) setFiles(local);
    resetReview();
  }

  function addPhotos(selection: File[]) {
    if (!selection.length) return;
    if (
      selection.some((f) => !uploadTypes.test(f.name) || f.size > limits.fileBytes) ||
      selection.length + files.length > limits.batchFiles ||
      [...files.map((f) => f.file), ...selection].reduce((n, f) => n + f.size, 0) > limits.batchBytes
    ) {
      setError('Choose up to 10 JPEG, PNG, GIF, WebP or SVG photos, 5 MiB each and 20 MiB together.');
      return;
    }
    setFiles((prev) => [
      ...prev,
      ...selection.map((file) => ({ file, path: file.name, key: operationKey() })),
    ]);
    setError('');
  }
  function inspect() {
    const result = convertNewsletter({ source, format, acceptMetadata: false, buttonLinks: [] });
    setMetadata((m) => ({ ...m, title: m.title || result.suggestions.title || '' }));
    setButtons([]);
    setAcceptMetadata(false);
    setAck(false);
    setStage('map');
    setError('');
  }
  async function prepare() {
    if (!converted || unresolved.length || !metadata.title.trim())
      throw Error('Enter a draft title and choose or remove each photo.');
    const selected = files.filter(
      (f) => photos.some((p) => choice(p) === localChoice(f)) && !ledger.current.has(f.key),
    );
    if (selected.length) {
      const signature = JSON.stringify(selected.map((f) => f.key));
      const batchKey = uploadKeys.current.get(signature) ?? operationKey();
      uploadKeys.current.set(signature, batchKey);
      const result = await api.call<{ results: UploadResult[] }>('asset.uploadBatch', {
        brandId: brand.id,
        operationKey: batchKey,
        files: await Promise.all(
          selected.map(async (f) => ({ itemKey: f.key, name: f.file.name, base64: await base64(f.file) })),
        ),
      });
      if (!alive.current) return;
      const outcomes = new Map(result.results.map((r) => [r.itemKey, r]));
      for (const item of selected) {
        const r = outcomes.get(item.key);
        if (r?.ok && r.asset) {
          ledger.current.set(item.key, r.asset);
          setUploaded((prev) => [...prev.filter((a) => a.id !== r.asset!.id), r.asset!]);
        }
      }
      setFiles((prev) =>
        prev.map((item) => {
          const r = outcomes.get(item.key);
          return !selected.some((s) => s.key === item.key)
            ? item
            : {
                ...item,
                asset: r?.asset,
                notice:
                  r?.ok && r.asset
                    ? 'Saved to ' + brand.name + (r.notice ? ' · ' + r.notice : '')
                    : (r?.error?.message ?? 'Could not verify this upload. Retry.'),
              };
        }),
      );
      if (selected.some((f) => !ledger.current.has(f.key))) {
        // A completed batch caches even its per-file rejections. Retry the failed files
        // under a new batch key, retaining each file's key and every successful upload.
        uploadKeys.current.delete(signature);
        throw Error('Check the photo results below. Retry or choose another photo for each failed upload.');
      }
    }
    const photoMapping = Object.fromEntries(
      photos.map((p) => {
        const selected = choice(p);
        if (selected === removePhoto) return [p.key, null];
        if (!selected.startsWith('file:')) return [p.key, selected];
        const asset = ledger.current.get(selected.slice(5));
        if (!asset) throw Error('Choose a saved photo for ' + p.source + '.');
        return [p.key, asset.id];
      }),
    );
    const input = {
      brandId: brand.id,
      source,
      format,
      acceptMetadata,
      buttonLinks: buttons,
      photoMapping,
      ...metadata,
      fromName: useSender && sender ? sender.fromName : brand.name,
      replyTo: useSender && sender ? sender.replyTo : '',
      ...(replacement ? { replace: { id: replacement.id, expectedVersion: replacement.version } } : {}),
    };
    const verified = await api.call<Reviewed>('campaign.previewImport', input);
    if (!alive.current) return;
    const key = priorCommit.current?.digest === verified.digest ? priorCommit.current.key : operationKey();
    priorCommit.current = { digest: verified.digest, key };
    commit.current = { input, operationKey: key };
    setReview(verified);
    setStage('review');
  }
  async function save() {
    if (!review || !commit.current) return;
    const { input, operationKey: key } = commit.current;
    const draft = await api.call<Campaign>('campaign.commitImport', {
      ...input,
      digest: review.digest,
      operationKey: key,
    });
    if (alive.current) open(draft);
  }
  const pickPhotos = (
    <label className="field">
      Add supplied photos
      <input
        type="file"
        multiple
        accept={photoAccept}
        onChange={(e) => {
          addPhotos(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </label>
  );
  return (
    <section className="card newsletter-import" aria-label="Import newsletter">
      <h2>Import newsletter</h2>
      <p className="help">Sending brand · {brand.name}</p>
      <fieldset disabled={busy}>
        {stage === 'source' && (
          <>
            <label className="field">
              Newsletter file
              <input
                type="file"
                accept=".md,.markdown,.html,.htm,.zip"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void perform(() => readDocument(f));
                  e.target.value = '';
                }}
              />
            </label>
            <p className="help">
              Choose Markdown, HTML, or a ZIP with newsletter.md or newsletter.html and an images folder.
            </p>
            <label className="field">
              Source format
              <select
                value={format}
                onChange={(e) => {
                  resetReview();
                  setFormat(e.target.value as Format);
                }}
              >
                <option value="markdown">Markdown</option>
                <option value="html">HTML</option>
              </select>
            </label>
            <label className="field">
              Newsletter source
              <textarea
                rows={9}
                value={source}
                placeholder="Paste Markdown or formatted newsletter content"
                onChange={(e) => {
                  resetReview();
                  setSource(e.target.value);
                }}
                onPaste={(e) => {
                  const html = e.clipboardData.getData('text/html');
                  if (!html) return;
                  if (
                    source &&
                    (e.currentTarget.selectionStart !== 0 || e.currentTarget.selectionEnd !== source.length)
                  ) {
                    e.preventDefault();
                    setError('To paste a formatted newsletter, select the entire source first.');
                    return;
                  }
                  e.preventDefault();
                  resetReview();
                  setSource(html);
                  setFormat('html');
                  addPhotos(Array.from(e.clipboardData.files));
                }}
              />
            </label>
            {pickPhotos}
            {!!files.length && (
              <ul>
                {files.map((f) => (
                  <li key={f.key}>
                    {f.path}{' '}
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={() => setFiles((all) => all.filter((other) => other.key !== f.key))}
                    >
                      Remove file
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="actions">
              <button
                className="btn"
                disabled={!source.trim()}
                onClick={() => void perform(async () => inspect())}
              >
                Review import
              </button>
              <button className="btn secondary" onClick={cancel}>
                Cancel
              </button>
            </div>
          </>
        )}
        {stage === 'map' && converted && (
          <>
            {(converted.suggestions.subject || converted.suggestions.preheader) && (
              <label className="import-choice">
                <input
                  type="checkbox"
                  checked={acceptMetadata}
                  onChange={(e) => {
                    const accepted = e.target.checked;
                    setAcceptMetadata(accepted);
                    if (accepted)
                      setMetadata((m) => ({
                        ...m,
                        subject: m.subject || converted.suggestions.subject || '',
                        preheader: m.preheader || converted.suggestions.preheader || '',
                      }));
                    setAck(false);
                  }}
                />
                Use detected email headers and remove their lines from the body
              </label>
            )}
            {converted.suggestions.subject && (
              <p className="help">Detected subject · {converted.suggestions.subject}</p>
            )}
            {converted.suggestions.preheader && (
              <p className="help">Detected preheader · {converted.suggestions.preheader}</p>
            )}
            {(['title', 'subject', 'preheader'] as const).map((key) => (
              <label key={key} className="field">
                {{ title: 'Draft title', subject: 'Email subject', preheader: 'Preheader' }[key]}
                <input
                  value={metadata[key]}
                  required={key === 'title'}
                  maxLength={{ title: 120, subject: 150, preheader: 200 }[key]}
                  onChange={(e) => setMetadata({ ...metadata, [key]: e.target.value })}
                />
              </label>
            ))}
            <label className="field">
              Sender details
              <select
                value={useSender ? 'configured' : 'later'}
                onChange={(e) => setUseSender(e.target.value === 'configured')}
              >
                <option value="later">Choose later in Studio</option>
                {sender && (
                  <option value="configured">
                    {sender.fromName} · {sender.fromEmail} · reply to {sender.replyTo}
                  </option>
                )}
              </select>
            </label>
            {senderStatus && <p className="help">{senderStatus}</p>}
            {!!converted.links.length && (
              <fieldset>
                <legend>Convert links to buttons</legend>
                {converted.links.map((link) => (
                  <label className="import-choice" key={link.href}>
                    <input
                      type="checkbox"
                      checked={buttons.includes(link.href)}
                      onChange={(e) => {
                        setButtons(
                          e.target.checked ? [...buttons, link.href] : buttons.filter((v) => v !== link.href),
                        );
                        setAck(false);
                      }}
                    />
                    {link.label} · {link.href}
                  </label>
                ))}
              </fieldset>
            )}
            {photos.length > 0 && pickPhotos}
            {files.some((file) => !photos.some((p) => choice(p) === localChoice(file))) && (
              <p className="help">
                Files outside the draft:{' '}
                {files
                  .filter((file) => !photos.some((p) => choice(p) === localChoice(file)))
                  .map((file) => file.path)
                  .join(', ')}
              </p>
            )}
            {library.error && (
              <p role="alert">
                {library.error} <button onClick={library.retry}>Reload image library</button>
              </p>
            )}
            <h3>Body preview</h3>
            <div className="import-preview">
              {converted.blocks.map((b, i) => {
                if (b.type !== 'photo') return <SectionPreview key={i} block={b} assets={assets} api={api} />;
                const value = choice(b),
                  local = files.find((f) => localChoice(f) === value),
                  asset = assets.find((a) => a.id === value);
                return (
                  <div className="import-photo" key={b.key}>
                    <label className="field">
                      Photo {b.alt || b.source}
                      <small>{b.source}</small>
                      <select
                        value={value}
                        onChange={(e) => setChoices({ ...choices, [b.key]: e.target.value })}
                      >
                        <option value="">Select a photo</option>
                        {files.map((f) => (
                          <option key={f.key} value={localChoice(f)}>
                            Supplied · {f.path}
                          </option>
                        ))}
                        {assets.map((a) => (
                          <option key={a.id} value={a.id}>
                            Library · {a.name}
                          </option>
                        ))}
                        <option value={removePhoto}>Remove this photo placement</option>
                      </select>
                    </label>
                    {asset && <BrandImage api={api} assetId={asset.id} name={asset.name} alt={b.alt} />}
                    {local && <LocalThumbnail file={local.file} alt={b.alt} />}
                    {local?.notice && (
                      <p role="status">
                        {local.path} · {local.notice}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            {!!converted.warnings.length && (
              <section>
                <h3>Conversion warnings</h3>
                <ul>
                  {converted.warnings.map((w, i) => (
                    <li key={i}>
                      {w.location} · {w.message}
                    </li>
                  ))}
                </ul>
                <label className="import-choice">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I reviewed
                  these formatting changes.
                </label>
              </section>
            )}
            <label className="field">
              Save to
              <select value={replaceId} onChange={(e) => setReplaceId(e.target.value)}>
                <option value="">New draft</option>
                {docDrafts.map((d) => (
                  <option key={d.id} value={d.id}>
                    Replace {d.content.title || 'Untitled draft'} · version {d.version}
                  </option>
                ))}
              </select>
            </label>
            <div className="actions">
              <button
                className="btn"
                disabled={
                  !metadata.title.trim() || !!unresolved.length || (!!converted.warnings.length && !ack)
                }
                onClick={() => void perform(prepare)}
              >
                {photos.some((p) => choice(p).startsWith('file:') && !ledger.current.has(choice(p).slice(5)))
                  ? 'Upload photos and preview draft'
                  : 'Preview draft'}
              </button>
              <button
                className="btn secondary"
                onClick={() => {
                  setStage('source');
                  setError('');
                }}
              >
                Back to source
              </button>
            </div>
          </>
        )}
        {stage === 'map' && conversion?.error && (
          <p role="alert">
            {conversion.error}{' '}
            {buttons.length > 0 && <button onClick={() => setButtons([])}>Keep links as text</button>}{' '}
            <button onClick={() => setStage('source')}>Edit source</button>
          </p>
        )}
        {stage === 'review' && review && (
          <>
            <h3>{review.content.title}</h3>
            <dl>
              <dt>Subject</dt>
              <dd>{review.content.subject || 'No subject yet'}</dd>
              <dt>Preheader</dt>
              <dd>{review.content.preheader || 'No preheader'}</dd>
              <dt>From</dt>
              <dd>
                {review.content.fromName}
                {review.content.replyTo && ' · Reply to ' + review.content.replyTo}
              </dd>
            </dl>
            <div className="import-preview">
              {review.content.studio?.blocks.map((b, i) => (
                <SectionPreview key={i} block={b} assets={assets} api={api} />
              ))}
            </div>
            {replacement && (
              <p className="notice">
                Saving will replace the content of {replacement.content.title}, version {replacement.version}.
              </p>
            )}
            <div className="actions">
              <button className="btn" onClick={() => void perform(save)}>
                {replacement ? 'Replace draft' : 'Create draft'}
              </button>
              <button
                className="btn secondary"
                onClick={() => {
                  setStage('map');
                  setError('');
                }}
              >
                Edit import
              </button>
            </div>
          </>
        )}
      </fieldset>
      {busy && <p role="status">Preparing newsletter…</p>}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
