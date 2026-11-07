import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { stateLabel, subscriberStates } from '../shared/audience.js';
import type { CommandName } from '../shared/contracts.js';
import {
  type Segment,
  type SegmentAction,
  type SegmentDirectory,
  type SegmentMembershipResult,
} from '../shared/segments.js';
import { operationKey, type Api } from './api.js';
import { SegmentMembershipForm } from './SegmentMembershipForm.js';
import './segments.css';

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The group could not be updated.';
function GroupName({
  value = '',
  rename = false,
  onSave,
}: {
  value?: string;
  rename?: boolean;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(value),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const id = useId();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !name.trim() || (rename && name.trim() === value)) return;
    setBusy(true);
    setError('');
    try {
      await onSave(name.trim());
      if (!rename) setName('');
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <div className="field">
        <label htmlFor={id}>{rename ? 'New name' : 'Group name'}</label>
        <input
          id={id}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          required
          disabled={busy}
        />
      </div>
      <button
        className="btn secondary"
        type="submit"
        disabled={busy || !name.trim() || (rename && name.trim() === value)}
      >
        {rename ? 'Confirm name change' : 'Create group'}
      </button>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
    </form>
  );
}

export function Segments({ api, brandId }: { api: Api; brandId: string }) {
  const [data, setData] = useState<SegmentDirectory | null>(null);
  const [selected, setSelected] = useState(''),
    [revision, setRevision] = useState(0),
    [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const title = useId(),
    picker = useId();
  const retries = useRef(new Map<string, string>());
  useEffect(() => {
    let active = true;
    setError('');
    api
      .call<SegmentDirectory>('segment.list', { brandId })
      .then((result) => {
        if (active) setData(result);
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [api, brandId, revision]);
  const current = data?.items.find((item) => item.id === selected);
  async function change<T>(name: CommandName, input: Record<string, unknown>) {
    const bytes = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([name, brandId, input])),
    );
    const fingerprint = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
    const key = retries.current.get(fingerprint) ?? operationKey();
    retries.current.set(fingerprint, key);
    const result = await api.call<T>(name, { ...input, brandId, operationKey: key });
    retries.current.delete(fingerprint);
    setRevision((value) => value + 1);
    return result;
  }
  return (
    <section className="card audience-groups" aria-labelledby={title}>
      <h2 id={title}>Audience groups</h2>
      {error && (
        <p className="notice error" role="alert">
          {error}{' '}
          <button className="btn secondary" onClick={() => setRevision((n) => n + 1)}>
            Reload groups
          </button>
        </p>
      )}
      {notice && (
        <p className="notice success" role="status">
          {notice}
        </p>
      )}
      {!data && !error && <p role="status">Loading groups…</p>}
      {data && (
        <>
          <p>
            {data.items.length} of {data.limit} groups in this brand.
          </p>
          {data.items.length < data.limit && (
            <details>
              <summary>Create a group</summary>
              <GroupName
                onSave={async (name) => {
                  const group = await change<Segment>('segment.create', { name });
                  setSelected(group.id);
                  setNotice('Group created.');
                }}
              />
            </details>
          )}
          {data.items.length > 0 && (
            <div className="field">
              <label htmlFor={picker}>Manage a group</label>
              <select
                id={picker}
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setNotice('');
                }}
              >
                <option value="">Choose a group</option>
                {data.items.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {current && (
            <GroupControls
              key={current.id}
              group={current}
              onMembers={(action, emails) =>
                change<SegmentMembershipResult>('segment.members', { segmentId: current.id, action, emails })
              }
              onRename={async (name) => {
                await change('segment.rename', { segmentId: current.id, name });
                setNotice('Group name updated.');
              }}
              onDelete={async () => {
                await change('segment.delete', { segmentId: current.id });
                setSelected('');
                setNotice('Group deleted. The contacts are still in your brand.');
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function GroupControls({
  group,
  onMembers,
  onRename,
  onDelete,
}: {
  group: Segment;
  onMembers: (action: SegmentAction, emails: string[]) => Promise<SegmentMembershipResult>;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onDelete();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article>
      <h3>{group.name}</h3>
      <p>
        {group.counts.total} contacts · {group.counts.confirmed} confirmed
      </p>
      <details>
        <summary>Contact status counts</summary>
        <dl>
          {subscriberStates.map((state) => (
            <div key={state}>
              <dt>{stateLabel[state]}</dt>
              <dd>{group.counts[state]}</dd>
            </div>
          ))}
        </dl>
      </details>
      <SegmentMembershipForm onSave={onMembers} />
      <details>
        <summary>Rename group</summary>
        <GroupName key={group.name} value={group.name} rename onSave={onRename} />
      </details>
      {confirm ? (
        <div role="group" aria-label="Confirm group deletion">
          <p>Delete “{group.name}”? Contacts, consent history and previous campaign reviews are kept.</p>
          <div className="actions">
            <button className="btn secondary" disabled={busy} onClick={() => setConfirm(false)}>
              Keep group
            </button>
            <button className="btn" disabled={busy} onClick={() => void remove()}>
              Confirm deletion
            </button>
          </div>
        </div>
      ) : (
        <button
          className="btn secondary"
          onClick={() => {
            setError('');
            setConfirm(true);
          }}
        >
          Delete group
        </button>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
