import type {SendingTrustStatus} from '../shared/sending-safeguards.js';

// Presentation scaffold drafted locally; authoritative limits come from the shared command.
export function SendingTrustNotice({status}:{status:SendingTrustStatus}){
 return <section className="card" aria-labelledby="sending-safeguards-heading">
  <h2 id="sending-safeguards-heading">Sending safeguards</h2>
  <dl><dt>Sender phase</dt><dd>{status.phase==='full'?'Full plan access':status.phase==='established'?'Established sender':status.phase==='limited'?'Limited restart':'New sender'}</dd>
   <dt>UTC daily admissions</dt><dd>{status.usedToday}{status.dailyLimit===null?' · Plan and provider limits apply':` of ${status.dailyLimit}`}</dd>
   <dt>Observed at</dt><dd>{status.observedAt}</dd></dl>
  {status.held&&<p role="alert">Sending is paused pending operator review.</p>}
  {status.warning&&<p className="notice">Bounce levels or delivery-service capacity need attention. Review the current reasons and Operations before sending.</p>}
  {status.reasons.length>0&&<ul>{status.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul>}
  <p className="help">Admissions include pending or uncertain provider work and are not proof of delivery. Subscription limits, confirmed consent and exact campaign approval still apply. A plan upgrade does not remove a hold or increase trust.</p>
 </section>;
}
