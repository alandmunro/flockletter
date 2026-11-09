import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { Authenticator, localIdentity } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { CustomerWorkflows } from '../src/server/customer-runtime.js';
import { platformRuntime } from '../src/server/platform/runtime.js';
import type { PlatformService } from '../src/server/platform/service.js';
import type { OperatorSession } from '../src/server/platform/auth.js';
import type { PlatformCase } from '../src/shared/platform.js';
import type { SupportPolicyReview } from '../src/shared/customer-support.js';

let fixture:Awaited<ReturnType<typeof startDatabase>>,db:Database,platform:PlatformService;
const owner:Actor={workspaceId:'org_local_sample',userId:'local_owner',actorId:'user:local_owner',owner:true,kind:'session',brandIds:null,scopes:['read']};
const session:OperatorSession={userId:owner.userId,sessionId:owner.actorId,verifiedAt:new Date().toISOString(),workspaceId:owner.workspaceId,exercise:true};
let now=new Date();
beforeAll(async()=>{
  fixture=await startDatabase();db=new Database(fixture.url);
  const identity=localIdentity(),config=loadConfig({APP_ENV:'test',APP_ORIGIN:'http://127.0.0.1:4310',LOCAL_TEST_IDENTITY:'true',DATABASE_URL:fixture.url});
  const service=new CommandService(db,undefined,identity.isOwner);
  await service.execute('workspace.initialize',{operationKey:randomUUID(),name:'Policy workspace',brandName:'Trail'},owner);
  const customer=new CustomerWorkflows(db,config,identity,{FLOCKLETTER_CUSTOMER_SUPPORT:'capture'});
  platform=(await platformRuntime(config,db,new Authenticator(db,identity),customer,{FLOCKLETTER_PLATFORM_MODE:'capture'}))!;
  platform.options.now=()=>now;
});
afterAll(async()=>{await platform?.close();await db?.close();await fixture?.stop();});
async function open(){return platform.execute('platform.openCase',{operationKey:randomUUID(),workspaceId:owner.workspaceId,kind:'support',resourceId:null,reason:'Review this exact public-guidance automation policy.'},session) as Promise<PlatformCase>;}
const support=(review:PlatformCase,command:string,input:Record<string,unknown>)=>platform.execute('platform.support',{caseId:review.id,command,input},session);
const previewInput=(expectedVersion:number)=>({operationKey:randomUUID(),expectedVersion,enabled:true,mode:'capture',topics:['plans'],validForDays:1,useWriter:false});

it('requires the exact policy preview in the same audited case and replays one immutable approval',async()=>{
  const a=await open(),b=await open(),input=previewInput(0);
  const preview=await support(a,'support.policyPreview',input) as SupportPolicyReview;
  expect(preview).toMatchObject({parentVersion:0,enabled:true,mode:'capture'});
  expect(await support(a,'support.policyPreview',input)).toEqual(preview);
  const approval={operationKey:randomUUID(),previewId:preview.id,reviewCode:preview.reviewCode};
  await expect(support(b,'support.publishPolicy',approval)).rejects.toMatchObject({code:'policy_review_case_mismatch'});
  await expect(support(a,'support.publishPolicy',{...approval,operationKey:randomUUID(),reviewCode:'c'.repeat(64)})).rejects.toMatchObject({code:'policy_review_case_mismatch'});
  const published=await support(a,'support.publishPolicy',approval);
  expect(published).toMatchObject({version:1,enabled:true});
  expect(await support(a,'support.publishPolicy',approval)).toEqual(published);
  expect(await db.tenant(owner.workspaceId,async sql=>Number((await sql.query('SELECT count(*) FROM customer_support_policies')).rows[0].count))).toBe(1);
  await expect(support(a,'support.publishPolicy',{...approval,reviewCode:'d'.repeat(64)})).rejects.toMatchObject({code:'operation_conflict'});
  await expect(support(a,'support.policyPreview',{...input,enabled:false})).rejects.toMatchObject({code:'operation_conflict'});
  await expect(support(a,'support.publishPolicy',{...approval,operationKey:input.operationKey})).rejects.toMatchObject({code:'operation_conflict'});
});

it('keeps writer previews public-only and does not regenerate them on an exact action replay',async()=>{
  const review=await open(),writer=vi.fn(async(facts:string)=>'Reviewed guidance: '+facts);
  platform.options.support.options.writer=writer;
  const input={...previewInput(1),useWriter:true};
  const preview=await support(review,'support.policyPreview',input) as SupportPolicyReview;
  expect(preview.responses.plans).toContain('AI assistance');
  expect(writer).toHaveBeenCalledOnce();expect(writer.mock.calls[0]![0]).toContain('Starter');
  expect(writer.mock.calls[0]![0]).not.toContain(owner.workspaceId);
  expect(await support(review,'support.policyPreview',input)).toEqual(preview);expect(writer).toHaveBeenCalledOnce();
  const publish={operationKey:randomUUID(),previewId:preview.id,reviewCode:preview.reviewCode};
  const before=now;now=new Date(now.getTime()+5*60000+1);
  await expect(support(review,'support.publishPolicy',publish)).rejects.toMatchObject({code:'operator_case_required'});
  now=before;
  expect(await support(review,'support.publishPolicy',publish)).toMatchObject({version:2});
  platform.options.support.options.writer=undefined;
});

it('publishes an exactly reviewed disabled policy and rejects a stale current-version assumption',async()=>{
  const review=await open(),input={...previewInput(2),enabled:false};
  const preview=await support(review,'support.policyPreview',input) as SupportPolicyReview;
  expect(await support(review,'support.publishPolicy',{operationKey:randomUUID(),previewId:preview.id,reviewCode:preview.reviewCode})).toMatchObject({version:3,enabled:false});
  await expect(support(review,'support.policyPreview',previewInput(2))).rejects.toMatchObject({code:'version_conflict'});
  const history=await support(review,'support.policyHistory',{}) as {policies:{version:number;enabled:boolean}[]};
  expect(history.policies[0]).toMatchObject({version:3,enabled:false});
});

it('fails alert credential configuration before opening live operator resources',async()=>{
  const identity=localIdentity(),config=loadConfig({APP_ENV:'test',APP_ORIGIN:'http://127.0.0.1:4310',DATABASE_URL:fixture.url});
  const customer=new CustomerWorkflows(db,config,identity,{}),auth=new Authenticator(db,identity);
  const env={FLOCKLETTER_PLATFORM_MODE:'live',FLOCKLETTER_PLATFORM_ALERTS_ENABLED:'approved',
    FLOCKLETTER_PLATFORM_ALERT_RESEND_KEY:'send-fixture',FLOCKLETTER_PLATFORM_ALERT_RESEND_RETRIEVE_KEY:' \t ',
    FLOCKLETTER_PLATFORM_ALERT_FROM:'ops@example.test',FLOCKLETTER_PLATFORM_ALERT_TO:'owner@example.test'};
  try {
    // No operator database or organization is supplied: malformed transport must fail first.
    await expect(platformRuntime(config,db,auth,customer,env)).rejects.toThrow('separate sending/retrieval');
    await expect(platformRuntime(config,db,auth,customer,{...env,FLOCKLETTER_PLATFORM_ALERTS_ENABLED:'enabled'}))
      .rejects.toThrow();
  }finally{await customer.close();}
});
