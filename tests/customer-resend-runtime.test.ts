import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {customerResendRuntime,resendEvents} from '../src/server/customer-delivery/resend.js';
import {customerSettings} from '../src/server/customer-settings.js';
import type {Config} from '../src/server/config.js';
const origin='https://flockletter.example.com';
const route={workspaceId:'org_example',brandId:randomUUID(),domainId:randomUUID(),webhookId:randomUUID(),from:'news@brand.example.com',region:'us-east-1'};
const secret='whsec_'+Buffer.alloc(32,5).toString('base64');
const env={APP_ENV:'production',FLOCKLETTER_CUSTOMER_DELIVERY:'resend',FLOCKLETTER_CUSTOMER_DELIVERY_SCOPE:'tests',FLOCKLETTER_TEST_MAILING_APPROVED:'true',FLOCKLETTER_CUSTOMER_RESEND_KEY:'synthetic-sending-only',FLOCKLETTER_CUSTOMER_RESEND_RETRIEVE_KEY:'synthetic-retrieval-only',FLOCKLETTER_CUSTOMER_RESEND_WEBHOOK_SECRET:secret,FLOCKLETTER_CUSTOMER_RESEND_BINDINGS:JSON.stringify([route])};
function mock(domainChanges={},webhookChanges={}){
 return vi.fn<typeof fetch>(async(url,init)=>{
  expect(init?.method).toBeUndefined();expect(init?.redirect).toBe('error');expect(init?.headers).toMatchObject({authorization:'Bearer synthetic-retrieval-only'});
  return new Response(JSON.stringify(String(url).includes('/domains/')?{id:route.domainId,name:'brand.example.com',status:'verified',region:'us-east-1',open_tracking:false,click_tracking:false,capabilities:{sending:'enabled'},...domainChanges}:
   {id:route.webhookId,status:'enabled',endpoint:origin+'/api/v1/customer-delivery/resend-events',events:[...resendEvents],signing_secret:secret,...webhookChanges}));
 });
}
it('inspects only the exact domain and signed feedback route, caches bounded observations without sending',async()=>{
 const read=mock(),runtime=customerResendRuntime(origin,env,read)!;
 const provider=runtime.provider(route.workspaceId,route.brandId)!;expect(await provider.ready!()).toBe(true);expect(await provider.ready!()).toBe(true);
 expect(read).toHaveBeenCalledTimes(2);expect(read.mock.calls.map(c=>String(c[0])).sort()).toEqual(['https://api.resend.com/domains/'+route.domainId,'https://api.resend.com/webhooks/'+route.webhookId].sort());
 expect(runtime.provider('org_foreign',route.brandId)).toBeUndefined();
});
it.each([{open_tracking:true},{click_tracking:true},{status:'pending'},{region:'eu-west-1'},{capabilities:{sending:'disabled'}},{name:'neighbor.example.com'},{id:randomUUID()}])('fails readiness for unverified or changed domain %j',async change=>{
 const runtime=customerResendRuntime(origin,env,mock(change))!;expect(await runtime.entries[0]!.provider.ready!()).toBe(false);
});
it.each([{events:['email.sent']},{status:'disabled'},{endpoint:'https://foreign.example.com/events'},{signing_secret:'different'},{id:randomUUID()}])('fails readiness for mismatched feedback %j',async change=>{
 const runtime=customerResendRuntime(origin,env,mock({},change))!;expect(await runtime.entries[0]!.provider.ready!()).toBe(false);
});
it('requires explicit production test or broadcast activation independently of transport',()=>{
 for(const changes of [{APP_ENV:'staging'},{FLOCKLETTER_TEST_MAILING_APPROVED:'false',FLOCKLETTER_LIVE_MAILING_APPROVED:'true'},{FLOCKLETTER_CUSTOMER_DELIVERY_SCOPE:'all'}])expect(()=>customerResendRuntime(origin,{...env,...changes})).toThrow();
 const config:Config={environment:'production',origin,browserOrigins:[origin],host:'127.0.0.1',port:4310,localIdentity:false,databasePoolMax:2};expect(customerSettings(config,env)).toMatchObject({delivery:'resend',deliveryScope:'tests',billing:'off'});
});
it('requires complete distinct credentials and refuses cross-workspace domain reuse before network',()=>{
 for(const changes of [{FLOCKLETTER_CUSTOMER_RESEND_KEY:''},{FLOCKLETTER_CUSTOMER_RESEND_RETRIEVE_KEY:'synthetic-sending-only'},{FLOCKLETTER_CUSTOMER_RESEND_WEBHOOK_SECRET:''},{FLOCKLETTER_CUSTOMER_RESEND_BINDINGS:'[]'}])expect(()=>customerResendRuntime(origin,{...env,...changes})).toThrow();
 expect(()=>customerResendRuntime(origin,{...env,FLOCKLETTER_CUSTOMER_RESEND_BINDINGS:JSON.stringify([route,{...route,workspaceId:'org_foreign',brandId:randomUUID()}])})).toThrow('workspace-owned');
 expect(()=>customerResendRuntime(origin,{...env,FLOCKLETTER_CUSTOMER_RESEND_BINDINGS:JSON.stringify([{...route,apiUrl:'https://evil.example'}])})).toThrow();
});
it('can coexist with SES and preserves read-only reconciliation configuration when delivery is off',async()=>{
 expect(customerResendRuntime(origin,{...env,FLOCKLETTER_CUSTOMER_DELIVERY:'ses'},mock())?.entries).toHaveLength(1);
 const read=mock(),runtime=customerResendRuntime(origin,{...env,FLOCKLETTER_CUSTOMER_DELIVERY:'off',FLOCKLETTER_TEST_MAILING_APPROVED:'false'},read)!;
 expect(runtime.entries).toHaveLength(1);expect(await runtime.entries[0]!.provider.ready!()).toBe(false);expect(read).not.toHaveBeenCalled();
 expect(customerResendRuntime(origin,{FLOCKLETTER_CUSTOMER_DELIVERY:'off'})).toBeUndefined();
});
