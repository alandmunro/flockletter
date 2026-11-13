import type {SendingTrustStatus} from '../shared/sending-safeguards.js';
import {SendingTrustNotice} from './SendingTrustNotice.js';

interface OperatorSendingTrustProps{
 status:SendingTrustStatus|null;
 busy:boolean;
 onRefresh:()=>void;
 onReview:(phase:"limited"|"established"|"full")=>void;
}

export function OperatorSendingTrust({status,busy,onRefresh,onReview}:OperatorSendingTrustProps){
 const canEstablished=status!==null&&status.ageDays>=7&&status.delivered>=100&&!status.held;
 const canFull=status!==null&&status.ageDays>=14&&status.delivered>=500&&!status.held;
 return <section className="operator-sending-trust" aria-labelledby="operator-sending-trust-heading">
  <h2 id="operator-sending-trust-heading">Operator sending trust</h2>
  <div className="actions">
   <button className="btn secondary" type="button" onClick={onRefresh} disabled={busy}>Refresh safeguards</button>
  </div>
  {status===null?<p className="notice">No current sending trust snapshot. Refresh to fetch the latest status.</p>:<>
   <SendingTrustNotice status={status}/>
   <dl className="operator-trust-details">
    <dt>Age in days</dt><dd>{status.ageDays}</dd>
    <dt>Delivered admissions</dt><dd>{status.delivered}</dd>
    <dt>Revision</dt><dd>{status.revision}</dd></dl>
   <div className="review-actions" role="group" aria-label="Operator review actions">
    <button className="btn secondary" type="button" onClick={()=>onReview('limited')} disabled={busy}>Review limited restart</button>
    <button className="btn secondary" type="button" onClick={()=>onReview('established')} disabled={busy||!canEstablished}>Review established limit</button>
    <button className="btn secondary" type="button" onClick={()=>onReview('full')} disabled={busy||!canFull}>Review full plan access</button></div>
   <p className="help">Only a current operator case can make this review. No button here sends a campaign or clears suppression.</p>
  </>}
 </section>;
}
