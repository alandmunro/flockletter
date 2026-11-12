import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {startDatabase} from './database-fixture.js';
import {rejectOptionalCookies} from './browser-cookie-choice.js';
import {Database} from '../src/server/db.js';
import {loadConfig} from '../src/server/config.js';
import {Authenticator,localIdentity} from '../src/server/auth.js';
import {CustomerWorkflows} from '../src/server/customer-runtime.js';
import {CommandService,type Actor} from '../src/server/service.js';
import type {CustomerProvider} from '../src/server/customer-delivery/types.js';
import {createApp} from '../src/server/app.js';
// Disposable local staging rehearsal: real DB, auth and canonical HTTP commands;
// only provider-readiness ports are substituted. No real credential, recipient or POST to an ESP.
const fixture=await startDatabase(),db=new Database(fixture.url),server=createServer();
const browser=await chromium.launch({channel:process.env.FLOCKLETTER_BROWSER_CHANNEL??'chrome'});
let customer:CustomerWorkflows|undefined;
const proof=process.env.FLOCKLETTER_PROVIDER_PROOF??'/private/tmp/flockletter-provider-choice-proof';
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
 const env={APP_ENV:'test',APP_ORIGIN:origin,DATABASE_URL:fixture.url,LOCAL_TEST_IDENTITY:'true',FLOCKLETTER_CUSTOMER_DELIVERY:'capture',FLOCKLETTER_CUSTOMER_DELIVERY_SCOPE:'tests'};
 const config=loadConfig(env),identity=localIdentity();customer=new CustomerWorkflows(db,config,identity,env);
 // Substituted transport option exercises selection, not real provider activation.
 customer.delivery.options.mode='ses';
 const ports:Record<string,CustomerProvider>=Object.fromEntries(['ses','resend'].map((mode,index)=>[mode,{fingerprint:String(index+1).repeat(64),from:'news@shop.example.com',ready:async()=>index===1,
  submit:async()=>{throw Error('No submission is authorized in this browser proof.');},lookup:async()=>({outcome:'unknown' as const})}]));
 customer.delivery.options.provider=(_w,_b,m='ses')=>ports[m];
 const service=new CommandService(db,undefined,identity.isOwner,undefined,undefined,identity.team,undefined,undefined,undefined,'test',undefined,customer);
 const actor:Actor={workspaceId:'org_local_sample',userId:'local_owner',actorId:'user:local_owner',kind:'session',owner:true,scopes:['read'],brandIds:null};
 await service.execute('workspace.initialize',{operationKey:randomUUID(),name:'Synthetic provider-choice proof',brandName:'Trail'},actor);
 const brand=(await db.tenant(actor.workspaceId,sql=>sql.query<{id:string}>('SELECT id FROM brands'))).rows[0]!.id;
 server.on('request',createApp(config,service,new Authenticator(db,identity,customer.billing.options)));await mkdir(proof,{recursive:true});
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors:string[]=[],keys:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  await page.goto(origin);await rejectOptionalCookies(page);await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Delivery',exact:true}).click();
  const panel=page.getByRole('region',{name:'Sending service',exact:true});
  const picker=panel.getByRole('combobox',{name:'Sending service',exact:true});await picker.waitFor();
  const before=await customer.delivery.execute('delivery.providers',{brandId:brand},actor) as {revision:number;selected:'ses'|'resend'};
  const next=before.selected==='ses'?'resend':'ses';await picker.selectOption(next);
  await page.route('**/api/v1/commands/delivery.selectProvider',async route=>{keys.push(route.request().postDataJSON().operationKey);await route.fetch();await route.abort('failed');},{times:1});
  await panel.getByRole('button',{name:'Save sending service',exact:true}).click();await panel.getByRole('alert').filter({hasText:/fetch|failed|request|service/i}).first().waitFor();
  page.on('request',request=>{if(request.url().endsWith('/delivery.selectProvider'))keys.push(request.postDataJSON().operationKey);});
  await panel.getByRole('button',{name:'Save sending service',exact:true}).click();await panel.getByRole('status').filter({hasText:'Sending service saved.'}).waitFor();
  assert.equal(keys.length,2);assert.equal(keys[0],keys[1],'Lost acknowledgment retries the same durable operation.');
  const after=await customer.delivery.execute('delivery.providers',{brandId:brand},actor) as {revision:number;selected:string};assert.equal(after.revision,before.revision+1);assert.equal(after.selected,next);
  assert.equal(await page.getByRole('button',{name:'Review saved campaign',exact:true}).isDisabled(),true,'Test-only scope still refuses broadcasts.');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Provider controls fit the viewport.');assert.deepEqual(errors,[]);
  await page.screenshot({path:proof+'/choice-'+width+'.png',fullPage:true});
  await page.reload();await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Delivery',exact:true}).click();await page.getByRole('combobox',{name:'Sending service',exact:true}).waitFor();assert.equal(await page.getByRole('combobox',{name:'Sending service',exact:true}).inputValue(),next);
  await page.close();
 }
 assert.equal((await db.tenant(actor.workspaceId,sql=>sql.query('SELECT FROM customer_deliveries'))).rowCount,0);
 console.info('Desktop/390px provider choice, same-key lost-ack retry, refresh persistence, no broadcast review or send, and no browser errors passed. Isolated synthetic provider ports only. Proof: '+proof);
}finally{await browser.close();await customer?.close();await db.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await fixture.stop();}
