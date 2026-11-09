import {useEffect,useId,useRef,useState} from 'react';
import type {Api} from './api.js';
import {deliveryRecipientStates,deliveryFeedbackKinds,type DeliveryOutcomesPage} from '../shared/customer-delivery.js';

type Props={api:Api;brandId:string;deliveryId:string;onPreview?:(recipientId:string)=>void;refreshKey?:string};
type Results={key:string;page:DeliveryOutcomesPage;items:DeliveryOutcomesPage['items']};
const words=(value:string)=>value.replaceAll('_',' ');

export function DeliveryOutcomes(props:Props) {
  return <Outcomes key={JSON.stringify([props.brandId,props.deliveryId])} {...props}/>;
}
function Outcomes({api,brandId,deliveryId,onPreview,refreshKey}:Props) {
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [status,setStatus]=useState(''),[feedback,setFeedback]=useState(''),[revision,setRevision]=useState(0);
  const [results,setResults]=useState<Results|null>(null);
  const sequence=useRef(0),inFlight=useRef(false),prefix=useId();
  const key=JSON.stringify([brandId,deliveryId,status,feedback,refreshKey,revision]);
  const shown=results?.key===key?results:null;

  useEffect(()=>{
    if(!open)return;
    const request=++sequence.current;inFlight.current=true;setBusy(true);setError(null);setResults(null);
    void api.call<DeliveryOutcomesPage>('delivery.outcomes',{brandId,id:deliveryId,limit:25,
      ...(status?{state:status}:{}),...(feedback?{feedback}:{})}).then(page=>{
      if(sequence.current!==request)return;
      if(page.deliveryId!==deliveryId||page.brandId!==brandId)throw Error('These results do not match the selected delivery. Refresh the results.');
      setResults({key,page,items:page.items});
    }).catch((reason:unknown)=>{
      if(sequence.current===request)setError(reason instanceof Error?reason.message:'Recipient outcomes are unavailable.');
    }).finally(()=>{if(sequence.current===request){inFlight.current=false;setBusy(false);}});
    return ()=>{sequence.current++;inFlight.current=false;};
  },[api,brandId,deliveryId,status,feedback,open,key]);

  async function more() {
    if(inFlight.current||!shown?.page.nextCursor)return;
    const request=++sequence.current;inFlight.current=true;setBusy(true);setError(null);
    try {
      const page=await api.call<DeliveryOutcomesPage>('delivery.outcomes',{brandId,id:deliveryId,limit:25,
        after:shown.page.nextCursor,...(status?{state:status}:{}),...(feedback?{feedback}:{})});
      if(sequence.current!==request)return;
      if(page.deliveryId!==deliveryId||page.brandId!==brandId)throw Error('These results do not match the selected delivery. Refresh the results.');
      setResults(previous=>{
        if(previous?.key!==key)return previous;
        const known=new Set(previous.items.map(item=>item.id));
        return {key,page,items:[...previous.items,...page.items.filter(item=>!known.has(item.id))]};
      });
    }catch(reason){if(sequence.current===request)setError(reason instanceof Error?reason.message:'More outcomes are unavailable.');}
    finally{if(sequence.current===request){inFlight.current=false;setBusy(false);}}
  }
  function close(){sequence.current++;inFlight.current=false;setBusy(false);setResults(null);setError(null);setOpen(false);}
  if(!open)return <button type="button" className="btn secondary" onClick={()=>setOpen(true)}>Show recipient outcomes</button>;
  return <section aria-labelledby={prefix+'-heading'} className="delivery-outcomes">
    <h4 id={prefix+'-heading'}>Recipient outcomes</h4>
    <div className="actions">
      <label htmlFor={prefix+'-state'}>Status</label>
      <select id={prefix+'-state'} value={status} disabled={busy} onChange={event=>setStatus(event.target.value)}>
        <option value="">All statuses</option>{deliveryRecipientStates.map(value=><option key={value} value={value}>{words(value)}</option>)}
      </select>
      <label htmlFor={prefix+'-feedback'}>Provider feedback</label>
      <select id={prefix+'-feedback'} value={feedback} disabled={busy} onChange={event=>setFeedback(event.target.value)}>
        <option value="">All feedback</option>{deliveryFeedbackKinds.map(value=><option key={value} value={value}>{words(value)}</option>)}
      </select>
      <button type="button" className="btn secondary" disabled={busy} onClick={()=>setRevision(value=>value+1)}>Refresh outcomes</button>
      <button type="button" className="btn secondary" onClick={close}>Close recipient outcomes</button>
    </div>
    {error&&<div className="notice" role="alert">{error} <button type="button" className="btn secondary" disabled={busy} onClick={()=>setRevision(value=>value+1)}>Retry outcomes</button></div>}
    {busy&&<p role="status">Loading recipient outcomes…</p>}
    {shown&&<>
      <p className="help" role="status">Showing {shown.items.length} loaded outcomes · {shown.page.total} match at last check.</p>
      <p className="help">Last page checked {new Date(shown.page.observedAt).toLocaleString()}. Feedback can change between pages. Refresh starts again and updates earlier results.</p>
      {!shown.items.length?<p>No matching recipient outcomes.</p>:<ul aria-label="Recipient outcomes" className="delivery-outcome-list">
        {shown.items.map(item=><li key={item.id}>
          <p><strong>{item.state==='accepted'?(shown.page.mode==='capture'?'Accepted in captured exercise':'Accepted by provider'):words(item.state)}</strong> · {item.attempts} {item.attempts===1?'submission attempt':'submission attempts'}</p>
          <p className="help">Recipient {item.id}</p>
          <p>{shown.page.mode==='capture'?'Captured feedback':'Provider feedback'}: {item.feedback?words(item.feedback):'No feedback received'}</p>
          {item.reason&&<p>Reason: {words(item.reason)}</p>}
          {item.state==='uncertain'&&<p className="notice">The provider may have accepted this message. Use Process or reconcile above; do not resend it while the outcome is unknown.</p>}
          {item.state==='accepted'&&!item.feedback&&<p className="help">{shown.page.mode==='capture'?'Captured outcomes do not establish delivery to a real inbox.':'Acceptance does not confirm inbox delivery.'}</p>}
          {shown.page.mode==='capture'&&item.state==='accepted'&&onPreview&&<button type="button" className="btn secondary" onClick={()=>onPreview(item.id)}>View captured message for recipient {item.id}</button>}
        </li>)}
      </ul>}
      {shown.page.nextCursor&&<button type="button" className="btn secondary" disabled={busy} onClick={()=>void more()}>Load more outcomes</button>}
    </>}
  </section>;
}
