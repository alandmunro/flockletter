import { useId, useRef, useState } from 'react';
import type { InvitationOutcome, InvitationPilot } from '../shared/team.js';
import { operationKey, type Api } from './api.js';

export function TeamInvite({
  api,
  pilot,
  available,
  onRefresh,
}: {
  api: Api;
  pilot: InvitationPilot;
  available: number | null;
  onRefresh: (message: string) => void;
}) {
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const keys = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const field = useId();
  const choice = pilot.choices.find((row) => row.email === selected);
  const known = choice?.prior && choice.prior.state !== 'awaiting_reconciliation';
  async function submit() {
    if (!choice || known || inFlight.current || (!choice.prior && available === 0)) return;
    inFlight.current = true;
    setBusy(true);
    const key = choice.prior?.operationKey ?? keys.current.get(choice.email) ?? operationKey();
    keys.current.set(choice.email, key);
    try {
      const result = await api.call<InvitationOutcome>('team.invite', {
        email: choice.email,
        operationKey: key,
      });
      const message =
        result.state === 'awaiting_reconciliation'
          ? 'The seat stays reserved. Choose Check invitation status to look up the original request.'
          : 'Clerk recorded the invitation as ' + result.state + '.';
      onRefresh(message);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Could not verify the invitation. Retry this request.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="team-invite">
      <h3>Invite a staging member</h3>
      {pilot.blocked && <p>Clerk must enforce this workspace’s finite seat allowance before another member can be invited.</p>}
      <label htmlFor={field}>Approved recipient</label>
      <select
        id={field}
        value={selected}
        disabled={busy}
        onChange={(e) => {
          setSelected(e.target.value);
          setNotice('');
        }}
      >
        <option value="">Choose an address</option>
        {pilot.choices.map((row) => (
          <option key={row.email} value={row.email}>
            {row.email}
          </option>
        ))}
      </select>
      {choice && (
        <p>
          {known
            ? 'Clerk recorded this invitation as ' + choice.prior!.state + '.'
            : choice.prior
              ? 'This request is awaiting confirmation. Checking it will look up the original invitation.'
              : 'Clerk will email a workspace member invitation to ' + choice.email + '.'}
        </p>
      )}
      {choice && !choice.prior && available === 0 && !pilot.blocked && <p>All seats are currently reserved.</p>}
      {choice && !known && (
        <button
          type="button"
          className="btn primary"
          disabled={busy || (!choice.prior && available === 0)}
          onClick={() => void submit()}
        >
          {busy
            ? 'Checking invitation…'
            : choice.prior
              ? 'Check invitation status'
              : 'Send member invitation'}
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
