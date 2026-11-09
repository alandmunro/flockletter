import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {WorkerReadiness} from '../src/client/WorkerReadiness.js';
import type {CustomerOperationsStatus} from '../src/shared/customer-operations.js';

const worker:CustomerOperationsStatus['worker']={running:true,dedicated:true,localProcessRunning:false,
  lastPass:'2026-01-01T00:00:00.000Z',lastFailure:'workspace_job_requires_review',
  heartbeat:{kind:'dedicated',state:'fresh',observedAt:'2026-11-08T00:00:00.000Z',startedAt:'2026-11-08T00:00:00.000Z',
    lastHeartbeat:'2026-11-08T00:00:00.000Z',stoppedAt:null,freshnessSeconds:60}};
it('shows dedicated heartbeat even when the web process does not run a worker, preserving old queue failures',()=>{
  const html=renderToStaticMarkup(createElement(WorkerReadiness,{worker}));
  expect(html).toContain('Verified by recent heartbeat');
  expect(html).toContain('This web process runs a worker</dt><dd>No');
  expect(html).toContain(worker.lastPass);
  expect(html).toContain(worker.lastFailure);
  expect(html).toContain('Last queue pass');
});
it('does not turn a configured worker or legacy running flag into verified liveness',()=>{
  const old={...worker,heartbeat:undefined};
  expect(renderToStaticMarkup(createElement(WorkerReadiness,{worker:old}))).toContain('Not verified');
  expect(renderToStaticMarkup(createElement(WorkerReadiness,{worker:{...worker,heartbeat:{...worker.heartbeat!,state:'stale'}}}))).toContain('Heartbeat expired');
  expect(renderToStaticMarkup(createElement(WorkerReadiness,{worker:{...worker,heartbeat:{...worker.heartbeat!,state:'stopped'}}}))).toContain('Worker reported stopped');
});
