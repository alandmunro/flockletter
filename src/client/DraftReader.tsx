import { useEffect, useState } from 'react';
import type { Api } from './api.js';
import type { Campaign } from '../shared/contracts.js';
export function DraftReader({ api, draft, back }: { api: Api; draft: Campaign; back: () => void }) {
  const [preview, setPreview] = useState<{ html: string; text: string }>(),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api
      .call<{ html: string; text: string }>('campaign.preview', {
        id: draft.id,
        expectedVersion: draft.version,
      })
      .then((data) => {
        if (active) setPreview(data);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api, draft.id, draft.version]);
  return (
    <>
      <button className="btn secondary" onClick={back}>
        ← Campaigns
      </button>
      <h1 className="page-heading">{draft.content.title || 'Untitled campaign'}</h1>
      <p>Read-only preview · version {draft.version}</p>
      {error && <p role="alert">{error}</p>}
      {preview && (
        <>
          <iframe
            sandbox=""
            className="preview-frame"
            title="Read-only campaign preview"
            srcDoc={preview.html}
          />
          <details>
            <summary>Plain text</summary>
            <pre>{preview.text}</pre>
          </details>
        </>
      )}
    </>
  );
}
