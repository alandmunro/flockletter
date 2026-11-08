import { useCallback, useEffect, useRef, useState } from 'react';
import { operationKey } from './api.js';
import type { PlatformApi } from './platform-api.js';
import type { PlatformCase } from '../shared/platform.js';
import type { SupportTicket, SupportPolicyReview } from '../shared/customer-support.js';
import { SupportDeliveryActions } from './SupportDeliveryActions.js';

type Policy = { version:number; enabled:boolean; mode:'capture'|'live'; responses:Record<string,string>; valid_until:string };
type Props = {
  api:PlatformApi; review:PlatformCase; onError:(message:string)=>void;
  supportMode:'off'|'capture'|'live'; writerConfigured:boolean;
};
export function OperatorSupportReview({api,review,onError,supportMode,writerConfigured}:Props) {
  const [ticket,setTicket]=useState<SupportTicket|null>(null),[text,setText]=useState('');
  const [busy,setBusy]=useState(false),[policy,setPolicy]=useState<SupportPolicyReview|null>(null);
  const [current,setCurrent]=useState<Policy|null>(null),[useWriter,setUseWriter]=useState(false),[reason,setReason]=useState('');
  const pending=useRef<{signature:string;key:string}|null>(null),active=useRef(true);
  const request=useCallback(<T,>(command:string,input:Record<string,unknown>)=>api.call<T>('platform.support',{caseId:review.id,command,input}),[api,review.id]);
  const refresh=useCallback(async()=>{
    if(review.resourceId) {
      const value=await request<SupportTicket>('support.get',{});
      if(active.current){setTicket(value);setText(value.draft??'');}
    } else {
      const value=await request<{policies:Policy[]}>('support.policyHistory',{});
      if(active.current)setCurrent(value.policies[0]??null);
    }
  },[request,review.resourceId]);
  useEffect(()=>{
    active.current=true;setBusy(true);
    void refresh().catch(error=>{if(active.current)onError(error instanceof Error?error.message:'Support review is unavailable.');}).finally(()=>{if(active.current)setBusy(false);});
    return()=>{active.current=false;};
  },[refresh,onError]);
  async function run(command:string,input:Record<string,unknown>={},mutation=true) {
    const signature=JSON.stringify([review.id,command,input]);
    if(mutation && pending.current?.signature!==signature)pending.current={signature,key:operationKey()};
    setBusy(true);onError('');
    try {
      const result=await request<SupportTicket&SupportPolicyReview>(command,{...input,...(mutation?{operationKey:pending.current!.key}:{})});
      if(!active.current)return;
      if(command==='support.policyPreview')setPolicy(result);
      else if(command==='support.publishPolicy'){setPolicy(null);await refresh();}
      else {setTicket(result);setText(result.draft??'');}
      pending.current=null;
    } catch(error) {if(active.current)onError(error instanceof Error?error.message:'The support action failed.');}
    finally {if(active.current)setBusy(false);}
  }
  async function reload() {
    setBusy(true);onError('');
    try{await refresh();}catch(error){if(active.current)onError(error instanceof Error?error.message:'Could not reload saved support data.');}
    finally{if(active.current)setBusy(false);}
  }
  if(!review.resourceId) return <section className="card" aria-labelledby="operator-support-policy-title">
    <h2 id="operator-support-policy-title">Approved support automation</h2>
    <p>Transport: <strong>{supportMode}</strong>. {supportMode==='capture'?'Policy exercises record replies without sending email.':supportMode==='live'?'An enabled policy can send real email only after separate live activation.':'Configure support before reviewing a policy.'}</p>
    <p>Only recognized public-guidance questions can receive an automatic answer. Uncertain, sensitive and repeated requests go to a person.</p>
    {current?<p>Current version {current.version}: <strong>{current.enabled?'Enabled':'Disabled'}</strong> · {current.mode} · valid until {new Date(current.valid_until).toLocaleString()}.</p>:<p>No approved automation policy is recorded.</p>}
    <button className="btn secondary" disabled={busy} onClick={()=>void reload()}>Refresh policy status</button>
    <label><input type="checkbox" checked={useWriter} disabled={busy||!writerConfigured} onChange={event=>{setUseWriter(event.target.checked);setPolicy(null);}}/> Use the configured AI writer to draft public guidance for my review</label>
    <p>{writerConfigured?'The writer receives approved public guidance only. Its draft cannot send until you approve the exact responses below.':'No AI writer is configured. Deterministic public guidance remains available.'}</p>
    <div className="actions">
      <button className="btn secondary" disabled={busy||supportMode==='off'} onClick={()=>void run('support.policyPreview',{expectedVersion:current?.version??0,enabled:true,mode:supportMode,topics:['plans','trial','audience','campaigns'],validForDays:7,useWriter})}>Review an enabled policy</button>
      <button className="btn secondary" disabled={busy||supportMode==='off'||!current?.enabled} onClick={()=>void run('support.policyPreview',{expectedVersion:current?.version??0,enabled:false,mode:supportMode,topics:['plans','trial','audience','campaigns'],validForDays:7,useWriter:false})}>Review disabling automatic replies</button>
    </div>
    {policy&&<article className="card" aria-labelledby="operator-policy-preview-title">
      <h3 id="operator-policy-preview-title">Exact policy for approval</h3>
      <p>Version {policy.parentVersion+1} · <strong>{policy.enabled?'Enabled':'Disabled'}</strong> · {policy.mode}. Review expires {new Date(policy.expiresAt).toLocaleString()}; policy expires {new Date(policy.validUntil).toLocaleString()}.</p>
      {Object.entries(policy.responses).map(([topic,body])=><section key={topic}><h4>{topic}</h4><p className="preserve-whitespace">{body}</p></section>)}
      <button className="btn" disabled={busy||Date.parse(policy.expiresAt)<=Date.now()} onClick={()=>void run('support.publishPolicy',{previewId:policy.id,reviewCode:policy.reviewCode})}>{policy.enabled?'Approve these exact responses':'Approve disabled policy'}</button>
    </article>}
  </section>;
  const reviewable=ticket&&['open','review','replied','escalated'].includes(ticket.state);
  const exactDraft=!!ticket?.reviewCode&&text===ticket.draft;
  return <section className="card" aria-labelledby="operator-support-review-title">
    <h2 id="operator-support-review-title">Conversation review</h2>
    <p>Access is limited to this case’s conversation and expires at {new Date(review.expiresAt).toLocaleTimeString()}. Open a new case after expiry.</p>
    {!ticket?<><p role="status">{busy?'Loading conversation…':'The conversation could not be loaded.'}</p><button className="btn secondary" disabled={busy} onClick={()=>void reload()}>Retry loading conversation</button></>:<>
      <h3>{ticket.subject}</h3><p className="badge">{ticket.state.replaceAll('_',' ')} · version {ticket.version}</p>
      {ticket.messages.map(message=><article key={message.id}><strong>{message.kind.replaceAll('_',' ')} · {message.provenance.replaceAll('_',' ')}</strong><p className="preserve-whitespace">{message.text}</p></article>)}
      {reviewable&&<><label htmlFor="operator-support-draft">Reply draft</label><textarea id="operator-support-draft" rows={8} maxLength={4000} value={text} onChange={event=>setText(event.target.value)} disabled={busy}/>
      <div className="actions"><button className="btn secondary" disabled={busy||ticket.state==='escalated'||supportMode==='off'} onClick={()=>void run('support.draft',{expectedVersion:ticket.version})}>Draft public guidance</button><button className="btn secondary" disabled={busy||!text.trim()||supportMode==='off'} onClick={()=>void run('support.editDraft',{expectedVersion:ticket.version,text})}>Save exact draft</button></div></>}
      {ticket.state==='queued'&&ticket.draft&&<><h4>Frozen approved reply</h4><p className="preserve-whitespace">{ticket.draft}</p></>}
      <SupportDeliveryActions busy={busy} mode={supportMode} state={ticket.state} delivery={ticket.delivery}
        canApprove={ticket.state==='review'&&exactDraft}
        canRenew={ticket.state==='queued'&&ticket.delivery?.state==='queued'&&ticket.delivery.attempts===0&&exactDraft}
        canProcess={!!ticket.delivery&&['queued','submitting','uncertain'].includes(ticket.delivery.state)}
        onRefresh={()=>void reload()}
        onApprove={()=>void run('support.approve',{expectedVersion:ticket.version,reviewCode:ticket.reviewCode})}
        onRenew={()=>void run('support.reauthorize',{expectedVersion:ticket.version,reviewCode:ticket.reviewCode})}
        onProcess={()=>void run('support.process')}/>
      {ticket.state!=='closed'&&<><label htmlFor="operator-support-handoff">Reason for a human handoff</label><input id="operator-support-handoff" maxLength={500} value={reason} onChange={event=>setReason(event.target.value)} disabled={busy}/><div className="actions"><button className="btn secondary" disabled={busy||!reason.trim()||supportMode==='off'} onClick={()=>void run('support.escalate',{expectedVersion:ticket.version,reason})}>Escalate to a human</button><button className="btn secondary" disabled={busy||supportMode==='off'} onClick={()=>void run('support.close',{expectedVersion:ticket.version})}>Close conversation</button></div><p>Closing or escalating cancels an unattempted queued reply. An uncertain provider attempt still requires receipt reconciliation.</p></>}
    </>}
  </section>;
}
