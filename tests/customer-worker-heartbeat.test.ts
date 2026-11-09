import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {startDatabase} from '../scripts/database-fixture.js';
import {Database} from '../src/server/db.js';
import {readWorkerHeartbeat,runWorkerHeartbeat,workerHeartbeatIntervalMs} from '../src/server/customer-worker-heartbeat.js';
import {loadConfig} from '../src/server/config.js';
import {CustomerWorkflows} from '../src/server/customer-runtime.js';
import {localIdentity} from '../src/server/auth.js';
import {CommandService,type Actor} from '../src/server/service.js';
import {customerSettings} from '../src/server/customer-settings.js';

let fixture:Awaited<ReturnType<typeof startDatabase>>,db:Database,owner:Database;
const workspace='org_local_sample';
beforeAll(async()=>{fixture=await startDatabase();db=new Database(fixture.url);owner=new Database(fixture.adminUrl);});
afterAll(async()=>{await db?.close();await owner?.close();await fixture?.stop();});
const reset=async()=>owner.pool.query('TRUNCATE flockletter_customer_jobs.worker_instances');
const beat=(kind:string,id=randomUUID())=>db.pool.query('SELECT flockletter_customer_jobs.worker_heartbeat($1,$2)',[kind,id]);

it('reports DB-clock freshness separately from configuration and clean shutdown',async()=>{
  await reset();
  expect(await readWorkerHeartbeat(db,'dedicated')).toMatchObject({state:'unknown',lastHeartbeat:null,startedAt:null,freshnessSeconds:60});
  const first=randomUUID(),second=randomUUID();
  await beat('dedicated',first);
  expect(await readWorkerHeartbeat(db,'dedicated')).toMatchObject({state:'fresh',kind:'dedicated'});
  expect((await readWorkerHeartbeat(db,'embedded')).state).toBe('unknown');
  await owner.pool.query("UPDATE flockletter_customer_jobs.worker_instances SET heartbeat_at=clock_timestamp()-interval '61 seconds' WHERE instance_id=$1",[first]);
  expect((await readWorkerHeartbeat(db,'dedicated')).state).toBe('stale');
  await owner.pool.query("UPDATE flockletter_customer_jobs.worker_instances SET heartbeat_at=clock_timestamp()+interval '1 hour' WHERE instance_id=$1",[first]);
  expect((await readWorkerHeartbeat(db,'dedicated')).state).toBe('unknown');
  await beat('dedicated',first);
  await beat('dedicated',second);
  await db.pool.query('SELECT flockletter_customer_jobs.worker_stop($1,$2)',['dedicated',first]);
  expect((await readWorkerHeartbeat(db,'dedicated')).state).toBe('fresh');
  await db.pool.query('SELECT flockletter_customer_jobs.worker_stop($1,$2)',['dedicated',second]);
  expect((await readWorkerHeartbeat(db,'dedicated')).state).toBe('stopped');
  await expect(beat('dedicated',second)).rejects.toThrow('cannot be reused');
});

it('denies direct tables and invalid kinds, and bounds/cleans metadata',async()=>{
  await reset();
  await expect(db.pool.query('SELECT * FROM flockletter_customer_jobs.worker_instances')).rejects.toMatchObject({code:'42501'});
  for(const kind of ['', 'production', 'DEDICATED'])await expect(beat(kind)).rejects.toThrow('Invalid worker heartbeat');
  const id=randomUUID();await beat('dedicated',id);
  await expect(beat('embedded',id)).rejects.toThrow('cannot be reused');
  for(let n=1;n<64;n++)await beat('dedicated');
  await expect(beat('dedicated')).rejects.toThrow('capacity requires review');
  await owner.pool.query("UPDATE flockletter_customer_jobs.worker_instances SET heartbeat_at=clock_timestamp()-interval '25 hours'");
  await beat('dedicated');
  expect((await owner.pool.query('SELECT count(*)::int AS n FROM flockletter_customer_jobs.worker_instances')).rows[0].n).toBe(1);
  await db.verifyBoundary();
  await reset();
  for(let n=0;n<24;n++){
    const stopped=randomUUID();await beat('dedicated',stopped);
    await db.pool.query('SELECT flockletter_customer_jobs.worker_stop($1,$2)',['dedicated',stopped]);
  }
  await beat('dedicated');
  expect((await owner.pool.query('SELECT count(*)::int AS n FROM flockletter_customer_jobs.worker_instances')).rows[0].n).toBeLessThanOrEqual(17);
  await owner.pool.query('GRANT MAINTAIN ON flockletter_customer_jobs.worker_instances TO flockletter_runtime');
  try { await expect(db.verifyBoundary()).rejects.toThrow('Private worker capacity'); }
  finally { await owner.pool.query('REVOKE MAINTAIN ON flockletter_customer_jobs.worker_instances FROM flockletter_runtime'); }
  await db.verifyBoundary();
});

it('dedicated liveness continues while idle and stops cleanly without queue passes',async()=>{
  await reset();const stop=new AbortController();
  const intervals:number[]=[];let resume:(()=>void)|undefined;
  const work=runWorkerHeartbeat(db,'dedicated',stop.signal,async(milliseconds,signal)=>{
    intervals.push(milliseconds);
    await new Promise<void>(resolve=>{
      resume=resolve;
      signal.addEventListener('abort',()=>resolve(),{once:true});
    });
  });
  try {
    await expect.poll(async()=>(await readWorkerHeartbeat(db,'dedicated')).state).toBe('fresh');
    const first=await readWorkerHeartbeat(db,'dedicated');
    expect(first.lastHeartbeat).not.toBeNull();
    expect(first.startedAt).not.toBeNull();
    expect((await readWorkerHeartbeat(db,'embedded')).state).toBe('unknown');
    await new Promise(resolve=>setTimeout(resolve,5));
    resume!();
    await expect.poll(async()=>(await readWorkerHeartbeat(db,'dedicated')).lastHeartbeat).not.toBe(first.lastHeartbeat);
    await expect.poll(()=>intervals.length).toBe(2);
    expect(intervals).toEqual([workerHeartbeatIntervalMs,workerHeartbeatIntervalMs]);
  }finally{stop.abort();await work;}
  expect((await readWorkerHeartbeat(db,'dedicated')).state).toBe('stopped');
});

it('manual queue work never becomes worker liveness; a separate worker is visible to the web reader',async()=>{
  await reset();
  const env={APP_ENV:'test',APP_ORIGIN:'http://127.0.0.1:4310',FLOCKLETTER_CUSTOMER_WORKER:'dedicated'};
  const config=loadConfig(env),identity=localIdentity();
  const web=new CustomerWorkflows(db,config,identity,env);
  const service=new CommandService(db,undefined,identity.isOwner,undefined,undefined,identity.team,undefined,undefined,undefined,'test',undefined,web);
  const actor:Actor={workspaceId:workspace,userId:'local_owner',actorId:'user:local_owner',kind:'session',owner:true,scopes:['read'],brandIds:null};
  await service.execute('workspace.initialize',{operationKey:randomUUID(),name:'Heartbeat fixture',brandName:'Trail'},actor);
  try {
    await web.execute('operations.process',{operationKey:randomUUID()},actor);
    const manual=await web.status(workspace);
    expect(manual.worker).toMatchObject({running:false,dedicated:true,localProcessRunning:false,heartbeat:{state:'unknown'}});
    expect(manual.worker.lastPass).not.toBeNull();
    const stop=new AbortController(),worker=new CustomerWorkflows(db,config,identity,env);
    const work=worker.run(stop.signal);
    try {
      await expect.poll(async()=>(await web.status(workspace)).worker.running).toBe(true);
      const active=await web.status(workspace);
      expect(active.worker).toMatchObject({dedicated:true,localProcessRunning:false,heartbeat:{state:'fresh'}});
      expect((await worker.status(workspace)).worker.localProcessRunning).toBe(true);
    }finally{stop.abort();await work;await worker.close();}
    expect((await web.status(workspace)).worker.heartbeat?.state).toBe('stopped');
    await owner.pool.query("UPDATE flockletter_customer_jobs.worker_instances SET stopped_at=NULL,heartbeat_at=clock_timestamp()-interval '61 seconds'");
    const stale=await web.status(workspace);
    expect(stale.worker).toMatchObject({running:false,heartbeat:{state:'stale'}});
    expect(stale.worker.lastPass).not.toBeNull();
    expect(stale.gaps.some(gap=>gap.code==='worker_heartbeat_stale')).toBe(true);
  }finally{await web.close();}
});

it('refuses unknown worker deployment modes instead of silently selecting embedded work',()=>{
  expect(()=>customerSettings(loadConfig({APP_ENV:'test'}),{FLOCKLETTER_CUSTOMER_WORKER:'dedciated'})).toThrow();
});
