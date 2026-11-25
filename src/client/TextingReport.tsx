import { useEffect, useState } from 'react';
import type { DeliveryCounts, PracticeReport, RecipientReport } from '../shared/texting-reports.js';
import type { Api } from './api.js';
import { csvCell } from './contact-export.js';

const metrics = {
  recipients: 'Recipients', delivered: 'Delivered', failed: 'Failed', pending: 'Pending',
  held: 'Held (within pending)', uncertain: 'Awaiting reconciliation', skipped: 'Skipped', cancelled: 'Cancelled',
  carrierReceipts: 'Mock carrier receipts', receiptSegments: 'Segments with receipts',
} satisfies Record<keyof DeliveryCounts, string>;
const keys = Object.keys(metrics) as (keyof DeliveryCounts)[];
const dateLabel = (date: string) => new Date(date).toLocaleString(undefined, { timeZone: 'UTC', timeZoneName: 'short' });
function download(name: string, rows: (string | number)[][]) {
  const lines = rows.map(row => row.map(value => csvCell(String(value))).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', lines, '\r\n'], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name + '.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function TextingReport({ api, companies, manage }: { api: Api; companies: { id: string; name: string }[]; manage: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [selected, setSelected] = useState(companies[0]?.id ?? '');
  const [from, setFrom] = useState(today.slice(0, 8) + '01'), [through, setThrough] = useState(today);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<PracticeReport | null>(null);
  const [campaignCursor, setCampaignCursor] = useState<string>();
  const [inspected, setInspected] = useState<{ id: string; cursor?: string; result: RecipientReport } | null>(null);
  const companyId = companies.some(company => company.id === selected) ? selected : '';
  const hasReport = !!report, sendId = manage ? inspected?.id : undefined, recipientCursor = inspected?.cursor;
  useEffect(() => {
    if (!open || !hasReport || busy || !companyId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const [next, details] = await Promise.all([
            api.call<PracticeReport>('sms.practiceReport', { companyId, from, through, cursor: campaignCursor }),
            sendId ? api.call<RecipientReport>('sms.practiceRecipients', { companyId, sendId, cursor: recipientCursor }) : null,
          ]);
          if (stopped) return;
          setReport(next); setError('');
          if (sendId && details) setInspected({ id: sendId, cursor: recipientCursor, result: details });
        } catch (failure) {
          if (!stopped) setError(failure instanceof Error ? failure.message : 'Could not refresh texting results.');
        }
      }
      if (!stopped) timer = setTimeout(poll, 60_000);
    };
    timer = setTimeout(poll, 60_000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [api, busy, campaignCursor, companyId, from, hasReport, open, recipientCursor, sendId, through]);
  const clear = () => { setReport(null); setCampaignCursor(undefined); setInspected(null); setError(''); };
  async function read(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not load texting results.'); }
    finally { setBusy(false); }
  }
  const load = (cursor?: string) => read(async () => {
    const next = await api.call<PracticeReport>('sms.practiceReport', { companyId, from, through, cursor });
    setReport(next); setCampaignCursor(cursor); setInspected(null);
  });
  const recipients = (sendId: string, cursor?: string) => read(async () => {
    const result = await api.call<RecipientReport>('sms.practiceRecipients', { companyId, sendId, cursor });
    setInspected({ id: sendId, cursor, result });
  });
  return <details className="card" onToggle={event => setOpen(event.currentTarget.open)}><summary>Practice texting results</summary>
    <form onSubmit={event => { event.preventDefault(); void load(); }}><fieldset disabled={busy}>
      <label>Company<select required value={companyId} onChange={e => { setSelected(e.target.value); clear(); }}>
        {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
      <label>Created from (UTC)<input type="date" value={from} required max={through} onChange={e => { setFrom(e.target.value); clear(); }} /></label>
      <label>Through (UTC)<input type="date" value={through} required min={from} onChange={e => { setThrough(e.target.value); clear(); }} /></label>
      <button className="btn secondary" disabled={!companyId}>{report ? 'Refresh results' : 'View results'}</button>
    </fieldset></form>
    {error && <p role="alert" className="notice error">{error}</p>}
    {busy && <p role="status">Loading results…</p>}
    {report && companyId && <><h3>Totals for the selected dates</h3>
      <dl>{keys.map(key => <div key={key}><dt>{metrics[key]}</dt><dd>{report.totals[key]}</dd></div>)}</dl>
      <button className="btn secondary" onClick={() => download('texting-totals-' + from + '-' + through,
        [keys.map(key => metrics[key]), keys.map(key => report.totals[key])])}>Download totals (CSV)</button>
      {report.campaigns.length === 0 ? <p>No campaigns were created in this date range.</p> : <>
        <h3>Campaigns</h3>
        <table><thead><tr><th>Created (UTC)</th><th>Kind</th><th>Status</th><th>Delivered</th><th>Failed</th><th>Held</th>{manage && <th>Recipients</th>}</tr></thead>
          <tbody>{report.campaigns.map(row => <tr key={row.id}><td>{dateLabel(row.created)}</td><td>{row.kind}</td><td>{row.state}</td>
            <td>{row.delivered}</td><td>{row.failed}</td><td>{row.held}</td>{manage && <td><button disabled={busy} className="btn secondary" onClick={() => void recipients(row.id)}>View {row.recipients} recipients</button></td>}</tr>)}</tbody></table>
        <button className="btn secondary" onClick={() => download('texting-campaigns-' + from + '-' + through, [
          ['Campaign ID', 'Created (UTC)', 'Kind', 'Status', ...keys.map(key => metrics[key])],
          ...report.campaigns.map(row => [row.id, row.created, row.kind, row.state, ...keys.map(key => row[key])])])}>Download displayed campaigns (CSV)</button>
        {report.next && <button className="btn secondary" disabled={busy} onClick={() => void load(report.next!)}>Next campaigns</button>}
      </>}
      {manage && inspected && <section><h3>Recipients for campaign {inspected.id}</h3>
        {inspected.result.recipients.length === 0 ? <p>No texts were queued for this campaign.</p> : <>
          <table><thead><tr><th>Phone</th><th>Outcome</th><th>Reason</th><th>Segments</th><th>Attempts</th></tr></thead>
            <tbody>{inspected.result.recipients.map(row => <tr key={row.id}><td>{row.phone}</td><td>{row.state}</td>
              <td>{row.reason?.replaceAll('_', ' ') ?? '—'}</td><td>{row.segments}</td><td>{row.attempts}</td></tr>)}</tbody></table>
          <button className="btn secondary" onClick={() => download('texting-recipients-' + inspected.id, [
            ['Phone', 'Outcome', 'Reason', 'Segments', 'Attempts', 'Updated (UTC)'],
            ...inspected.result.recipients.map(row => [row.phone, row.state, row.reason ?? '', row.segments, row.attempts, row.updated])])}>Download displayed recipients (CSV)</button>
          {inspected.result.next && <button className="btn secondary" disabled={busy} onClick={() => void recipients(inspected.id, inspected.result.next!)}>Next recipients</button>}
        </>}</section>}
    </>}
  </details>;
}
