import {randomUUID} from 'node:crypto';
import {Webhook} from 'standardwebhooks';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {startDatabase} from '../scripts/database-fixture.js';
import {Database} from '../src/server/db.js';
import {createTestSendFixture} from './helpers/test-send-fixture.js';
import {saveSenderProfile,addCampaignPhoto} from './helpers/delivery-profile.js';
import {CustomerResendFeedback} from '../src/server/customer-delivery/resend-feedback.js';
import {CustomerResendProvider} from '../src/server/customer-delivery/resend.js';
import {parseResendRoute} from '../src/server/customer-delivery/resend-route.js';
import type {DeliveryView} from '../src/shared/customer-delivery.js';
let fixture:Awaited<ReturnType<typeof startDatabase>>,db:Database;
const secret='whsec_'+Buffer.alloc(32,7).toString('base64');
beforeAll(async()=>{fixture=await startDatabase();db=new Database(fixture.url);});
afterAll(async()=>{await db?.close();await fixture?.stop();});
function signed(value:unknown,id='evt_'+randomUUID(),age=0){const date=new Date(Date.now()+age),body=Buffer.from(JSON.stringify(value));return {body,headers:{'svix-id':id,'svix-timestamp':String(Math.floor(date.getTime()/1000)),'svix-signature':new Webhook(secret).sign(id,date,body.toString())}};}
async function setup(){
 const f=await createTestSendFixture(db,{mode:'resend',scope:'tests'});const messageId=randomUUID();
 const route=parseResendRoute({workspaceId:f.workspaceId,brandId:f.brandId,from:'news@shop.example.com',domainId:randomUUID(),webhookId:randomUUID(),region:'us-east-1'});
 const provider=new CustomerResendProvider(route,f.options.origin,'synthetic',async()=>true,'tests');
 f.options.provider=()=>({...provider,fingerprint:route.fingerprint,from:route.from,ready:async()=>true,submit:vi.fn(async()=>({outcome:'unknown' as const})),lookup:async()=>({outcome:'unknown' as const})});
 await saveSenderProfile(f.delivery,f.actor,f.brandId);
 await f.delivery.execute('delivery.saveSender',{operationKey:randomUUID(),brandId:f.brandId,fromName:'Shop',fromEmail:route.from,replyTo:route.from,organization:'Synthetic shop',postalAddress:'123 Example Road Denver CO 80202'},f.actor);await addCampaignPhoto(db,f.actor,f.brandId,f.campaign.id);
 await db.brand(f.workspaceId,f.brandId,sql=>sql.query("INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge,verified_at) VALUES($1,$2,'shop.example.com',gen_random_uuid(),now())",[f.workspaceId,f.brandId]));
 const review=await f.delivery.execute('delivery.reviewTest',{operationKey:randomUUID(),brandId:f.brandId,campaignId:f.campaign.id,expectedVersion:1,subscriberId:f.subscriberId},f.actor) as DeliveryView;
 await f.delivery.execute('delivery.approveTest',{operationKey:randomUUID(),brandId:f.brandId,id:review.id,expectedVersion:1,subscriberId:f.subscriberId},f.actor);
 await f.delivery.worker.tick(f.workspaceId,review.id);await f.delivery.worker.tick(f.workspaceId,review.id);
 const operation=(await db.tenant(f.workspaceId,sql=>sql.query<{id:string}>('SELECT id FROM customer_delivery_recipients WHERE delivery_id=$1',[review.id]))).rows[0]!.id;
 let receipt={id:messageId,from:route.from,to:['confirmed@shop.test'],tags:[{name:'fl_kind',value:'customer'},{name:'fl_operation',value:operation},{name:'fl_workspace',value:f.workspaceId},{name:'fl_brand',value:f.brandId},{name:'fl_route',value:route.fingerprint}]};
 const send=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(receipt)));
 const feedback=new CustomerResendFeedback(db,{register:vi.fn(),entries:[{route,provider}],retrieveKey:'synthetic-retrieve',webhookSecret:secret,send,provider:()=>provider},f.delivery.worker);
 const event=(type='email.delivered',bounce?:{type:string})=>({type,created_at:new Date().toISOString(),data:{email_id:messageId,from:route.from,to:['confirmed@shop.test'],...(bounce?{bounce}:{})}});
 const rows=()=>db.brand(f.workspaceId,f.brandId,async sql=>({person:(await sql.query('SELECT state,feedback,message_id FROM customer_delivery_recipients WHERE id=$1',[operation])).rows[0],subscriber:(await sql.query('SELECT state FROM subscribers WHERE id=$1',[f.subscriberId])).rows[0]}));
 return {...f,feedback,send,event,rows,review,receipt,setReceipt:(value:typeof receipt)=>{receipt=value;}};
}
it('settles unknown acceptance from a real-shaped nullable recipient receipt and applies deduplicated delivery, complaint and monotonic suppression',async()=>{
 const f=await setup(),delivered=signed(f.event());
 f.send.mockImplementation(async()=>new Response(JSON.stringify({...f.receipt,cc:null,bcc:null})));
 await f.feedback.receive(delivered.body,delivered.headers);await f.feedback.receive(delivered.body,delivered.headers);
 expect((await f.rows()).person).toMatchObject({state:'accepted',feedback:'delivered'});
 const complaint=signed(f.event('email.complained'));await f.feedback.receive(complaint.body,complaint.headers);
 const late=signed(f.event());await f.feedback.receive(late.body,late.headers);
 expect(await f.rows()).toMatchObject({person:{feedback:'complaint'},subscriber:{state:'complained'}});expect((await f.billing.status(f.workspaceId)).usage.emails).toBe(1);
 expect(f.send.mock.calls.every(c=>c[1]?.method===undefined)).toBe(true);
});
it('rejects invalid/stale signatures, oversized events, wrong recipients and forged routing',async()=>{
 const f=await setup(),good=signed(f.event());await expect(f.feedback.receive(good.body,{...good.headers,'svix-signature':'bad'})).rejects.toMatchObject({code:'invalid_signature'});
 const stale=signed(f.event(),undefined,-600000);await expect(f.feedback.receive(stale.body,stale.headers)).rejects.toMatchObject({code:'invalid_signature'});
 await expect(f.feedback.receive(Buffer.alloc(16385),good.headers)).rejects.toMatchObject({status:413});expect(f.send).not.toHaveBeenCalled();
 for(const receipt of [{...f.receipt,to:['other@example.com']},{...f.receipt,tags:f.receipt.tags.map(t=>t.name==='fl_workspace'?{...t,value:'org_foreign'}:t)},{...f.receipt,tags:[...f.receipt.tags,{name:'fl_operation',value:randomUUID()}]}]){
  f.setReceipt(receipt);await expect(f.feedback.receive(good.body,good.headers)).rejects.toMatchObject({code:'delivery_feedback_unmapped'});
 }
 expect((await f.rows()).person.state).toBe('uncertain');
});
it('requires retrieval, rejects replay conflicts, and preserves negative feedback after provider selection changes',async()=>{
 const f=await setup(),good=signed(f.event());f.send.mockResolvedValueOnce(new Response('',{status:503}));await expect(f.feedback.receive(good.body,good.headers)).rejects.toMatchObject({status:503});
 await f.feedback.receive(good.body,good.headers);const changed=signed(f.event('email.complained'),good.headers['svix-id']);await expect(f.feedback.receive(changed.body,changed.headers)).rejects.toMatchObject({code:'delivery_feedback_conflict'});
 f.options.mode='off';const hard=signed(f.event('email.bounced',{type:'Permanent'}));await f.feedback.receive(hard.body,hard.headers);expect((await f.rows()).subscriber.state).toBe('hard_bounced');
});
