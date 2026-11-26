import {useState} from 'react';
import {operationKey} from './api.js';
import type {PlatformApi} from './platform-api.js';
import type {PlatformCase} from '../shared/platform.js';

type Review={decision:string|null;revision:string|null;incident:string|null;balance:number};
export function OperatorGiftReview({api,review}:{api:PlatformApi;review:PlatformCase}) {
  const [facts,setFacts]=useState<Review>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function action(decision?:'paused'|'probation'|'complete'|'release') {
    setBusy(true);setError('');
    try {
      const input={caseId:review.id,operationKey:operationKey(),reason:review.reason};
      if(decision==='release') await api.call('platform.releaseGiftHold',{...input,expectedIncident:facts?.incident});
      else if(decision) await api.call('platform.reviewGiftEligibility',{...input,expectedRevision:facts?.revision,decision});
      setFacts(await api.call<Review>('platform.giftReview',{caseId:review.id}));
    } catch(e){setError(e instanceof Error?e.message:'Review could not be saved.');}
    finally{setBusy(false);}
  }
  return <section className="card"><h2>Gifting review</h2><button disabled={busy} onClick={()=>void action()}>Inspect gifting status</button>
    {facts&&<fieldset disabled={busy}><legend>Brand eligibility · {facts.decision??'Awaiting decision'}</legend>
    <button onClick={()=>void action('paused')}>Pause gifts</button><button onClick={()=>void action('probation')}>Approve with probation cap</button>
    <button onClick={()=>void action('complete')}>Mark probation complete</button>
    {facts.incident&&<button disabled={facts.balance<0} onClick={()=>void action('release')}>Resolve reviewed dispute hold</button>}</fieldset>}
    {error&&<p role="alert">{error}</p>}</section>;
}
