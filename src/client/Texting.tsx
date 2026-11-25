import { TextingPracticePlan } from './TextingPlan.js';
import { TextingReport } from './TextingReport.js';
import type { PracticePlanStatus } from '../shared/texting-commercial.js';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { operationKey, type Api } from './api.js';
import { blockedCharacters, encodeText, plainText } from '../shared/texting.js';
import { TextingOnboarding } from './TextingOnboarding.js';

// FL-SMS-007/008/011/015: the workspace texting page. Every action calls the same commands as the API and MCP.
type Status = { mode: string; practicePlan?: PracticePlanStatus | null; onboardingAvailable?: boolean; profile: null | { shortName: string | null; notificationEmail: string | null; timeZone: string; phoneField: boolean; birthdayField: boolean; anniversaryField: boolean; anniversaryLabel: string; nameField: boolean; phoneOnlySignup: boolean; revision: number };
  companies: { id: string; name: string; registration: string; number: string | null; canSend: boolean; sendingHold?: string | null }[]; usage: { month: string; used: number; reserved: number; allowance: number | null }; settingsNeeded: string[] };
type Review = { id: string; revision: number; preview: string; encoding: string; perSegment: number; recipients: number; segments: number; gsm7Recipients: number; ucs2Recipients: number;
  allowance: { total: number | null; remaining: number | null; afterSend: number | null }; daysNeeded: number | null; links: { link: string; allowed: boolean }[]; gaps: string[]; digest?: string };
type Contact = { id: string; phone: string; name: string | null; textable: boolean; notTextableReason: string | null; consents: { companyId: string; state: string }[] };
const gapText: Record<string, string> = {
  texting_plan_cancelled: 'The practice texting plan has been cancelled.', texting_plan_pending: 'The practice plan is waiting for registration approval.',
  texting_spend_cap: 'The workspace has reached its monthly practice texting spending cap.',
  link_not_allowed: 'A link points outside your verified domain and Flockletter-hosted pages.', short_name_required: 'Set a short name before sending links.',
  text_too_long: 'The text is longer than 10 segments for some recipients.', no_opted_in_recipients: 'No contacts have confirmed texts from this company yet.',
  registration_not_approved: 'Carrier registration for this company is not approved yet.', texting_setting_required: 'The platform operator has not finished texting settings.',
  allowance_insufficient: 'This send needs more segments than remain this month.',
  probation_settings_required: 'An operator must configure probation limits before this broadcast can send.',
  probation_suspended: 'This sender needs operator review before sending can resume.',
  probation_paused: 'Sending is paused. Review the sender before restarting probation.',
  probation_template_required: 'During probation, use one of your approved campaign message examples.',
};

export function Texting({ api, manage = true, onOpenAudience }: { api: Api; manage?: boolean; onOpenAudience?: () => void }) {
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const latestRequest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latestRequest.current;
    try {
      const next = await api.call<Status>('sms.status', {});
      if (request === latestRequest.current) {
        setStatus(next);
        setLoadError('');
      }
    } catch (failure) {
      if (request === latestRequest.current) setLoadError(failure instanceof Error ? failure.message : 'Texting is unavailable.');
    }
  }, [api]);
  useEffect(() => {
    void load();
    return () => { latestRequest.current++; };
  }, [load]);
  const pending = status?.companies.some(company => ['provisioning', 'brand_pending', 'campaign_pending'].includes(company.registration));
  const pollMs = pending ? 5000 : 30000;
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.visibilityState === 'visible') await load();
      if (!stopped) timer = setTimeout(poll, pollMs);
    };
    timer = setTimeout(poll, pollMs);
    return () => { stopped = true; clearTimeout(timer); };
  }, [load, pollMs]);
  const act = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); try { await action(); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'The action failed.'); } finally { setBusy(false); } };
  if (!status) return <section className="card"><h1 className="page-heading">Texting</h1>{loadError ? <div role="alert" className="notice error">{loadError}</div> : <p>Loading texting…</p>}</section>;
  return <>
    <h1 className="page-heading">Texting</h1>
    <p className="page-intro">Text customers who confirmed by replying YES. {status.mode === 'mock' ? 'Staging uses a simulated carrier: no real text is sent.' : ''}</p>
    {(error || loadError) && <div role="alert" className="notice error">{error || loadError}</div>}
    <section className="card"><h2>Companies and numbers</h2>
      {status.companies.map(c => <p key={c.id}><strong>{c.name}</strong> · registration {c.registration.replaceAll('_', ' ')} {c.number ? '· ' + c.number : ''} {c.sendingHold ? '· ' + (gapText[c.sendingHold] ?? 'Sending is on hold.') : c.canSend ? '· ready to send' : ''}</p>)}
      <p className="help">Segments this month: {status.usage.used} used, {status.usage.reserved} in progress{status.usage.allowance !== null ? `, of ${status.usage.allowance}` : ''}.</p>
      {status.settingsNeeded.length > 0 && <p className="notice">Waiting for platform settings: {status.settingsNeeded.join(', ')}.</p>}
    </section>
    {manage && status.onboardingAvailable && <TextingOnboarding onOpenAudience={onOpenAudience} api={api} companies={status.companies} refreshCompanies={load} />}
    {manage && status.practicePlan && <TextingPracticePlan key={status.practicePlan.revision} api={api} busy={busy} act={act} plan={status.practicePlan} />}
    {status.onboardingAvailable && status.companies.length > 0 && <TextingReport key={status.companies.map(company => company.id).join(',')} api={api} companies={status.companies} manage={manage} />}
    {manage && <Profile api={api} status={status} busy={busy} act={act} />}
    {status.companies.length > 0
      ? <Composer api={api} companies={status.companies} busy={busy} act={act} />
      : <p className="notice">You need access to all brands in a company to text its audience.</p>}
    {manage && <Contacts api={api} companies={status.companies} busy={busy} act={act} />}
    {manage && <Inbound api={api} />}
  </>;
}
type Act = (action: () => Promise<unknown>) => Promise<void>;
function Profile({ api, status, busy, act }: { api: Api; status: Status; busy: boolean; act: Act }) {
  const p = status.profile;
  const [form, setForm] = useState({ shortName: p?.shortName ?? '', notificationEmail: p?.notificationEmail ?? '', timeZone: p?.timeZone ?? 'America/New_York', phoneField: p?.phoneField ?? false, birthdayField: p?.birthdayField ?? false, anniversaryField: p?.anniversaryField ?? false, anniversaryLabel: p?.anniversaryLabel ?? 'Anniversary', nameField: p?.nameField ?? false, phoneOnlySignup: p?.phoneOnlySignup ?? false });
  const key = useRef(operationKey());
  const [saved, setSaved] = useState(false);
  const save = (e: FormEvent) => { e.preventDefault(); setSaved(false); void act(async () => { await api.call('sms.configure', { operationKey: key.current, expectedRevision: p?.revision ?? 1, ...form, shortName: form.shortName || undefined, notificationEmail: form.notificationEmail || null }); key.current = operationKey(); setSaved(true); }); };
  const set = (patch: Partial<typeof form>) => { setForm(f => ({ ...f, ...patch })); key.current = operationKey(); setSaved(false); };
  return <section className="card"><h2>Texting settings</h2><form onSubmit={save}><fieldset disabled={busy}>
    <label>Short name for links (flkl.cc/<em>name</em>)<input value={form.shortName} pattern="[a-z0-9][a-z0-9-]{1,28}[a-z0-9]" onChange={e => set({ shortName: e.target.value.toLowerCase() })} /></label>
    <label>Email for text replies<input type="email" value={form.notificationEmail} onChange={e => set({ notificationEmail: e.target.value })} /></label>
    <label>Workspace time zone<select value={form.timeZone} onChange={e => set({ timeZone: e.target.value })}>{['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'].map(z => <option key={z}>{z}</option>)}</select></label>
    <fieldset><legend>Optional sign-up page fields (never required)</legend>
      <label className="asset-option"><input type="checkbox" checked={form.nameField} onChange={e => set({ nameField: e.target.checked })} />First and last name</label>
      <label className="asset-option"><input type="checkbox" checked={form.phoneField} onChange={e => set({ phoneField: e.target.checked, ...(e.target.checked ? {} : { phoneOnlySignup: false }) })} />Mobile number, with a separate unchecked texting checkbox</label>
      {form.phoneField && <label className="asset-option"><input type="checkbox" checked={form.phoneOnlySignup} onChange={e => set({ phoneOnlySignup: e.target.checked })} />Let people sign up for texts without an email (they still need an email or a ticked text box)</label>}
      <label className="asset-option"><input type="checkbox" checked={form.birthdayField} onChange={e => set({ birthdayField: e.target.checked })} />Birthday (month and day)</label>
      <label className="asset-option"><input type="checkbox" checked={form.anniversaryField} onChange={e => set({ anniversaryField: e.target.checked })} />Anniversary</label>
      {form.anniversaryField && <label>Anniversary label<input maxLength={40} value={form.anniversaryLabel} onChange={e => set({ anniversaryLabel: e.target.value })} /></label>}
    </fieldset>
    <button className="btn" type="submit">Save texting settings</button>
    {saved && <p role="status" className="notice success">Texting settings saved.</p>}</fieldset></form></section>;
}
function Composer({ api, companies, busy, act }: { api: Api; companies: Status['companies']; busy: boolean; act: Act }) {
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? ''), [body, setBody] = useState(''), [draft, setDraft] = useState<{ id: string; revision: number } | null>(null);
  const [review, setReview] = useState<Review | null>(null), [schedule, setSchedule] = useState(''), [phone, setPhone] = useState(''), [code, setCode] = useState(''), [note, setNote] = useState('');
  const local = encodeText(body), blocked = blockedCharacters(plainText(body));
  const saveDraft = () => act(async () => { const saved = await api.call<{ id: string; revision: number }>('sms.draft', { operationKey: operationKey(), companyId, body, ...(draft ? { id: draft.id, expectedRevision: draft.revision } : {}) }); setDraft(saved); setReview(null); });
  return <section className="card"><h2>Send a text</h2>
    <label>Company<select value={companyId} onChange={e => { setCompanyId(e.target.value); setDraft(null); setReview(null); }}>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    <label>Message <span className="help">(use {'{{name|friend}}'} for first name; the business name and “Reply STOP to opt out.” are added when missing)</span>
      <textarea maxLength={1600} value={body} onChange={e => { setBody(e.target.value); setReview(null); }} /></label>
    <p className="help">{local.units} characters · {local.segments} segment{local.segments === 1 ? '' : 's'} at {local.perSegment} characters each ({local.encoding === 'gsm7' ? 'standard' : 'extended characters'}). Counts are checked again for each recipient.</p>
    {blocked.length > 0 && <p className="notice error">Remove emoji and decorative symbols: {blocked.join(' ')}</p>}
    <div className="button-row">
      <button className="btn secondary" disabled={busy || !body || blocked.length > 0} onClick={() => void saveDraft()}>{draft ? 'Save changes' : 'Save draft'}</button>
      <button className="btn secondary" disabled={busy || !draft} onClick={() => void act(async () => setReview(await api.call<Review>('sms.review', { id: draft!.id, expectedRevision: draft!.revision })))}>Review before sending</button>
    </div>
    {review && <div className="notice"><p><strong>{review.recipients}</strong> recipients · <strong>{review.segments}</strong> segments ({review.ucs2Recipients} use the 70-character limit)
      {review.allowance.remaining !== null && ` · ${review.allowance.remaining} segments left this month, ${review.allowance.afterSend} after this send`}
      {review.daysNeeded && review.daysNeeded > 1 && ` · takes about ${review.daysNeeded} days at your daily limit`}.</p>
      <p className="help">Example: {review.preview}</p>
      {review.gaps.map(g => <p key={g} className="notice error">{gapText[g] ?? g}</p>)}
      <label>Schedule (optional)<input type="datetime-local" value={schedule} onChange={e => setSchedule(e.target.value)} /></label>
      <button className="btn" disabled={busy || review.gaps.length > 0} onClick={() => void act(async () => { await api.call('sms.confirm', { operationKey: operationKey(), id: review.id, expectedRevision: review.revision, digest: review.digest, ...(schedule ? { scheduledAt: new Date(schedule).toISOString() } : {}) }); setNote(schedule ? 'Scheduled.' : 'Sending. Texts go out within quiet hours and your daily limit.'); setDraft(null); setReview(null); setBody(''); })}>
        {schedule ? 'Schedule this text' : 'Send this text now'}</button></div>}
    <h3>Test on your own phone</h3>
    <div className="button-row"><input type="tel" placeholder="Your mobile number" value={phone} onChange={e => setPhone(e.target.value)} />
      <button className="btn secondary" disabled={busy || !phone} onClick={() => void act(async () => { await api.call('sms.verifyPhone', { operationKey: operationKey(), phone }); setNote('Code sent.'); })}>Send code</button>
      <input inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code} onChange={e => setCode(e.target.value)} />
      <button className="btn secondary" disabled={busy || code.length !== 6} onClick={() => void act(async () => { const r = await api.call<{ verified: boolean }>('sms.confirmPhone', { operationKey: operationKey(), code }); setNote(r.verified ? 'Phone verified.' : 'That code did not match.'); })}>Verify</button>
      <button className="btn secondary" disabled={busy || !draft} onClick={() => void act(async () => { const r = await api.call<{ remainingToday: number }>('sms.testSend', { operationKey: operationKey(), id: draft!.id, expectedRevision: draft!.revision }); setNote(`Test sent. ${r.remainingToday} left today.`); })}>Send test</button></div>
    {note && <p role="status">{note}</p>}
  </section>;
}
function Contacts({ api, companies, busy, act }: { api: Api; companies: Status['companies']; busy: boolean; act: Act }) {
  const [filter, setFilter] = useState<'all' | 'not_textable' | 'opted_out' | 'pending'>('all'), [items, setItems] = useState<Contact[]>([]);
  const [phone, setPhone] = useState(''), [name, setName] = useState(''), [warning, setWarning] = useState('');
  const load = useCallback(async () => setItems((await api.call<{ contacts: Contact[] }>('sms.contacts', { filter })).contacts), [api, filter]);
  useEffect(() => { void load().catch(() => undefined); }, [load]);
  const add = (acknowledgeOptOut: boolean) => act(async () => {
    try { await api.call('sms.addContact', { operationKey: operationKey(), companyId: companies[0]?.id, phone, ...(name ? { name } : {}), acknowledgeOptOut }); setWarning(''); setPhone(''); setName(''); }
    catch (e) { if (e instanceof Error && /opted out/.test(e.message)) { setWarning(e.message); return; } throw e; }
    await load();
  });
  return <section className="card"><h2>Text contacts</h2>
    <p className="help">Adding a number never gives consent. Contacts are texted only after they check the box on your sign-up page and reply YES.</p>
    <div className="button-row"><input type="tel" placeholder="Mobile number" value={phone} onChange={e => setPhone(e.target.value)} /><input placeholder="Name (optional)" value={name} onChange={e => setName(e.target.value)} />
      <button className="btn secondary" disabled={busy || !phone} onClick={() => void add(false)}>Add contact</button></div>
    {warning && <div className="notice"><p>{warning}</p><button className="btn" disabled={busy} onClick={() => void add(true)}>Add as pending re-enrollment</button></div>}
    <label>Show<select value={filter} onChange={e => setFilter(e.target.value as typeof filter)}><option value="all">All</option><option value="not_textable">Not textable</option><option value="opted_out">Opted out</option><option value="pending">Pending</option></select></label>
    <table className="operator-health"><thead><tr><th>Number</th><th>Name</th><th>Status</th></tr></thead><tbody>{items.map(c => <tr key={c.id}><td>{c.phone}</td><td>{c.name ?? ''}</td>
      <td>{c.textable ? c.consents.map(s => s.state.replaceAll('_', ' ')).join(', ') || 'no consent' : 'not textable (' + (c.notTextableReason ?? '').replaceAll('_', ' ') + ')'}</td></tr>)}</tbody></table>
  </section>;
}
function Inbound({ api }: { api: Api }) {
  const [items, setItems] = useState<{ id: string; from: string; contactName: string | null; body: string; classification: string; receivedAt: string; forwardState: string }[]>([]);
  useEffect(() => { void api.call<typeof items>('sms.inbound', {}).then(setItems).catch(() => undefined); }, [api]);
  return <section className="card"><h2>Replies</h2>{items.length ? items.map(i => <p key={i.id}><strong>{i.contactName ?? i.from}</strong> · {new Date(i.receivedAt).toLocaleString()} · {i.classification.replaceAll('_', ' ')}{i.forwardState === 'uncertain' && ' · email acceptance unknown'}{i.forwardState === 'failed' && ' · email forwarding failed'}<br />{i.body}</p>) : <p>No replies yet.</p>}</section>;
}
