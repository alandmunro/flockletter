import type {Workspace} from '../shared/contracts.js';
import type {SetupPage,WorkspacePreflight,WorkspaceSetupGap} from '../shared/workspace-preflight.js';
import {DeliveryScopeNotice} from './DeliveryScopeNotice.js';

export type OnboardingProgressProps={
  workspace:Pick<Workspace,'name'|'brands'|'entitlement'>|null;hasDraft?:boolean;
  readiness?:WorkspacePreflight;loading?:boolean;error?:string;onRefresh?:()=>void;
  onNavigate:(page:SetupPage)=>void;
};
const actions:Record<SetupPage,string>={settings:'View workspace',campaigns:'Open campaigns',subscription:'Open Subscription',delivery:'Open Delivery',audience:'Open Audience',operations:'Open Operations'};

export function OnboardingProgress({workspace,hasDraft,readiness:observed,loading,error,onRefresh,onNavigate}:OnboardingProgressProps) {
  const readiness=loading||error?undefined:observed;
  const names=workspace?.brands.map(brand=>brand.name)??[];
  const service=readiness?.service;
  const grouped=new Map<string,WorkspaceSetupGap>();
  for(const gap of readiness?.gaps??[]){const key=gap.code+'-'+(gap.brandId??'workspace'),prior=grouped.get(key);
    grouped.set(key,prior?{...prior,detail:prior.detail+' '+gap.detail}:gap);}
  const gaps=[...grouped.values()];

  const serviceLabel=!service?'Not checked':service.source==='exercise'?'Captured exercise · '+(service.eligible?service.state.replaceAll('_',' '):'Action needed'):
    !service.eligible?'Action needed':service.source==='complimentary'?'Complimentary':service.state.replaceAll('_',' ');
  const steps=[
    {label:'Workspace',status:workspace?'Complete':'Upcoming',detail:workspace?.name??'Create a workspace after signing in.'},
    {label:'First brand',status:names.length?'Complete':'Upcoming',detail:names.join(', ')||'Name your first sending brand.'},
    {label:'First campaign draft',status:hasDraft&&names.length?'Complete':hasDraft===false&&workspace&&names.length?'Ready to start':'Upcoming',detail:hasDraft?'A campaign draft is saved in this workspace.':'Create a draft and preview it before sending.'},
    {label:'Service access',status:serviceLabel,detail:service?.eligible?'Recorded service eligibility is separate from sender and campaign approval.':service?.reasons.join(' ')||'Refresh setup to inspect current service access.'},
    {label:'Live delivery',status:!readiness?'Not checked':readiness.mode==='capture'?'Captured exercise':readiness.mode==='off'?'Not configured':'Exact review required',detail:'A delivery mode or completed setup never grants permission to send.'},
  ];
  return <section className="card onboarding-progress" aria-labelledby="onboarding-progress-title" aria-busy={loading||undefined}>
    <h2 id="onboarding-progress-title">Workspace setup</h2>
    {loading&&<p role="status">Checking current workspace setup…</p>}
    {error&&<p role="alert" className="notice error">Setup could not be checked. {error}</p>}
    <ol className="setup-steps">{steps.map(step=><li key={step.label}><div><strong>{step.label}</strong><span>{step.status}</span></div><p>{step.detail}</p></li>)}</ol>
    {readiness&&<>
      <DeliveryScopeNotice mode={readiness.mode} scope={readiness.deliveryScope??'all'}/>
      <p className="help">Snapshot observed {readiness.observedAt??'at the last refresh'}. Refresh to check again. Private renderer: {readiness.rendererConfigured?'configured':'not configured'}.</p>
      {readiness.mode==='capture'&&<p className="help">Captured exercises do not verify external sending or inbox delivery.</p>}
      {(readiness.brands??[]).map(brand=><section key={brand.id} aria-labelledby={'setup-brand-'+brand.id}>
        <h3 id={'setup-brand-'+brand.id}>{brand.name}</h3><dl>
          <dt>Sender identity</dt><dd>{brand.senderProfileConfigured?'Configured':'Needed'}</dd>
          <dt>Sender verification</dt><dd>{readiness.mode==='ses'&&brand.senderVerified?'Current at this check':readiness.mode==='capture'?'Exercise only':'Needs verification'}</dd>
          <dt>Confirmed audience</dt><dd>{brand.confirmed===null?'Not available with this access':brand.confirmed+' confirmed contacts'}</dd>
        </dl><p className="help">Confirmed contacts still pass consent and suppression checks in the exact campaign review and at execution.</p>
      </section>)}
      {!!gaps.length&&<section aria-labelledby="setup-next-steps"><h3 id="setup-next-steps">Next steps</h3><ul>{gaps.map((gap,index)=><li key={gap.code+'-'+(gap.brandId??'workspace')+'-'+index}>
        <strong>{gap.title}</strong>{gap.brandId&&' · '+(readiness.brands?.find(brand=>brand.id===gap.brandId)?.name??'Selected brand')}<p>{gap.detail}</p>
        {actions[gap.action]&&<button type="button" className="btn secondary" onClick={()=>onNavigate(gap.action)}>{actions[gap.action]}</button>}
      </li>)}</ul></section>}
    </>}
    <p className="help">Exact campaign review and approval are always required. Setup never grants permission to send.</p>
    <div className="actions">
      {onRefresh&&<button type="button" className="btn secondary" disabled={loading} onClick={onRefresh}>Refresh setup</button>}
      {workspace&&<button type="button" className="btn secondary" onClick={()=>onNavigate('settings')}>View workspace</button>}
      {!!names.length&&<button type="button" className="btn secondary" onClick={()=>onNavigate('campaigns')}>Open campaigns</button>}
    </div>
  </section>;
}
