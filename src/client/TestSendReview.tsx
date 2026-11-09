import type { TestDeliveryReview } from '../shared/customer-test-send.js';

type Props = {
  review: TestDeliveryReview;
  recipientLabel: string;
  canApprove: boolean;
  busy: boolean;
  onApprove: () => void;
  onProcess: () => void;
  onResume: () => void;
  onCancel: () => void;
  onPreview: () => void;
  onRefresh: () => void;
};

export function TestSendReview({ review, recipientLabel, canApprove, busy, onApprove, onProcess, onResume, onCancel, onPreview, onRefresh }: Props) {
  const p = review.senderProfile;
  const fromName = p?.fromName ?? 'No name';
  const fromEmail = p?.fromEmail ?? 'No email';
  const replyTo = p?.replyTo ?? 'No reply-to';
  const organization = p?.organization ?? 'Unknown organization';
  const postalAddress = p?.postalAddress ?? 'No postal address';

  const approvalDay = review.testDay;
  const showProcess = ['queued', 'paused', 'cancelled', 'blocked'].includes(review.state) || review.uncertain > 0;
  const showCancel = ['reviewed', 'queued', 'paused'].includes(review.state);
  const canPreview = review.mode === 'capture' && review.accepted > 0;

  return (
    <section className="card" aria-labelledby={'test-review-'+review.id}>
      <h2 id={'test-review-'+review.id}>One-recipient test review</h2>

      <div className="field">
        <span className="help">This approves only this test, never the full campaign.</span>
      </div>

      <dl className="field">
        <dt>Version</dt><dd>{review.version}</dd>
        <dt>Subject</dt><dd>{review.subject}</dd>
        <dt>Purpose</dt><dd>{review.purpose}</dd>
        <dt>Mode</dt><dd className="notice">{review.mode === 'capture' ? 'Captured exercise · no external email' : 'Live transport · normal checks required'}</dd>
        <dt>Sender</dt><dd>{fromName} &lt;{fromEmail}&gt;</dd>
        <dt>Reply-to</dt><dd>{replyTo}</dd>
        <dt>Organization</dt><dd>{organization}</dd>
        <dt>Postal</dt><dd>{postalAddress}</dd>
        <dt>Recipient</dt><dd>{recipientLabel}</dd>
        <dt>Timing</dt><dd>Immediate after explicit approval; no future schedule.</dd>
        <dt>Approval day (UTC)</dt><dd>{approvalDay??'Not approved'}</dd>
        {review.testAdmittedAt && <><dt>Approved at</dt><dd>{new Date(review.testAdmittedAt).toUTCString()}</dd></>}
      </dl>

      <div className="field">
        <span className="help">New submission attempts expire at the end of the approval day at midnight UTC. An unknown outcome may be reconciled; do not resend it.</span>
      </div>

      <dl className="field">
        <dt>State</dt><dd>{review.state}</dd>
        <dt>Selected</dt><dd>{review.selected}</dd>
        <dt>{review.mode==='capture'?'Captured acceptance':'Provider accepted'}</dt><dd>{review.accepted}</dd>
        <dt>{review.mode==='capture'?'Captured delivered feedback':'Delivered feedback'}</dt><dd>{review.delivered}</dd>
        <dt>Uncertain</dt><dd>{review.uncertain}</dd>
        <dt>Rejected</dt><dd>{review.rejected}</dd>
        <dt>Skipped</dt><dd>{review.skipped}</dd>
        <dt>Excluded</dt><dd>{review.excluded}</dd>
      </dl>

      {review.mode === 'capture' && review.accepted > 0 && (
        <div className="notice">Capture accepted is not real provider acceptance.</div>
      )}

      {review.mode !== 'capture' && review.accepted > 0 && <p className="help">Provider acceptance does not confirm inbox delivery. Delivery feedback may arrive later.</p>}

      {review.uncertain > 0 && (
        <div className="notice">The provider may have accepted this message. Reconcile this original test; do not create a replacement while its outcome is unknown.</div>
      )}

      {review.state === 'cancelled' && (
        <div className="notice">Cancellation cannot recall already-accepted messages.</div>
      )}

      <dl className="field">
        <dt>Daily policy</dt>
        <dd>Up to 5 approved tests per workspace each UTC day. A canceled, failed or rejected test still counts toward that daily limit. An accepted real test uses 1 recipient email and 0 campaign slots.</dd>
      </dl>

      {review.reason && <div className="help">{review.reason}</div>}

      <div className="actions">
        {review.state === 'reviewed' && (
          <button type="button" className="btn" disabled={busy || !canApprove} onClick={onApprove}>
            Approve one-recipient test
          </button>
        )}
        {showProcess && (
          <button type="button" className="btn secondary" disabled={busy} onClick={onProcess}>
            Process or reconcile test
          </button>
        )}
        {review.state==='paused'&&<button type="button" className="btn secondary" disabled={busy} onClick={onResume}>Resume unchanged test</button>}
        {showCancel && (
          <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>
            Cancel remaining test
          </button>
        )}
        <button type="button" className="btn secondary" disabled={busy} onClick={onRefresh}>
          Refresh test
        </button>
        {canPreview && (
          <button type="button" className="btn secondary" disabled={busy} onClick={onPreview}>
            View captured test message
          </button>
        )}
      </div>
    </section>
  );
}
