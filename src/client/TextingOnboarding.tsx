import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { twilioBusinessTypes, twilioIndustries } from '../shared/texting-business.js';
import type { OnboardingBusiness, OnboardingView } from '../shared/texting-onboarding.js';
import { TextingPlanChoice } from './TextingPlan.js';
import { policyPreview } from '../shared/texting-policy-pages.js';
import type { VerificationChannel } from '../shared/texting-onboarding.js';
import { operationKey, type Api } from './api.js';

const blank: OnboardingBusiness = {
  registrationType: 'ein', plan: 'text_300', legalName: '', ein: '', businessType: 'Limited Liability Corporation', vertical: 'RETAIL',
  website: '', privacyPolicyUrl: '', smsTermsUrl: '', street: '', city: '', region: '', postalCode: '',
  firstName: '', lastName: '', title: '', email: '', phone: '',
};
const states: Record<string, string> = {
  not_started: 'Business details needed', draft: 'Preparing enrollment', provisioning: 'Creating your sender',
  brand_pending: 'Business under review', campaign_pending: 'Campaign or number under review', approved: 'Registration approved',
  rejected: 'Registration needs corrections', suspended: 'Sender needs review', review: 'Identity review required',
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [codes, setCodes] = useState<Partial<Record<VerificationChannel, string>>>({});
  const [capture, setCapture] = useState<Partial<Record<VerificationChannel, string>>>({});
  const [document, setDocument] = useState<'CP575' | '147C'>('CP575');
  const [resumeReason, setResumeReason] = useState('');
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
  const observing = pending || view?.state === 'review' || view?.checkout === 'pending' || view?.state === 'approved';
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
  const canPrepare = ['not_started', 'draft', 'rejected'].includes(view.state);
  const verified = view.requiredChannels.every(channel => channel === 'carrier' ? view.carrierVerified : view.verified[channel]);
  const pagesReady = !!view.pageCheck && view.pageCheck.issues.length === 0;
  const published = view.publicPages;
  return <>
    <p role="status"><strong>{states[view.state] ?? 'Registration progress'}</strong>{view.message ? ` · ${view.message}` : ''}</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {(edit || !view.revision) && canPrepare ? <BusinessForm key={view.revision ?? 'new'} initial={view.business ?? blank} busy={busy}
      save={(business) => void action(async () => {
        await api.call('sms.onboardingSave', { ...context(), business, accepted: true });
        setEdit(false);
        setCapture({});
        setCodes({});
      })} />
      : canPrepare && <button className="btn secondary" disabled={busy} onClick={() => setEdit(true)}>{view.state === 'rejected' ? 'Correct business details' : 'Edit business details'}</button>}
    {view.revision && !edit && <>
      {published && <p><a href={published.website} target="_blank" rel="noreferrer">View published business and policy pages</a></p>}
      {(canPrepare || view.state === 'review') && <section><h3>Website and signup checks</h3>
        {pagesReady ? <p>All four pages passed the automated checks.</p> : view.pageCheck ? <ul>{view.pageCheck.issues.map(issue => <li key={issue.page+issue.message}>{issue.message}</li>)}</ul> : <p>The pages are waiting to be checked.</p>}
        <button className="btn secondary" disabled={busy} onClick={() => void action(() => api.call('sms.onboardingScan', context()).then(() => {}))}>Check pages again</button>
        {onOpenAudience && (!pagesReady || view.pageCheck?.issues.some(issue => issue.page === 'signup')) && <button className="btn secondary" onClick={onOpenAudience}>Open Audience signup settings</button>}
      </section>}
    </>}
    {view.state === 'review' && <section><h3>Ownership review</h3>
      {view.review === 'hosted_ownership' || view.review === 'payer_mismatch' ? view.evidence ? <p>Practice letter {view.evidence.document} attached. An operator will review it.</p> : <>
        <label>Practice IRS letter<select value={document} onChange={e=>setDocument(e.target.value as 'CP575'|'147C')}><option>CP575</option><option>147C</option></select></label>
        <p>This stages a fictional letter for review. Use synthetic business details here.</p>
        <button className="btn secondary" disabled={busy} onClick={()=>void action(async()=>{await api.call('sms.onboardingEvidence',{...context(),document});})}>Attach practice ownership letter</button>
      </> : <p>An operator can return this application for correction.</p>}
    </section>}
    {view.samples.length > 0 && <details><summary>Campaign message examples</summary><ul>{view.samples.map(sample => <li key={sample}>{sample}</li>)}</ul></details>}
    {(view.state === 'draft' || view.review === 'hosted_ownership') && !edit && <>
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
      {view.checkout === 'pending' && <p role="status">Waiting for Stripe to verify the test payment.</p>}
      {view.checkout === 'declined' && <p className="notice">The practice payment was declined. Try again.</p>}

      {view.checkoutMode === 'capture' && view.checkout !== 'paid' && <button className="btn" disabled={busy || !verified || !pagesReady || !!view.review}
        onClick={()=>void action(async()=>{ await api.call('sms.onboardingFinish', {...context(), acceptedFee:view.setupFee.amount,currency:view.setupFee.currency}); })}>Confirm practice setup and submit</button>}
      {view.checkout !== 'paid' && <button className="btn secondary" disabled={busy || !verified || !pagesReady || !!view.review} onClick={() => void action(async () => {
        const result = await api.call<{ checkoutUrl?: string }>('sms.onboardingPay', context());
        if (result.checkoutUrl) window.location.assign(result.checkoutUrl);
      })}>{view.checkoutMode === 'stripe_test' ? 'Open Stripe test checkout' : 'Simulate setup payment'}</button>}
      {view.checkout === 'pending' && <button className="btn secondary" disabled={busy} onClick={() => void action(async () => {})}>Refresh payment status</button>}
      <button className="btn" disabled={busy || view.checkout !== 'paid' || !verified || !pagesReady || !!view.review} onClick={() => void action(async () => {
        await api.call('sms.onboardingSubmit', context());
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

function BusinessForm({ initial, busy, save }: { initial: OnboardingBusiness; busy: boolean; save: (business: OnboardingBusiness) => void }) {
  const [business, setBusiness] = useState(initial);
  const [accepted, setAccepted] = useState(false);
  const set = <K extends keyof OnboardingBusiness>(field: K, value: OnboardingBusiness[K]) => setBusiness(previous => ({ ...previous, [field]: value }));
  const hosted = business.hostedPages === true, sole = business.registrationType === 'sole_proprietor';
  const preview = policyPreview(business.dbaName || business.legalName, business.publicContact ?? '', business.description ?? '');
  const submit = (event: FormEvent) => { event.preventDefault(); if (accepted) save({ ...business,
    ...(hosted ? { website:'', privacyPolicyUrl:'', smsTermsUrl:'' } : { publicContact:undefined, description:undefined }),
    ...(sole ? {ein:'', dbaName:undefined} : {}) }); };
  return <form onSubmit={submit}><fieldset disabled={busy}>
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
    <label className="asset-option"><input type="checkbox" required checked={accepted} onChange={event => setAccepted(event.target.checked)} />
      {hosted ? 'I authorize publishing this practice business name, description, support email, privacy policy and SMS terms on the public business page.' : 'I am authorized to register this business and confirm these are the published privacy policy and SMS terms for its texting program.'}
    </label>
    <button className="btn" disabled={busy || !accepted}>Save business details</button>
  </fieldset></form>;
}
