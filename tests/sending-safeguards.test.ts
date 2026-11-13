import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,beforeEach,it,expect,vi} from 'vitest';
import {startDatabase} from '../scripts/database-fixture.js';
import {Database} from '../src/server/db.js';
import {CommandService,type Actor} from '../src/server/service.js';
import {SendingSafeguards} from '../src/server/customer-delivery/safeguards.js';
import {CustomerDeliveryWorker} from '../src/server/customer-delivery/worker.js';
import type {DeliveryOptions} from '../src/server/customer-delivery/types.js';
import {emptyContent} from '../src/shared/contracts.js';

let fixture:Awaited<ReturnType<typeof startDatabase>>,db:Database,admin:pg.Client;
const guard=()=>new SendingSafeguards(db);
const actor=():Actor=>{const workspaceId='org_'+randomUUID().replaceAll('-','');return {workspaceId,userId:'user_fixture',actorId:'user:fixture',owner:true,kind:'session',brandIds:null,scopes:['read']};};
beforeAll(async()=>{fixture=await startDatabase();db=new Database(fixture.url);admin=new pg.Client({connectionString:fixture.adminUrl});await admin.connect();});
afterAll(async()=>{await admin?.end();await db?.close();await fixture?.stop();});
beforeEach(async()=>{await admin.query('TRUNCATE flockletter_customer_jobs.sending_admissions,flockletter_customer_jobs.sending_state');await admin.query('UPDATE flockletter_customer_jobs.sending_account SET next_at=NULL,resend_retry_at=NULL,observed_at=NULL,snapshot_started_at=NULL,monthly_reset=NULL,monthly_used=NULL,daily_used=NULL,exercise=false');});
const reset=()=>new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth()+1,1)).toISOString();
const dayReset=()=>new Date(Date.now()+86400000).toISOString();
async function usage(used=0,limit=50000){await db.pool.query('SELECT flockletter_customer_jobs.sending_usage($1,$2,$3,0,NULL,$4,$5)',[used,limit,reset(),dayReset(),new Date(Date.now()-1000)]);}
async function unpace(){await admin.query('UPDATE flockletter_customer_jobs.sending_account SET next_at=NULL');await admin.query('UPDATE flockletter_customer_jobs.sending_state SET next_at=NULL');}
async function seed(a=actor()){
 const core=new CommandService(db);await core.execute('workspace.initialize',{operationKey:randomUUID(),name:'Synthetic shop',brandName:'Trail'},a);
 const brand=(await db.read(a.workspaceId,sql=>sql.query<{id:string}>('SELECT id FROM brands'))).rows[0]!.id;
 const c=await core.execute('campaign.create',{operationKey:randomUUID(),brandId:brand,content:emptyContent()},a) as {id:string};
 const delivery=randomUUID(),recipient=randomUUID(),subscriber=randomUUID();
 await db.brand(a.workspaceId,brand,async sql=>{
  await sql.query("INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,$4,'confirmed')",[a.workspaceId,brand,subscriber,subscriber+'@example.test']);
  await sql.query("INSERT INTO customer_deliveries(workspace_id,brand_id,id,campaign_id,version,actor_id,creator_id,mode,state,content,rendered_html,rendered_text,asset_digests,provider_binding,due_at,selected,excluded) VALUES($1,$2,$3,$4,1,$5,$6,'resend','queued',$7,'<html></html>','fixture','[]','fixture-route',now(),1,0)",[a.workspaceId,brand,delivery,c.id,a.actorId,a.userId,JSON.stringify(emptyContent())]);
  await sql.query("INSERT INTO customer_delivery_recipients(workspace_id,brand_id,delivery_id,id,subscriber_id,email_digest,engine_reference,state) VALUES($1,$2,$3,$4,$5,'fixture-digest',$6,'prepared')",[a.workspaceId,brand,delivery,recipient,subscriber,recipient]);
 });
 return {a,brand,delivery,recipient};
}
async function admit(s:Awaited<ReturnType<typeof seed>>){return db.tenant(s.a.workspaceId,sql=>guard().admit(sql,s.a.workspaceId,s.recipient));}
async function status(workspace:string){return db.read(workspace,sql=>guard().status(sql,workspace));}
async function outcome(s:Awaited<ReturnType<typeof seed>>,kind:string){await db.tenant(s.a.workspaceId,async sql=>{await sql.query("UPDATE customer_delivery_recipients SET state='submitting',attempts=1 WHERE id=$1",[s.recipient]);await guard().outcome(sql,s.a.workspaceId,s.recipient,kind);});}

it('denies unknown provider usage, validates a fresh GET snapshot and recovers without sending',async()=>{
 const s=await seed();expect(await admit(s)).toMatchObject({allowed:false,reason:'sending_provider_usage_unavailable'});
 const send=vi.fn(async()=>new Response(JSON.stringify({object:'usage',emails:{daily:{used:0,limit:null,resets_at:dayReset()},monthly:{used:3,limit:50000,resets_at:reset()}}}),{status:200}));
 expect(await new SendingSafeguards(db,'synthetic-key',send as typeof fetch).refreshUsage()).toBe(true);
 expect(send.mock.calls).toHaveLength(1);expect(await admit(s)).toMatchObject({allowed:true});
 expect(await status(s.a.workspaceId)).toMatchObject({phase:'new',dailyLimit:2500,usedToday:1,held:false});
});
it('enforces private table and exact workspace boundaries',async()=>{
 const s=await seed();await usage();await db.verifyBoundary();
 await expect(db.pool.query('SELECT * FROM flockletter_customer_jobs.sending_account')).rejects.toMatchObject({code:'42501'});
 await expect(db.tenant('org_other',sql=>guard().admit(sql,s.a.workspaceId,s.recipient))).rejects.toThrow(/scope/);
 await expect(db.read('org_other',sql=>guard().status(sql,s.a.workspaceId))).rejects.toThrow(/scope/);
});
it('serializes global pacing across workspaces and preserves a stable recipient admission on retry',async()=>{
 const [a,b]=await Promise.all([seed(),seed()]);await usage();
 const results=await Promise.all([admit(a),admit(b)]);expect(results.filter(r=>r.allowed)).toHaveLength(1);
 expect(results.find(r=>!r.allowed)).toMatchObject({reason:'sending_rate_wait'});
 const winner=results[0]!.allowed?a:b;await unpace();expect((await admit(winner)).allowed).toBe(true);
 expect((await status(winner.a.workspaceId)).usedToday).toBe(1);
});
it('admits 2,500 first-day recipients once and defers the next unique recipient until UTC midnight',async()=>{
 const last=await seed();await usage();
 await admin.query("INSERT INTO flockletter_customer_jobs.sending_admissions(workspace_id,recipient_id,provider) SELECT $1,gen_random_uuid(),'resend' FROM generate_series(1,2499)",[last.a.workspaceId]);
 expect(await admit(last)).toMatchObject({allowed:true});
 await unpace();
 expect(await admit(last)).toMatchObject({allowed:true});
 const next=await seed(last.a);
 const blocked=await admit(next);
 expect(blocked).toMatchObject({allowed:false,reason:'sending_daily_limit'});
 const tomorrow=new Date();tomorrow.setUTCHours(24,0,0,0);
 expect(new Date(blocked.retryAt!).getTime()).toBe(tomorrow.getTime());
 expect(await status(last.a.workspaceId)).toMatchObject({phase:'new',dailyLimit:2500,usedToday:2500});
});
it('shares Resend cooldowns across workspaces and requires an admitted submitted intent',async()=>{
 const first=await seed(),next=await seed();await usage();
 const cooldown=(seconds:number)=>db.tenant(first.a.workspaceId,sql=>guard().cooldown(sql,first.a.workspaceId,first.recipient,seconds));
 await expect(cooldown(60)).rejects.toThrow('admitted Resend submission');
 await admit(first);
 await db.tenant(first.a.workspaceId,sql=>sql.query("UPDATE customer_delivery_recipients SET state='submitting',attempts=1 WHERE id=$1",[first.recipient]));
 await expect(cooldown(86401)).rejects.toThrow('admitted Resend submission');
 await cooldown(15);await unpace();
 expect(await admit(next)).toMatchObject({allowed:false,reason:'sending_provider_backoff'});
 await admin.query("UPDATE flockletter_customer_jobs.sending_account SET resend_retry_at=clock_timestamp()-interval '1 second'");
 expect(await admit(next)).toMatchObject({allowed:true});
});
it('reserves the shared provider margin and fails closed on stale or malformed observations',async()=>{
 const a=await seed(),b=await seed();await usage(44999);expect((await admit(a)).allowed).toBe(true);await unpace();
 expect(await admit(b)).toMatchObject({allowed:false,reason:'sending_provider_capacity'});
 expect((await status(b.a.workspaceId)).warning).toBe(true);
 await admin.query("UPDATE flockletter_customer_jobs.sending_account SET observed_at=now()-interval '121 seconds'");
 expect(await admit(b)).toMatchObject({allowed:false,reason:'sending_provider_usage_unavailable'});
 await expect(db.pool.query('SELECT flockletter_customer_jobs.sending_usage(0,50000,$1,0,NULL,$2,$3)',[new Date(Date.now()-1000),dayReset(),new Date()])).rejects.toThrow(/observation/);
});
it('a complaint latches a workspace hold and replay cannot create a new incident',async()=>{
 const s=await seed();await usage();await admit(s);await outcome(s,'complaint');const held=await status(s.a.workspaceId);
 expect(held).toMatchObject({held:true,revision:1});await outcome(s,'complaint');expect((await status(s.a.workspaceId)).revision).toBe(1);
 // A customer runtime can write exercise records, but these can never clear a production hold.
 await db.tenant(s.a.workspaceId,sql=>sql.query("INSERT INTO platform_exercise_records(workspace_id,kind,id,body) VALUES($1,'approval','sending-trust',$2)",[s.a.workspaceId,JSON.stringify({resume:true,phase:'limited',incidentRevision:1})]));
 expect((await status(s.a.workspaceId)).held).toBe(true);
});
it('an authorized exact incident review permits only a limited restart; a new complaint relatches it',async()=>{
 const s=await seed();await usage();await admit(s);await outcome(s,'complaint');
 await admin.query("INSERT INTO flockletter_retention_control.platform_records(workspace_id,kind,id,body) VALUES($1,'approval','sending-trust',$2)",[s.a.workspaceId,JSON.stringify({resume:true,phase:'limited',incidentRevision:1})]);
 expect(await status(s.a.workspaceId)).toMatchObject({held:false,phase:'limited',dailyLimit:100});
 const next=await seed(s.a);await unpace();expect(await admit(next)).toMatchObject({allowed:true,reason:null,retryAt:null});await outcome(next,'complaint');
 expect(await status(s.a.workspaceId)).toMatchObject({held:true,revision:2});
});
it('a late complaint for a pre-policy submitted intent also creates a hold',async()=>{
 const s=await seed();await outcome(s,'complaint');expect(await status(s.a.workspaceId)).toMatchObject({held:true,revision:1});
});
it('unknown submissions reconcile without another admission or POST even while the workspace is held',async()=>{
 const s=await seed();await usage();await admit(s);await outcome(s,'complaint');
 await db.tenant(s.a.workspaceId,sql=>sql.query("UPDATE customer_delivery_recipients SET state='uncertain',next_check_at=NULL WHERE id=$1",[s.recipient]));
 const submit=vi.fn(),lookup=vi.fn(async()=>({outcome:'unknown' as const}));
 const worker=new CustomerDeliveryWorker(db,{mode:'resend',scope:'all',environment:'test',origin:'http://localhost',billing:{} as DeliveryOptions['billing'],isOwner:async()=>true,safeguards:guard(),provider:()=>({fingerprint:'fixture-route',submit,lookup})});
 expect(await worker.tick(s.a.workspaceId,s.delivery)).toEqual({processed:true});expect(lookup).toHaveBeenCalledExactlyOnceWith(s.recipient,null);expect(submit).not.toHaveBeenCalled();
 expect((await status(s.a.workspaceId)).usedToday).toBe(1);
});

it('honors the provider billing anniversary and rejects a premature reset',async()=>{
 const s=await seed(),anniversary=new Date(Date.now()+27*86400000);
 await db.pool.query('SELECT flockletter_customer_jobs.sending_usage(39999,50000,$1,0,NULL,$2,$3)',[anniversary,dayReset(),new Date(Date.now()-1000)]);
 expect((await status(s.a.workspaceId)).warning).toBe(false);
 expect((await admit(s)).allowed).toBe(true);expect((await status(s.a.workspaceId)).warning).toBe(true);
 await expect(db.pool.query('SELECT flockletter_customer_jobs.sending_usage(0,50000,$1,0,NULL,$2,$3)',[reset(),dayReset(),new Date()])).rejects.toThrow('billing period changed');
});
it('warns at one percent bounce and latches at two percent without any complaint',async()=>{
 const s=await seed();await usage();await admit(s);await outcome(s,'accepted');
 await admin.query("INSERT INTO flockletter_customer_jobs.sending_admissions(workspace_id,recipient_id,provider,accepted_at) SELECT $1,gen_random_uuid(),'resend',clock_timestamp() FROM generate_series(1,99)",[s.a.workspaceId]);
 await outcome(s,'hard_bounce');expect(await status(s.a.workspaceId)).toMatchObject({warning:true,held:false});
 const next=await seed(s.a);await unpace();await admin.query("DELETE FROM flockletter_customer_jobs.sending_admissions WHERE workspace_id=$1 AND recipient_id=(SELECT recipient_id FROM flockletter_customer_jobs.sending_admissions WHERE workspace_id=$1 AND recipient_id<>$2 LIMIT 1)",[s.a.workspaceId,s.recipient]);
 await admit(next);await outcome(next,'hard_bounce');expect(await status(s.a.workspaceId)).toMatchObject({held:true,revision:1});
});
it('requires both verified delivery counts and elapsed age before using an operator promotion',async()=>{
 const s=await seed();await usage();await admit(s);
 await admin.query("INSERT INTO flockletter_retention_control.platform_records(workspace_id,kind,id,body) VALUES($1,'approval','sending-trust',$2)",[s.a.workspaceId,JSON.stringify({phase:'full',resume:true,incidentRevision:0})]);
 expect((await status(s.a.workspaceId)).phase).toBe('new');
 await admin.query("UPDATE flockletter_customer_jobs.sending_state SET first_sent_at=clock_timestamp()-interval '14 days' WHERE workspace_id=$1",[s.a.workspaceId]);
 expect((await status(s.a.workspaceId)).phase).toBe('new');
 await admin.query("INSERT INTO flockletter_customer_jobs.sending_admissions(workspace_id,recipient_id,provider,accepted_at,delivered_at) SELECT $1,gen_random_uuid(),'resend',clock_timestamp(),clock_timestamp() FROM generate_series(1,500)",[s.a.workspaceId]);
 expect(await status(s.a.workspaceId)).toMatchObject({phase:'full',dailyLimit:null});
});
