import { useCallback, useEffect, useState } from 'react';
import { operationKey } from './api.js';
import type { PlatformApi } from './platform-api.js';

// FL-SMS-004/013: operator texting controls. Same commands as /api/operator/v1 and the operator MCP.
type Setting = { key: string; kind: string; min?: number; max?: number; required: string; description: string; platform: { value: unknown; revision: number } | null; workspace: { value: unknown; revision: number } | null };
type Registration = { mode: string; settingsNeeded?: string[]; registrations: { id: string; company_id: string; legal_name: string; state: string; revision: number; rejection_reason: string | null; carrier_brand_id: string;
  onboardingRevision?: number | null; onboardingReview?: string | null; probationState?: string | null;
  steps: { step: string; state: string; attempts: number; operationKey: string; reason: string | null }[] }[]; numbers: { e164: string; state: string }[] };

export function OperatorTexting({ api, workspaceId, onError }: { api: PlatformApi; workspaceId: string; onError: (message: string) => void }) {
  const [settings, setSettings] = useState<Setting[]>([]), [scope, setScope] = useState<'platform' | 'workspace'>('platform'), [reg, setReg] = useState<Registration | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({}), [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [history, setHistory] = useState<unknown[] | null>(null);
  const [testPhone, setTestPhone] = useState(''), [reply, setReply] = useState('YES'), [mockResult, setMockResult] = useState('');
  const load = useCallback(async () => {
    try {
      setSettings(await api.call<Setting[]>('platform.textingSettings', workspaceId ? { workspaceId } : {}));
      if (workspaceId) setReg(await api.call<Registration>('platform.textingRegistration', { workspaceId }));
    } catch (e) { onError(e instanceof Error ? e.message : 'Texting controls are unavailable.'); }
  }, [api, workspaceId, onError]);
  useEffect(() => { void load(); }, [load]);
  const run = async (action: () => Promise<unknown>) => { setBusy(true); try { await action(); await load(); } catch (e) { onError(e instanceof Error ? e.message : 'The texting action failed.'); } finally { setBusy(false); } };
  const save = (s: Setting) => run(async () => {
    const raw = edits[s.key] ?? '';
    const value = raw.trim() === '' ? null : s.kind === 'int' ? Number(raw) : raw.split(',').map(v => v.trim()).filter(Boolean);
    const current = scope === 'platform' ? s.platform : s.workspace;
    await api.call('platform.textingSetSetting', { operationKey: operationKey(), key: s.key, workspaceId: scope === 'platform' ? null : workspaceId, value, expectedRevision: current?.revision ?? 0, reason });
    setEdits(e => ({ ...e, [s.key]: '' }));
  });
  const show = (v: unknown) => v === undefined || v === null ? 'unset' : Array.isArray(v) ? v.join(', ') : String(v);
  return <>
    <section className="card"><h2>Texting settings</h2>
      <p>Bounds are fixed in code; values live here and take effect without a deployment. Every change is audited with the old and new value. Fraud-control values stay out of the repository.</p>
      <label>Apply to<select value={scope} onChange={e => setScope(e.target.value as 'platform' | 'workspace')}><option value="platform">Every workspace</option>{workspaceId && <option value="workspace">Only {workspaceId}</option>}</select></label>
      <label>Reason for change<input minLength={12} maxLength={400} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <div className="operator-table-wrap"><table className="operator-health"><thead><tr><th>Setting</th><th>Platform</th><th>Workspace</th><th>New value</th><th /></tr></thead><tbody>
        {settings.map(s => <tr key={s.key}><td><strong>{s.key}</strong><br /><span className="help">{s.description}{s.kind === 'int' ? ` (${s.min}–${s.max})` : ''}{s.required !== 'optional' ? ` · needed for ${s.required}` : ''}</span></td>
          <td>{show(s.platform?.value)}</td><td>{show(s.workspace?.value)}</td>
          <td><input aria-label={'New value for ' + s.key} value={edits[s.key] ?? ''} placeholder={s.kind === 'int' ? 'number, blank clears' : 'comma-separated, blank clears'} onChange={e => setEdits(x => ({ ...x, [s.key]: e.target.value }))} /></td>
          <td><button className="btn secondary" disabled={busy || reason.trim().length < 12 || (scope === 'workspace' && !workspaceId)} onClick={() => void save(s)}>Save</button></td></tr>)}
      </tbody></table></div>
      <button className="btn secondary" onClick={() => void api.call<unknown[]>('platform.textingSettingHistory', workspaceId ? { workspaceId } : {}).then(setHistory).catch(e => onError(e.message))}>Show change history</button>
      {history && <pre className="token-output">{JSON.stringify(history, null, 2)}</pre>}
    </section>
    {workspaceId && reg && <section className="card"><h2>Carrier registration · {workspaceId}</h2>
      <p className="badge">Twilio client: {reg.mode}{reg.mode === 'live' ? ' · each brand, campaign and number step needs a separate approval' : ' · simulated, nothing is filed with carriers'}</p>
      {!!reg.settingsNeeded?.length && <p className="badge">A step is waiting to be checked again. Set {reg.settingsNeeded.join(', ')} above so it can be retried.</p>}
      {reg.registrations.length === 0 && <p>No carrier brand yet. Create one with platform.textingCarrierBrand through the operator API or MCP.</p>}
      {reg.registrations.map(r => <article key={r.id} className="connection-row"><div>
        <strong>{r.legal_name}</strong> · {r.state.replaceAll('_', ' ')} · revision {r.revision}{r.rejection_reason ? ' · ' + r.rejection_reason : ''}
        {r.onboardingReview && <p>Enrollment review required · {r.onboardingReview.replaceAll('_', ' ')}</p>}
        {r.probationState && <p>Probation · {r.probationState}</p>}
        <ul>{r.steps.map(s => <li key={s.step}>{s.step.replaceAll('_', ' ')}: {s.state}{s.attempts ? ` (${s.attempts} call${s.attempts > 1 ? 's' : ''})` : ''}{s.reason ? ' · ' + s.reason : ''} <code>{s.operationKey}</code></li>)}</ul>
        <div className="button-row">
          {!r.onboardingRevision && ['draft', 'rejected'].includes(r.state) && <button className="btn" disabled={busy || reason.trim().length < 12} onClick={() => void run(() => api.call('platform.textingSubmit', { operationKey: operationKey(), workspaceId, registrationId: r.id, reason }))}>Submit registration</button>}
          {r.onboardingRevision && r.onboardingReview && <button className="btn secondary" disabled={busy || reason.trim().length < 12} onClick={() => void run(() => api.call('platform.textingOnboardingReview', {
            operationKey: operationKey(), workspaceId, companyId: r.company_id, expectedRevision: r.onboardingRevision, action: 'request_correction', reason,
          }))}>Return enrollment for correction</button>}
          {r.onboardingRevision && r.state === 'approved' && r.probationState !== 'complete' && <button className="btn secondary" disabled={busy || reason.trim().length < 12} onClick={() => void run(() => api.call('platform.textingOnboardingReview', {
            operationKey: operationKey(), workspaceId, companyId: r.company_id, expectedRevision: r.onboardingRevision, action: 'complete_probation', reason,
          }))}>End practice probation</button>}
          {reg.mode === 'live' && (['brand', 'campaign', 'number'] as const).map(step => <button key={step} className="btn secondary" disabled={busy || reason.trim().length < 12}
            onClick={() => void run(() => api.call('platform.textingApprove', { operationKey: operationKey(), workspaceId, registrationId: r.id, step, costNote: 'Approved in the control room; see Twilio pricing for ' + step + '.', reason }))}>Approve {step}</button>)}
          {reg.mode === 'mock' && <>
            <button className="btn secondary" disabled={busy} onClick={() => void run(() => api.call('platform.textingMock', { operationKey: operationKey(), workspaceId, action: { kind: 'brand', registrationId: r.id, status: 'APPROVED' } }))}>Simulate brand approval</button>
            <button className="btn secondary" disabled={busy} onClick={() => void run(() => api.call('platform.textingMock', { operationKey: operationKey(), workspaceId, action: { kind: 'campaign', registrationId: r.id, status: 'VERIFIED' } }))}>Simulate campaign approval</button>
          </>}
          <button className="btn secondary" disabled={busy} onClick={() => void run(() => api.call('platform.textingProcess', { operationKey: operationKey(), workspaceId }))}>Run worker pass</button>
        </div></div></article>)}
      {reg.numbers.map(n => <p key={n.e164}>Number {n.e164} · {n.state}</p>)}
      {reg.mode === 'mock' && reg.numbers.some(n => n.state === 'active') && <fieldset disabled={busy}>
        <legend>Simulated carrier delivery</legend>
        <label>Fictional subscriber number<input type="tel" placeholder="+13035550123" value={testPhone} onChange={event => setTestPhone(event.target.value)} /></label>
        <label>Subscriber reply<select value={reply} onChange={event => setReply(event.target.value)}>{['YES','STOP','START'].map(word => <option key={word}>{word}</option>)}</select></label>
        {reg.numbers.filter(n => n.state === 'active').map(n => <button key={n.e164} className="btn secondary" disabled={!/^\+1[2-9]\d{2}55501\d{2}$/.test(testPhone)} onClick={() => void run(async () => {
          setMockResult('');
          await api.call('platform.textingMock', { operationKey: operationKey(), workspaceId, action: { kind:'inbound', from:testPhone, to:n.e164, body:reply } });
          setMockResult(`Simulated ${reply} to ${n.e164}. Check the subscriber’s consent history.`);
        })}>Simulate reply to {n.e164}</button>)}
        <button className="btn secondary" onClick={() => void run(async () => {
          setMockResult('');
          await api.call('platform.textingMock', { operationKey:operationKey(), workspaceId, action:{ kind:'fault', target:'send', faults:['timeout_after_commit'] } });
          setMockResult('The next simulated text in this workspace will time out after carrier acceptance.');
        })}>Simulate timeout on next text</button>
        {mockResult && <p role="status">{mockResult}</p>}
      </fieldset>}
    </section>}
  </>;
}
