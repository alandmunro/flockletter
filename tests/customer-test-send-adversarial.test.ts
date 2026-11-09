import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import pg from 'pg';
import {startDatabase} from '../scripts/database-fixture.js';
import {Database} from '../src/server/db.js';
import type {Actor} from '../src/server/service.js';
import type {DeliveryView} from '../src/shared/customer-delivery.js';
import {createMcpServer} from '../src/mcp/bridge.js';
import {usage} from '../src/server/customer-billing/service.js';
import {createTestSendFixture} from './helpers/test-send-fixture.js';
import {makeAudienceConnection} from './helpers/audience-connection.js';
import {saveSenderProfile,addCampaignPhoto} from './helpers/delivery-profile.js';

let fixture:Awaited<ReturnType<typeof startDatabase>>,db:Database;
type Fixture=Awaited<ReturnType<typeof createTestSendFixture>>;
type TestReview=DeliveryView&{purpose:'test';testSubscriberId:string};
type Selection={brandId:string;campaignId:string;subscriberId:string};
beforeAll(async()=>{fixture=await startDatabase();db=new Database(fixture.url);});
afterAll(async()=>{await db?.close();await fixture?.stop();});
const selection=(f:Fixture):Selection=>({brandId:f.brandId,campaignId:f.campaign.id,subscriberId:f.subscriberId});
async function review(f:Fixture,actor:Actor=f.actor,target=selection(f),extra:Record<string,unknown>={}){
 return await f.delivery.execute('delivery.reviewTest',{operationKey:randomUUID(),...target,expectedVersion:1,...extra},actor) as TestReview;
}
async function approve(f:Fixture,row:TestReview,actor:Actor=f.actor,extra:Record<string,unknown>={}){
 return await f.delivery.execute('delivery.approveTest',{operationKey:randomUUID(),brandId:row.brandId,id:row.id,subscriberId:row.testSubscriberId,expectedVersion:row.version,...extra},actor) as TestReview;
}
async function admissions(f:Fixture){
 return await db.tenant(f.workspaceId,async sql=>(await sql.query<{n:number}>("SELECT count(*)::int n FROM customer_deliveries WHERE purpose='test' AND test_slot IS NOT NULL")).rows[0]!.n);
}
async function report(f:Fixture,row:TestReview){return await f.delivery.execute('delivery.report',{brandId:row.brandId,id:row.id},f.actor) as DeliveryView;}
async function extraBrand(f:Fixture):Promise<Selection>{
 const brandId=randomUUID(),subscriberId=randomUUID();
 // Fixture setup only: a second brand under the already-active synthetic Growth plan.
 await db.tenant(f.workspaceId,async sql=>{
  const company=(await sql.query<{id:string}>('SELECT id FROM companies WHERE is_default')).rows[0]!;
  await sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)',[f.workspaceId,brandId,'Second synthetic brand']);
  // The ordinary brand INSERT trigger creates its default-company mapping.
  expect((await sql.query('SELECT company_id FROM company_brands WHERE brand_id=$1',[brandId])).rows).toEqual([{company_id:company.id}]);
 });
 const campaign=await f.core.execute('campaign.create',{operationKey:randomUUID(),brandId,content:{title:'Second',subject:'Second news',fromName:'Shop',replyTo:'shop@example.test',heading:'Hello',body:'Synthetic news',preheader:'',ctaLabel:'',ctaUrl:'',assetIds:[]}},f.actor) as {id:string};
 await db.brand(f.workspaceId,brandId,sql=>sql.query("INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'second@shop.test','confirmed')",[f.workspaceId,brandId,subscriberId]));
 return {brandId,campaignId:campaign.id,subscriberId};
}
async function readySes(f:Fixture){
 await saveSenderProfile(f.delivery,f.actor,f.brandId);
 await addCampaignPhoto(db,f.actor,f.brandId,f.campaign.id);
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query('INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge,checked_at,verified_at) VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp())',[f.workspaceId,f.brandId,'shop.test',randomUUID()]));
}
async function ageSyntheticAdmission(f:Fixture,row:TestReview){
 // Historical fixture setup only. Product identities cannot disable this trigger.
 // Restore ALWAYS inside the same transaction before any runtime exercise.
 const admin=new pg.Client({connectionString:fixture.adminUrl});await admin.connect();
 try{
  expect((await admin.query('SELECT current_database() name')).rows[0].name).toBe('flockletter_test');
  await admin.query('BEGIN');
  try{
   await admin.query('ALTER TABLE public.customer_deliveries DISABLE TRIGGER flockletter_customer_test_snapshot_guard');
   await admin.query("UPDATE public.customer_deliveries SET test_day=(test_admitted_at AT TIME ZONE 'UTC')::date-1,test_admitted_at=test_admitted_at-interval '1 day' WHERE workspace_id=$1 AND id=$2",[f.workspaceId,row.id]);
   await admin.query('ALTER TABLE public.customer_deliveries ENABLE ALWAYS TRIGGER flockletter_customer_test_snapshot_guard');
   await admin.query('COMMIT');
  }catch(error){await admin.query('ROLLBACK');throw error;}
  expect((await admin.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.customer_deliveries'::regclass AND tgname='flockletter_customer_test_snapshot_guard'")).rows).toEqual([{tgenabled:'A'}]);
 }finally{await admin.end();}
}

it('admits exactly five concurrent requests across brands and session/MCP transports without consuming campaign slots',async()=>{
 const f=await createTestSendFixture(db),other=await extraBrand(f);
 const capacity=(await f.billing.status(f.workspaceId)).limits!;
 await db.brand(f.workspaceId,f.brandId,async sql=>{
  for(let index=0;index<capacity.campaigns;index++)await f.billing.reserve(sql,f.workspaceId,{operationKey:'broadcast-reservation-'+randomUUID(),campaignId:f.campaign.id,brandId:f.brandId,recipients:1});
 });
 const sender=await makeAudienceConnection(db,f.actor,[f.brandId,other.brandId],['read','campaign:send']);
 const targets:Selection[]=[];
 for(let index=0;index<6;index++){
  const chosen=index%2?other:selection(f),subscriberId=randomUUID();
  await db.brand(f.workspaceId,chosen.brandId,sql=>sql.query("INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,$4,'confirmed')",[f.workspaceId,chosen.brandId,subscriberId,`parallel${index}@shop.test`]));
  targets.push({...chosen,subscriberId});
 }
 const rows=await Promise.all(targets.map((target,index)=>review(f,index%2?sender.actor:f.actor,target)));
 const observed=await f.delivery.execute('delivery.preflight',{brandId:f.brandId,campaignId:f.campaign.id,purpose:'test',subscriberId:f.subscriberId},f.actor) as {gaps:{code:string}[]};
 expect(observed.gaps.some(gap=>gap.code==='allowance_exceeded')).toBe(false);
 const bridge=createMcpServer((name,input)=>f.delivery.execute(name,input,sender.actor)),client=new Client({name:'test-send-concurrency',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await bridge.connect(serverTransport);await client.connect(clientTransport);
 try{
  const results=await Promise.all(rows.map(async(row,index)=>{
   if(index%2){const result=await client.callTool({name:'delivery_approveTest',arguments:{operationKey:randomUUID(),brandId:row.brandId,id:row.id,subscriberId:row.testSubscriberId,expectedVersion:row.version}});return !result.isError;}
   try{await approve(f,row);return true;}catch{return false;}
  }));
  expect(results.filter(Boolean)).toHaveLength(5);expect(await admissions(f)).toBe(5);
  const used=(await f.billing.status(f.workspaceId)).usage;
  expect(used.reservedCampaigns).toBe(capacity.campaigns);expect(used.campaigns).toBe(0);expect(used.reservedEmails).toBe(capacity.campaigns+5);
  const tools=(await client.listTools()).tools.map(tool=>tool.name);expect(tools).not.toContain('delivery_testDetails');
 }finally{await client.close();await bridge.close();}
});

it('observes the cross-brand DB-UTC test budget through session and MCP without mutating delivery or usage facts',async()=>{
 const f=await createTestSendFixture(db),other=await extraBrand(f),row=await review(f);await approve(f,row);
 const sender=await makeAudienceConnection(db,f.actor,[other.brandId],['read','campaign:send']);
 const before=await db.tenant(f.workspaceId,async sql=>JSON.stringify((await sql.query(`SELECT
  (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM customer_deliveries d) deliveries,
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM customer_delivery_recipients p) recipients,
  (SELECT jsonb_agg(to_jsonb(r) ORDER BY operation_key) FROM customer_usage_reservations r) reservations,
  (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_key) FROM operations o) operations`)).rows));
 const request={brandId:other.brandId,campaignId:other.campaignId,purpose:'test',subscriberId:other.subscriberId};
 const session=await f.delivery.execute('delivery.preflight',request,f.actor) as {testBudget:{day:string;used:number;remaining:number;limit:number}};
 expect(session).toMatchObject({purpose:'test',canSend:false,reviewRequired:true,testBudget:{day:expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),used:1,remaining:4,limit:5}});
 const bridge=createMcpServer((name,input)=>f.delivery.execute(name,input,sender.actor)),client=new Client({name:'test-budget-observation',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await bridge.connect(serverTransport);await client.connect(clientTransport);
 try{
  expect((await client.listTools()).tools.find(tool=>tool.name==='delivery_preflight')?.annotations?.readOnlyHint).toBe(true);
  const response=await client.callTool({name:'delivery_preflight',arguments:request});expect(response.isError).not.toBe(true);
  const text=(response.content as {text:string}[])[0]!.text;
  expect(JSON.parse(text)).toMatchObject({purpose:'test',canSend:false,audience:{visibility:'restricted'},testBudget:session.testBudget});
  expect(text).not.toContain('second@shop.test');
 }finally{await client.close();await bridge.close();}
 const after=await db.tenant(f.workspaceId,async sql=>JSON.stringify((await sql.query(`SELECT
  (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM customer_deliveries d) deliveries,
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM customer_delivery_recipients p) recipients,
  (SELECT jsonb_agg(to_jsonb(r) ORDER BY operation_key) FROM customer_usage_reservations r) reservations,
  (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_key) FROM operations o) operations`)).rows));
 expect(after).toBe(before);
});

it('retains pending/unknown duplicate protection across pause, cancellation and a changed draft revision',async()=>{
 let outcome:'unknown'|'not_submitted'='unknown';
 const f=await createTestSendFixture(db,{mode:'ses',provider:()=>({fingerprint:'synthetic-test-route',from:'news@shop.test',ready:async()=>true,submit:async()=>({outcome:'unknown' as const}),lookup:async()=>({outcome})})});
 await readySes(f);const original=await review(f);await approve(f,original);
 const replacement=await review(f);
 await expect(approve(f,replacement)).rejects.toMatchObject({code:'test_already_pending',status:409});
 await f.delivery.execute('delivery.pause',{operationKey:randomUUID(),brandId:original.brandId,id:original.id},f.actor);
 await expect(approve(f,replacement)).rejects.toMatchObject({code:'test_already_pending'});
 await f.delivery.execute('delivery.resume',{operationKey:randomUUID(),brandId:original.brandId,id:original.id},f.actor);
 await f.delivery.worker.tick(f.workspaceId,original.id);await f.delivery.worker.tick(f.workspaceId,original.id);
 await f.delivery.execute('delivery.cancel',{operationKey:randomUUID(),brandId:original.brandId,id:original.id},f.actor);
 await db.tenant(f.workspaceId,sql=>sql.query('UPDATE campaigns SET version=version+1 WHERE id=$1',[f.campaign.id]));
 const newer=await review(f,f.actor,selection(f),{expectedVersion:2});
 await expect(approve(f,newer)).rejects.toMatchObject({code:'test_already_pending'});
 expect(await admissions(f)).toBe(1);expect((await f.billing.status(f.workspaceId)).usage.reservedEmails).toBe(1);
 outcome='not_submitted';f.setClock(new Date(f.now().getTime()+61000));await f.delivery.worker.tick(f.workspaceId,original.id);
 await approve(f,newer);expect(await admissions(f)).toBe(2);
 expect((await f.billing.status(f.workspaceId)).usage).toMatchObject({reservedEmails:1,reservedCampaigns:0,campaigns:0});
});

it('retains daily admissions after cancellation while releasing only the known-unsent email budget',async()=>{
 const f=await createTestSendFixture(db);
 const rows=await Promise.all(Array.from({length:6},()=>review(f)));
 for(const row of rows.slice(0,5)){
  await approve(f,row);
  await f.delivery.execute('delivery.cancel',{operationKey:randomUUID(),brandId:row.brandId,id:row.id},f.actor);
 }
 const sixth=rows[5]!;
 await expect(approve(f,sixth)).rejects.toMatchObject({status:429,code:'test_daily_limit'});
 expect(await admissions(f)).toBe(5);
 expect((await f.billing.status(f.workspaceId)).usage).toMatchObject({campaigns:0,reservedCampaigns:0,emails:0,reservedEmails:0});
});

it('keeps same-key retries idempotent and refuses changed recipient/version or generic approval bypasses',async()=>{
 const f=await createTestSendFixture(db),request={operationKey:randomUUID(),...selection(f),expectedVersion:1};
 const first=await f.delivery.execute('delivery.reviewTest',request,f.actor) as TestReview;
 expect((await f.delivery.execute('delivery.reviewTest',request,f.actor) as TestReview).id).toBe(first.id);
 await expect(f.delivery.execute('delivery.reviewTest',{...request,subscriberId:randomUUID()},f.actor)).rejects.toMatchObject({code:'operation_conflict'});
 await expect(f.delivery.execute('delivery.approve',{operationKey:randomUUID(),brandId:first.brandId,id:first.id},f.actor)).rejects.toMatchObject({status:409});
 await expect(approve(f,first,f.actor,{subscriberId:randomUUID()})).rejects.toMatchObject({status:409});
 await expect(approve(f,first,f.actor,{expectedVersion:first.version+1})).rejects.toMatchObject({status:409});
 expect(await admissions(f)).toBe(0);
 const approval={operationKey:randomUUID(),brandId:first.brandId,id:first.id,subscriberId:first.testSubscriberId,expectedVersion:first.version};
 await f.delivery.execute('delivery.approveTest',approval,f.actor);await f.delivery.execute('delivery.approveTest',approval,f.actor);
 await approve(f,first);
 expect(await admissions(f)).toBe(1);expect((await f.billing.status(f.workspaceId)).usage).toMatchObject({reservedEmails:1,reservedCampaigns:0});
});

it('rolls back a legacy generic approval and its accidental campaign-slot reservation without a daily admission',async()=>{
 const f=await createTestSendFixture(db),row=await review(f),key='customer-delivery-'+row.id;
 await expect(db.brand(f.workspaceId,f.brandId,async sql=>{
  await f.billing.reserve(sql,f.workspaceId,{operationKey:key,campaignId:f.campaign.id,brandId:f.brandId,recipients:1,dueAt:new Date(row.dueAt)});
  await sql.query("UPDATE customer_deliveries SET state='queued',reservation_key=$2,approved_at=clock_timestamp() WHERE id=$1",[row.id,key]);
 })).rejects.toThrow();
 expect(await admissions(f)).toBe(0);expect(await report(f,row)).toMatchObject({state:'reviewed'});
 expect((await f.billing.status(f.workspaceId)).usage).toMatchObject({campaigns:0,reservedCampaigns:0,emails:0,reservedEmails:0});
 expect(await db.tenant(f.workspaceId,async sql=>(await sql.query('SELECT FROM customer_usage_reservations WHERE operation_key=$1',[key])).rowCount)).toBe(0);
});

it('requires completed approval and the exact zero-slot one-email reservation even when a caller sets the protocol marker',async()=>{
 const f=await createTestSendFixture(db),row=await review(f);
 await expect(db.brand(f.workspaceId,f.brandId,async sql=>{
  await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[f.workspaceId]);
  await sql.query(`WITH observed AS(SELECT clock_timestamp() at) UPDATE customer_deliveries SET
   test_day=(o.at AT TIME ZONE 'UTC')::date,test_slot=1,test_admitted_at=o.at FROM observed o WHERE id=$1`,[row.id]);
  await sql.query("SELECT set_config('app.customer_test_dispatch','v1',true)");
  await sql.query("UPDATE customer_delivery_recipients SET state='submitting',attempts=attempts+1 WHERE delivery_id=$1",[row.id]);
 })).rejects.toThrow('test_dispatch_not_authorized');
 expect(await admissions(f)).toBe(0);
 await approve(f,row);await f.delivery.worker.tick(f.workspaceId,row.id);
 for(const assignment of ['slots=1','recipients=2',"state='settled'"]){
  await expect(db.brand(f.workspaceId,f.brandId,async sql=>{
   await sql.query(`UPDATE customer_usage_reservations SET ${assignment} WHERE operation_key=$1`,['customer-delivery-'+row.id]);
   await sql.query("SELECT set_config('app.customer_test_dispatch','v1',true)");
   await sql.query("UPDATE customer_delivery_recipients SET state='submitting',attempts=attempts+1 WHERE delivery_id=$1",[row.id]);
  })).rejects.toThrow('test_dispatch_not_authorized');
 }
 expect(await report(f,row)).toMatchObject({accepted:0,submitting:0});
 expect((await f.billing.status(f.workspaceId)).usage).toMatchObject({reservedEmails:1,reservedCampaigns:0});
});

it('refuses legacy fresh-submit SQL and immutable recipient/assigned-admission edits without calling a provider',async()=>{
 let sdkCalls=0;
 const f=await createTestSendFixture(db),row=await review(f);await approve(f,row);await f.delivery.worker.tick(f.workspaceId,row.id);
 const legacySubmit=async()=>{
  await db.brand(f.workspaceId,f.brandId,sql=>sql.query("UPDATE customer_delivery_recipients SET state='submitting',attempts=attempts+1 WHERE delivery_id=$1",[row.id]));
  sdkCalls++; // Models the legacy worker's provider call after its committed intent.
 };
 await expect(legacySubmit()).rejects.toThrow();expect(sdkCalls).toBe(0);
 for(const assignment of [
  "purpose='broadcast',test_day=NULL,test_slot=NULL,test_admitted_at=NULL,state='reviewed',approved_at=NULL,reservation_key=NULL",
  "test_day=test_day+1,test_admitted_at=test_admitted_at+interval '1 day'",
  'test_slot=CASE WHEN test_slot=1 THEN 2 ELSE 1 END',
  "test_day=NULL,test_slot=NULL,test_admitted_at=NULL,state='reviewed',approved_at=NULL,reservation_key=NULL",
  "rendered_html=rendered_html||' '",
 ])
  await expect(db.tenant(f.workspaceId,sql=>sql.query(`UPDATE customer_deliveries SET ${assignment} WHERE id=$1`,[row.id]))).rejects.toThrow();
 const another=randomUUID();
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query("INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'other-confirmed@shop.test','confirmed')",[f.workspaceId,f.brandId,another]));
 await expect(db.brand(f.workspaceId,f.brandId,sql=>sql.query(`INSERT INTO customer_deliveries
  SELECT (jsonb_populate_record(NULL::public.customer_deliveries,to_jsonb(d)||jsonb_build_object('id',$2::uuid,'test_slot',CASE WHEN d.test_slot=1 THEN 2 ELSE 1 END))).*
  FROM customer_deliveries d WHERE id=$1`,[row.id,randomUUID()]))).rejects.toThrow('test_admission_must_start_empty');
 await expect(db.brand(f.workspaceId,f.brandId,sql=>sql.query(`INSERT INTO customer_delivery_recipients(workspace_id,brand_id,delivery_id,id,subscriber_id,email_digest,engine_reference,state)
  VALUES($1,$2,$3,$4,$5,$6,$7,'pending')`,[f.workspaceId,f.brandId,row.id,randomUUID(),another,'a'.repeat(64),'second-'+randomUUID()]))).rejects.toThrow('test_requires_one_recipient');
 for(const [column,value] of [['subscriber_id',another],['email_digest','a'.repeat(64)],['engine_reference','changed-'+randomUUID()]] as const)
  await expect(db.brand(f.workspaceId,f.brandId,sql=>sql.query(`UPDATE customer_delivery_recipients SET ${column}=$2 WHERE delivery_id=$1`,[row.id,value]))).rejects.toThrow();
 expect(await admissions(f)).toBe(1);expect((await f.billing.status(f.workspaceId)).usage).toMatchObject({reservedEmails:1,reservedCampaigns:0});
 await ageSyntheticAdmission(f,row);
 await expect(db.brand(f.workspaceId,f.brandId,async sql=>{
  await sql.query("SELECT set_config('app.customer_test_dispatch','v1',true)");
  await sql.query("UPDATE customer_delivery_recipients SET state='submitting',attempts=attempts+1 WHERE delivery_id=$1",[row.id]);
  sdkCalls++;
 })).rejects.toThrow();expect(sdkCalls).toBe(0);
});

it('refuses cross-brand/unconfirmed/extra-recipient/scheduled test input before recording a review',async()=>{
 const f=await createTestSendFixture(db),other=await extraBrand(f);
 await expect(review(f,f.actor,{...selection(f),subscriberId:other.subscriberId})).rejects.toMatchObject({status:422});
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query("UPDATE subscribers SET state='pending' WHERE id=$1",[f.subscriberId]));
 await expect(review(f)).rejects.toMatchObject({status:422});
 for(const extra of [{dueAt:new Date(Date.now()+3600000).toISOString()},{segmentId:randomUUID()},{email:'arbitrary@recipient.test'},{subscriberIds:[f.subscriberId,other.subscriberId]}])await expect(review(f,f.actor,selection(f),extra)).rejects.toThrow();
 expect(await db.tenant(f.workspaceId,async sql=>(await sql.query('SELECT count(*)::int n FROM customer_deliveries')).rows[0].n)).toBe(0);
 expect(await admissions(f)).toBe(0);
});

it('rechecks issuing owner and narrowed/revoked grants before cached receipts, approval and new submissions',async()=>{
 const f=await createTestSendFixture(db),sender=await makeAudienceConnection(db,f.actor,[f.brandId],['read','campaign:send']);
 const request={operationKey:randomUUID(),...selection(f),expectedVersion:1};
 const row=await f.delivery.execute('delivery.reviewTest',request,sender.actor) as TestReview;
 await expect(f.delivery.execute('delivery.testDetails',{brandId:row.brandId,id:row.id},sender.actor)).rejects.toMatchObject({status:403});
 await db.tenant(f.workspaceId,sql=>sql.query('UPDATE connections SET brand_ids=ARRAY[]::uuid[] WHERE id=$1',[sender.id]));
 await expect(f.delivery.execute('delivery.reviewTest',request,sender.actor)).rejects.toMatchObject({code:'connection_revoked'});
 await expect(approve(f,row,sender.actor)).rejects.toMatchObject({code:'connection_revoked'});
 await db.tenant(f.workspaceId,sql=>sql.query('UPDATE connections SET brand_ids=$2::uuid[] WHERE id=$1',[sender.id,[f.brandId]]));
 await approve(f,row,sender.actor);await f.delivery.worker.tick(f.workspaceId,row.id);
 await db.tenant(f.workspaceId,sql=>sql.query("UPDATE connections SET scopes=ARRAY['read']::text[] WHERE id=$1",[sender.id]));
 await f.delivery.worker.tick(f.workspaceId,row.id);
 expect(await report(f,row)).toMatchObject({accepted:0,state:'blocked',reason:'authority_revoked'});
 const another=await review(f);f.setOwner(false);
 await expect(approve(f,another)).rejects.toMatchObject({code:'owner_required'});
 await expect(f.delivery.execute('delivery.testDetails',{brandId:another.brandId,id:another.id},f.actor)).rejects.toMatchObject({status:403});
 expect((await f.billing.status(f.workspaceId)).usage).toMatchObject({emails:0,reservedEmails:0,campaigns:0});
});

it('invalidates recipient, revision and sender changes before admission rather than silently reviewing new facts',async()=>{
 for(const change of ['email','campaign','sender'] as const){
  const f=await createTestSendFixture(db);await saveSenderProfile(f.delivery,f.actor,f.brandId);const row=await review(f);
  if(change==='email')await db.brand(f.workspaceId,f.brandId,sql=>sql.query("UPDATE subscribers SET email_normalized='replacement@shop.test' WHERE id=$1",[f.subscriberId]));
  else if(change==='campaign')await db.tenant(f.workspaceId,sql=>sql.query('UPDATE campaigns SET version=version+1 WHERE id=$1',[f.campaign.id]));
  else await saveSenderProfile(f.delivery,f.actor,f.brandId,'200 Changed Lane, Denver, CO 80202');
  await expect(approve(f,row)).rejects.toMatchObject({status:change==='email'?422:409});
  expect(await admissions(f)).toBe(0);expect((await f.billing.status(f.workspaceId)).usage).toMatchObject({emails:0,reservedEmails:0,campaigns:0,reservedCampaigns:0});
 }
});

it('freezes the selected address and excludes later consent/email changes before any provider submission',async()=>{
 for(const mutation of ['email','consent'] as const){
  const f=await createTestSendFixture(db),row=await review(f);await approve(f,row);
  await f.delivery.worker.tick(f.workspaceId,row.id);
  await db.brand(f.workspaceId,f.brandId,sql=>sql.query(mutation==='email'?"UPDATE subscribers SET email_normalized='changed@shop.test' WHERE id=$1":"UPDATE subscribers SET state='unsubscribed' WHERE id=$1",[f.subscriberId]));
  await f.delivery.worker.tick(f.workspaceId,row.id);
  expect(await report(f,row)).toMatchObject({accepted:0,skipped:1});
  expect((await f.billing.status(f.workspaceId)).usage).toMatchObject({emails:0,reservedEmails:0,campaigns:0});
  expect(await admissions(f)).toBe(1);
 }
});

it('does not admit a test when the shared email allowance is exhausted',async()=>{
 const f=await createTestSendFixture(db),row=await review(f),status=await f.billing.status(f.workspaceId),limits=status.limits!;
 await db.brand(f.workspaceId,f.brandId,async sql=>{
  for(let remaining=limits.emails;remaining>0;remaining-=limits.recipients){const count=Math.min(remaining,limits.recipients),key='prior-accepted-'+randomUUID();
   await f.billing.reserve(sql,f.workspaceId,{operationKey:key,campaignId:f.campaign.id,brandId:f.brandId,recipients:count,campaignSlot:false});await f.billing.settle(sql,f.workspaceId,key,{accepted:count,excluded:0});
  }
 });
 await expect(approve(f,row)).rejects.toMatchObject({code:'allowance_exceeded'});
 expect(await admissions(f)).toBe(0);expect((await f.billing.status(f.workspaceId)).usage).toMatchObject({emails:limits.emails,campaigns:0,reservedEmails:0});
});

it('settles accepted messages once without campaign slots and keeps tested subscriber IDs out of generic reports',async()=>{
 const f=await createTestSendFixture(db),row=await review(f);await approve(f,row);
 await f.delivery.worker.tick(f.workspaceId,row.id);await f.delivery.worker.tick(f.workspaceId,row.id);
 const result=await report(f,row);expect(result).toMatchObject({purpose:'test',accepted:1,state:'completed'});
 expect(JSON.stringify(result)).not.toContain(f.subscriberId);
 expect(JSON.stringify(await f.delivery.execute('delivery.list',{brandId:f.brandId},f.actor))).not.toContain(f.subscriberId);
 expect(f.renderCalls[0]!.subject).toBe('[TEST] Trail news');
 expect((await f.billing.status(f.workspaceId)).usage).toMatchObject({emails:1,campaigns:0,reservedEmails:0,reservedCampaigns:0});
 await f.delivery.worker.tick(f.workspaceId,row.id);expect((await f.billing.status(f.workspaceId)).usage.emails).toBe(1);
 const draft=await db.tenant(f.workspaceId,async sql=>(await sql.query<{content:{subject:string}}>('SELECT content FROM campaigns WHERE id=$1',[f.campaign.id])).rows[0]!);expect(draft.content.subject).toBe('Trail news');
});

it('keeps uncertain/cancelled acceptance reserved and reconciles the original provider operation across UTC expiry',async()=>{
 let submits=0,lookups=0;
 const f=await createTestSendFixture(db,{mode:'ses',provider:()=>({fingerprint:'synthetic-test-route',from:'news@shop.test',ready:async()=>true,
  submit:async()=>{submits++;throw Error('synthetic lost response');},lookup:async()=>{lookups++;return {outcome:'accepted' as const,messageId:'synthetic-provider-acceptance'};}})});
 await readySes(f);const row=await review(f);await approve(f,row);
 await f.delivery.worker.tick(f.workspaceId,row.id);await f.delivery.worker.tick(f.workspaceId,row.id);
 expect(await report(f,row)).toMatchObject({uncertain:1,accepted:0});
 await f.delivery.execute('delivery.cancel',{operationKey:randomUUID(),brandId:row.brandId,id:row.id},f.actor);
 expect((await f.billing.status(f.workspaceId)).usage).toMatchObject({reservedEmails:1,emails:0,campaigns:0});
 const reserved=(await f.billing.status(f.workspaceId)).usage.period;
 await ageSyntheticAdmission(f,row);
 await f.billing.execute('customerBilling.advanceExercise',{operationKey:randomUUID(),days:32},f.actor);
 await f.billing.execute('customerBilling.exercisePayment',{operationKey:randomUUID(),result:'succeeded'},f.actor);
 expect((await f.billing.status(f.workspaceId)).usage.period).not.toBe(reserved);
 f.setClock(new Date(f.now().getTime()+61000));await f.delivery.worker.tick(f.workspaceId,row.id);
 expect(submits).toBe(1);expect(lookups).toBe(1);expect(await report(f,row)).toMatchObject({accepted:1,uncertain:0});
 expect(await db.tenant(f.workspaceId,sql=>usage(sql,reserved))).toMatchObject({emails:1,campaigns:0,reservedEmails:0});expect(await admissions(f)).toBe(1);
});

it('expires old-day queued tests before a new provider attempt while preserving the prior daily admission',async()=>{
 let submits=0;
 const f=await createTestSendFixture(db,{mode:'ses',provider:()=>({fingerprint:'synthetic-test-route',from:'news@shop.test',ready:async()=>true,
  submit:async()=>{submits++;return {outcome:'accepted' as const};},lookup:async()=>({outcome:'unknown' as const})})});
 await readySes(f);const row=await review(f);await approve(f,row);await f.delivery.worker.tick(f.workspaceId,row.id);
 await ageSyntheticAdmission(f,row);
 await f.delivery.worker.tick(f.workspaceId,row.id);expect(submits).toBe(0);expect(await report(f,row)).toMatchObject({state:'blocked',accepted:0});
 expect(await admissions(f)).toBe(1);expect((await f.billing.status(f.workspaceId)).usage).toMatchObject({emails:0,reservedEmails:0,campaigns:0});
});

it('reconciles verified non-submission after UTC expiry and owner revocation without requeueing a fresh send',async()=>{
 let submits=0,lookups=0;
 const f=await createTestSendFixture(db,{mode:'ses',provider:()=>({fingerprint:'synthetic-test-route',from:'news@shop.test',ready:async()=>true,
  submit:async()=>{submits++;return {outcome:'unknown' as const};},lookup:async()=>{lookups++;return {outcome:'not_submitted' as const};}})});
 await readySes(f);const row=await review(f);await approve(f,row);await f.delivery.worker.tick(f.workspaceId,row.id);await f.delivery.worker.tick(f.workspaceId,row.id);
 expect((await f.billing.status(f.workspaceId)).usage.reservedEmails).toBe(1);
 await ageSyntheticAdmission(f,row);f.setOwner(false);f.setClock(new Date(f.now().getTime()+61000));
 await f.delivery.worker.tick(f.workspaceId,row.id);await f.delivery.worker.tick(f.workspaceId,row.id);
 expect(submits).toBe(1);expect(lookups).toBe(1);
 f.setOwner(true);
 expect(await report(f,row)).toMatchObject({accepted:0,uncertain:0,pending:0,submitting:0,skipped:1});
 expect((await f.billing.status(f.workspaceId)).usage).toMatchObject({emails:0,reservedEmails:0,campaigns:0,reservedCampaigns:0});expect(await admissions(f)).toBe(1);
});

it('refuses runtime attempts to disable the database dispatch safety trigger',async()=>{
 const f=await createTestSendFixture(db);
 await expect(db.tenant(f.workspaceId,sql=>sql.query('ALTER TABLE public.customer_delivery_recipients DISABLE TRIGGER flockletter_customer_test_dispatch_guard'))).rejects.toMatchObject({code:'42501'});
});

it('fails startup verification if a privileged actor disables an ALWAYS safety trigger',async()=>{
 const admin=new pg.Client({connectionString:fixture.adminUrl});await admin.connect();
 try{
  await admin.query('ALTER TABLE public.customer_delivery_recipients DISABLE TRIGGER flockletter_customer_test_dispatch_guard');
  await expect(db.verifyBoundary()).rejects.toThrow();
 }finally{
  await admin.query('ALTER TABLE public.customer_delivery_recipients ENABLE ALWAYS TRIGGER flockletter_customer_test_dispatch_guard');
  await admin.end();
 }
 await expect(db.verifyBoundary()).resolves.toBeUndefined();
});

it('refuses an altered guard body even when its owner, signature, fixed search path and ALWAYS trigger remain intact',async()=>{
 const admin=new pg.Client({connectionString:fixture.adminUrl});await admin.connect();
 const original=(await admin.query("SELECT pg_get_functiondef('public.flockletter_customer_test_dispatch_guard()'::regprocedure) AS definition")).rows[0]!.definition as string;
 try{
  await admin.query('CREATE OR REPLACE FUNCTION public.flockletter_customer_test_dispatch_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN RETURN NEW; END $$');
  await expect(db.verifyBoundary()).rejects.toThrow();
 }finally{await admin.query(original);await admin.end();}
 await expect(db.verifyBoundary()).resolves.toBeUndefined();
});
