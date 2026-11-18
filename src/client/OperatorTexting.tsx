import { useCallback, useEffect, useState } from 'react';
import { operationKey } from './api.js';
import type { PlatformApi } from './platform-api.js';

// FL-SMS-004/013: operator texting controls. Same commands as /api/operator/v1 and the operator MCP.
type Setting = { key: string; kind: string; min?: number; max?: number; required: string; description: string; platform: { value: unknown; revision: number } | null; workspace: { value: unknown; revision: number } | null };
type Registration = { mode: string; registrations: { id: string; company_id: string; legal_name: string; state: string; revision: number; rejection_reason: string | null; carrier_brand_id: string;
  steps: { step: string; state: string; attempts: number; operationKey: string; reason: string | null }[] }[]; numbers: { e164: string; state: string }[] };

export function OperatorTexting({ api, workspaceId, onError }: { api: PlatformApi; workspaceId: string; onError: (message: string) => void }) {
  const [settings, setSettings] = useState<Setting[]>([]), [scope, setScope] = useState<'platform' | 'workspace'>('platform'), [reg, setReg] = useState<Registration | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({}), [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [history, setHistory] = useState<unknown[] | null>(null);
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
      {reg.registrations.length === 0 && <p>No carrier brand yet. Create one with platform.textingCarrierBrand through the operator API or MCP.</p>}
      {reg.registrations.map(r => <article key={r.id} className="connection-row"><div>
        <strong>{r.legal_name}</strong> · {r.state.replaceAll('_', ' ')} · revision {r.revision}{r.rejection_reason ? ' · ' + r.rejection_reason : ''}
        <ul>{r.steps.map(s => <li key={s.step}>{s.step.replaceAll('_', ' ')}: {s.state}{s.attempts ? ` (${s.attempts} call${s.attempts > 1 ? 's' : ''})` : ''}{s.reason ? ' · ' + s.reason : ''} <code>{s.operationKey}</code></li>)}</ul>
        <div className="button-row">
          {['draft', 'rejected'].includes(r.state) && <button className="btn" disabled={busy || reason.trim().length < 12} onClick={() => void run(() => api.call('platform.textingSubmit', { operationKey: operationKey(), workspaceId, registrationId: r.id, reason }))}>Submit registration</button>}
          {reg.mode === 'live' && (['brand', 'campaign', 'number'] as const).map(step => <button key={step} className="btn secondary" disabled={busy || reason.trim().length < 12}
            onClick={() => void run(() => api.call('platform.textingApprove', { operationKey: operationKey(), workspaceId, registrationId: r.id, step, costNote: 'Approved in the control room; see Twilio pricing for ' + step + '.', reason }))}>Approve {step}</button>)}
          {reg.mode === 'mock' && <>
            <button className="btn secondary" disabled={busy} onClick={() => void run(() => api.call('platform.textingMock', { operationKey: operationKey(), workspaceId, action: { kind: 'brand', registrationId: r.id, status: 'APPROVED' } }))}>Simulate brand approval</button>
            <button className="btn secondary" disabled={busy} onClick={() => void run(() => api.call('platform.textingMock', { operationKey: operationKey(), workspaceId, action: { kind: 'campaign', registrationId: r.id, status: 'VERIFIED' } }))}>Simulate campaign approval</button>
          </>}
          <button className="btn secondary" disabled={busy} onClick={() => void run(() => api.call('platform.textingProcess', { operationKey: operationKey(), workspaceId }))}>Run worker pass</button>
        </div></div></article>)}
      {reg.numbers.map(n => <p key={n.e164}>Number {n.e164} · {n.state}</p>)}
    </section>}
  </>;
}
