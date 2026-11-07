import { useEffect, useRef, useState } from 'react';
import type { Campaign, CommandName } from '../shared/contracts.js';
import {
  practiceMailbox,
  type Rehearsal,
  type RehearsalAudience,
  type WorkspaceAccess,
  type Usage,
} from '../shared/rehearsal.js';
import { operationKey, type Api } from './api.js';

const showError = (e: unknown) =>
  e instanceof Error ? e.message : 'Flockletter could not complete this request.';
const reasonText: Record<string, string> = {
  authority_revoked: 'The reviewer no longer has access.',
  access_changed: 'Workspace access changed.',
  draft_changed: 'The saved draft changed.',
  cancelled_by_owner: 'Cancelled by a workspace owner or authorized connection.',
};
type Message = { subject: string; text: string; html: string; mailbox: string };
export function Rehearsals({ api, draft }: { api: Api; draft: Campaign }) {
  const [audience, setAudience] = useState<RehearsalAudience>('test');
  const [at, setAt] = useState('');
  const [items, setItems] = useState<Rehearsal[]>([]);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [revision, refresh] = useState(0);
  const keys = useRef(new Map<string, string>());
  useEffect(() => {
    let current = true;
    api
      .call<Rehearsal[]>('rehearsal.list', { brandId: draft.brandId, campaignId: draft.id })
      .then((value) => {
        if (current) setItems(value);
      })
      .catch((e) => {
        if (current) setError(showError(e));
      });
    return () => {
      current = false;
    };
  }, [api, draft.brandId, draft.id, revision]);
  async function mutate<T>(name: CommandName, input: Record<string, unknown>) {
    const fingerprint = JSON.stringify([name, input]),
      key = keys.current.get(fingerprint) ?? operationKey();
    keys.current.set(fingerprint, key);
    const result = await api.call<T>(name, { operationKey: key, ...input });
    keys.current.delete(fingerprint);
    return result;
  }
  async function action(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setError(showError(e));
    } finally {
      setBusy(false);
      refresh((v) => v + 1);
    }
  }
  const context = { brandId: draft.brandId, campaignId: draft.id };
  async function approve(item: Rehearsal) {
    const approved = await mutate<Rehearsal>('rehearsal.approve', { brandId: draft.brandId, id: item.id });
    if (Date.parse(approved.dueAt) <= Date.now())
      await mutate('rehearsal.process', { brandId: draft.brandId, id: item.id });
  }
  return (
    <section className="card" aria-labelledby="rehearsal-heading">
      <h2 id="rehearsal-heading">Campaign rehearsal</h2>
      <p>
        Review a saved version and capture its message inside Flockletter. Rehearsals never deliver email to
        an inbox.
      </p>
      <fieldset disabled={busy}>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="capture-audience">Practice audience</label>
            <select
              id="capture-audience"
              value={audience}
              onChange={(e) => setAudience(e.target.value as RehearsalAudience)}
            >
              <option value="test">One test mailbox</option>
              <option value="confirmed">Confirmed test contacts in this brand</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="capture-time">Schedule (local time, optional)</label>
            <input
              id="capture-time"
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </div>
        </div>
        <p className="help">
          {audience === 'test'
            ? 'Capture for ' + practiceMailbox + '.'
            : 'Requires a complimentary plan and up to 25 confirmed addresses on reserved test domains.'}
        </p>
        <button
          className="btn"
          type="button"
          onClick={() =>
            void action(async () => {
              await mutate('rehearsal.review', {
                ...context,
                expectedVersion: draft.version,
                audience,
                ...(at ? { dueAt: new Date(at).toISOString() } : {}),
              });
            })
          }
        >
          Review capture
        </button>
      </fieldset>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {items.map((item) => (
        <article className="card" key={item.id}>
          <h3>
            {item.audience === 'test' ? 'Test mailbox' : 'Confirmed test audience'} · version {item.version}
          </h3>
          <p>
            <strong>{item.state}</strong> · {new Date(item.dueAt).toLocaleString()} · {item.selected} selected
            · {item.excluded} excluded at review
          </p>
          <p>
            {item.captured} captured · {item.pending} pending · {item.skipped} skipped or cancelled
          </p>
          {item.reason && <p>{reasonText[item.reason] ?? item.reason}</p>}
          <div className="actions">
            {item.state === 'reviewed' && (
              <button className="btn" disabled={busy} onClick={() => void action(() => approve(item))}>
                Approve capture
              </button>
            )}
            {item.state === 'queued' && (
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await mutate('rehearsal.process', { brandId: draft.brandId, id: item.id });
                  })
                }
              >
                Process if due
              </button>
            )}
            {['reviewed', 'queued'].includes(item.state) && (
              <button
                className="btn secondary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await mutate('rehearsal.cancel', { brandId: draft.brandId, id: item.id });
                  })
                }
              >
                Cancel rehearsal
              </button>
            )}
            {item.captured > 0 && (
              <button
                className="btn secondary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    setMessage(
                      await api.call<Message>('rehearsal.message', { brandId: draft.brandId, id: item.id }),
                    );
                  })
                }
              >
                Open captured email
              </button>
            )}
          </div>
        </article>
      ))}
      <button
        className="btn secondary"
        disabled={busy}
        onClick={() => {
          setError('');
          refresh((v) => v + 1);
        }}
      >
        Refresh rehearsals
      </button>
      {message && (
        <div className="card">
          <h3>Captured email</h3>
          <p>
            {message.subject} · {message.mailbox}
          </p>
          <iframe
            className="preview-frame"
            sandbox=""
            title="Captured campaign email"
            srcDoc={message.html}
          />
          <details>
            <summary>Plain-text email</summary>
            <pre>{message.text}</pre>
          </details>
        </div>
      )}
    </section>
  );
}
export function WorkspaceAccessPanel({ api }: { api: Api }) {
  const [data, setData] = useState<{ access: WorkspaceAccess; usage: Usage }>(),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api
      .call<{ access: WorkspaceAccess; usage: Usage }>('workspace.access', {})
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) setError(showError(e));
      });
    return () => {
      active = false;
    };
  }, [api]);
  return (
    <section className="card">
      <h2>Workspace access and practice usage</h2>
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p role="status">Loading access…</p>
      ) : (
        <>
          <p>{data.access.plan ? 'Complimentary · ' + data.access.plan : 'Preparation access'}</p>
          <p>
            Practice usage for {data.usage.period} (UTC). {data.usage.campaigns} campaigns and{' '}
            {data.usage.messages} messages captured. {data.usage.reservedCampaigns} campaigns and{' '}
            {data.usage.reservedMessages} messages reserved.
          </p>
          <p className="help">
            Practice messages use a separate counter and incur no delivery or billing charges.
          </p>
        </>
      )}
    </section>
  );
}
