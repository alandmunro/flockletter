import {CustomerWorkflows} from '../src/server/customer-runtime.js';
import {localIdentity} from '../src/server/auth.js';
import type {Config} from '../src/server/config.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../src/mcp/bridge.js';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {startDatabase} from '../scripts/database-fixture.js';
import {Database} from '../src/server/db.js';
import {createTestSendFixture} from './helpers/test-send-fixture.js';
import {saveSenderProfile,addCampaignPhoto} from './helpers/delivery-profile.js';
import {makeAudienceConnection} from './helpers/audience-connection.js';
import type {DeliveryProviders,DeliveryView} from '../src/shared/customer-delivery.js';
import type {CustomerProvider} from '../src/server/customer-delivery/types.js';
let fixture:Awaited<ReturnType<typeof startDatabase>>,db:Database;
beforeAll(async()=>{fixture=await startDatabase();db=new Database(fixture.url);});
afterAll(async()=>{await db?.close();await fixture?.stop();});
async function setup(){
 const ses:CustomerProvider={from:'news@shop.test',fingerprint:'a'.repeat(64),ready:async()=>true,submit:vi.fn(async()=>({outcome:'accepted' as const,messageId:'ses-example'})),lookup:vi.fn(async()=>({outcome:'unknown' as const}))};
 const resend:CustomerProvider={from:'news@shop.test',fingerprint:'b'.repeat(64),ready:async()=>true,submit:vi.fn(async()=>({outcome:'accepted' as const,messageId:randomUUID()})),lookup:vi.fn(async()=>({outcome:'unknown' as const}))};
 const f=await createTestSendFixture(db,{mode:'ses',scope:'tests',provider:(_w,_b,m)=>m==='resend'?resend:ses});
 await saveSenderProfile(f.delivery,f.actor,f.brandId);await addCampaignPhoto(db,f.actor,f.brandId,f.campaign.id);
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query("INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge,verified_at) VALUES($1,$2,'shop.test',gen_random_uuid(),now())",[f.workspaceId,f.brandId]));
 const select=(provider:'ses'|'resend',revision:number,key=randomUUID())=>f.delivery.execute('delivery.selectProvider',{brandId:f.brandId,provider,expectedRevision:revision,operationKey:key},f.actor) as Promise<DeliveryProviders>;
 const review=()=>f.delivery.execute('delivery.reviewTest',{operationKey:randomUUID(),brandId:f.brandId,campaignId:f.campaign.id,expectedVersion:1,subscriberId:f.subscriberId},f.actor) as Promise<DeliveryView>;
 const approve=(r:DeliveryView)=>f.delivery.execute('delivery.approveTest',{operationKey:randomUUID(),brandId:f.brandId,id:r.id,expectedVersion:1,subscriberId:f.subscriberId},f.actor);
 return {...f,ses,resend,select,review,approve};
}
it('persists versioned per-brand selection, exact idempotent retry and stale-write denial',async()=>{
 const f=await setup();const initial=await f.delivery.execute('delivery.providers',{brandId:f.brandId},f.actor) as DeliveryProviders;
 expect(initial).toMatchObject({selected:'ses',revision:0,choices:[{provider:'ses',configured:true},{provider:'resend',configured:true}]});
 const key=randomUUID(),choice=await f.select('resend',0,key);expect(choice).toMatchObject({selected:'resend',revision:1});
 expect(await f.select('resend',0,key)).toEqual(choice);
 await expect(f.select('ses',0)).rejects.toMatchObject({code:'provider_revision_conflict'});
 await expect(f.select('ses',0,key)).rejects.toMatchObject({code:'operation_conflict'});
 expect(await f.delivery.execute('delivery.status',{brandId:f.brandId},f.actor)).toMatchObject({mode:'resend',scope:'tests',externalSendingEnabled:false,testSendingEnabled:true});
});
it('requires an explicitly granted configuration scope and current issuing ownership',async()=>{
 const f=await setup();const old=await makeAudienceConnection(db,f.actor,[f.brandId],['read','campaign:send']);
 await expect(f.delivery.execute('delivery.selectProvider',{operationKey:randomUUID(),brandId:f.brandId,provider:'resend',expectedRevision:0},old.actor)).rejects.toMatchObject({code:'scope_required'});
 const grant=await makeAudienceConnection(db,f.actor,[f.brandId],['read','delivery:configure']);
 expect(await f.delivery.execute('delivery.selectProvider',{operationKey:randomUUID(),brandId:f.brandId,provider:'resend',expectedRevision:0},grant.actor)).toMatchObject({revision:1,selected:'resend'});
 await expect(f.delivery.execute('delivery.reviewTest',{operationKey:randomUUID(),brandId:f.brandId,campaignId:f.campaign.id,expectedVersion:1,subscriberId:f.subscriberId},grant.actor)).rejects.toMatchObject({code:'scope_required'});
 await db.tenant(f.workspaceId,sql=>sql.query('UPDATE connections SET revoked_at=now() WHERE id=$1',[grant.id]));
 await expect(f.delivery.execute('delivery.providers',{brandId:f.brandId},grant.actor)).rejects.toMatchObject({code:'connection_revoked'});
});
it('invalidates an old review even after switching back to the same provider',async()=>{
 const f=await setup(),old=await f.review();await f.select('resend',0);await f.select('ses',1);
 await expect(f.approve(old)).rejects.toMatchObject({code:'sender_changed'});
 expect((await f.billing.status(f.workspaceId)).usage.reservedEmails).toBe(0);
});
it('sends the freshly reviewed Resend test only through Resend and keeps broadcasts blocked',async()=>{
 const f=await setup();await f.select('resend',0);const r=await f.review();expect(r.mode).toBe('resend');await f.approve(r);
 for(let i=0;i<3;i++)await f.delivery.worker.tick(f.workspaceId,r.id);
 expect(f.resend.submit).toHaveBeenCalledTimes(1);expect(f.ses.submit).not.toHaveBeenCalled();
 await expect(f.delivery.execute('delivery.review',{operationKey:randomUUID(),brandId:f.brandId,campaignId:f.campaign.id,expectedVersion:1},f.actor)).rejects.toMatchObject({code:'broadcasts_disabled'});
 const usage=await f.billing.status(f.workspaceId);expect(usage.usage.emails).toBe(1);expect(usage.usage.campaigns).toBe(0);
});
it('reconciles unknown attempts against the original provider after switching without submitting again',async()=>{
 const f=await setup();vi.mocked(f.ses.submit).mockResolvedValue({outcome:'unknown'});const r=await f.review();await f.approve(r);
 await f.delivery.worker.tick(f.workspaceId,r.id);await f.delivery.worker.tick(f.workspaceId,r.id);await f.select('resend',0);
 await db.tenant(f.workspaceId,sql=>sql.query("UPDATE customer_delivery_recipients SET next_check_at=now()-interval '1 second' WHERE delivery_id=$1",[r.id]));
 await f.delivery.worker.tick(f.workspaceId,r.id);
 expect(f.ses.lookup).toHaveBeenCalledTimes(1);expect(f.ses.submit).toHaveBeenCalledTimes(1);expect(f.resend.submit).not.toHaveBeenCalled();expect(f.resend.lookup).not.toHaveBeenCalled();
});
it('blocks queued unsubmitted work after switching and releases unaccepted allowance',async()=>{
 const f=await setup(),r=await f.review();await f.approve(r);await f.select('resend',0);await f.delivery.worker.tick(f.workspaceId,r.id);
 const report=await f.delivery.execute('delivery.report',{brandId:f.brandId,id:r.id},f.actor) as DeliveryView;expect(report).toMatchObject({state:'blocked',reason:'delivery_configuration_changed'});
 expect(f.ses.submit).not.toHaveBeenCalled();expect(f.resend.submit).not.toHaveBeenCalled();expect((await f.billing.status(f.workspaceId)).usage.reservedEmails).toBe(0);
});
it('never enables off/capture or chooses an absent provider and rejects a foreign brand',async()=>{
 const f=await setup(),other=await setup();f.options.mode='capture';await expect(f.select('resend',0)).rejects.toMatchObject({code:'delivery_off'});
 f.options.mode='off';await expect(f.select('resend',0)).rejects.toMatchObject({code:'delivery_off'});
 f.options.mode='ses';f.options.provider=()=>undefined;await expect(f.select('resend',0)).rejects.toMatchObject({code:'provider_unavailable'});
 await expect(f.delivery.execute('delivery.providers',{brandId:other.brandId},f.actor)).rejects.toMatchObject({code:'brand_unavailable'});
});
it('the runtime cannot rewrite frozen provider routing or a reviewed selection revision',async()=>{
 const f=await setup(),r=await f.review();
 for(const update of ["provider_revision=1","mode='resend'","provider_binding='different'"]){
  await expect(db.tenant(f.workspaceId,sql=>sql.query('UPDATE customer_deliveries SET '+update+' WHERE id=$1',[r.id]))).rejects.toThrow(/immutable/);
 }
});

it('exposes the identical revisioned selection in MCP without granting sending and rejects revoked authority',async()=>{
 const f=await setup(),grant=await makeAudienceConnection(db,f.actor,[f.brandId],['read','delivery:configure']);
 const server=createMcpServer((name,input)=>f.delivery.execute(name,input,grant.actor)),client=new Client({name:'provider-choice-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{
  const tools=await client.listTools();expect(tools.tools.map(t=>t.name)).toContain('delivery_selectProvider');
  const result=await client.callTool({name:'delivery_selectProvider',arguments:{operationKey:randomUUID(),brandId:f.brandId,provider:'resend',expectedRevision:0}});
  expect(result.isError).not.toBe(true);expect(JSON.parse((result.content as {text:string}[])[0]!.text)).toMatchObject({selected:'resend',revision:1});
  const denied=await client.callTool({name:'delivery_reviewTest',arguments:{operationKey:randomUUID(),brandId:f.brandId,campaignId:f.campaign.id,subscriberId:f.subscriberId,expectedVersion:1}});expect(denied.isError).toBe(true);
  f.setOwner(false);const revoked=await client.callTool({name:'delivery_providers',arguments:{brandId:f.brandId}});expect(revoked.isError).toBe(true);
 }finally{await client.close();await server.close();}
});
it('fails startup when the provider snapshot guard is disabled and verifies it again after restoration',async()=>{
 const admin=new pg.Client({connectionString:fixture.adminUrl});await admin.connect();
 try{await admin.query('ALTER TABLE public.customer_deliveries DISABLE TRIGGER flockletter_delivery_provider_snapshot_guard');await expect(db.verifyBoundary()).rejects.toThrow('migration033');}
 finally{await admin.query('ALTER TABLE public.customer_deliveries ENABLE ALWAYS TRIGGER flockletter_delivery_provider_snapshot_guard');await admin.end();}
 await expect(db.verifyBoundary()).resolves.toBeUndefined();
});

it('constructs a Resend-only runtime while retaining the old trusted SES feedback receiver without AWS sending keys',async()=>{
 const origin='https://flockletter.example.com',brand=randomUUID();
 const config:Config={environment:'production',origin,browserOrigins:[origin],host:'127.0.0.1',port:4310,localIdentity:false,databasePoolMax:2};
 const runtime=new CustomerWorkflows(db,config,localIdentity(),{APP_ENV:'production',FLOCKLETTER_CUSTOMER_DELIVERY:'resend',FLOCKLETTER_CUSTOMER_DELIVERY_SCOPE:'tests',FLOCKLETTER_TEST_MAILING_APPROVED:'true',
  FLOCKLETTER_CUSTOMER_RESEND_KEY:'synthetic-send',FLOCKLETTER_CUSTOMER_RESEND_RETRIEVE_KEY:'synthetic-retrieve',FLOCKLETTER_CUSTOMER_RESEND_WEBHOOK_SECRET:'whsec_'+Buffer.alloc(32,4).toString('base64'),
  FLOCKLETTER_CUSTOMER_RESEND_BINDINGS:JSON.stringify([{workspaceId:'org_example',brandId:brand,from:'news@brand.example.com',domainId:randomUUID(),webhookId:randomUUID(),region:'us-east-1'}]),
  FLOCKLETTER_CUSTOMER_SES_FEEDBACK_BINDING:JSON.stringify({workspaceId:'org_example',brandId:brand,from:'news@brand.example.com',accountId:'123456789012',region:'us-east-2',tenant:'example',configurationSet:'example',identityArn:'arn:aws:ses:us-east-2:123456789012:identity/brand.example.com',topicArn:'arn:aws:sns:us-east-2:123456789012:old_feedback'})});
 try{expect(runtime.ses).toBeUndefined();expect(runtime.feedback).toBeDefined();expect(runtime.resendFeedback).toBeDefined();expect(runtime.delivery.options.provider?.('org_example',brand,'resend')).toBeDefined();}
 finally{await runtime.close();}
});
