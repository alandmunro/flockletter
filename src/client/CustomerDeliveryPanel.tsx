import { useCallback,useEffect,useRef,useState } from 'react';
import type { Api } from './api.js';
import { operationKey } from './api.js';
import type { Brand,Campaign,CommandName } from '../shared/contracts.js';
import type { DeliveryView,DeliveryMode } from '../shared/customer-delivery.js';
import type { CustomerBillingStatus } from '../shared/customer-billing.js';
import type { SegmentDirectory } from '../shared/segments.js';
import { SenderProfilePanel } from './SenderProfilePanel.js';
import { DeliveryOutcomes } from './DeliveryOutcomes.js';
import type { CustomerCampaignPreflight } from '../shared/customer-preflight.js';

type Status={mode:DeliveryMode;eligible:boolean;eligibility:CustomerBillingStatus;gaps:string[]};
type Captured={to:string;subject:string;html:string;text:string;images:{sha256:string;mime:string;base64:string}[]};
const explain=(error:unknown)=>error instanceof Error?error.message:'This action could not finish. Retry with the same inputs.';
function captureHtml(message:Captured) {
  const images=new Map(message.images.filter(image=>['image/jpeg','image/png','image/webp'].includes(image.mime)&&/^[a-f0-9]{64}$/.test(image.sha256))
    .map(image=>[image.sha256,'data:'+image.mime+';base64,'+image.base64]));
  const html=message.html.replace(/cid:([a-f0-9]{64})/g,(_match,sha:string)=>images.get(sha)??'');
  const policy='<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data:; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;">';
  return html.includes('<head>')?html.replace('<head>','<head>'+policy):policy+html;
}
export function CustomerDeliveryPanel({api,brands}:{api:Api;brands:Brand[]}) {
  const [id,setId]=useState(brands[0]?.id??'');
  const brand=brands.find(item=>item.id===id);
  return <><h1 className="page-heading">Delivery</h1><p className="page-intro">Review your saved message and audience, then approve that exact version.</p>
    <div className="field"><label htmlFor="delivery-brand">Sending brand</label><select id="delivery-brand" value={id} onChange={event=>setId(event.target.value)}>
      {brands.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
    {brand&&<><DeliveryBrand key={brand.id} api={api} brand={brand}/><SenderProfilePanel key={'sender-'+brand.id} api={api} brandId={brand.id}/></>}
  </>;
}
function DeliveryBrand({api,brand}:{api:Api;brand:Brand}) {
  const [status,setStatus]=useState<Status|null>(null),[campaigns,setCampaigns]=useState<Campaign[]>([]),[deliveries,setDeliveries]=useState<DeliveryView[]>([]),[groups,setGroups]=useState<SegmentDirectory|null>(null);
  const [campaignId,setCampaignId]=useState(''),[schedule,setSchedule]=useState(''),[segmentId,setSegmentId]=useState('');
  const [busy,setBusy]=useState(''),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [outcomeRevision,setOutcomeRevision]=useState(0);
  const [checks,setChecks]=useState<CustomerCampaignPreflight|null>(null);
  const [review,setReview]=useState<DeliveryView|null>(null),[reviewAudience,setReviewAudience]=useState(''),[capture,setCapture]=useState<{deliveryId:string;recipientId:string;message:Captured}|null>(null);
  const pending=useRef(new Map<string,{signature:string;key:string}>()),acting=useRef(false),context=useRef(0);
  const read=useCallback(async()=>{
    const [s,cs,ds,gs]=await Promise.all([api.call<Status>('delivery.status',{brandId:brand.id}),api.call<Campaign[]>('campaign.list',{}),api.call<DeliveryView[]>('delivery.list',{brandId:brand.id}),api.call<SegmentDirectory>('segment.list',{brandId:brand.id})]);
    return {s,cs:cs.filter(item=>item.brandId===brand.id),ds,gs};
  },[api,brand.id]);
  const apply=useCallback((data:Awaited<ReturnType<typeof read>>)=>{
    setStatus(data.s);setCampaigns(data.cs);setDeliveries(data.ds);setGroups(data.gs);setLoaded(true);
    setOutcomeRevision(value=>value+1);
    setChecks(null);
    setCampaignId(id=>data.cs.some(item=>item.id===id)?id:data.cs[0]?.id??'');
  },[]);
  useEffect(()=>{
    context.current++;
    let active=true;
    void read().then(data=>{if(active)apply(data);}).catch(error=>{if(active)setError(explain(error));});
    return ()=>{active=false;context.current++;};
  },[read,apply]);
  const working=deliveries.some(item=>item.state==='queued'||item.uncertain>0||item.submitting>0);
  useEffect(()=>{
    if(!working)return;
    let active=true;
    const timer=setInterval(()=>{if(acting.current)return;void api.call<DeliveryView[]>('delivery.list',{brandId:brand.id})
      .then(rows=>{if(active)setDeliveries(rows);}).catch(error=>{if(active)setError(explain(error));});},5000);
    return ()=>{active=false;clearInterval(timer);};
  },[api,brand.id,working]);
  async function refresh() {
    if(acting.current)return;acting.current=true;setBusy('refresh');setError('');
    try{apply(await read());}catch(error){setError(explain(error));}finally{acting.current=false;setBusy('');}
  }
  async function mutate<T>(name:CommandName,input:Record<string,unknown>,slot:string,after?:(result:T)=>void,before?:()=>Promise<boolean>) {
    if(acting.current)return;acting.current=true;setBusy(slot);setError('');setNotice('');
    const current=context.current;
    const signature=JSON.stringify([name,input]),previous=pending.current.get(slot);
    const key=previous?.signature===signature?previous.key:operationKey();pending.current.set(slot,{signature,key});
    try {
      if(before&&!await before())return;
      if(current!==context.current)return;
      const result=await api.call<T>(name,{...input,operationKey:key});pending.current.delete(slot);after?.(result);
      setNotice('Saved. The results below show the recorded outcome.');
      try{apply(await read());}catch(error){setError('Your action was saved. Refresh the results: '+explain(error));}
    }catch(error){setError(explain(error));}finally{acting.current=false;setBusy('');}
  }
  const selectedGroup=groups?.items.find(item=>item.id===segmentId);
  const missingGroup=segmentId!==''&&!selectedGroup;
  async function reviewSaved() {
    const campaign=campaigns.find(item=>item.id===campaignId);if(!campaign)return;
    setReview(null);setChecks(null);
    if(missingGroup){setError('Selected group unavailable. Choose an available audience.');return;}
    let dueAt:string|undefined;
    if(schedule){const date=new Date(schedule);if(!Number.isFinite(date.getTime())){setError('Choose a valid date and time.');return;}dueAt=date.toISOString();}
    const input={brandId:brand.id,campaignId,expectedVersion:campaign.version,...(segmentId?{segmentId}:{}),...(dueAt?{dueAt}:{})};
    await mutate<DeliveryView>('delivery.review',input,'review',result=>{setReview(result);setReviewAudience(selectedGroup?.name??'All confirmed contacts');},async()=>{
      const observed=await api.call<CustomerCampaignPreflight>('delivery.preflight',input);setChecks(observed);
      return observed.gaps.length===0;
    });
  }
  async function preview(deliveryId:string,recipientId:string) {
    if(acting.current)return;acting.current=true;setBusy('preview');setError('');
    try{const message=await api.call<Captured>('delivery.message',{brandId:brand.id,id:deliveryId,recipientId});setCapture({deliveryId,recipientId,message});}
    catch(error){setError(explain(error));}finally{acting.current=false;setBusy('');}
  }
  return <><section className="card">
    <div className="actions"><h2>Review and approve</h2><button className="btn secondary" disabled={!!busy} onClick={()=>void refresh()}>{busy==='refresh'?'Refreshing…':'Refresh delivery'}</button></div>
    {error&&<p role="alert" className="notice error">{error}</p>}{notice&&<p role="status" className="notice success">{notice}</p>}
    {!loaded?<p>Loading delivery settings…</p>:<>
      <p className="badge">{status?.mode==='capture'?'Captured exercise · no external email':status?.mode==='ses'?'Customer provider configured':'Delivery is off'}</p>
      {status?.mode==='capture'&&<p className="help">These messages stay in your staging workspace. Captured outcomes exercise the workflow and cannot prove inbox delivery.</p>}
      {!!status?.gaps.length&&<ul>{status.gaps.map(gap=><li key={gap}>{gap}</li>)}</ul>}
      {!status?.eligible&&<div className="notice"><strong>Service activation needed</strong><ul>{status?.eligibility.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul><p>Open Subscription to review your plan or start a captured trial.</p></div>}
      <fieldset disabled={!!busy}>
        <div className="field"><label htmlFor="delivery-campaign">Saved campaign</label><select id="delivery-campaign" value={campaignId} onChange={event=>{setCampaignId(event.target.value);setReview(null);setChecks(null);}}>
          {campaigns.map(item=><option key={item.id} value={item.id}>{item.content.subject||item.content.title||'Untitled'} · version {item.version}</option>)}</select></div>
        <div className="field"><label htmlFor="delivery-audience">Audience</label><select id="delivery-audience" value={segmentId} onChange={event=>{setSegmentId(event.target.value);setReview(null);setChecks(null);}}>
          <option value="">All confirmed contacts</option>
          {missingGroup&&<option value={segmentId} disabled>Selected group unavailable</option>}
          {groups?.items.map(group=><option key={group.id} value={group.id}>{group.name} · {group.counts.confirmed} confirmed</option>)}</select>
          {missingGroup?<p className="help" role="status">Selected group unavailable. Choose an available audience.</p>:<p className="help">Review freezes the eligible recipients in this audience. Later group additions are not added to that review.</p>}
        </div>
        {!campaigns.length&&<p>Create and save a campaign before reviewing delivery.</p>}
        <div className="field"><label htmlFor="delivery-time">Schedule in your local time, optional</label><input id="delivery-time" type="datetime-local" value={schedule} onChange={event=>{setSchedule(event.target.value);setReview(null);setChecks(null);}}/></div>
        <button className="btn" disabled={!campaignId||status?.mode==='off'||missingGroup} onClick={()=>void reviewSaved()}>{busy==='review'?'Reviewing…':'Review saved campaign'}</button>
      </fieldset>
      {checks&&checks.gaps.length>0&&<section aria-label="Delivery preparation gaps" className="notice">
        <h3>Resolve these items before review</h3><ul>{checks.gaps.map((gap,index)=><li key={gap.code+'-'+index}><strong>{gap.title}</strong>: {gap.detail}</li>)}</ul>
        <p className="help">Checked {new Date(checks.observedAt).toLocaleString()}. This check has not created or approved a delivery.</p>
      </section>}
      {review&&<p role="status">{reviewAudience} · Reviewed version {review.version}: {review.selected} confirmed recipients and {review.excluded} excluded. Approve this review below.</p>}
    </>}
  </section>
  <section className="card"><h2>Delivery history</h2>{loaded&&!deliveries.length&&<p>No reviewed deliveries yet.</p>}
    {deliveries.map(item=><article className="delivery-record" key={item.id}>
      <h3>{item.subject}</h3><p>Version {item.version} · {item.state} · {new Date(item.dueAt).toLocaleString()}</p>
      {item.senderProfile&&<p className="help">From {item.senderProfile.fromName} &lt;{item.senderProfile.fromEmail}&gt; · Reply to {item.senderProfile.replyTo}</p>}
      <p>{item.selected} selected · {item.accepted} accepted · {item.delivered} {item.mode==='capture'?'captured delivery outcomes':'delivered'} · {item.uncertain} uncertain · {item.rejected} rejected · {item.skipped+item.excluded} excluded</p>
      <p className="help">{item.pending+item.preparing+item.submitting} processing · {item.hardBounced} hard bounces · {item.complained} complaints</p>
      {item.reason&&<p className="notice">{item.state==='paused'?'Paused: ':'Action needed: '}{item.reason.replaceAll('_',' ')}. {item.state==='paused'?'The reviewed recipients and reserved allowance are held. Resume when the cause is resolved.':'Preserve uncertain outcomes for reconciliation. A blocked review needs a fresh review after its cause is fixed.'}</p>}
      <div className="actions">
        {item.state==='reviewed'&&<button className="btn" disabled={!!busy} onClick={()=>void mutate('delivery.approve',{brandId:brand.id,id:item.id},'approve:'+item.id)}>{item.mode==='capture'?'Approve captured delivery':'Approve customer delivery'}</button>}
        {['queued','paused','cancelled','blocked'].includes(item.state)&&<button className="btn secondary" disabled={!!busy} onClick={()=>void mutate('delivery.process',{brandId:brand.id,id:item.id},'process:'+item.id)}>Process or reconcile</button>}
        {item.state==='queued'&&<button className="btn secondary" disabled={!!busy} onClick={()=>void mutate('delivery.pause',{brandId:brand.id,id:item.id},'pause:'+item.id)}>Pause future submissions</button>}
        {item.state==='paused'&&<button className="btn" disabled={!!busy} onClick={()=>void mutate('delivery.resume',{brandId:brand.id,id:item.id},'resume:'+item.id)}>Resume unchanged delivery</button>}
        {['reviewed','queued','paused'].includes(item.state)&&<button className="btn secondary" disabled={!!busy} onClick={()=>void mutate('delivery.cancel',{brandId:brand.id,id:item.id},'cancel:'+item.id)}>Cancel remaining work</button>}
      </div>
      {item.mode==='capture'&&<div className="actions">{item.recipients.filter(person=>person.state==='accepted').map((person,index)=><button className="btn secondary" key={person.id} disabled={!!busy} onClick={()=>void preview(item.id,person.id)}>View captured email {index+1}</button>)}</div>}
      {item.selected>50&&<p className="help">Quick previews show the first 50 recipients. Open recipient outcomes to inspect the full audience.</p>}
      <DeliveryOutcomes api={api} brandId={brand.id} deliveryId={item.id} refreshKey={String(outcomeRevision)}
        onPreview={item.mode==='capture'?person=>void preview(item.id,person):undefined}/>
    </article>)}
  </section>
  {capture&&<section className="card"><h2>Captured email</h2><p>{capture.message.subject} · To {capture.message.to}</p>
    <iframe sandbox="" title="Captured campaign email" srcDoc={captureHtml(capture.message)} className="customer-capture-preview"/>
    <details><summary>Plain text</summary><pre className="message-text">{capture.message.text}</pre></details>
    <p className="help">A captured hard bounce or complaint suppresses this staging contact for later campaigns.</p>
    <div className="actions">{(['delivered','hard_bounce','complaint','temporary_bounce'] as const).map(kind=><button className="btn secondary" key={kind} disabled={!!busy}
      onClick={()=>void mutate('delivery.exerciseFeedback',{brandId:brand.id,id:capture.deliveryId,recipientId:capture.recipientId,kind},'feedback:'+capture.deliveryId+':'+capture.recipientId)}>
      Capture {kind.replaceAll('_',' ')}</button>)}<button className="btn secondary" onClick={()=>setCapture(null)}>Close email</button></div>
  </section>}
  </>;
}
