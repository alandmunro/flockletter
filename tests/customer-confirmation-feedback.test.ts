import { randomUUID,randomBytes } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { beforeAll,afterAll,expect,it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService,type Actor } from '../src/server/service.js';
import { CustomerAudience,type ConfirmationEnvelope } from '../src/server/customer-audience/service.js';
import { CustomerConfirmationFeedback } from '../src/server/customer-audience/feedback.js';
import { CustomerConfirmationProvider } from '../src/server/customer-audience/resend.js';
import { recordRestoredErasure } from './helpers/restored-erasure.js';

let fixture:Awaited<ReturnType<typeof startDatabase>>,db:Database;
beforeAll(async()=>{fixture=await startDatabase();db=new Database(fixture.url);});
afterAll(async()=>{await db?.close();await fixture?.stop();});
const sender='confirm@mail.example.test',secret='whsec_'+randomBytes(32).toString('base64');
const routeKey=randomBytes(32);
function signed(raw:unknown,id='msg_'+randomUUID(),offset=0){
 const body=Buffer.from(JSON.stringify(raw)),at=new Date(Date.now()+offset);
 return {body,headers:{'svix-id':id,'svix-timestamp':String(Math.floor(at.getTime()/1000)),'svix-signature':new Webhook(secret).sign(id,at,body.toString())}};
}
async function setup(){
 const workspace='org_'+randomUUID().replaceAll('-','');
 const actor:Actor={workspaceId:workspace,userId:'user_owner',actorId:'user:owner',owner:true,kind:'session',scopes:['read'],brandIds:null};
 const core=new CommandService(db);
 await core.execute('workspace.initialize',{operationKey:randomUUID(),name:'Mail shop',brandName:'Alpine'},actor);
 const brand=((await core.execute('workspace.get',{},actor)) as {brands:{id:string}[]}).brands[0]!.id;
 let message:ConfirmationEnvelope|undefined,fetches=0,status=200;
 const providerId=randomUUID();
 let sent:unknown;
 const feedback=new CustomerConfirmationFeedback(db,{webhookSecret:secret,retrieveKey:'retrieve-only',sendingKey:'send-only',routeKey,sender,send:async(url,options)=>{
   fetches++;expect(url).toBe('https://api.resend.com/emails/'+providerId);expect(options?.redirect).toBe('error');expect(options?.headers).toEqual({authorization:'Bearer retrieve-only'});
   return Response.json(sent,{status});
 }});
 const audience=new CustomerAudience(db,{mode:'live',origin:'https://mail.example.test',checkOwner:async()=>true,confirmationKey:randomBytes(32),feedback,provider:{
   submit:async value=>{message=value;sent={id:providerId,from:sender,to:[value.to],tags:[{name:'fl_confirmation',value:value.operationKey},{name:'fl_confirmation_route',value:value.routeToken}]};return {state:'unknown'};},lookup:async()=>({state:'unknown'}),
 }});
 await audience.execute('audienceOnboarding.configure',{operationKey:randomUUID(),brandId:brand,enabled:true,purpose:'shop_news',policyVersion:'v1',consentText:'Send occasional news from the shop. I can unsubscribe anytime.',sourceDomain:'shop.example.test'},actor);
 const view=await audience.execute('audienceOnboarding.status',{brandId:brand},actor) as {publicUrl:string};
 await audience.publicSignup(view.publicUrl.split('/newsletter/')[1]!,{email:'reader@retailer.test',consentAffirmed:true,policyVersion:'v1'});
 await audience.tick(workspace,brand);
 expect(message?.routeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
 const event=(type='email.delivered',extra={})=>({type,created_at:new Date().toISOString(),data:{email_id:providerId,from:sender,to:['reader@retailer.test'],...extra}});
 const rows=()=>db.brand(workspace,brand,async sql=>({job:(await sql.query('SELECT id,state,provider_id,consumed_at FROM customer_audience_confirmations')).rows[0],person:(await sql.query('SELECT id,state FROM subscribers')).rows[0],events:(await sql.query('SELECT * FROM customer_audience_feedback')).rows}));
 return {workspace,brand,actor,audience,feedback,providerId,event,rows,message:()=>message!,fetches:()=>fetches,setSent:(v:unknown)=>{sent=v;},sent:()=>sent as {id:string;from:string;to:string[];tags:{name:string;value:string}[]},setStatus:(v:number)=>{status=v;}};
}
it('settles an unknown send through provider-authoritative tags, replays once, and never grants opt-in',async()=>{
 const a=await setup(),receipt=signed({...a.event(),data:{...a.event().data,tags:{fl_confirmation:'forged',fl_confirmation_route:'ignored'}}});
 expect((await a.rows()).job.state).toBe('uncertain');
 await a.feedback.receive(receipt.body,receipt.headers);await a.feedback.receive(receipt.body,receipt.headers);
 const result=await a.rows();expect(result.job).toMatchObject({state:'accepted',provider_id:a.providerId});expect(result.events).toHaveLength(1);expect(result.person.state).toBe('pending');
 expect(await db.brand(a.workspace,a.brand,async sql=>(await sql.query("SELECT FROM subscriber_consent_events WHERE subscriber_id=$1 AND event='confirmed'",[result.person.id])).rowCount)).toBe(0);
});
it('verifies raw signatures, timestamp and size before any retrieval',async()=>{
 const a=await setup(),good=signed(a.event());
 await expect(a.feedback.receive(good.body,{...good.headers,'svix-signature':'bad'})).rejects.toMatchObject({code:'invalid_signature'});
 const stale=signed(a.event(),undefined,-600000);await expect(a.feedback.receive(stale.body,stale.headers)).rejects.toMatchObject({code:'invalid_signature'});
 await expect(a.feedback.receive(Buffer.alloc(16385),good.headers)).rejects.toMatchObject({code:'confirmation_feedback_too_large'});
 const wrong=signed({...a.event(),data:{...a.event().data,email_id:'https://evil.example'}});await expect(a.feedback.receive(wrong.body,wrong.headers)).rejects.toThrow();
 expect(a.fetches()).toBe(0);expect((await a.rows()).events).toHaveLength(0);
});
it('keeps failed retrieval unresolved and retries without provider send',async()=>{
 const a=await setup(),receipt=signed(a.event());a.setStatus(403);
 await expect(a.feedback.receive(receipt.body,receipt.headers)).rejects.toMatchObject({status:503,code:'confirmation_feedback_pending'});
 expect((await a.rows()).job.state).toBe('uncertain');a.setStatus(200);await a.feedback.receive(receipt.body,receipt.headers);expect((await a.rows()).job.state).toBe('accepted');expect(a.fetches()).toBe(2);
});
it('rejects missing/duplicate authoritative tags, recipient tampering and different provider IDs',async()=>{
 const a=await setup(),original=a.sent(),receipt=signed(a.event());
 for(const modified of [{...original,tags:[]},{...original,tags:[...original.tags,original.tags[0]!]},{...original,to:['other@retailer.test']},{...original,id:randomUUID()}]){
  a.setSent(modified);await expect(a.feedback.receive(receipt.body,receipt.headers)).rejects.toThrow();
 }
 expect((await a.rows()).events).toHaveLength(0);expect((await a.rows()).job.state).toBe('uncertain');
});
it('never remaps a signed event identifier or known provider binding',async()=>{
 const a=await setup(),id='msg_'+randomUUID(),first=signed(a.event(),id);await a.feedback.receive(first.body,first.headers);
 const changed=signed(a.event('email.complained'),id);await expect(a.feedback.receive(changed.body,changed.headers)).rejects.toMatchObject({code:'confirmation_feedback_conflict'});
 const b=await setup(),foreign=signed(b.event(),id);await expect(b.feedback.receive(foreign.body,foreign.headers)).rejects.toMatchObject({code:'confirmation_feedback_conflict'});
 expect((await a.rows()).person.state).toBe('pending');expect((await b.rows()).events).toHaveLength(0);
 await db.brand(b.workspace,b.brand,sql=>sql.query('UPDATE customer_audience_confirmations SET provider_id=$1',[randomUUID()]));
 const known=signed(b.event());await expect(b.feedback.receive(known.body,known.headers)).rejects.toMatchObject({code:'confirmation_feedback_mismatch'});
});
it('strengthens hard bounce and complaint suppression despite out-of-order delivery receipts',async()=>{
 const a=await setup(),b=await setup();
 const transient=signed(a.event('email.bounced',{bounce:{type:'Transient'}}));await a.feedback.receive(transient.body,transient.headers);expect((await a.rows()).person.state).toBe('pending');
 const hard=signed(a.event('email.bounced',{bounce:{type:'Permanent'}}));await a.feedback.receive(hard.body,hard.headers);expect((await a.rows()).person.state).toBe('hard_bounced');
 const complaint=signed(a.event('email.complained'));await a.feedback.receive(complaint.body,complaint.headers);
 const late=signed(a.event('email.delivered'));await a.feedback.receive(late.body,late.headers);
 expect((await a.rows()).person.state).toBe('complained');expect((await a.rows()).job.state).toBe('cancelled');expect((await b.rows()).person.state).toBe('pending');
});
it('keeps route registration private, brand-scoped and immutable and receipts append-only',async()=>{
 const a=await setup(),b=await setup();
 await expect(db.pool.query('SELECT * FROM flockletter_customer_jobs.confirmation_routes')).rejects.toThrow(/permission denied/);
 await expect(db.brand(b.workspace,b.brand,sql=>sql.query('SELECT flockletter_customer_jobs.register_confirmation_route($1,$2,$3,$4,$5,$6)',[a.workspace,a.brand,a.message().operationKey,'a'.repeat(64),'b'.repeat(64),new Date(Date.now()+86400000)]))).rejects.toThrow(/Invalid confirmation route/);
 await db.brand(a.workspace,a.brand,sql=>sql.query("UPDATE customer_audience_confirmations SET state='submitting'"));
 await expect(db.brand(a.workspace,a.brand,sql=>sql.query('SELECT flockletter_customer_jobs.register_confirmation_route($1,$2,$3,$4,$5,$6)',[a.workspace,a.brand,a.message().operationKey,'a'.repeat(64),'b'.repeat(64),new Date(Date.now()+86400000)]))).rejects.toThrow(/immutable/);
 const receipt=signed(a.event());await a.feedback.receive(receipt.body,receipt.headers);
 for(const action of ['UPDATE customer_audience_feedback SET kind=\'complaint\'','DELETE FROM customer_audience_feedback'])await expect(db.brand(a.workspace,a.brand,sql=>sql.query(action))).rejects.toThrow(/permission denied/);
 expect(await db.brand(b.workspace,b.brand,async sql=>(await sql.query('SELECT * FROM customer_audience_feedback')).rowCount)).toBe(0);
});
it('refuses restored-erased or expired routes before tenant writes',async()=>{
 const a=await setup();await recordRestoredErasure(fixture.adminUrl,a.workspace);const receipt=signed(a.event());await expect(a.feedback.receive(receipt.body,receipt.headers)).rejects.toMatchObject({code:'workspace_retention_blocked'});
 const b=await setup(),admin=new Database(fixture.adminUrl);
 try{await admin.pool.query("UPDATE flockletter_customer_jobs.confirmation_routes SET expires_at=now()-interval '1 second' WHERE workspace_id=$1",[b.workspace]);}finally{await admin.close();}
 const expired=signed(b.event());await expect(b.feedback.receive(expired.body,expired.headers)).rejects.toMatchObject({code:'confirmation_feedback_unmapped'});expect((await b.rows()).events).toHaveLength(0);
});
it('requires distinct credentials and includes the registered route in outbound provider tags',async()=>{
 expect(()=>new CustomerConfirmationFeedback(db,{webhookSecret:secret,retrieveKey:'same',sendingKey:'same',routeKey,sender})).toThrow(/distinct/);
 const a=await setup();let payload:unknown;
 const provider=new CustomerConfirmationProvider('send-only',sender,'https://mail.example.test',async(_url,options)=>{payload=JSON.parse(String(options?.body));return Response.json({id:a.providerId});});
 expect(await provider.submit(a.message())).toMatchObject({state:'accepted',providerId:a.providerId});expect(payload).toMatchObject({tags:[{name:'fl_confirmation',value:a.message().operationKey},{name:'fl_confirmation_route',value:a.message().routeToken}]});
 expect(await provider.submit({...a.message(),routeToken:undefined})).toEqual({state:'rejected'});
});
it('does not bind one provider message to a second confirmation even across workspaces',async()=>{
 const a=await setup(),b=await setup(),first=signed(a.event());await a.feedback.receive(first.body,first.headers);
 const foreign=new CustomerConfirmationFeedback(db,{webhookSecret:secret,retrieveKey:'retrieve-only',sendingKey:'send-only',routeKey,sender,send:async()=>Response.json({...b.sent(),id:a.providerId})});
 const duplicate=signed({...b.event(),data:{...b.event().data,email_id:a.providerId}});
 await expect(foreign.receive(duplicate.body,duplicate.headers)).rejects.toMatchObject({code:'confirmation_feedback_conflict'});
 expect((await b.rows()).job).toMatchObject({state:'uncertain',provider_id:null});expect((await b.rows()).events).toHaveLength(0);
});
it('commits a concurrent duplicate receipt once and exposes only its verified transport fact to the owner',async()=>{
 const a=await setup(),receipt=signed(a.event());
 await Promise.all([a.feedback.receive(receipt.body,receipt.headers),a.feedback.receive(receipt.body,receipt.headers)]);
 const result=await a.rows();expect(result.events).toHaveLength(1);
 const status=await a.audience.execute('audienceOnboarding.status',{brandId:a.brand},a.actor) as {messages:{transport:unknown}[]};
 expect(status.messages[0]?.transport).toMatchObject({kind:'delivered'});expect(JSON.stringify(status)).not.toContain(a.message().routeToken);
});
