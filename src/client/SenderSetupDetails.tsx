import type { SenderSetupView } from '../shared/sender-setup.js';

interface Props {
  view: SenderSetupView;
  busy: boolean;
  onReview: () => void;
  onApprove: () => void;
  onRefresh: () => void;
}

export function SenderSetupDetails({ view, busy, onReview, onApprove, onRefresh }: Props) {
  return (
    <section className="card" aria-labelledby="sender-setup-title">
      <h2 id="sender-setup-title">Sending domain setup</h2>{view.captured&&<p className="notice">Captured staging exercise. These DNS records are unusable examples; do not add them to your domain. No real domain or email is created.</p>}

      {view.alreadyConfigured && (
        <p role="note">A sender route is configured. Current domain, consent and service checks still apply.</p>
      )}

      {view.gaps.length > 0 && (
        <>
          <h3>Setup gaps</h3>
          <ul>
            {view.gaps.map((gap, i) => (
              <li key={i}>{gap}</li>
            ))}
          </ul>
        </>
      )}

      {view.setup && (
        <div className="card">
          <h3>Current setup</h3>
          <p>State: {view.setup.state}</p>
          <p>From email: {view.setup.fromEmail}</p>
          <p>Domain: {view.setup.domain}</p>

          {view.setup.dns.length > 0 && (
            <>
              <h4>DNS records</h4>
              <div className="sender-dns-table"><table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col">Value</th>
                    <th scope="col">Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {view.setup.dns.map((d, i) => (
                    <tr key={i}>
                      <td>{d.name}</td>
                      <td>{d.type}</td>
                      <td>{d.value}</td>
                      <td>{typeof d.priority === 'number' ? String(d.priority) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </>
          )}

          {view.setup.dns.length>0&&<p className="help">
            Add the exact provider records listed above to your DNS provider. Do not replace or remove
            existing mail records (MX, SPF, DKIM or DMARC). If the same hostname already has a conflicting record, contact support before editing it.
            Flockletter ownership proof and provider verification are separate checks. Status checks run at most once per minute.
          </p>}

          {view.setup.state === 'uncertain' && (
            <p role="alert">
              This setup is in an uncertain state. Do not create another domain or submit a new review.
              Support must reconcile the existing request before further action can be taken.
            </p>
          )}

          {view.setup.state !== 'reviewed' && (
            <div className="actions">
              <button className="btn secondary" disabled={busy} onClick={onRefresh}>
                Refresh existing setup
              </button>
            </div>
          )}
        </div>
      )}

      <div className="actions">
        {(!view.setup || view.setup.state==='held' || view.setup.senderRevision!==view.senderRevision) && view.setup?.state!=='uncertain' && view.setup?.state!=='creating' && (
          <button
            className="btn"
            disabled={busy || !view.enabled || view.senderRevision === null}
            onClick={onReview}
          >
            Review sender setup
          </button>
        )}

        {view.setup && view.setup.state === 'reviewed' && (
          <button
            className="btn"
            disabled={busy || !view.ownershipVerified || !view.enabled}
            onClick={onApprove}
          >
            Approve reviewed setup
          </button>
        )}
      </div>
    </section>
  );
}
