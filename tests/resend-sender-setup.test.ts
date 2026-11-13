import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {startDatabase} from '../scripts/database-fixture.js';
import {Database} from '../src/server/db.js';
import {CommandService,type Actor,authorize} from '../src/server/service.js';
import {ResendSenderSetup,capturedSenderSetupPort,type ResendDomainFacts} from '../src/server/customer-delivery/sender-setup.js';
import type {SenderSetupView} from '../src/shared/sender-setup.js';
let fixture:Awaited<ReturnType<typeof startDatabase>>,db:Database,admin:pg.Client;
beforeAll(async()=>{fixture=await startDatabase();db=new Database(fixture.url);admin=new pg.Client({connectionString:fixture.adminUrl});await admin.connect();});
afterAll(async()=>{await admin?.end();await db?.close();await fixture?.stop();});
async function factory(domain='shop-'+randomUUID()+'.example.com'){
 const a:Actor={workspaceId:'org_'+randomUUID().replaceAll('-',''),userId:'user_fixture',actorId:'user:fixture',kind:'session',owner:true,scopes:['read'],brandIds:null};
 const core=new CommandService(db);await core.execute('workspace.initialize',{operationKey:randomUUID(),name:'Synthetic sender',brandName:'Trail'},a);
 const brand=(await db.read(a.workspaceId,sql=>sql.query<{id:string}>('SELECT id FROM brands'))).rows[0]!.id;
 await db.brand(a.workspaceId,brand,async sql=>{
  await sql.query('INSERT INTO customer_sender_profiles(workspace_id,brand_id,profile) VALUES($1,$2,$3)',[a.workspaceId,brand,JSON.stringify({fromName:'Trail',fromEmail:'news@'+domain,replyTo:'support@'+domain,organization:'Synthetic shop',postalAddress:'100 Synthetic Lane, Denver CO 80202',revision:1})]);
  await sql.query('INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge,verified_at) VALUES($1,$2,$3,$4,now())',[a.workspaceId,brand,domain,randomUUID()]);
 });
 let verified=false,owner=true;
 const id=randomUUID(),hook=randomUUID();
 const facts=():ResendDomainFacts=>({id,name:domain,region:'us-east-1',status:verified?'verified':'not_started',open_tracking:false,click_tracking:false,capabilities:{sending:'enabled'},records:[{name:'send.'+domain,type:'TXT',value:'synthetic-dns-only'}]});
 const port={usage:vi.fn(async()=>({available:true})),create:vi.fn(async()=>facts()),inspect:vi.fn(async()=>facts()),configure:vi.fn(async()=>{}),verify:vi.fn(async()=>{})};
 const register=vi.fn(),setup=new ResendSenderSetup(db,{enabled:true,port,webhookId:hook,isOwner:async()=>owner,eligible:async()=>({eligible:true}),register});
 const review=()=>setup.execute('senderSetup.review',{operationKey:randomUUID(),brandId:brand,senderRevision:1},a) as Promise<SenderSetupView>;
 const approve=(view:SenderSetupView,key=randomUUID())=>setup.execute('senderSetup.approve',{operationKey:key,brandId:brand,setupId:view.setup!.id,senderRevision:1},a) as Promise<SenderSetupView>;
 const age=()=>admin.query("UPDATE public.customer_resend_senders SET updated_at=now()-interval '61 seconds' WHERE workspace_id=$1",[a.workspaceId]);
 return {a,brand,domain,id,port,setup,review,approve,age,register,setVerified:()=>{verified=true;},revoke:()=>{owner=false;}};
}
it('reviews without creating, then creates once, returns DNS and verifies the exact owned route',async()=>{
 const f=await factory(),review=await f.review();expect(review.setup).toMatchObject({domain:f.domain,state:'reviewed'});expect(f.port.create).not.toHaveBeenCalled();
 const key=randomUUID(),pending=await f.approve(review,key);expect(pending.setup).toMatchObject({state:'awaiting_dns'});expect(f.port.create).toHaveBeenCalledTimes(1);
 expect(pending.setup!.dns).toHaveLength(1);await f.approve(review,key);expect(f.port.create).toHaveBeenCalledTimes(1);
 f.setVerified();await f.age();await f.setup.tick(f.a.workspaceId);
 expect((await f.setup.status(f.a,f.brand)).setup!.state).toBe('verified');expect(f.register).toHaveBeenCalledTimes(1);
 const routes=await db.read(f.a.workspaceId,sql=>sql.query('SELECT flockletter_customer_jobs.resend_routes($1) route',[f.a.workspaceId]));
 expect(routes.rows[0]!.route).toMatchObject({workspaceId:f.a.workspaceId,brandId:f.brand,domainId:f.id,from:'news@'+f.domain});
 await db.verifyBoundary();
});
it('unknown creation cannot be retried, changed or replaced by a second POST',async()=>{
 const f=await factory();f.port.create.mockRejectedValueOnce(new Error('response lost'));
 const review=await f.review();expect((await f.approve(review)).setup).toMatchObject({state:'uncertain'});
 await f.setup.execute('senderSetup.process',{operationKey:randomUUID(),brandId:f.brand,setupId:review.setup!.id},f.a);
 await expect(f.review()).rejects.toMatchObject({code:'sender_setup_uncertain'});
 expect(f.port.create).toHaveBeenCalledTimes(1);
});
it('requires current DNS ownership and does not purchase capacity',async()=>{
 const f=await factory();const review=await f.review();await db.brand(f.a.workspaceId,f.brand,sql=>sql.query('UPDATE sender_domains SET verified_at=NULL'));
 await expect(f.approve(review)).rejects.toMatchObject({code:'sender_ownership_required'});expect(f.port.create).not.toHaveBeenCalled();
 const other=await factory();other.port.usage.mockResolvedValueOnce({available:false});expect((await other.approve(await other.review())).setup).toMatchObject({state:'held',reason:'provider_domain_capacity'});expect(other.port.create).not.toHaveBeenCalled();
});
it('prevents two workspaces from claiming the same domain, including concurrent approval',async()=>{
 const domain='shared-'+randomUUID()+'.example.com',a=await factory(domain),b=await factory(domain),[ra,rb]=await Promise.all([a.review(),b.review()]);
 const result=await Promise.allSettled([a.approve(ra),b.approve(rb)]);expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(a.port.create.mock.calls.length+b.port.create.mock.calls.length).toBe(1);
});
it('does not let existing delivery configuration grants acquire provisioning access',async()=>{
 const f=await factory(),connection={...f.a,kind:'connection' as const,actorId:'connection:'+randomUUID(),scopes:['read','delivery:configure'] as Actor['scopes'],brandIds:[f.brand]};
 expect(()=>authorize(connection,'senderSetup.review')).toThrow(/sender:configure/);
 expect(()=>authorize({...connection,scopes:['sender:configure']},'senderSetup.review')).toThrow(/read/);
 await expect(f.setup.execute('senderSetup.status',{brandId:f.brand},{...f.a,brandIds:[]})).rejects.toMatchObject({status:404});
});
it('revoked ownership and changed sender profiles stop queued provisioning',async()=>{
 const f=await factory(),r=await f.review();f.revoke();await expect(f.approve(r)).rejects.toMatchObject({code:'owner_required'});expect(f.port.create).not.toHaveBeenCalled();
 const g=await factory(),v=await g.review();await db.brand(g.a.workspaceId,g.brand,sql=>sql.query("UPDATE customer_sender_profiles SET profile=jsonb_set(profile,'{revision}','2')"));
 await expect(g.approve(v)).rejects.toMatchObject({code:'sender_setup_changed'});expect(g.port.create).not.toHaveBeenCalled();
});
it('captured staging setup needs no provider credential and is identified as an exercise',async()=>{
 const f=await factory(),captured=new ResendSenderSetup(db,{enabled:true,captured:true,port:capturedSenderSetupPort(),webhookId:randomUUID(),isOwner:async()=>true,eligible:async()=>({eligible:true})});
 const r=await captured.execute('senderSetup.review',{operationKey:randomUUID(),brandId:f.brand,senderRevision:1},f.a) as SenderSetupView;
 const p=await captured.execute('senderSetup.approve',{operationKey:randomUUID(),brandId:f.brand,senderRevision:1,setupId:r.setup!.id},f.a) as SenderSetupView;
 expect(p).toMatchObject({captured:true,setup:{state:'awaiting_dns'}});expect(p.setup!.dns[0]!.name).toContain('.invalid');await f.age();await captured.tick(f.a.workspaceId);expect((await captured.status(f.a,f.brand)).setup?.state).toBe('verified');
});

it('rejects a non-public sender domain before any provider creation',async()=>{
 const f=await factory('trail.example.test');await expect(f.review()).rejects.toThrow('public domain name');expect(f.port.create).not.toHaveBeenCalled();
});
