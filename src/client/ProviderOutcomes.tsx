import { useEffect, useId, useState } from 'react';
import type { RecipientOutcome } from '../shared/rehearsal.js';
import type { Api } from './api.js';

const reasonText: Record<string, string> = {
  ineligible: 'The recipient was no longer eligible when the worker checked.',
  provider_unknown:
    'The provider may already have accepted this attempt. The worker checks its status before retrying.',
  provider_rejected: 'The provider refused this submission.',
  verified_not_submitted:
    'The provider confirmed it did not accept the attempt. The worker checks eligibility again before retrying.',
  retry_exhausted: 'The worker reached its retry limit.',
  authority_revoked: 'The reviewer no longer has permission.',
  reservation_unavailable: 'The approved allowance is no longer reserved.',
  image_unavailable: 'An approved image could not be verified.',
  simulator_unavailable:
    'The approved Amazon SES simulator configuration is no longer available for this brand.',
  engine_unavailable: 'The private Listmonk test is unavailable for this brand.',
  engine_render_failed: 'Listmonk could not prepare the reviewed message.',
  awaiting_engine_callback: 'Waiting for Listmonk to finish preparing the message.',
  awaiting_provider: 'Waiting for the test provider to confirm the submission.',
  access_changed: 'The workspace’s access changed.',
  draft_changed: 'The saved draft changed after review.',
  cancelled_by_owner: 'The rehearsal was cancelled.',
};

const statusText: Record<RecipientOutcome['state'], string> = {
  pending: 'Pending',
  submitting: 'Submitting',
  uncertain: 'Uncertain',
  accepted: 'Accepted by the test provider',
  rejected: 'Rejected',
  excluded: 'Skipped',
  cancelled: 'Cancelled',
  captured: 'Captured',
};
const preparingText: Record<string, string> = {
  awaiting_engine_callback: 'Preparing in Listmonk',
  awaiting_provider: 'Queued for the test provider',
};

const feedbackText: Record<NonNullable<RecipientOutcome['feedback']>, string> = {
  delivered: 'The test provider confirmed delivery.',
  temporary_bounce: 'The test provider reported a temporary bounce.',
  permanent_bounce:
    'The test provider reported a permanent bounce. Future mail to the matching subscriber is blocked for this brand.',
  complaint:
    'The test provider reported a spam complaint. Future mail to the matching subscriber is blocked for this brand.',
};

export function RecipientList({ recipients }: { recipients: readonly RecipientOutcome[] }) {
  if (!recipients.length) return <p>No recipient outcomes are available.</p>;
  return (
    <ul aria-label="Recipient outcomes" style={{ overflowWrap: 'anywhere' }}>
      {recipients.map((recipient) => {
        const reason =
          recipient.state === 'uncertain' && !Object.hasOwn(reasonText, recipient.reason ?? '')
            ? 'provider_unknown'
            : recipient.reason;
        const preparing =
          recipient.state === 'submitting' && recipient.attempts === 0
            ? preparingText[reason ?? '']
            : undefined;
        return (
          <li key={recipient.id}>
            <strong>{preparing ?? statusText[recipient.state]}</strong> · {recipient.attempts}{' '}
            {preparing && 'provider '}
            {recipient.attempts === 1 ? 'attempt' : 'attempts'}
            {recipient.feedback && <p className="help">{feedbackText[recipient.feedback]}</p>}
            <p className="help">
              Recipient ID <code>{recipient.id}</code>
            </p>
            {!preparing && reason && reasonText[reason] && <p className="help">{reasonText[reason]}</p>}
          </li>
        );
      })}
    </ul>
  );
}

export function ProviderOutcomes({
  api,
  brandId,
  rehearsalId,
  revision,
}: {
  api: Api;
  brandId: string;
  rehearsalId: string;
  revision: number | string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [recipients, setRecipients] = useState<RecipientOutcome[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let current = true;
    setError('');
    setRecipients(null);
    api
      .call<{ recipients: RecipientOutcome[] }>('rehearsal.outcomes', { brandId, id: rehearsalId })
      .then(({ recipients }) => {
        if (current) setRecipients(recipients);
      })
      .catch((e: unknown) => {
        if (current) setError(e instanceof Error ? e.message : 'Recipient outcomes could not be loaded.');
      });
    return () => {
      current = false;
    };
  }, [api, brandId, rehearsalId, revision, open]);
  return (
    <>
      <button
        className="btn secondary"
        type="button"
        aria-controls={id}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide recipient outcomes' : 'Show recipient outcomes'}
      </button>
      <div id={id} hidden={!open}>
        {error ? (
          <p role="alert">{error}</p>
        ) : recipients ? (
          <RecipientList recipients={recipients} />
        ) : (
          <p role="status">Loading recipient outcomes…</p>
        )}
      </div>
    </>
  );
}
