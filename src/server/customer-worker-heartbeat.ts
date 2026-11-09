import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import type {Database} from './db.js';
import type {CustomerWorkerHeartbeat} from '../shared/customer-operations.js';

export type CustomerWorkerKind = 'embedded'|'dedicated';
export const workerHeartbeatIntervalMs=15_000;

/** The ID is generated inside the trusted process, never accepted through customer commands. */
export async function runWorkerHeartbeat(db:Database,kind:CustomerWorkerKind,signal:AbortSignal,
  delay:(milliseconds:number,signal:AbortSignal)=>Promise<void>=async(milliseconds,signal)=>{await pause(milliseconds,undefined,{signal});}) {
  const instance=randomUUID();
  try {
    while(!signal.aborted) {
      try { await db.pool.query('SELECT flockletter_customer_jobs.worker_heartbeat($1,$2)',[kind,instance]); }
      catch { console.error('The customer worker heartbeat could not be recorded.'); }
      try { await delay(workerHeartbeatIntervalMs,signal); }
      catch { if(!signal.aborted) throw Error('Worker heartbeat timer failed.'); }
    }
  } finally {
    try { await db.pool.query('SELECT flockletter_customer_jobs.worker_stop($1,$2)',[kind,instance]); }
    catch { console.error('The customer worker stop could not be recorded.'); }
  }
}

export async function readWorkerHeartbeat(db:Database,kind:CustomerWorkerKind):Promise<CustomerWorkerHeartbeat> {
  const row=(await db.pool.query<{state:CustomerWorkerHeartbeat['state'];observed_at:Date;
    started_at:Date|null;heartbeat_at:Date|null;stopped_at:Date|null;freshness_seconds:number}>(
    'SELECT * FROM flockletter_customer_jobs.worker_liveness($1)',[kind])).rows[0];
  if(!row) throw Error('Worker heartbeat metadata is unavailable.');
  return {kind,state:row.state,observedAt:row.observed_at.toISOString(),startedAt:row.started_at?.toISOString()??null,
    lastHeartbeat:row.heartbeat_at?.toISOString()??null,stoppedAt:row.stopped_at?.toISOString()??null,
    freshnessSeconds:row.freshness_seconds};
}
