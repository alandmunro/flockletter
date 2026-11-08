import { useEffect, useId, useState } from 'react';
import { plans } from '../shared/contracts.js';
import type { PlanComparison } from '../shared/plan-comparison.js';
import type { PlanId } from '../shared/rehearsal.js';
import { hostedTrial } from '../shared/trial.js';
import type { Api } from './api.js';

const count = (n: number) => n.toLocaleString('en-US');
const fitLabel: Record<PlanComparison['fit'], string> = {
  within_limits: 'Current workspace counts fit this tier.',
  over_limit: 'Some workspace counts exceed this tier.',
  needs_verification: 'The member count still needs verification.',
};
export function PlanComparisonDetails({ result }: { result: PlanComparison }) {
  const { target, practice, current } = result;
  const price = new Intl.NumberFormat('en-US', { style: 'currency', currency: target.currency, minimumFractionDigits: 0 }).format(target.priceMinor / 100);
  const source = current.source === 'complimentary' ? 'Complimentary plan' : 'Last verified Stripe sandbox plan';
  const campaigns = practice.campaigns + practice.reservedCampaigns;
  const emails = practice.messages + practice.reservedMessages;
  return <>
    <h4>{target.name} · {price} per month</h4>
    <p>{current.plan ? source + ' · ' + plans.find(p => p.id === current.plan)!.name : 'This workspace has preparation access.'}</p>
    <p role="status">{fitLabel[result.fit]}</p>
    <dl className="plan-details">{result.capacity.map(row => <div key={row.label}>
      <dt>{row.label}</dt><dd>{row.count === null ? 'Unverified' : count(row.count)} / {row.limit === null ? 'Unlimited' : count(row.limit)}
      {row.guidance && <p>{row.guidance}</p>}</dd>
    </div>)}</dl>
    {result.brands.length > 0 && <details><summary>Confirmed contacts by brand</summary>
      <ul>{result.brands.map(brand => <li key={brand.id}>{brand.name} · {count(brand.confirmed)}
        {brand.exceedsCampaignLimit && ' · A full-brand send exceeds this tier’s per-campaign limit. Choose a smaller audience.'}</li>)}</ul>
    </details>}
    <p>A campaign can include up to {count(target.recipients)} recipients. Each confirmed brand subscription counts once toward the shared contact comparison.</p>
    <p><strong>Practice usage for {practice.period.slice(0, 7)} (UTC)</strong><br/>
      {count(campaigns)} of {count(target.campaigns)} campaigns · {count(emails)} of {count(target.emails)} recipient emails.
      {' '}These totals include outstanding reservations and apply to rehearsals only.
    </p>
    {result.practiceGuidance.map(guidance => <p key={guidance}>{guidance}</p>)}
    <p className="help">An ordinary {hostedTrial.days}-day hosted trial has a separate allowance of {count(hostedTrial.activeContacts)} active contacts and {count(hostedTrial.totalEmails)} recipient emails over the full trial.</p>
  </>;
}

export function PlanComparisonPanel({ api }: { api: Api }) {
  const id = useId();
  const [plan, setPlan] = useState<PlanId>('starter');
  const [request, setRequest] = useState<{ target: PlanId }>();
  const [reply, setReply] = useState<{ api: Api; request: typeof request; result?: PlanComparison; error?: string }>();
  useEffect(() => {
    if (!request) return;
    let active = true;
    api.call<PlanComparison>('billing.comparePlan', { plan: request.target })
      .then(result => { if (active) setReply({ api, request, result }); })
      .catch(() => { if (active) setReply({ api, request, error: 'Could not compare this plan. Try again.' }); });
    return () => { active = false; };
  }, [request, api]);
  const shown = reply?.api === api && reply.request === request ? reply : undefined;
  const loading = Boolean(request && !shown);
  return <div>
    <h3>Compare a hosted plan</h3>
    <label htmlFor={id}>Target tier</label>
    <select id={id} value={plan} onChange={event => { setPlan(event.target.value as PlanId); setRequest(undefined); }}>
      {plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
    <button type="button" className="btn secondary" disabled={loading} onClick={() => setRequest({ target: plan })}>Compare allowances</button>
    {loading && <p role="status">Checking workspace counts…</p>}
    {shown?.error && <p role="alert">{shown.error}</p>}
    {shown?.result && <PlanComparisonDetails result={shown.result}/>}
  </div>;
}
