import { useEffect, useRef, useState } from 'react';
import type { Campaign } from '../shared/contracts.js';
import type { Rehearsal } from '../shared/rehearsal.js';
import { alertGuidance, type RehearsalAlert, type WorkspaceActivity } from '../shared/workspace-activity.js';
import type { Api } from './api.js';
function RehearsalDetails({ api, alert }: { api: Api; alert: RehearsalAlert }) {
  const [open, setOpen] = useState(false), [report, setReport] = useState<Rehearsal>(), [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let current = true;
    api.call<Rehearsal>('rehearsal.report', { brandId:alert.brandId, id:alert.rehearsalId })
      .then((value) => { if (current) setReport(value); })
      .catch(() => { if (current) setError('Rehearsal details could not load. Close and reopen to retry.'); });
    return () => { current = false; };
  }, [open, api, alert.brandId, alert.rehearsalId]);
  return <details onToggle={(event) => {
    const opened = event.currentTarget.open;
    if (!opened) { setReport(undefined); setError(''); }
    setOpen(opened);
  }}>
    <summary>Inspect affected rehearsal</summary>
    {error ? <p role="alert">{error}</p> : report ?
      <p>Version {report.version} · {report.state} · due {new Date(report.dueAt).toLocaleString()} ·{' '}
        {report.pending} pending · {report.uncertain} uncertain · {report.accepted} accepted</p>
      : open && <p role="status">Loading rehearsal…</p>}
  </details>;
}
export function Operations({ api, openCampaign }: { api: Api; openCampaign: (campaign: Campaign) => void }) {
  const [data, setData] = useState<WorkspaceActivity>(),
    [error, setError] = useState(''),
    [load, reload] = useState(0);
  const [navigationError, setNavigationError] = useState('');
  const [opening, setOpening] = useState(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setData(undefined);
    setError('');
    api
      .call<WorkspaceActivity>('workspace.operations', {})
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e:unknown) => {
        if (active) setError(e instanceof Error ? e.message : 'Workspace activity could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, [api, load]);
  async function inspect(id: string) {
    if (opening) return;
    setOpening(true);
    setNavigationError('');
    try {
      const campaign = await api.call<Campaign>('campaign.get', { id });
      if (mounted.current) openCampaign(campaign);
    } catch (cause) {
      if (mounted.current) setNavigationError(cause instanceof Error ? cause.message : 'The campaign could not be opened.');
    } finally {
      if (mounted.current) setOpening(false);
    }
  }
  return (
    <section className="card" aria-label="Workspace activity">
      <h2>Workspace activity</h2>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">Checking workspace activity…</p>}
      {data && (
        <>
          {data.checkedAt && <p>Checked <time dateTime={data.checkedAt}>{new Date(data.checkedAt).toLocaleString()}</time></p>}
          <p>
            {data.captures.queued} queued rehearsals · {data.captures.overdue} due for over 15 minutes ·{' '}
            {data.captures.blocked} blocked · {data.captures.captured} captured messages
          </p>
          <h3>Staging rehearsal alerts</h3>
          {!data.alerts ? <p>Alert details are unavailable on this version.</p> : data.alerts.length ? <ul>
            {data.alerts.map((alert) => <li key={alert.brandId + '/' + alert.kind}>
              <h4>{alertGuidance[alert.kind].title} ({alert.count})</h4>
              <p>{alert.brandName} · Sample campaign version {alert.version}</p>
              <p>{alert.nextAction}</p>
              <RehearsalDetails api={api} alert={alert} />
              <button type="button" className="btn secondary" disabled={opening}
                onClick={() => void inspect(alert.campaignId)}>Open affected campaign</button>
            </li>)}
          </ul> : <p>No rehearsal alerts were found.</p>}
          {navigationError && <p role="alert">{navigationError}</p>}
          {data.events.length ? (
            <ol>
              {data.events.map((item) => (
                <li key={item.id}>
                  <time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time> · {item.action} ·{' '}
                  {item.actor}
                </li>
              ))}
            </ol>
          ) : (
            <p>No workspace activity yet.</p>
          )}
        </>
      )}
      <button
        className="btn secondary"
        onClick={() => {
          reload((v) => v + 1);
        }}
      >
        Refresh activity
      </button>
    </section>
  );
}
