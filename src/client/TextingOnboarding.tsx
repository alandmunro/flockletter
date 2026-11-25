import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { twilioBusinessTypes, twilioIndustries } from '../shared/texting-business.js';
import type { OnboardingBusiness, OnboardingView } from '../shared/texting-onboarding.js';
import { operationKey, type Api } from './api.js';

const blank: OnboardingBusiness = {
  legalName: '', ein: '', businessType: 'Limited Liability Corporation', vertical: 'RETAIL',
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
export function TextingOnboarding({ api, companies, refreshCompanies }: { api: Api; companies: Company[]; refreshCompanies: () => Promise<void> }) {
  const [selection, setSelection] = useState('');
  const company = companies.find(item => item.id === selection) ?? companies[0];
  if (!company) return null;
  return <section className="card">
    <h2>Set up business texting</h2>
    <p>Use fictional business details for this practice enrollment. Verification and carrier review are simulated.</p>
    <label>Company to register<select value={company.id} onChange={event => setSelection(event.target.value)}>
      {companies.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
    </select></label>
    <Enrollment key={company.id} api={api} company={company} refreshCompanies={refreshCompanies} />
  </section>;
}

function Enrollment({ api, company, refreshCompanies }: { api: Api; company: Company; refreshCompanies: () => Promise<void> }) {
  const companyId = company.id;
  const [view, setView] = useState<OnboardingView>();
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [codes, setCodes] = useState<Partial<Record<'email' | 'phone', string>>>({});
  const [capture, setCapture] = useState<Partial<Record<'email' | 'phone', string>>>({});
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
    {view.samples.length > 0 && <details><summary>Campaign message examples</summary><ul>{view.samples.map(sample => <li key={sample}>{sample}</li>)}</ul></details>}
    {view.state === 'draft' && !edit && <>
      <h3>Verify the business</h3>
      {(['email', 'phone'] as const).map(channel => <div key={channel}>
        {view.verified[channel] ? <p>{channel === 'email' ? 'Business email' : 'Business phone'} verified</p> : <>
          <button className="btn secondary" disabled={busy} onClick={() => void action(async () => {
            const response = await api.call<{ captureCode?: string }>('sms.onboardingChallenge', { ...context(), channel });
            if (response.captureCode) setCapture(previous => ({ ...previous, [channel]: response.captureCode }));
          })}>Request {channel} code</button>
          {capture[channel] && <p>Practice code <strong>{capture[channel]}</strong></p>}
          <label>{channel === 'email' ? 'Email' : 'Phone'} verification code<input value={codes[channel] ?? ''} maxLength={6} inputMode="numeric"
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
      <p>Enable a Flockletter sign-up page in Audience and turn on the mobile number field in Texting settings before continuing.</p>
      {view.checkout !== 'paid' && <button className="btn secondary" disabled={busy || !view.verified.email || !view.verified.phone} onClick={() => void action(async () => {
        const result = await api.call<{ checkoutUrl?: string }>('sms.onboardingPay', context());
        if (result.checkoutUrl) window.location.assign(result.checkoutUrl);
      })}>{view.checkoutMode === 'stripe_test' ? 'Open Stripe test checkout' : 'Simulate setup payment'}</button>}
      {view.checkout === 'pending' && <button className="btn secondary" disabled={busy} onClick={() => void action(async () => {})}>Refresh payment status</button>}
      <button className="btn" disabled={busy || view.checkout !== 'paid' || !view.verified.email || !view.verified.phone} onClick={() => void action(async () => {
        await api.call('sms.onboardingSubmit', context());
      })}>Submit carrier registration</button>
    </>}
    {pending && <button className="btn secondary" disabled={busy} onClick={() => void action(async () => {})}>Refresh registration status</button>}
  </>;
}

function BusinessForm({ initial, busy, save }: { initial: OnboardingBusiness; busy: boolean; save: (business: OnboardingBusiness) => void }) {
  const [business, setBusiness] = useState(initial);
  const [accepted, setAccepted] = useState(false);
  const set = <K extends keyof OnboardingBusiness>(field: K, value: OnboardingBusiness[K]) => setBusiness(previous => ({ ...previous, [field]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); if (accepted) save(business); };
  return <form onSubmit={submit}><fieldset disabled={busy}>
    <legend>Registered US business details</legend>
    {fields.map(field => <label key={field}>{labels[field]}
      <input required value={business[field]} type={field === 'email' ? 'email' : ['website', 'privacyPolicyUrl', 'smsTermsUrl'].includes(field) ? 'url' : 'text'}
        onChange={event => set(field, field === 'region' ? event.target.value.toUpperCase() : event.target.value)} />
    </label>)}
    <label>Business type<select value={business.businessType} onChange={event => set('businessType', event.target.value as OnboardingBusiness['businessType'])}>
      {twilioBusinessTypes.filter(value => value !== 'Non-profit Corporation').map(value => <option key={value}>{value}</option>)}
    </select></label>
    <label>Industry<select value={business.vertical} onChange={event => set('vertical', event.target.value as OnboardingBusiness['vertical'])}>
      {twilioIndustries.map(value => <option value={value} key={value}>{value.replaceAll('_', ' ').toLowerCase()}</option>)}
    </select></label>
    <label className="asset-option"><input type="checkbox" required checked={accepted} onChange={event => setAccepted(event.target.checked)} />
      I am authorized to register this business and confirm these are the published privacy policy and SMS terms for its texting program.
    </label>
    <button className="btn" disabled={busy || !accepted}>Save business details</button>
  </fieldset></form>;
}
