import type { SenderSetupView } from '../shared/sender-setup.js';

interface Props {
  view: SenderSetupView;
  busy: boolean;
  onRecover: (domainId:string) => void;
  onReview: () => void;
  onApprove: () => void;
  onRefresh: () => void;
}

export function SenderSetupDetails({ view, busy, onReview, onApprove, onRefresh, onRecover }: Props) {
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
              <h4>DNS records for {view.setup.domain}</h4>
              {!view.captured && <p>In Cloudflare, open DNS → Records for {view.setup.domain} and add each row below.
                Use Auto for TTL. For CNAME records, choose DNS only.</p>}
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
                      <td><code>{d.value}</code></td>
                      <td>{typeof d.priority === 'number' ? String(d.priority) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </>
          )}

          {view.setup.dns.length>0&&<p className="help">
            Match the name and type on each row. The MX priority applies to the sending subdomain. Keep your existing inbox routing.
            After publishing the records, choose Refresh existing setup. Verification checks run at most once per minute.
          </p>}

          {view.setup.state === 'uncertain' && (
            <form onSubmit={event=>{
              event.preventDefault();
              onRecover(String(new FormData(event.currentTarget).get('domainId')).trim());
            }}>
              <p role="alert">Resend may already have created this domain. Enter its ID from the Resend domain page to reconnect it.</p>
              <label>Resend domain ID <input name="domainId" required maxLength={36} pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" /></label>
              <button className="btn" disabled={busy || !view.enabled || !view.ownershipVerified}>Reconnect existing domain</button>
            </form>
          )}

          {view.setup.state !== 'reviewed' && view.setup.state !== 'uncertain' && (
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
