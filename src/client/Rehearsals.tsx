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
import type { SegmentDirectory } from '../shared/segments.js';
import { ProviderOutcomes } from './ProviderOutcomes.js';

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
  const [transport, setTransport] = useState<Rehearsal['transport']>('capture');
  const [chosenGroup, setChosenGroup] = useState({ brandId: '', id: '' });
  const [groups, setGroups] = useState<{ brandId: string; directory: SegmentDirectory } | null>(null);
  const [groupError, setGroupError] = useState('');
  const selectedGroup = chosenGroup.brandId === draft.brandId ? chosenGroup.id : '';
  const groupOptions = groups?.brandId === draft.brandId ? groups.directory.items : null;
  const selectionMissing = Boolean(
    selectedGroup && groupOptions && !groupOptions.some((group) => group.id === selectedGroup),
  );
  const [scheduled, setScheduled] = useState(false);
  const scheduleTime = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Rehearsal[]>([]);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [revision, refresh] = useState(0);
  const keys = useRef(new Map<string, string>());
  useEffect(() => {
    if (audience !== 'confirmed') return;
    let active = true;
    setGroupError('');
    setGroups(null);
    api
      .call<SegmentDirectory>('segment.list', { brandId: draft.brandId })
      .then((directory) => {
        if (active) setGroups({ brandId: draft.brandId, directory });
      })
      .catch((e: unknown) => {
        if (active) setGroupError(showError(e));
      });
    return () => {
      active = false;
    };
  }, [api, audience, draft.brandId, revision]);
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
      <p>Review the saved version and test recipients before approving a rehearsal.</p>
      <fieldset disabled={busy}>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="rehearsal-method">Rehearsal method</label>
            <select
              id="rehearsal-method"
              value={transport}
              onChange={(e) => setTransport(e.target.value as Rehearsal['transport'])}
            >
              <option value="capture">Flockletter capture</option>
              <option value="provider_test">Staging test provider</option>
            </select>
          </div>
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
          {audience === 'confirmed' && (
            <div className="field">
              <label htmlFor="capture-group">Audience group</label>
              <select
                id="capture-group"
                disabled={!groupOptions}
                value={selectedGroup}
                onChange={(event) => setChosenGroup({ brandId: draft.brandId, id: event.target.value })}
              >
                <option value="">Entire brand</option>
                {selectionMissing && (
                  <option value={selectedGroup}>Group unavailable · choose another</option>
                )}
                {groupOptions?.map((group) => (
                  <option value={group.id} key={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
              {groupError && (
                <p role="alert">
                  {groupError}{' '}
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => refresh((value) => value + 1)}
                  >
                    Reload groups
                  </button>
                </p>
              )}
            </div>
          )}
          <div className="field">
            <label>
              <input type="checkbox" checked={scheduled} onChange={(e) => setScheduled(e.target.checked)} />{' '}
              Schedule for later
            </label>
            {scheduled && (
              <>
                <label htmlFor="capture-time">Scheduled time (local)</label>
                <input ref={scheduleTime} id="capture-time" type="datetime-local" required />
              </>
            )}
          </div>
        </div>
        <p className="help">
          {audience === 'test'
            ? 'This rehearsal uses ' + practiceMailbox + '.'
            : 'Requires a complimentary plan and up to 25 confirmed addresses on reserved test domains.'}{' '}
          {transport === 'provider_test'
            ? 'The staging provider records one result per test recipient.'
            : 'The captured message stays inside Flockletter.'}
        </p>
        <button
          className="btn"
          type="button"
          disabled={audience === 'confirmed' && (!groupOptions || selectionMissing)}
          onClick={() =>
            void action(async () => {
              const at = scheduled ? scheduleTime.current?.value : '';
              if (scheduled && (!at || !Number.isFinite(Date.parse(at)) || Date.parse(at) <= Date.now()))
                throw new Error('Enter a future local time before creating this scheduled review.');
              await mutate('rehearsal.review', {
                ...context,
                expectedVersion: draft.version,
                audience,
                ...(transport === 'provider_test' ? { transport } : {}),
                ...(audience === 'confirmed' && selectedGroup ? { segmentId: selectedGroup } : {}),
                ...(at ? { dueAt: new Date(at).toISOString() } : {}),
              });
            })
          }
        >
          {transport === 'provider_test' ? 'Review provider test' : 'Review capture'}
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
            {item.transport === 'provider_test' ? 'Staging provider test · ' : ''}
            {item.segment?.name ?? (item.audience === 'test' ? 'Test mailbox' : 'Confirmed test audience')} ·
            version {item.version}
          </h3>
          <p>
            <strong>{item.state}</strong> · {new Date(item.dueAt).toLocaleString()} · {item.selected} selected
            · {item.excluded} excluded at review
          </p>
          {item.transport === 'provider_test' ? (
            <p>
              {item.accepted} accepted by the test provider · {item.rejected} rejected · {item.uncertain}{' '}
              uncertain · {item.submitting} submitting · {item.pending} pending · {item.skipped} skipped or
              cancelled
            </p>
          ) : (
            <p>
              {item.captured} captured · {item.pending} pending · {item.skipped} skipped or cancelled
            </p>
          )}
          {item.reason && <p>{reasonText[item.reason] ?? item.reason}</p>}
          <div className="actions">
            {item.state === 'reviewed' && (
              <button className="btn" disabled={busy} onClick={() => void action(() => approve(item))}>
                {item.transport === 'provider_test' ? 'Approve provider test' : 'Approve capture'}
              </button>
            )}
            {(item.state === 'queued' || (item.transport === 'provider_test' && item.uncertain > 0)) && (
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await mutate('rehearsal.process', { brandId: draft.brandId, id: item.id });
                  })
                }
              >
                {item.transport === 'provider_test' && item.uncertain > 0
                  ? 'Check provider status'
                  : 'Process if due'}
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
            {item.transport !== 'provider_test' && item.captured > 0 && (
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
          {item.transport === 'provider_test' && (
            <ProviderOutcomes api={api} brandId={draft.brandId} rehearsalId={item.id} revision={revision} />
          )}
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
            {data.usage.messages} messages used. {data.usage.reservedCampaigns} campaigns and{' '}
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
