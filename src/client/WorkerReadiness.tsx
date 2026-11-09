import type {CustomerOperationsStatus} from '../shared/customer-operations.js';

export function WorkerReadiness({worker}:{worker:CustomerOperationsStatus['worker']}) {
  const heartbeat=worker.heartbeat;
  const state=heartbeat?.state??'unknown';
  const label={fresh:'Recent heartbeat',stale:'Heartbeat expired',unknown:'No heartbeat observed',stopped:'Worker reported stopped'}[state];
  return <section aria-labelledby="worker-heading">
    <h3 id="worker-heading" className="badge">Worker</h3>
    <p>This snapshot shows liveness at the observed time; refresh to check current status. Last queue pass and failures show whether work is progressing.</p>
    <dl>
      <dt>Running at last refresh</dt><dd>{state==='fresh'?'Verified by recent heartbeat':state==='stopped'?'No — reported stop':'Not verified'}</dd>
      <dt>Dedicated</dt><dd>{worker.dedicated?'Yes':'No'}</dd>
      <dt>This web process runs a worker</dt><dd>{worker.localProcessRunning===undefined?'Not reported':worker.localProcessRunning?'Yes':'No'}</dd>
      <dt>Heartbeat</dt><dd>{label}</dd>
      <dt>Last heartbeat</dt><dd>{heartbeat?.lastHeartbeat??'—'}</dd>
      <dt>Observed at</dt><dd>{heartbeat?.observedAt??'—'}</dd>
      <dt>Freshness window</dt><dd>{heartbeat?heartbeat.freshnessSeconds+' seconds':'Not reported'}</dd>
      <dt>Last queue pass</dt><dd>{worker.lastPass??'—'}</dd>
      <dt>Last failure</dt><dd>{worker.lastFailure??'—'}</dd>
    </dl>
  </section>;
}
