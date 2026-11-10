import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {startDatabase} from '../scripts/database-fixture.js';
import {Database} from '../src/server/db.js';
import {CommandService,type Actor} from '../src/server/service.js';
import {CustomerSupport} from '../src/server/customer-support/index.js';
import {OperatorStore} from '../src/server/platform/store.js';
import {PlatformService} from '../src/server/platform/service.js';
import type {OperatorSession} from '../src/server/platform/auth.js';
import type {PlatformCase,PlatformOverview} from '../src/shared/platform.js';
import type {SupportTicket} from '../src/shared/customer-support.js';
import type {CustomerOperationsStatus} from '../src/shared/customer-operations.js';
import {operatorRoleGrants} from '../src/server/platform/provision.js';
import {createOperatorMcpServer,operatorApiCaller} from '../src/mcp/operator.js';
import {readWorkerHeartbeat} from '../src/server/customer-worker-heartbeat.js';
let fixture:Awaited<ReturnType<typeof startDatabase>>,db:Database,admin:pg.Client;
let revoked=false;let now=new Date();
const actor=(workspaceId='org_'+randomUUID().replaceAll('-','')):Actor=>({workspaceId,userId:'user_'+randomUUID(),actorId:'user:test',owner:true,kind:'session',brandIds:null,scopes:['read']});
const owner=actor(),other=actor();
const session:OperatorSession={userId:owner.userId,sessionId:'verified_session',verifiedAt:now.toISOString(),workspaceId:owner.workspaceId,exercise:true};
const support=()=>new CustomerSupport(db,{mode:'capture',isOwner:async(u,w)=>u===owner.userId&&w===owner.workspaceId});
const identity={authenticate:async()=>session,current:async()=>!revoked};
let platform:PlatformService;
beforeAll(async()=>{fixture=await startDatabase();db=new Database(fixture.url);admin=new pg.Client({connectionString:fixture.adminUrl});await admin.connect();for(const a of [owner,other])await new CommandService(db).execute('workspace.initialize',{operationKey:randomUUID(),name:'Operator test',brandName:'Trail'},a);platform=new PlatformService(db,new OperatorStore(db,'capture'),{mode:'capture',identity,support:support(),databaseName:'flockletter_test',now:()=>now});});
afterAll(async()=>{await platform?.close();await admin?.end();await db?.close();await fixture?.stop();});
async function open(kind:PlatformCase['kind']='support',resourceId:string|null=null){return platform.execute('platform.openCase',{operationKey:randomUUID(),workspaceId:owner.workspaceId,kind,resourceId,reason:'Review the exact bounded customer issue.'},session) as Promise<PlatformCase>;}
it('isolates exercise health, cases and inbox from other workspaces',async()=>{
 const status={worker:{lastPass:new Date().toISOString(),lastFailure:null,dedicated:false},queue:{unknown:1,delivery:1,confirmations:0,team:0,support:0,retention:0}} as CustomerOperationsStatus;
 await platform.observe(owner.workspaceId,status);await platform.observe(other.workspaceId,status);
 const result=await platform.execute('platform.overview',{},session) as PlatformOverview;expect(result.workspaceId).toBe(owner.workspaceId);expect(result.health.map(h=>h.workspaceId)).toEqual([owner.workspaceId]);expect(result.health[0]?.heartbeat).toBeNull();expect(result.alerts.every(a=>a.workspaceId===owner.workspaceId)).toBe(true);
 await expect(platform.execute('platform.openCase',{operationKey:randomUUID(),workspaceId:other.workspaceId,kind:'support',resourceId:null,reason:'Attempt an unrelated workspace access.'},session)).rejects.toMatchObject({code:'exercise_workspace_only'});
 await expect(platform.execute('platform.inbox',{},session)).rejects.toMatchObject({code:'operator_required'});
});
it('locks conversation IDs and expires/revokes independently minted cases',async()=>{
 const ticket=await platform.options.support.execute('support.create',{operationKey:randomUUID(),subject:'Plan',text:'Which plans are available?',topic:'plans'},owner) as SupportTicket;
 const c=await open('support',ticket.id);
 const read=await platform.execute('platform.support',{caseId:c.id,command:'support.get',input:{}},session) as SupportTicket;expect(read.id).toBe(ticket.id);
 await expect(platform.execute('platform.support',{caseId:c.id,command:'support.get',input:{id:randomUUID()}},session)).rejects.toMatchObject({code:'case_scope_mismatch'});
 await expect(platform.execute('platform.support',{caseId:c.id,command:'support.get',input:{}},{...session,sessionId:'different'})).rejects.toMatchObject({code:'operator_case_required'});
 revoked=true;await expect(platform.execute('platform.case',{caseId:c.id},session)).rejects.toMatchObject({code:'operator_authority_expired'});revoked=false;
 now=new Date(now.getTime()+5*60000+1);await expect(platform.execute('platform.case',{caseId:c.id},session)).rejects.toMatchObject({code:'operator_case_required'});now=new Date();
});
it('keeps hold and acknowledgement intents idempotent without clearing the alert',async()=>{
 const c=await open('abuse'),operationKey=randomUUID(),input={operationKey,caseId:c.id,held:true,reason:'A bounded platform review is required.'};
 const first=await platform.execute('platform.abuseHold',input,session);expect(await platform.execute('platform.abuseHold',input,session)).toEqual(first);
 expect(await db.tenant(owner.workspaceId,async sql=>(await sql.query('SELECT public.flockletter_platform_hold($1) held',[owner.workspaceId])).rows[0]?.held)).toBe(true);
 await expect(platform.execute('platform.abuseHold',{...input,held:false},session)).rejects.toMatchObject({code:'operation_conflict'});
 await platform.execute('platform.abuseHold',{...input,operationKey:randomUUID(),held:false},session);
 const overview=await platform.overview(session),alert=overview.alerts.find(a=>a.active)!;
 await platform.execute('platform.alertAck',{operationKey:randomUUID(),alertId:alert.id,reason:'Reviewed the pending provider outcome.'},session);
 const acknowledged=(await platform.overview(session)).alerts.find(a=>a.id===alert.id)!;expect(acknowledged.active).toBe(true);expect(acknowledged.acknowledgedAt).toBeTruthy();
});
it('cannot sign hosted erasure without independently configured protected evidence',async()=>{
 // A support case cannot be repurposed as erasure approval, even with a valid hash.
 const c=await open();await expect(platform.execute('platform.retentionApprove',{operationKey:randomUUID(),caseId:c.id,expectedDigest:'a'.repeat(64)},session)).rejects.toMatchObject({code:'case_scope_mismatch'});
});
it('uses a separate exact operator database role and blocks tenant reads',async()=>{
 const role='flockletter_test_operator';const password=randomUUID();await admin.query('CREATE ROLE '+role+' LOGIN PASSWORD '+pg.escapeLiteral(password));await admin.query(operatorRoleGrants('flockletter_test',role));
 const url=new URL(fixture.adminUrl);url.username=role;url.password=password;const store=new OperatorStore(db,'live',url.toString());await store.verify();
 await store.transaction(owner.workspaceId,r=>r.put('health','current',{ok:true}));expect(await store.read('health')).toHaveLength(1);
 const client=new pg.Client({connectionString:url.toString()});await client.connect();try{await expect(client.query('SELECT * FROM public.workspaces')).rejects.toMatchObject({code:'42501'});}finally{await client.end();await store.close();}
});
it('never blindly retries an unknown platform notification submission',async()=>{
 let submits=0,lookups=0;const target=actor().workspaceId;
 const live=new PlatformService(db,new OperatorStore(db,'capture'),{mode:'live',identity,support:support(),databaseName:'flockletter_test',alerts:{from:'ops@example.test',to:'owner@example.test',provider:{submit:async()=>{submits++;return {state:'unknown'};},lookup:async()=>{lookups++;return {state:'unknown'};}}}});
 const status={worker:{lastPass:new Date().toISOString(),lastFailure:'worker_failed',dedicated:true},queue:{unknown:0,delivery:0,confirmations:0,team:0,support:0,retention:0}} as CustomerOperationsStatus;
 await live.observe(target,status);await live.notifications(target);expect(submits).toBe(1);expect(lookups).toBe(1);await live.close();
});
it('monitors current trusted daemon liveness independently from idle queues and manual passes',async()=>{
 const role='flockletter_heartbeat_operator',password=randomUUID();
 await admin.query('CREATE ROLE '+role+' LOGIN PASSWORD '+pg.escapeLiteral(password));
 await admin.query(operatorRoleGrants('flockletter_test',role));
 const url=new URL(fixture.adminUrl);url.username=role;url.password=password;
 const store=new OperatorStore(db,'live',url.toString());await store.verify();
 // The earlier role-boundary test deliberately stored a non-health fixture.
 await admin.query("DELETE FROM flockletter_retention_control.platform_records WHERE kind='health'");
 await admin.query('TRUNCATE flockletter_customer_jobs.worker_instances');
 const target=other.workspaceId,liveSession={...session,exercise:false,workspaceId:undefined};
 const live=new PlatformService(db,store,{mode:'live',identity,support:support(),databaseName:'flockletter_test',
  workerHeartbeat:()=>readWorkerHeartbeat(db,'dedicated')});
 const status={worker:{running:true,lastPass:new Date().toISOString(),lastFailure:null,dedicated:true},
  queue:{unknown:0,delivery:0,confirmations:0,team:0,support:0,retention:0}} as CustomerOperationsStatus;
 const alert=async(code:string)=>(await live.overview(liveSession)).alerts.find(a=>a.workspaceId===target&&a.code===code);
 const notices=async()=>Number((await admin.query("SELECT count(*)::int n FROM flockletter_retention_control.platform_records WHERE workspace_id=$1 AND kind='notification' AND body->>'code'='worker_liveness_unverified'",[target])).rows[0].n);
 try{
  await live.observe(target,status);await live.monitor();
  let view=await live.overview(liveSession);
  expect(view.health[0]?.heartbeat).toMatchObject({kind:'dedicated',state:'unknown'});
  expect(view).toMatchObject({sendingEnabled:false,erasureEnabled:false});
  expect(await alert('worker_liveness_unverified')).toMatchObject({active:true});
  expect(await alert('worker_stale')).toBeUndefined();
  expect(await notices()).toBe(1);
  await live.monitor();expect(await notices()).toBe(1);
  const active=(await alert('worker_liveness_unverified'))!;
  await live.execute('platform.alertAck',{operationKey:randomUUID(),alertId:active.id,reason:'Reviewed the missing trusted daemon heartbeat.'},liveSession);
  await live.monitor();expect((await alert('worker_liveness_unverified'))?.acknowledgedAt).toBeTruthy();
  const instance=randomUUID();
  await db.pool.query('SELECT flockletter_customer_jobs.worker_heartbeat($1,$2)',['dedicated',instance]);
  // No workspace queue pass changed. Overview and monitor still reread the database.
  view=await live.overview(liveSession);expect(view.health[0]?.heartbeat?.state).toBe('fresh');
  await live.monitor();expect(await alert('worker_liveness_unverified')).toMatchObject({active:false,acknowledgedAt:null});
  await live.observe(target,{...status,worker:{...status.worker,lastPass:'2026-01-01T00:00:00.000Z'},queue:{...status.queue,delivery:1}});
  await live.monitor();expect(await alert('worker_stale')).toMatchObject({active:true});
  expect(await alert('worker_liveness_unverified')).toMatchObject({active:false});
  await admin.query("UPDATE flockletter_customer_jobs.worker_instances SET heartbeat_at=clock_timestamp()-interval '61 seconds' WHERE instance_id=$1",[instance]);
  // A fresh manual pass cannot turn an expired daemon heartbeat into liveness.
  await live.observe(target,status);await live.monitor();
  expect((await live.overview(liveSession)).health[0]?.heartbeat?.state).toBe('stale');
  expect(await alert('worker_liveness_unverified')).toMatchObject({active:true});
  expect(await alert('worker_stale')).toMatchObject({active:false});
  expect(await notices()).toBe(2);
  await db.pool.query('SELECT flockletter_customer_jobs.worker_stop($1,$2)',['dedicated',instance]);
  await live.monitor();expect((await live.overview(liveSession)).health[0]?.heartbeat?.state).toBe('stopped');
  expect(await notices()).toBe(2);
  live.options.workerHeartbeat=async()=>{throw Error('Synthetic unavailable heartbeat');};
  expect((await live.overview(liveSession)).health[0]?.heartbeat).toBeNull();
  await live.monitor();expect(await alert('worker_liveness_unverified')).toMatchObject({active:true});
  live.options.workerHeartbeat=()=>readWorkerHeartbeat(db,'dedicated');
  await db.pool.query('SELECT flockletter_customer_jobs.worker_heartbeat($1,$2)',['dedicated',randomUUID()]);
  await live.monitor();expect(await alert('worker_liveness_unverified')).toMatchObject({active:false});
 }finally{await live.close();}
});
it('operator MCP rejects customer connection tokens before any request',()=>{expect(()=>operatorApiCaller('https://example.test','flk_customer.secret')).toThrow();expect(createOperatorMcpServer(async()=>({ok:true}))).toBeTruthy();});
it('rechecks private erasure at insertion after an earlier tenant preflight passed',async()=>{
 const workspace='org_erasure_race_'+randomUUID().replaceAll('-','');
 let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),resume=new Promise<void>(r=>release=r);
 const pending=db.tenant(workspace,async sql=>{entered();await resume;return sql.query('INSERT INTO workspaces(workspace_id,name) VALUES($1,$2)',[workspace,'Must not resurrect']);});
 const denied=expect(pending).rejects.toMatchObject({code:'workspace_retention_blocked'});await ready;
 try{await admin.query('BEGIN');await admin.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[workspace]);
 await admin.query('INSERT INTO flockletter_retention_control.receipts(workspace_id,job_id,source_version,erased_at,manifest_digest,checkpoint_digest) VALUES($1,$2,$3,now(),$4,$5)',[workspace,randomUUID(),'closed-v1','a'.repeat(64),'b'.repeat(64)]);await admin.query('COMMIT');}catch(error){await admin.query('ROLLBACK');throw error;}finally{release();}
 await denied;expect((await admin.query('SELECT FROM public.workspaces WHERE workspace_id=$1',[workspace])).rowCount).toBe(0);
});
it('fails busy inserts immediately so an erasure table freeze cannot deadlock against a trigger',async()=>{
 const workspace='org_erasure_lock_'+randomUUID().replaceAll('-','');await admin.query('BEGIN');await admin.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[workspace]);
 try{await expect(db.tenant(workspace,sql=>sql.query('INSERT INTO workspaces(workspace_id,name) VALUES($1,$2)',[workspace,'Busy']))).rejects.toMatchObject({code:'workspace_busy'});await admin.query('LOCK TABLE public.workspaces IN SHARE ROW EXCLUSIVE MODE');}finally{await admin.query('ROLLBACK');}
 expect((await admin.query('SELECT FROM public.workspaces WHERE workspace_id=$1',[workspace])).rowCount).toBe(0);
});
