import {useCallback,useEffect,useId,useRef,useState} from 'react';
import type {Campaign,CommandName} from '../shared/contracts.js';
import type {AudienceContact,ContactPage} from '../shared/audience.js';
import type {CustomerCampaignPreflight} from '../shared/customer-preflight.js';
import type {DeliveryView} from '../shared/customer-delivery.js';
import type {TestDeliveryDetails,TestDeliveryReview} from '../shared/customer-test-send.js';
import type {Api} from './api.js';
import {operationKey} from './api.js';
import {ConfirmedTestRecipientPicker} from './ConfirmedTestRecipientPicker.js';
import {TestSendReview} from './TestSendReview.js';
import {CampaignPreview} from './CampaignPreview.js';

type Captured={to:string;subject:string;html:string;text:string;images:{sha256:string;mime:string;base64:string}[]};
type Props={api:Api;brandId:string;draft:Campaign|null;restoreId?:string|null;onSelectTest?:(campaignId:string,id:string)=>void;onRestoreConsumed?:()=>void;onChanged?:()=>Promise<void>};
const explain=(error:unknown)=>error instanceof Error?error.message:'The test could not finish. Refresh its original status before trying again.';
function capturedHtml(message:Captured){
  const images=new Map(message.images.filter(image=>['image/png','image/jpeg','image/webp'].includes(image.mime)&&/^[a-f0-9]{64}$/.test(image.sha256))
    .map(image=>[image.sha256,'data:'+image.mime+';base64,'+image.base64]));
  const html=message.html.replace(/cid:([a-f0-9]{64})/g,(_match,id:string)=>images.get(id)??'');
  const policy="<meta http-equiv=\"Content-Security-Policy\" content=\"default-src &#39;none&#39;; img-src data:; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;\">";
  return html.includes('<head>')?html.replace('<head>','<head>'+policy):policy+html;
}
export function CustomerTestSendPanel(props:Props){
  if(!props.draft)return <section className="card"><h2>Test one confirmed contact</h2><p>Choose a saved campaign above to prepare its separate one-recipient test.</p></section>;
  if(props.draft.brandId!==props.brandId)return <p role="alert">Choose a saved campaign in this brand.</p>;
  return <TestSend key={props.draft.id+':'+props.draft.version} {...props} draft={props.draft}/>;
}
function TestSend({api,brandId,draft,restoreId,onSelectTest,onRestoreConsumed,onChanged}:Props&{draft:Campaign}){
  const prefix=useId(),alive=useRef(true),contactsRequest=useRef(0),historyRequest=useRef(0),working=useRef(false);
  const pending=useRef(new Map<string,{signature:string;key:string}>());
  const [contacts,setContacts]=useState<AudienceContact[]>([]),[cursor,setCursor]=useState<string|null>(null),[search,setSearch]=useState(''),[selectedId,setSelectedId]=useState('');
  const [contactsBusy,setContactsBusy]=useState(false),[contactError,setContactError]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [history,setHistory]=useState<DeliveryView[]>([]),[historyError,setHistoryError]=useState('');
  const [checks,setChecks]=useState<CustomerCampaignPreflight|null>(null),[review,setReview]=useState<TestDeliveryReview|null>(null),[recipientLabel,setRecipientLabel]=useState('');
  const [canApprove,setCanApprove]=useState(false),[approvalUnknown,setApprovalUnknown]=useState(false),[capture,setCapture]=useState<Captured|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;contactsRequest.current++;};},[]);
  const current=()=>alive.current;
  function assertReview(value:TestDeliveryReview,id?:string,subscriberId?:string){
    if(value.purpose!=='test'||value.brandId!==brandId||value.campaignId!==draft.id||value.selected!==1||
      (id&&value.id!==id)||(subscriberId&&value.testSubscriberId!==subscriberId))throw Error('The returned test does not match the exact selected campaign and recipient. Refresh the original review.');
  }
  async function mutate<T>(name:CommandName,input:Record<string,unknown>,slot:string):Promise<T>{
    const signature=JSON.stringify([name,input]),prior=pending.current.get(slot),key=prior?.signature===signature?prior.key:operationKey();
    pending.current.set(slot,{signature,key});
    const result=await api.call<T>(name,{...input,operationKey:key});
    return result;
  }
  const loadContacts=useCallback(async(next?:string,query='')=>{
    const request=++contactsRequest.current;setContactsBusy(true);setContactError('');
    try{
      const page=await api.call<ContactPage>('audience.list',{brandId,state:'confirmed',limit:25,...(next?{cursor:next}:{}),...(query?{email:query}:{})});
      if(!alive.current||request!==contactsRequest.current)return;
      setContacts(previous=>next?[...previous,...page.items.filter(item=>!previous.some(prior=>prior.id===item.id))]:page.items);setCursor(page.nextCursor);
    }catch(error){if(alive.current&&request===contactsRequest.current)setContactError(explain(error));}
    finally{if(alive.current&&request===contactsRequest.current)setContactsBusy(false);}
  },[api,brandId]);
  useEffect(()=>{void loadContacts();},[loadContacts]);
  const loadHistory=useCallback(async()=>{
    const request=++historyRequest.current;
    try{const rows=await api.call<DeliveryView[]>('delivery.list',{brandId,purpose:'test'});if(alive.current&&request===historyRequest.current){setHistory(rows.filter(row=>row.purpose==='test'));setHistoryError('');}}
    catch(error){if(alive.current&&request===historyRequest.current)setHistoryError(explain(error));}
  },[api,brandId]);
  useEffect(()=>{void loadHistory();},[loadHistory]);
  const restore=useCallback(async(id:string)=>{
    const details=await api.call<TestDeliveryDetails>('delivery.testDetails',{brandId,id});
    if(!alive.current)return;
    const value=details.review;
    if(value.purpose!=='test'||value.brandId!==brandId||value.campaignId!==draft.id||value.id!==id||value.selected!==1||details.recipient.id!==value.testSubscriberId)
      throw Error('The restored test does not match this campaign and brand.');
    setReview(value);setSelectedId(value.testSubscriberId);setRecipientLabel(details.recipient.email??'Contact '+value.testSubscriberId);
    setCanApprove(details.canApprove&&details.recipient.eligible&&value.version===draft.version);setApprovalUnknown(false);
    if(value.version!==draft.version)setNotice('This test uses an older saved version. Prepare a fresh review of the current saved campaign.');
  },[api,brandId,draft.id,draft.version]);
  useEffect(()=>{
    if(!restoreId)return;
    if(working.current){setError('Wait for the current test action before opening another saved review.');onRestoreConsumed?.();return;}
    working.current=true;setBusy('restore');setError('');
    void restore(restoreId).catch(error=>{if(alive.current)setError(explain(error));}).finally(()=>{
      if(alive.current){working.current=false;setBusy('');onRestoreConsumed?.();}
    });
  },[restoreId,restore,onRestoreConsumed]);
  async function act(action:'approve'|'process'|'cancel'|'resume'|'refresh'){
    if(working.current||!review)return;
    working.current=true;setBusy(action);setError('');setNotice('');
    const original=review;let actionSaved=false;
    try{
      if(action==='approve'){
        setApprovalUnknown(true);
        const value=await mutate<TestDeliveryReview>('delivery.approveTest',{brandId,id:original.id,expectedVersion:original.version,subscriberId:original.testSubscriberId},'approve:'+original.id);
        assertReview(value,original.id,original.testSubscriberId);if(value.version!==original.version)throw Error('The approved test version does not match its frozen review.');pending.current.delete('approve:'+original.id);if(!current())return;
        setReview(value);setCanApprove(false);setApprovalUnknown(false);actionSaved=true;
      }else if(action==='process'){
        const result=await mutate<{processingRequested:boolean;id:string}>('delivery.process',{brandId,id:original.id},action+':'+original.id);
        if(!result.processingRequested||result.id!==original.id)throw Error('The process result does not match the original test.');
        pending.current.delete(action+':'+original.id);actionSaved=true;
      }else if(action==='resume'){
        if(!original.testDay||!original.testAdmittedAt)throw Error('Refresh this paused test’s recorded approval before resuming.');
        const result=await mutate<DeliveryView>('delivery.resume',{brandId,id:original.id},action+':'+original.id);
        if(result.purpose!=='test'||result.id!==original.id||result.brandId!==brandId||result.campaignId!==original.campaignId||result.version!==original.version||
          result.testDay!==original.testDay||result.testAdmittedAt!==original.testAdmittedAt)throw Error('The resumed test does not match its original approved day and frozen campaign. Refresh the original status.');
        pending.current.delete(action+':'+original.id);actionSaved=true;
      }else if(action==='cancel'){
        const result=await mutate<DeliveryView>('delivery.cancel',{brandId,id:original.id},action+':'+original.id);
        if(result.purpose!=='test'||result.id!==original.id||result.brandId!==brandId)throw Error('The cancellation result does not match the original test.');
        pending.current.delete(action+':'+original.id);actionSaved=true;
      }
      await restore(original.id);if(!current())return;
      setNotice('The original test status is shown below.');await loadHistory();
      try{await onChanged?.();}catch{setNotice('Test status updated. Refresh delivery history to see the saved result there.');}
    }catch(error){if(current())setError((actionSaved?'The original test action was saved, but its current status could not refresh. ':'')+explain(error));}
    finally{if(current()){working.current=false;setBusy('');}}
  }
  async function reviewTest(){
    const recipient=contacts.find(contact=>contact.id===selectedId&&contact.state==='confirmed');
    if(working.current||!recipient)return;
    working.current=true;setBusy('review');setError('');setNotice('');setCapture(null);setChecks(null);
    try{
      const preflight=await api.call<CustomerCampaignPreflight>('delivery.preflight',{brandId,campaignId:draft.id,expectedVersion:draft.version,purpose:'test',subscriberId:recipient.id});
      if(!current())return;
      if(preflight.purpose!=='test'||preflight.brandId!==brandId||preflight.campaignId!==draft.id||preflight.version!==draft.version)throw Error('The test preflight does not match the saved campaign. Reload it before continuing.');
      setChecks(preflight);if(preflight.gaps.length){setNotice('Resolve the test setup gaps before preparing a review.');return;}
      const value=await mutate<TestDeliveryReview>('delivery.reviewTest',{brandId,campaignId:draft.id,expectedVersion:draft.version,subscriberId:recipient.id},'review');
      assertReview(value,undefined,recipient.id);if(value.version!==draft.version)throw Error('The saved campaign changed. Refresh it before reviewing a test.');
      pending.current.delete('review');if(!current())return;setReview(value);setRecipientLabel(recipient.email);setCanApprove(true);setApprovalUnknown(false);
      setNotice('Review the frozen details below, then explicitly approve this one-recipient test.');await loadHistory();
      try{await onChanged?.();}catch{/* The review remains saved; the owner can refresh its history. */}
    }catch(error){if(current())setError(explain(error));}
    finally{if(current()){working.current=false;setBusy('');}}
  }
  async function preview(){
    const person=review?.recipients.find(person=>person.state==='accepted');if(!review||!person||working.current)return;
    working.current=true;setBusy('preview');setError('');
    try{const message=await api.call<Captured>('delivery.message',{brandId,id:review.id,recipientId:person.id});if(current())setCapture(message);}
    catch(error){if(current())setError(explain(error));}finally{if(current()){working.current=false;setBusy('');}}
  }
  const locked=!!busy||approvalUnknown||!!review&&review.state!=='reviewed';
  const startAgain=review&&['completed','cancelled','blocked'].includes(review.state)&&review.uncertain===0&&review.pending+review.preparing+review.submitting===0;
  return <section className="card" aria-labelledby={prefix+'-title'} style={{overflowWrap:'anywhere'}}>
    <h2 id={prefix+'-title'}>Test one confirmed contact</h2><p>Saved campaign: {draft.content.subject||draft.content.title} · version {draft.version}. This never sends to the full audience.</p>
    <p className="help">At most five approved test requests per workspace per UTC day, shared across brands. A canceled or failed test still counts toward this daily limit. An accepted real test uses one recipient email and no campaign slot.</p>
    <ConfirmedTestRecipientPicker prefix={prefix} contacts={contacts} selectedId={selectedId} busy={locked||contactsBusy} search={search} error={contactError} hasMore={!!cursor}
      onSelect={id=>{setSelectedId(id);setReview(null);setChecks(null);setCapture(null);setCanApprove(false);setNotice('');}}
      onSearchChange={setSearch} onSearch={()=>{setReview(null);setChecks(null);setSelectedId('');void loadContacts(undefined,search.trim());}}
      onNext={()=>void loadContacts(cursor??undefined,search.trim())} onRefresh={()=>void loadContacts(undefined,search.trim())}/>
    {!review&&<button type="button" className="btn" disabled={!!busy||contactsBusy||!!contactError||!contacts.some(person=>person.id===selectedId&&person.state==='confirmed')} onClick={()=>void reviewTest()}>Review one-recipient test</button>}
    {error&&<p role="alert" className="notice error">{error}</p>}{notice&&<p role="status" className="notice">{notice}</p>}
    {checks&&<div><p className="help">Test checks observed {checks.observedAt}. {checks.testBudget&&`${checks.testBudget.remaining} of ${checks.testBudget.limit} daily approvals remain at that check (${checks.testBudget.day} UTC).`}</p><ul>{checks.gaps.map((gap,index)=><li key={gap.code+'-'+index}><strong>{gap.title}</strong><p>{gap.detail}</p></li>)}</ul></div>}
    {review&&<TestSendReview review={review} recipientLabel={recipientLabel} canApprove={canApprove&&!approvalUnknown} busy={!!busy}
      onApprove={()=>void act('approve')} onProcess={()=>void act('process')} onResume={()=>void act('resume')} onCancel={()=>void act('cancel')} onRefresh={()=>void act('refresh')} onPreview={()=>void preview()}/>}
    {approvalUnknown&&<div className="notice"><p>Approval may already be saved. Refresh this original test or retry the same approval; do not prepare a replacement.</p><button type="button" className="btn secondary" disabled={!!busy} onClick={()=>void act('approve')}>Retry same test approval</button></div>}
    {review?.state==='reviewed'&&!approvalUnknown&&<button type="button" className="btn secondary" disabled={!!busy} onClick={()=>{setReview(null);setChecks(null);setSelectedId('');setCapture(null);setCanApprove(false);setError('');setNotice('The previous test remains unapproved in history. Choose a confirmed contact for a fresh review.');}}>Prepare fresh test review</button>}
    {startAgain&&<button type="button" className="btn secondary" disabled={!!busy} onClick={()=>{setReview(null);setChecks(null);setSelectedId('');setCapture(null);setCanApprove(false);setError('');setNotice('');}}>Prepare another test</button>}
    <section aria-labelledby={prefix+'-history'}><h3 id={prefix+'-history'}>Recent one-recipient tests</h3>
      <p className="help">Up to 100 recent tests for this brand. Broadcast campaign history is separate.</p>
      {historyError&&<p role="alert">{historyError}</p>}
      <button type="button" className="btn secondary" disabled={!!busy} onClick={()=>void loadHistory()}>Refresh test history</button>
      {!history.length&&!historyError&&<p>No test reviews recorded yet.</p>}
      {history.map(item=><article key={item.id} className="delivery-record"><h4>{item.subject}</h4><p>One-recipient test · version {item.version} · {item.state} · {item.testDay?item.testDay+' UTC':'Not approved'}</p>
        <p>{item.accepted} {item.mode==='capture'?'captured acceptances':'provider accepted'} · {item.uncertain} uncertain. Acceptance does not establish inbox delivery.</p>
        <button type="button" className="btn secondary" disabled={!!busy||approvalUnknown} onClick={()=>{if(onSelectTest)onSelectTest(item.campaignId,item.id);else if(item.campaignId===draft.id){working.current=true;setBusy('restore');setError('');void restore(item.id).catch(error=>{if(current())setError(explain(error));}).finally(()=>{if(current()){working.current=false;setBusy('');}});}else setError('Choose this test’s saved campaign before opening its details.');}}>Open one-recipient test</button>
      </article>)}
    </section>
    {capture&&<section><h3>Captured test message</h3><p>{capture.subject} · {capture.to}</p><CampaignPreview title="Captured test email" html={capturedHtml(capture)}/><details><summary>Plain-text test message</summary><pre className="message-text">{capture.text}</pre></details></section>}
  </section>;
}
