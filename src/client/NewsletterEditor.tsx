import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  type AssetSummary,
  type Campaign,
  type CampaignContent,
  type Preflight,
} from '../shared/contracts.js';
import { studioProblem, type StudioDocument } from '../shared/studio.js';
import { legacyToStudio, withStudio } from '../shared/studio-legacy.js';
import { operationKey, type Api } from './api.js';
import { CampaignFields } from './CampaignFields.js';
import { CampaignPreview } from './CampaignPreview.js';
import { Rehearsals } from './Rehearsals.js';
const StudioCanvas = lazy(() => import('./studio/StudioCanvas.js'));
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Unable to complete the request.');
type Preview = { html: string; text: string; version: number };

class CanvasBoundary extends Component<
  { children: ReactNode; onFailure: (error: string) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFailure('The Studio could not open this document. Reload the saved version to recover.');
  }
  render() {
    return this.state.failed ? (
      <p role="alert">The canvas could not load. Your saved draft is available.</p>
    ) : (
      this.props.children
    );
  }
}

export function NewsletterEditor({
  api,
  initial,
  back,
  onDirty,
  rehearse = true,
}: {
  api: Api;
  initial: Campaign;
  back: () => void;
  onDirty: (dirty: boolean) => void;
  rehearse?: boolean;
}) {
  const [saved, setSaved] = useState(initial),
    [content, setContent] = useState(initial.content);
  const [assets, setAssets] = useState<AssetSummary[]>([]),
    [libraryReady, setLibraryReady] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [canvasError, setCanvasError] = useState(''),
    [epoch, setEpoch] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null),
    [checks, setChecks] = useState<Preflight | null>(null);
  const saveKey = useRef(operationKey());
  const changed = JSON.stringify(content) !== JSON.stringify(saved.content);
  const dirty = changed || !!canvasError;
  const savedProblem = saved.content.studio === undefined ? null : studioProblem(saved.content.studio);
  const inputProblem = content.studio === undefined ? null : studioProblem(content.studio);
  const invalid = savedProblem || canvasError || inputProblem;

  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    let active = true;
    api
      .call<AssetSummary[]>('asset.list', { brandId: initial.brandId })
      .then((result) => {
        if (active) {
          setAssets(result);
          setLibraryReady(true);
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [api, initial.brandId, epoch]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function change(next: CampaignContent) {
    setContent(next);
    saveKey.current = operationKey();
    setPreview(null);
    setChecks(null);
    setNotice('');
    setError('');
  }
  function openStudio() {
    const doc = legacyToStudio(content, assets);
    const issue = studioProblem(doc);
    if (issue) {
      setError(issue);
      return;
    }
    change(withStudio(content, doc));
  }
  function changeStudio(next: StudioDocument) {
    change(withStudio(content, next));
  }
  async function reload() {
    setBusy(true);
    try {
      const fresh = await api.call<Campaign>('campaign.get', { id: saved.id });
      setSaved(fresh);
      setContent(fresh.content);
      setCanvasError('');
      setError('');
      setNotice('');
      setPreview(null);
      setChecks(null);
      saveKey.current = operationKey();
      setEpoch((n) => n + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function run(review: boolean) {
    if (invalid || busy) return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      let current = saved;
      if (changed) {
        current = await api.call<Campaign>('campaign.update', {
          operationKey: saveKey.current,
          id: saved.id,
          expectedVersion: saved.version,
          content,
        });
        setSaved(current);
        setContent(current.content);
        saveKey.current = operationKey();
      }
      setNotice('Saved version ' + current.version + '.');
      if (review) {
        const [p, f] = await Promise.all([
          api.call<Preview>('campaign.preview', { id: current.id, expectedVersion: current.version }),
          api.call<Preflight>('campaign.preflight', { id: current.id }),
        ]);
        if (f.version !== current.version) throw Error('This draft changed. Reload it before previewing.');
        setPreview(p);
        setChecks(f);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="btn secondary" disabled={dirty || busy} onClick={back}>
        ← Campaigns
      </button>
      <h1 className="page-heading studio-editor-heading">
        {content.studio !== undefined ? 'Newsletter Studio' : 'Campaign draft'}
      </h1>
      <p className="page-intro">
        {dirty ? 'You have unsaved changes.' : 'Saved draft · version ' + saved.version}
      </p>
      {(error || invalid) && (
        <p role="alert" className="notice error studio-editor-alert">
          {error || invalid}
        </p>
      )}
      {(dirty || error || savedProblem) && (
        <button className="btn secondary" disabled={busy} onClick={() => void reload()}>
          {dirty ? 'Discard edits and reload saved version' : 'Reload saved version'}
        </button>
      )}
      {notice && (
        <p className="notice success" role="status">
          {notice}
        </p>
      )}
      {!savedProblem && (
        <>
          <section className="card">
            <CampaignFields
              value={content}
              assets={assets}
              disabled={busy}
              messageOnly={!!content.studio}
              onChange={change}
            />
            {!content.studio && (
              <button className="btn secondary" disabled={busy || !libraryReady} onClick={openStudio}>
                Open Newsletter Studio
              </button>
            )}
          </section>
          {content.studio && (
            <CanvasBoundary key={epoch} onFailure={setCanvasError}>
              <Suspense fallback={<p role="status">Loading Newsletter Studio…</p>}>
                <StudioCanvas
                  document={content.studio}
                  assets={assets}
                  api={api}
                  disabled={busy}
                  onChange={changeStudio}
                  onValidity={setCanvasError}
                />
              </Suspense>
            </CanvasBoundary>
          )}
          <div className="actions">
            <button
              className="btn secondary"
              disabled={busy || !changed || !!invalid}
              onClick={() => void run(false)}
            >
              Save draft
            </button>
            <button className="btn" disabled={busy || !!invalid} onClick={() => void run(true)}>
              {busy ? 'Saving & checking…' : 'Preview & check'}
            </button>
          </div>
          {preview && !invalid && (
            <section className="preview-layout">
              <div className="card">
                <h2>Preview · version {preview.version}</h2>
                <CampaignPreview title="Campaign email preview" html={preview.html} />
                <details>
                  <summary>Plain-text version</summary>
                  <pre className="token-output">{preview.text}</pre>
                </details>
              </div>
              <div className="card">
                <h2>Before you send</h2>
                {checks?.audience && (
                  <p className="audience-preview-count">
                    <strong>Current brand audience</strong>
                    <br />
                    {checks.audience.confirmed.toLocaleString()} confirmed ·{' '}
                    {checks.audience.excluded.toLocaleString()} excluded
                  </p>
                )}
                <p className="badge">
                  {checks?.contentReady ? 'Content looks complete' : 'Content needs attention'}
                </p>
                <ul className="check-list">
                  {checks?.gaps.map((g) => (
                    <li className="gap" key={g.code}>
                      <strong>{g.title}</strong>
                      <p>{g.detail}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}
          {rehearse && !dirty && !invalid && (
            <Rehearsals key={saved.id + ':' + saved.version} api={api} draft={saved} />
          )}
        </>
      )}
    </>
  );
}
