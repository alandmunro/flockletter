import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright-core';
import {startDatabase} from './database-fixture.js';
import {rejectOptionalCookies} from './browser-cookie-choice.js';
import {Database} from '../src/server/db.js';
import {loadConfig} from '../src/server/config.js';
import {Authenticator,localIdentity} from '../src/server/auth.js';
import {CustomerWorkflows} from '../src/server/customer-runtime.js';
import {CommandService,type Actor} from '../src/server/service.js';
import type {CustomerBillingStatus} from '../src/shared/customer-billing.js';
import {createApp} from '../src/server/app.js';

// Real isolated HTTP/database onboarding. Hosted billing status/checkout are
// substituted only for presentation/retry checks; no Clerk or Stripe account is used.
const browser=await chromium.launch({channel:process.env.FLOCKLETTER_BROWSER_CHANNEL??'chrome'});
const screenshots=process.env.FLOCKLETTER_SIGNUP_PROOF??path.join(tmpdir(),'flockletter-subscription-signup-proof');
await mkdir(screenshots,{recursive:true});
try{
 for(const width of [1280,390]){
  const fixture=await startDatabase(),db=new Database(fixture.url),server=createServer();
  let customer:CustomerWorkflows|undefined;
  const page=await browser.newPage({viewport:{width,height:900}}),errors:string[]=[],external:string[]=[],writes:{name:string;input:Record<string,unknown>}[]=[];
  page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  try{
   server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
   const env={APP_ENV:'test',APP_ORIGIN:origin,DATABASE_URL:fixture.url,LOCAL_TEST_IDENTITY:'true',FLOCKLETTER_CUSTOMER_BILLING:'exercise',FLOCKLETTER_CUSTOMER_DELIVERY:'capture'};
   const config=loadConfig(env),identity=localIdentity();customer=new CustomerWorkflows(db,config,identity,env);
   const service=new CommandService(db,undefined,identity.isOwner,undefined,undefined,identity.team,undefined,undefined,undefined,'test',undefined,customer);
   const actor:Actor={workspaceId:'org_local_sample',userId:'local_owner',actorId:'user:local_owner',kind:'session',owner:true,scopes:['read'],brandIds:null};
   server.on('request',createApp(config,service,new Authenticator(db,identity,customer.billing.options)));
   page.on('request',r=>{if(!r.url().startsWith(origin+'/'))external.push(r.url());const name=new URL(r.url()).pathname.split('/api/v1/commands/')[1];if(name?.startsWith('customerBilling.')&&name!=='customerBilling.status')writes.push({name,input:r.postDataJSON() as Record<string,unknown>});});
   await page.goto(origin+'/pricing');await rejectOptionalCookies(page);
   assert.equal(await page.getByRole('link',{name:'Choose Pro',exact:true}).count(),0);await page.getByText('Pro enrollment is paused',{exact:false}).waitFor();
   await page.getByRole('link',{name:'Choose Growth',exact:true}).click();assert.equal(new URL(page.url()).searchParams.get('plan'),'growth');
   await page.getByLabel('Workspace name',{exact:true}).fill('Synthetic signup proof');await page.getByLabel('Sending brand',{exact:true}).fill('Trail Notes');
   await page.getByRole('button',{name:'Create workspace',exact:true}).click();
   const panel=page.getByRole('region',{name:'Subscription and usage',exact:true});
   const picker=panel.getByRole('combobox',{name:/^Plan/});await picker.waitFor();assert.equal(await picker.inputValue(),'growth');
   assert.equal(new URL(page.url()).pathname,'/subscription');assert.equal(new URL(page.url()).searchParams.get('plan'),'growth');assert.equal(writes.length,0);
   await page.reload();await picker.waitFor();assert.equal(await picker.inputValue(),'growth');
   await picker.selectOption('starter');assert.equal(new URL(page.url()).searchParams.get('plan'),'starter');await page.reload();await picker.waitFor();assert.equal(await picker.inputValue(),'starter');
   const counts=(await db.tenant(actor.workspaceId,sql=>sql.query('SELECT (SELECT count(*)::int FROM customer_subscriptions) subscriptions,(SELECT count(*)::int FROM customer_trial_setups) setups'))).rows[0];assert.deepEqual(counts,{subscriptions:0,setups:0});
   await page.screenshot({path:path.join(screenshots,'signup-'+width+'.png'),fullPage:true});
   const baseline=await service.execute('customerBilling.status',{},actor) as CustomerBillingStatus;
   const setupId=randomUUID();let shown:CustomerBillingStatus={...baseline,mode:'stripe',source:'preparation',trialProtectionReady:true,trialSetup:{id:setupId,state:'pending',plan:'growth',revision:1,review:null}};
   await page.route('**/api/v1/commands/customerBilling.status',route=>route.fulfill({json:{result:shown}}));
   await page.route('**/api/v1/commands/customerBilling.checkout',route=>route.fulfill({json:{result:{state:'card_setup_complete'}}}));
   await page.goto(origin+'/subscription?plan=pro');await picker.waitFor();assert.equal(await picker.inputValue(),'growth');assert.equal(await picker.isDisabled(),true);
   await panel.getByRole('button',{name:'Verify card with Stripe',exact:true}).click();await panel.getByRole('status').filter({hasText:'Your card-only setup is complete.'}).waitFor();assert.equal(writes.length,1);assert.equal(writes[0]!.input.plan,'growth');
   await page.goto(origin+'/?billing=card-returned&plan=pro');await picker.waitFor();assert.equal(await picker.inputValue(),'growth');assert.equal(writes.length,1,'A provider-return URL creates no billing action.');
   await panel.getByRole('button',{name:'Review trial terms after card setup',exact:true}).waitFor();
   const now=Date.now();shown={...shown,taxMode:'off',trialSetup:{...shown.trialSetup!,state:'reviewed',revision:2,review:{version:1,taxMode:'off',setupId,revision:2,plan:'growth',priceMinor:2500,currency:'USD',trialDays:14,firstChargeAt:new Date(now+14*86400000).toISOString(),expiresAt:new Date(now+300000).toISOString(),hash:'1'.repeat(64)}}};
   await panel.getByRole('button',{name:'Refresh',exact:true}).click();const accept=panel.getByRole('checkbox',{name:/I represent a US business and accept/});await accept.waitFor();await panel.getByText('No tax is collected on this subscription.',{exact:false}).waitFor();const activate=panel.getByRole('button',{name:'Accept and start 14-day trial',exact:true});assert.equal(await activate.isDisabled(),true);await accept.check();assert.equal(await activate.isEnabled(),true);
   shown={...shown,taxMode:'stripe-automatic',trialSetup:{...shown.trialSetup!,revision:3,review:{...shown.trialSetup!.review!,taxMode:'stripe-automatic',revision:3,hash:'2'.repeat(64)}}};await panel.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>!Array.from(document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).some(input=>input.checked));assert.equal(await activate.isDisabled(),true,'A replacement review clears acceptance.');
   await page.screenshot({path:path.join(screenshots,'saved-card-review-'+width+'.png'),fullPage:true});
   shown={...baseline,mode:'stripe',source:'stripe',state:'active',plan:'growth',eligible:true,reasons:[]};await panel.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>Array.from(document.querySelectorAll('select')).some(select=>select.value==='growth'&&!select.disabled));assert.equal(await picker.inputValue(),'growth','The saved setup plan survives verified activation in the same session.');await page.goto(origin+'/subscription');await picker.waitFor();await page.waitForFunction(()=>document.querySelector<HTMLSelectElement>('select')?.value==='growth');assert.equal(await picker.inputValue(),'growth','Existing service initializes to its recorded plan.');
   await panel.getByRole('button',{name:'Continue to sender setup',exact:true}).click();
   await page.getByRole('heading',{name:'Sender identity and footer',exact:true}).waitFor();
   await page.getByRole('heading',{name:'Sending domain for Trail Notes',exact:true}).waitFor();
   await page.getByRole('button',{name:'Subscription',exact:true}).click();
   shown={...baseline,mode:'stripe',source:'preparation',taxMode:'off',trialProtectionReady:true};
   await page.route('**/api/v1/commands/customerBilling.paidCheckout',route=>route.fulfill({json:{result:{state:'awaiting_reconciliation'}}}));
   await page.goto(origin+'/subscription?plan=starter');await picker.waitFor();
   const paidChoice=panel.getByRole('checkbox',{name:/I choose Starter at/}),paidButton=panel.getByRole('button',{name:'Continue with normal paid plan',exact:true});
   await paidChoice.waitFor();assert.match(await paidChoice.locator('..').innerText(),/with no tax collected/);await page.screenshot({path:path.join(screenshots,'no-tax-paid-'+width+'.png'),fullPage:true});await paidChoice.check();await paidButton.click();
   await panel.getByText('The provider outcome is still being checked.',{exact:false}).waitFor();
   const paidWrites=writes.filter(write=>write.name==='customerBilling.paidCheckout');assert.equal(paidWrites.length,1);assert.equal(paidWrites[0]!.input.taxMode,'off');assert.equal(paidWrites[0]!.input.accepted,true);
   shown={...shown,taxMode:'stripe-automatic'};await panel.getByRole('button',{name:'Refresh',exact:true}).click();
   await page.waitForFunction(()=>!Array.from(document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).some(input=>input.checked));assert.equal(await paidButton.isDisabled(),true,'Changed collection terms clear paid acceptance.');
   shown={...shown,source:'complimentary'};await page.reload();await panel.getByText('Complimentary service is assigned by the operator.',{exact:false}).waitFor();assert.equal(await panel.getByRole('button',{name:'Verify card with Stripe',exact:true}).count(),0);assert.equal(await panel.getByRole('combobox',{name:/^Plan/}).count(),0);
   shown={...baseline,mode:'off',source:'preparation'};await page.goto(origin+'/subscription?plan=pro');await panel.getByText('Billing activation is not enabled.',{exact:false}).waitFor();assert.equal(await panel.getByRole('button',{name:'Verify card with Stripe',exact:true}).count(),0);
   assert.equal(writes.filter(w=>w.name==='customerBilling.activateTrial').length,0);assert.equal(writes.filter(w=>w.name==='customerBilling.paidCheckout').length,1);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }catch(error){await page.screenshot({path:path.join(screenshots,'failure-'+width+'.png'),fullPage:true});console.error('Synthetic signup state:',await page.locator('body').innerText(),errors);throw error;}finally{await page.close();await customer?.close();await db.close();if(server.listening)await new Promise<void>(r=>server.close(()=>r()));await fixture.stop();}
 }
 console.info('Desktop/390px pricing-to-workspace signup, plan persistence, bound-card resume, explicit renewed review, explicit off-mode tax acceptance/reset, complimentary/off guards and zero external requests passed. Clerk/Stripe ports were substituted, not live sign-in or payment evidence. Proof: '+screenshots);
}finally{await browser.close();}
