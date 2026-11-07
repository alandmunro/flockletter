import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetSummary } from '../shared/contracts.js';
import type { Api } from './api.js';

// A delayed directory read must not replace a fresher listing returned after a batch upload.
export function useBrandImages(api: Api, brandId: string) {
  const [assets, setAssets] = useState<AssetSummary[]>([]),
    [ready, setReady] = useState(false),
    [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const revision = useRef(0);
  const accept = useCallback((items: AssetSummary[]) => {
    revision.current++;
    setAssets(items);
    setReady(true);
    setError('');
  }, []);
  useEffect(() => {
    let active = true;
    const version = revision.current;
    api
      .call<AssetSummary[]>('asset.list', { brandId })
      .then((items) => {
        if (active && version === revision.current) accept(items);
      })
      .catch((e: unknown) => {
        if (active && version === revision.current)
          setError(e instanceof Error ? e.message : 'The image library could not load.');
      });
    return () => {
      active = false;
    };
  }, [api, brandId, attempt, accept]);
  return { assets, ready, error, accept, retry: () => setAttempt((n) => n + 1) };
}
