import { useEffect, useId, useRef, useState } from 'react';
import { limits, type AssetSummary } from '../shared/contracts.js';
import { base64, operationKey, type Api } from './api.js';

type Props = { api: Api; brandId: string; onUploaded: (assets: AssetSummary[]) => void };
type Batch = { operationKey: string; items: { itemKey: string; file: File }[] };
type FileResult = { itemKey: string; ok: boolean; asset?: AssetSummary; error?: { message: string } };

export function BrandImageUpload(props: Props) {
  // Switching brands discards the previous selection and its in-flight completion handler.
  return <UploadForm key={props.brandId} {...props} />;
}

function UploadForm({ api, brandId, onUploaded }: Props) {
  const field = useId();
  const alive = useRef(false),
    pending = useRef(false);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [results, setResults] = useState<FileResult[]>([]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function choose(files: File[]) {
    setBatch(
      files.length
        ? { operationKey: operationKey(), items: files.map((file) => ({ itemKey: operationKey(), file })) }
        : null,
    );
    setResults([]);
    setError('');
  }
  async function upload() {
    if (!batch || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const { items } = batch;
      if (
        items.length > limits.batchFiles ||
        items.some(({ file }) => file.size > limits.fileBytes) ||
        items.reduce((total, { file }) => total + file.size, 0) > limits.batchBytes
      )
        throw Error('Choose up to 10 images, no more than 5 MiB each and 20 MiB together.');
      const files = await Promise.all(
        items.map(async ({ itemKey, file }) => ({ itemKey, name: file.name, base64: await base64(file) })),
      );
      if (!alive.current) return;
      const response = await api.call<{ results: FileResult[] }>('asset.uploadBatch', {
        brandId,
        operationKey: batch.operationKey,
        files,
      });
      if (!alive.current) return;
      setResults(response.results);
      const refreshed = await api.call<AssetSummary[]>('asset.list', { brandId });
      if (alive.current) onUploaded(refreshed);
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'The upload could not be verified. Retry the same selection.',
        );
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const count = batch?.items.length ?? 0;
  return (
    <div className="brand-image-upload">
      <div className="field">
        <label htmlFor={field}>Add JPEG, PNG or WebP images</label>
        <input
          id={field}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          disabled={busy}
          aria-describedby={field + '-limits'}
          onChange={(e) => choose(Array.from(e.currentTarget.files ?? []))}
        />
        <p id={field + '-limits'} className="help">
          Up to 10 files, 5 MiB each, 20 MiB per batch. Animated images and SVG are not supported.
        </p>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <button className="btn" type="button" disabled={busy || !count} onClick={() => void upload()}>
        {busy
          ? 'Checking & uploading…'
          : count
            ? `Upload ${count} ${count === 1 ? 'image' : 'images'}`
            : 'Upload images'}
      </button>
      <ul aria-live="polite">
        {results.map((result) => {
          const name = batch?.items.find((item) => item.itemKey === result.itemKey)?.file.name ?? 'Image';
          return (
            <li key={result.itemKey}>
              {result.ok
                ? `Saved: ${result.asset?.name ?? name}`
                : `${name}: ${result.error?.message ?? 'Upload failed.'}`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
