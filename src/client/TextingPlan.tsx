import { useState } from 'react';
import { operationKey, type Api } from './api.js';
import { practiceTextPlans, textPlanId, type TextPlan, type PracticePlanStatus } from '../shared/texting-commercial.js';

const usd = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export function TextingPlanChoice({ plan, onChange, lowVolumeOnly }: { lowVolumeOnly?: boolean; plan: TextPlan | undefined; onChange: (plan: TextPlan) => void }) {
  return <label>Practice texting plan<select required value={plan ?? ''} onChange={e => onChange(textPlanId.parse(e.target.value))}>
    <option value="" disabled>Choose a plan</option>
    {textPlanId.options.filter(id => !lowVolumeOnly || id !== 'text_2500').map(id => <option key={id} value={id}>
      {practiceTextPlans[id].name} · {usd(practiceTextPlans[id].monthly)}/month · {usd(practiceTextPlans[id].setup)} setup
    </option>)}
  </select><span className="help">Staging simulates these fees. Each message segment counts toward your plan.</span></label>;
}
export function TextingPracticePlan({ api, plan, busy, act }: { api: Api; plan: PracticePlanStatus; busy: boolean; act: (action: () => Promise<unknown>) => Promise<void> }) {
  const [selected, setSelected] = useState<TextPlan>(plan.requested);
  const [cap, setCap] = useState(plan.capUsdCents === null ? '' : (plan.capUsdCents / 100).toFixed(2));
  const [confirm, setConfirm] = useState(false);
  const ctx = () => ({ operationKey: operationKey(), expectedRevision: plan.revision });
  return <section className="card"><h2>Practice texting plan</h2>
    <p>{plan.active ? practiceTextPlans[plan.active].name : practiceTextPlans[plan.requested].name} · {plan.state.replaceAll('_', ' ')}</p>
    <p>{plan.used} segments used and {plan.reserved} in progress. Monthly plan allowance: {plan.allowance}.</p>
    <p>{plan.month} simulated fees: {usd(plan.spendUsdCents)} ({usd(plan.monthlyFeeUsdCents)} plan, {usd(plan.setupFeeUsdCents)} setup).</p>
    {plan.change && <p role="status">{practiceTextPlans[plan.requested].name} {plan.change === 'standard_review' ? 'is waiting for mock Standard registration approval.' : 'starts at the next UTC calendar month.'}</p>}
    {plan.upgradeFailure && <p role="status">The Standard registration needs correction ({plan.upgradeFailure.replaceAll('_', ' ')}). Your previous plan remains active.</p>}
    {plan.canReactivate && <button className="btn secondary" disabled={busy} onClick={() => void act(() => api.call('sms.planReactivate', {
      ...ctx(), acceptedMonthlyUsdCents: practiceTextPlans[plan.active ?? plan.requested].monthly }))}>Reactivate {practiceTextPlans[plan.active ?? plan.requested].name} at {usd(practiceTextPlans[plan.active ?? plan.requested].monthly)}/month in practice</button>}
    {plan.hold === 'texting_spend_cap' && <p role="status">Texting is held at the monthly spending cap.</p>}
    {plan.state !== 'cancelled' && <fieldset disabled={busy}>
      {plan.state === 'active' && <><label>Change practice plan<select value={selected} onChange={e => setSelected(textPlanId.parse(e.target.value))}>
        {textPlanId.options.map(id => <option value={id} key={id}>{practiceTextPlans[id].name} · {usd(practiceTextPlans[id].monthly)}/month</option>)}
      </select></label><button className="btn secondary" disabled={selected === plan.requested} onClick={() => void act(() => api.call('sms.planChange', {
        ...ctx(), plan: selected, acceptedMonthlyUsdCents: practiceTextPlans[selected].monthly }))}>Accept practice plan change</button></>}
      <form onSubmit={e => { e.preventDefault(); const cents = cap === '' ? null : Math.round(Number(cap) * 100);
        void act(() => api.call('sms.planCap', { ...ctx(), capUsdCents: cents })); }}>
        <label>Monthly texting spending cap (USD)<input type="number" step="0.01" min="0" max="1000000" value={cap} onChange={e => setCap(e.target.value)} placeholder="No cap" /></label>
        <p className="help">Captures setup and plan fees in the UTC calendar month. Texting pauses when those fees reach the cap.</p>
        <button className="btn secondary">Save spending cap</button>
      </form>
      <label><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} /> Cancel this workspace’s practice texting add-on immediately.</label>
      <button className="btn secondary" disabled={!confirm} onClick={() => void act(() => api.call('sms.planCancel', { ...ctx(), confirm: true }))}>Cancel practice texting</button>
    </fieldset>}
  </section>;
}
