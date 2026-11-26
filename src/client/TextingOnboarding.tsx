import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { twilioBusinessTypes, twilioIndustries } from '../shared/texting-business.js';
import type { DraftAccess, EnrollmentDraftFields, OnboardingBusiness, OnboardingView } from '../shared/texting-onboarding.js';
import { TextingPlanChoice } from './TextingPlan.js';
import { practiceTextPlans } from '../shared/texting-commercial.js';
import { policyPreview } from '../shared/texting-policy-pages.js';
import type { VerificationChannel } from '../shared/texting-onboarding.js';
import { acceptBrowserDraft, draftStorageKey, readBrowserDraft, writeBrowserDraft, type BrowserDraft } from './texting-draft.js';
import { operationKey, type Api } from './api.js';

const blank: OnboardingBusiness = {
  registrationType: 'ein', plan: 'text_300', legalName: '', ein: '', businessType: 'Limited Liability Corporation', vertical: 'RETAIL',
  website: '', privacyPolicyUrl: '', smsTermsUrl: '', street: '', city: '', region: '', postalCode: '',
  firstName: '', lastName: '', title: '', email: '', phone: '',
};
const states: Record<string, string> = {
  not_started: 'Business details needed', draft: 'Preparing enrollment', provisioning: 'Creating your sender',
  brand_pending: 'Business under review', campaign_pending: 'Campaign or number under review', approved: 'Registration approved',
  correction_required: 'Business details need correction', rejected: 'Registration needs corrections', suspended: 'Sender needs review', review: 'Identity review required',
};
const labels = {
  legalName: 'Legal business name', ein: 'Employer identification number', website: 'Business website',
  privacyPolicyUrl: 'Privacy policy URL', smsTermsUrl: 'SMS terms URL', street: 'Street address',
  city: 'City', region: 'State code', postalCode: 'ZIP code', firstName: 'Authorized contact first name',
  lastName: 'Authorized contact last name', title: 'Job title', email: 'Business email', phone: 'Business phone in +1 format',
} as const;
const fields = Object.keys(labels) as (keyof typeof labels)[];

type Company = { id: string; name: string; registration: string };
export function TextingOnboarding({ api, companies, refreshCompanies, onOpenAudience }: { onOpenAudience?: () => void; api: Api; companies: Company[]; refreshCompanies: () => Promise<void> }) {
  const [selection, setSelection] = useState('');
  const company = companies.find(item => item.id === selection) ?? companies[0];
  if (!company) return null;
  return <section className="card">
    <h2>Set up business texting</h2>
    <p>Use fictional business details for this practice enrollment. Verification and carrier review are simulated.</p>
    <label>Company to register<select value={company.id} onChange={event => setSelection(event.target.value)}>
      {companies.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
    </select></label>
    <Enrollment key={company.id} api={api} company={company} onOpenAudience={onOpenAudience} refreshCompanies={refreshCompanies} />
  </section>;
}

function Enrollment({ api, company, refreshCompanies, onOpenAudience }: { onOpenAudience?: () => void; api: Api; company: Company; refreshCompanies: () => Promise<void> }) {
  const companyId = company.id;
  const [view, setView] = useState<OnboardingView>();
  const [edit, setEdit] = useState(false);
  const [formReset, setFormReset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [codes, setCodes] = useState<Partial<Record<VerificationChannel, string>>>({});
  const [capture, setCapture] = useState<Partial<Record<VerificationChannel, string>>>({});
  const [document, setDocument] = useState<'CP575' | '147C'>('CP575');
  const [resumeReason, setResumeReason] = useState('');
  const [device, setDevice] = useState<{id: string; draft: BrowserDraft | null; unreadable?: boolean; unreadableRaw?: string}>();
  const draftId = view?.draftId, revision = view?.revision;
  const accessDraft = useCallback(async () => {
    const access = await api.call<DraftAccess>('sms.onboardingDraftAccess', {companyId, expectedRevision:revision, operationKey:operationKey()});
    if (!draftId || access.id !== draftId) throw Error('Reload the current enrollment before using this draft.');
    return access;
  }, [api, companyId, draftId, revision]);
  useEffect(() => {
    if (!draftId) return;
    let current = true;
    const restore = async () => {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(draftStorageKey(draftId));
        const draft = raw ? await readBrowserDraft(await accessDraft()) : null;
        if (current) setDevice({id:draftId, draft});
      } catch {
        if (current) setDevice({id:draftId, draft:null, unreadable:true, unreadableRaw:raw ?? undefined});
      }
    };
    void restore();
    return () => { current = false; };
  }, [draftId, accessDraft]);
  const latestRequest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latestRequest.current;
    const next = await api.call<OnboardingView>('sms.onboardingStatus', { companyId });
    if (request === latestRequest.current) setView(next);
  }, [api, companyId]);
  useEffect(() => {
    void load().catch(() => setError('Could not load texting enrollment.'));
    return () => { latestRequest.current++; };
  }, [load, company.registration]);
  const pending = view && ['provisioning', 'brand_pending', 'campaign_pending'].includes(view.state);
  const observing = !!view?.pageCheck?.retryAt || (!!view?.revision && !view.pageCheck && view.state === 'draft') || pending || view?.state === 'review' || view?.checkout === 'pending' || view?.state === 'approved';
  useEffect(() => {
    if (!observing) return;
    const update = () => { if (!window.document.hidden) void load().catch(() => setError('Could not refresh enrollment. Try again.')); };
    const timer = window.setInterval(update, pending ? 5000 : 20000);
    window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); };
  }, [observing, pending, load]);
  const action = async (run: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try { await run(); await Promise.all([load(), refreshCompanies()]); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The enrollment action failed.'); }
    finally { setBusy(false); }
  };
  if (!view) return <><p role="status">{error || 'Loading enrollment…'}</p>{error && <button className="btn secondary" onClick={() => void action(async () => {})}>Retry</button>}</>;
  if (view.blocked) return <p>This company already has a carrier registration. See its status under Companies and numbers.</p>;
  const context = () => ({ companyId, operationKey: operationKey(), expectedRevision: view.revision });
  const canPrepare = ['not_started', 'draft', 'rejected', 'correction_required'].includes(view.state) && view.checkout !== 'pending';
  const deviceDraft = device?.id === draftId ? device?.draft ?? null : null;
  const showForm = canPrepare && (edit || !view.revision || !!deviceDraft);
  const verified = view.requiredChannels.every(channel => channel === 'carrier' ? view.carrierVerified : view.verified[channel]);
  const pagesReady = !!view.pageCheck && view.pageCheck.issues.length === 0;
  const published = view.publicPages;
  const planId = view.checkoutMode === 'capture' ? view.business?.plan : undefined;
  const offer = planId ? {acceptedPlan:planId, acceptedMonthlyUsdCents:practiceTextPlans[planId].monthly} : {};
  return <>
    <p role="status"><strong>{states[view.state] ?? 'Registration progress'}</strong>{view.message ? ` · ${view.message}` : ''}</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {view.signupReady === false && <section><h3>Prepare the signup form</h3>
      <p>Enable a public signup page for this company in Audience, and turn on the mobile number field in Texting settings. You can save an unfinished draft first.</p>
      {onOpenAudience && <button className="btn secondary" onClick={onOpenAudience}>Open signup settings</button>}
    </section>}
    {device?.id === draftId && device?.unreadable && <div role="alert"><p>Your browser could not open private draft storage. Reload to try again.</p>
      {draftId && device.unreadableRaw && <button className="btn secondary" disabled={busy} onClick={() => void action(async () => {
        const storage = draftStorageKey(draftId);
        await navigator.locks.request(storage, () => {
          if (localStorage.getItem(storage) !== device.unreadableRaw) throw Error('Another tab changed this draft. Reload Texting.');
          localStorage.removeItem(storage);
        });
        setDevice({id:draftId,draft:null}); setFormReset(value => value + 1);
      })}>Discard unreadable draft</button>}</div>}
    {showForm && device?.id !== draftId ? <p role="status">Opening your form…</p> : showForm ? <BusinessForm key={String(view.revision) + '/' + formReset}
      initial={view.business ?? blank} draft={deviceDraft} busy={busy}
      saveDraft={(fields, version, onSaved) => void action(async () => {
        const access = await accessDraft();
        const nextVersion = await writeBrowserDraft(access, fields, version);
        setDevice({id:access.id, draft:fields && nextVersion ? {version:nextVersion,fields} : null});
        onSaved(nextVersion);
        if (!fields) { setFormReset(value => value + 1); setEdit(false); }
      })}
      save={(business, version) => void action(async () => {
        if (!draftId) throw Error('Reload the current enrollment before saving.');
        await acceptBrowserDraft(draftId, version, () => api.call('sms.onboardingSave', { ...context(), business, accepted: true }));
        setEdit(false);
        setCapture({});
        setCodes({});
      })} />
      : canPrepare && <button className="btn secondary" disabled={busy} onClick={() => setEdit(true)}>{['rejected','correction_required'].includes(view.state) ? 'Correct business details' : 'Edit business details'}</button>}
    {view.revision && !showForm && <>
      {published && <p><a href={published.website} target="_blank" rel="noreferrer">View published business and policy pages</a></p>}
      {(canPrepare || view.state === 'review') && <section><h3>Website and signup checks</h3>
        {pagesReady ? <p>All four pages passed the automated checks.</p> : view.pageCheck ? <ul>{view.pageCheck.issues.map(issue => <li key={issue.page+issue.message}>{issue.message}</li>)}</ul> : <p>The pages are waiting to be checked.</p>}
        {view.pageCheck?.retryAt && <p role="status">We’ll check again automatically at {new Date(view.pageCheck.retryAt).toLocaleTimeString()}. You can leave this page.</p>}
        <button className="btn secondary" disabled={busy} onClick={() => void action(() => api.call('sms.onboardingScan', context()).then(() => {}))}>Check pages again</button>
        {onOpenAudience && (!pagesReady || view.pageCheck?.issues.some(issue => issue.page === 'signup')) && <button className="btn secondary" onClick={onOpenAudience}>Open Audience signup settings</button>}
      </section>}
    </>}
    {view.state === 'review' && <section><h3>Ownership review</h3>
      {view.review === 'hosted_ownership' || view.review === 'payer_mismatch' ? view.evidence ? <p>Practice letter {view.evidence.document} attached. An operator will review it.</p> : <>
        <label>Practice IRS letter<select value={document} disabled={busy} onChange={e=>setDocument(e.target.value as 'CP575'|'147C')}><option>CP575</option><option>147C</option></select></label>
        <p>Use the fictional letter for this company and enrollment revision.</p>
        {view.evidenceFiles?.[document] && <PracticeEvidenceFile key={view.revision + document}
          expected={view.evidenceFiles[document]} document={document} busy={busy} action={action}
          attach={contents => api.call('sms.onboardingEvidence', { ...context(), document, contents })} />}
        <button className="btn secondary" disabled={busy} onClick={()=>void action(async()=>{await api.call('sms.onboardingEvidence',{...context(),document});})}>Attach practice ownership letter</button>
      </> : <p>An operator can return this application for correction.</p>}
    </section>}
    {view.samples.length > 0 && <details><summary>Campaign message examples</summary><ul>{view.samples.map(sample => <li key={sample}>{sample}</li>)}</ul></details>}
    {(view.state === 'draft' || view.review === 'hosted_ownership') && !showForm && <>
      <h3>Verify the business</h3>
      {view.requiredChannels.map(channel => <div key={channel}>
        {(channel === 'carrier' ? view.carrierVerified : view.verified[channel]) ? <p>{channel === 'email' ? 'Business email' : channel === 'phone' ? 'Business phone' : 'Practice carrier identity'} verified</p> : <>
          <button className="btn secondary" disabled={busy} onClick={() => void action(async () => {
            const response = await api.call<{ captureCode?: string }>('sms.onboardingChallenge', { ...context(), channel });
            if (response.captureCode) setCapture(previous => ({ ...previous, [channel]: response.captureCode }));
          })}>Request {channel} code</button>
          {capture[channel] && <p>Practice code <strong>{capture[channel]}</strong></p>}
          <label>{channel === 'email' ? 'Email' : channel === 'phone' ? 'Phone' : 'Carrier'} verification code<input value={codes[channel] ?? ''} maxLength={6} inputMode="numeric"
            onChange={event => setCodes(previous => ({ ...previous, [channel]: event.target.value }))} /></label>
          <button className="btn secondary" disabled={busy || !/^\d{6}$/.test(codes[channel] ?? '')} onClick={() => void action(async () => {
            const response = await api.call<{ verified: boolean }>('sms.onboardingVerify', { ...context(), channel, code: codes[channel] });
            if (!response.verified) throw Error('The code did not match.');
            setCodes(previous => ({ ...previous, [channel]: '' }));
          })}>Verify {channel}</button>
        </>}
      </div>)}
      <h3>Setup payment</h3>
      <p>{new Intl.NumberFormat('en-US', { style: 'currency', currency: view.setupFee.currency }).format(view.setupFee.amount / 100)}
        {view.checkout === 'paid' ? ' setup payment verified' : view.checkoutMode === 'stripe_test' ? ' Stripe test setup fee' : ' simulated setup fee'}</p>
      {planId && <p>{practiceTextPlans[planId].name} · {new Intl.NumberFormat('en-US', {style:'currency',currency:'USD'}).format(practiceTextPlans[planId].monthly / 100)} per month in practice once the registration is active.</p>}
      {view.checkout === 'pending' && <p role="status">Waiting for Stripe to verify the test payment.</p>}
      {view.checkout === 'declined' && <p className="notice">The practice payment was declined. Try again.</p>}

      {view.checkoutMode === 'capture' && view.checkout !== 'paid' && <button className="btn" disabled={busy || !verified || !pagesReady || !!view.review}
        onClick={()=>void action(async()=>{ await api.call('sms.onboardingFinish', {...context(), ...offer, acceptedFee:view.setupFee.amount,currency:view.setupFee.currency}); })}>Confirm practice setup and submit</button>}
      {view.checkout !== 'paid' && <button className="btn secondary" disabled={busy || !verified || !pagesReady || !!view.review} onClick={() => void action(async () => {
        const result = await api.call<{ checkoutUrl?: string }>('sms.onboardingPay', context());
        if (result.checkoutUrl) window.location.assign(result.checkoutUrl);
      })}>{view.checkoutMode === 'stripe_test' ? 'Open Stripe test checkout' : 'Simulate setup payment'}</button>}
      {view.checkout === 'pending' && <button className="btn secondary" disabled={busy} onClick={() => void action(async () => {})}>Refresh payment status</button>}
      <button className="btn" disabled={busy || view.checkout !== 'paid' || !verified || !pagesReady || !!view.review} onClick={() => void action(async () => {
        await api.call('sms.onboardingSubmit', {...context(), ...offer});
      })}>Submit carrier registration</button>
    </>}
    {pending && view.progress?.stage === 'carrier_recovery' && <p role="status">An operator is reconciling the existing carrier account or registration. Your application is saved and you can leave this page.</p>}
    {pending && view.progress?.stage !== 'carrier_recovery' && <p>{view.progress?.stage === 'number_pending' ? 'Campaign approved. Waiting for the carrier to confirm the assigned number.' : 'Registration progresses automatically. Real brand review can take days, and campaign review can take one to two weeks or longer.'}</p>}
    {view.progress?.stalled && view.progress.stage !== 'carrier_recovery' && <p role="status">This registration is taking longer than expected and is visible to the operator for review.</p>}
    {view.probation === 'paused' && <section><h3>Sending paused</h3><p>Review the cause before restarting probation. Restarting closes the first broadcast and cancels its unsent texts. A newly reviewed broadcast starts with a new first cohort.</p>
      <label>Reason for restarting probation<input value={resumeReason} minLength={12} maxLength={300} onChange={e=>setResumeReason(e.target.value)} /></label>
      <button className="btn secondary" disabled={busy || resumeReason.trim().length < 12} onClick={()=>void action(async()=>{await api.call('sms.onboardingResume',{...context(), reason:resumeReason});setResumeReason('');})}>Close held broadcast and restart probation</button></section>}
    {view.probation === 'suspended' && <p>Sending is suspended. An operator must review the sender.</p>}
    {!!view.notices.length && <details><summary>Enrollment updates</summary><ul>{view.notices.map((n,i)=><li key={n.at+n.message+i}><time dateTime={n.at}>{new Date(n.at).toLocaleString()}</time> · {n.message}</li>)}</ul><p>Owner email notifications are captured on staging.</p></details>}
    {pending && <button className="btn secondary" disabled={busy} onClick={() => void action(async () => {})}>Refresh registration status</button>}
  </>;
}

function PracticeEvidenceFile({ document, expected, busy, action, attach }: {
  document: 'CP575' | '147C'; expected: string; busy: boolean;
  action: (run: () => Promise<void>) => Promise<void>; attach: (contents: string) => Promise<void>;
}) {
  const [file, setFile] = useState<File>();
  const verify = async () => {
    if (!file || file.size > 1024) throw new Error('Choose a practice letter of 1 KiB or less.');
    const reference = new TextEncoder().encode(expected);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length !== reference.length || !bytes.every((byte, index) => byte === reference[index]))
      throw new Error('This file does not match the selected practice letter. Download the letter for this enrollment and try again.');
    await attach(expected);
  };
  return <>
    <a download={'practice-' + document + '.txt'} href={'data:text/plain;charset=utf-8,' + encodeURIComponent(expected)}>Download practice {document} letter</a>
    <label>Select downloaded practice letter<input type="file" accept="text/plain,.txt" disabled={busy}
      onChange={event => setFile(event.currentTarget.files?.[0])} /></label>
    <button className="btn secondary" disabled={busy || !file} onClick={() => void action(verify)}>Verify and attach file</button>
  </>;
}

function BusinessForm({ initial, draft, busy, save, saveDraft }: {
  initial: OnboardingBusiness; draft: BrowserDraft | null; busy: boolean;
  save: (business: OnboardingBusiness, version: string | null) => void;
  saveDraft: (fields: EnrollmentDraftFields | null, version: string | null, onSaved: (version: string | null) => void) => void;
}) {
  const [business, setBusiness] = useState<OnboardingBusiness>(() => ({ ...initial, ...draft?.fields }));
  const [version, setVersion] = useState(draft?.version ?? null);
  const [accepted, setAccepted] = useState(false);
  const [saved, setSaved] = useState(!!draft);
  const keepDraft = () => {
    const fields: EnrollmentDraftFields & { ein?: string } = { ...business };
    delete fields.ein;
    saveDraft(fields, version, next => { setVersion(next); setSaved(true); });
  };
  const set = <K extends keyof OnboardingBusiness>(field: K, value: OnboardingBusiness[K]) => setBusiness(previous => ({ ...previous, [field]: value }));
  const hosted = business.hostedPages === true, sole = business.registrationType === 'sole_proprietor';
  const preview = policyPreview(business.dbaName || business.legalName, business.publicContact ?? '', business.description ?? '');
  const submit = (event: FormEvent) => { event.preventDefault(); if (accepted) save({ ...business,
    ...(hosted ? { website:'', privacyPolicyUrl:'', smsTermsUrl:'' } : { publicContact:undefined, description:undefined }),
    ...(sole ? {ein:'', dbaName:undefined} : {}) }, version); };
  return <form onSubmit={submit} onChange={e => { setSaved(false); if (!(e.target instanceof HTMLInputElement && e.target.name === 'acceptEnrollment')) setAccepted(false); }}><fieldset disabled={busy}>
    <legend>Registered US business details</legend>
    <label>Registration type<select value={sole ? 'sole_proprietor' : 'ein'} onChange={e=>setBusiness(value => ({...value,registrationType:e.target.value as 'ein'|'sole_proprietor', ...(e.target.value==='sole_proprietor' && value.plan==='text_2500' ? {plan:'text_300'}:{})}))}>
      <option value="ein">US business with an EIN</option><option value="sole_proprietor">Sole proprietor without an EIN · practice</option></select></label>
    {!sole && <label>DBA or trade name (optional)<input maxLength={120} value={business.dbaName ?? ''} onChange={e=>set('dbaName',e.target.value||undefined)} /></label>}
    <TextingPlanChoice plan={business.plan} onChange={plan=>set('plan',plan)} />
    {sole && business.plan==='text_2500' && <p role="alert">Sole proprietors can choose a low-volume plan only.</p>}
    <label><input type="checkbox" checked={hosted} onChange={e=>{set('hostedPages',e.target.checked);setAccepted(false);}} /> Publish practice business and policy pages</label>
    {hosted && <><label>Public support email<input type="email" required maxLength={120} value={business.publicContact ?? ''} onChange={e=>set('publicContact',e.target.value)} /></label>
      <label>Public business description<textarea required maxLength={300} value={business.description ?? ''} onChange={e=>set('description',e.target.value)} /></label></>}
    {fields.filter(field=>!(sole && field==='ein') && !(hosted && ['website','privacyPolicyUrl','smsTermsUrl'].includes(field))).map(field => <label key={field}>{labels[field]}
      <input required value={business[field]} type={field === 'email' ? 'email' : ['website', 'privacyPolicyUrl', 'smsTermsUrl'].includes(field) ? 'url' : 'text'}
        onChange={event => set(field, field === 'region' ? event.target.value.toUpperCase() : event.target.value)} />
    </label>)}
    <label>Business type<select value={business.businessType} onChange={event => set('businessType', event.target.value as OnboardingBusiness['businessType'])}>
      {twilioBusinessTypes.filter(value => value !== 'Non-profit Corporation').map(value => <option key={value}>{value}</option>)}
    </select></label>
    <label>Industry<select value={business.vertical} onChange={event => set('vertical', event.target.value as OnboardingBusiness['vertical'])}>
      {twilioIndustries.map(value => <option value={value} key={value}>{value.replaceAll('_', ' ').toLowerCase()}</option>)}
    </select></label>
    {hosted && <details><summary>Review the pages to publish</summary><h3>Privacy policy</h3><p>{preview.privacy}</p><h3>SMS terms</h3><p>{preview.terms}</p></details>}
    <label className="asset-option"><input type="checkbox" name="acceptEnrollment" required checked={accepted} onChange={event => setAccepted(event.target.checked)} />
      {hosted ? 'I authorize publishing this practice business name, description, support email, privacy policy and SMS terms on the public business page.' : 'I am authorized to register this business and confirm these are the published privacy policy and SMS terms for its texting program.'}
    </label>
    <button className="btn" disabled={busy || !accepted}>Save business details</button>
    <button type="button" className="btn secondary" disabled={busy} onClick={keepDraft}>Save unfinished draft</button>
    {version && <button type="button" className="btn secondary" disabled={busy} onClick={() => saveDraft(null, version, setVersion)}>Discard saved draft</button>}
    <p className="help">Resume the encrypted draft in this browser when signed in as the same owner. Enter the EIN and confirm the details when you finish.</p>
    {saved && <p role="status">Private draft saved.</p>}
  </fieldset></form>;
}
