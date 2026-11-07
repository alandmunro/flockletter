import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { segmentBatchLimit, type SegmentAction } from '../shared/segments.js';

type Status = { kind: 'success' | 'error'; message: string };

export function SegmentMembershipForm({
  onSave,
}: {
  onSave: (action: SegmentAction, emails: string[]) => Promise<{ changed: number }>;
}) {
  const baseId = useId();
  const actionId = `${baseId}-action`;
  const emailsId = `${baseId}-emails`;
  const helpId = `${baseId}-help`;

  const [action, setAction] = useState<SegmentAction>('add');
  const [emailsText, setEmailsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (busy) {
      return;
    }

    const emails = emailsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (emails.length === 0) {
      setStatus({ kind: 'error', message: 'Enter at least one email address to add or remove.' });
      return;
    }

    if (emails.length > segmentBatchLimit) {
      setStatus({
        kind: 'error',
        message: `You can enter up to ${segmentBatchLimit} email addresses at a time.`,
      });
      return;
    }

    setBusy(true);
    setStatus(null);

    try {
      const result = await onSave(action, emails);

      setEmailsText('');
      setStatus({
        kind: 'success',
        message: `${action === 'add' ? 'Added' : 'Removed'} ${result.changed} contact${
          result.changed === 1 ? '' : 's'
        }.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The group could not be updated. Try again.';

      setStatus({ kind: 'error', message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} aria-busy={busy} noValidate>
      <div className="field">
        <label htmlFor={actionId}>Add or remove</label>
        <select
          id={actionId}
          value={action}
          onChange={(event) => setAction(event.target.value as SegmentAction)}
          disabled={busy}
        >
          <option value="add">Add existing contacts</option>
          <option value="remove">Remove existing contacts</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor={emailsId}>Email addresses</label>
        <textarea
          id={emailsId}
          value={emailsText}
          onChange={(event) => setEmailsText(event.target.value)}
          aria-describedby={helpId}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          rows={8}
        />
        <p id={helpId} className="help">
          Enter one address per line, up to {segmentBatchLimit}. Each contact keeps its current subscription
          status.
        </p>
      </div>

      <button type="submit" className="btn" disabled={busy}>
        {busy ? 'Saving…' : 'Save membership changes'}
      </button>

      {status ? (
        <p
          className={`notice ${status.kind === 'success' ? 'success' : 'error'}`}
          role={status.kind === 'error' ? 'alert' : 'status'}
        >
          {status.message}
        </p>
      ) : null}
    </form>
  );
}
