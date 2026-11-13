import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startDatabase} from './database-fixture.js';
import {studioFixtureImage} from './studio-fixture-image.js';
import {rejectOptionalCookies} from './browser-cookie-choice.js';
import {Database} from '../src/server/db.js';
import {loadConfig} from '../src/server/config.js';
import {Authenticator,localIdentity} from '../src/server/auth.js';
import {CustomerWorkflows} from '../src/server/customer-runtime.js';
import {CommandService,type Actor} from '../src/server/service.js';
import {emptyContent,type Campaign} from '../src/shared/contracts.js';
import type {AudienceSettingsView} from '../src/shared/customer-audience.js';
import type {DeliveryView} from '../src/shared/customer-delivery.js';
import type {CustomerBillingStatus} from '../src/shared/customer-billing.js';
import type {TestDeliveryReview} from '../src/shared/customer-test-send.js';
import type {CustomerCampaignPreflight} from '../src/shared/customer-preflight.js';
import {createApp} from '../src/server/app.js';

// Entirely disposable, local and captured. No provider key or real recipient is used.
const scratch=await mkdtemp(path.join(tmpdir(),'flockletter-test-send-'));
const fixture=await startDatabase(),db=new Database(fixture.url),server=createServer();
const browser=await chromium.launch({channel:process.env.FLOCKLETTER_BROWSER_CHANNEL??'chrome'});
let customer:CustomerWorkflows|undefined;
const images=process.env.FLOCKLETTER_TEST_SEND_SCREENSHOTS??path.join(scratch,'screenshots');
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
  const env={APP_ENV:'test',APP_ORIGIN:origin,DATABASE_URL:fixture.url,LOCAL_TEST_IDENTITY:'true',FLOCKLETTER_CUSTOMER_BILLING:'exercise',FLOCKLETTER_CUSTOMER_DELIVERY:'capture',FLOCKLETTER_CUSTOMER_DELIVERY_SCOPE:'tests',FLOCKLETTER_CUSTOMER_AUDIENCE:'exercise'};
  const config=loadConfig(env),identity=localIdentity();customer=new CustomerWorkflows(db,config,identity,env);
  customer.delivery.options.render=async()=>{};
  const service=new CommandService(db,undefined,identity.isOwner,undefined,undefined,identity.team,undefined,undefined,undefined,'test',undefined,customer);
  const actor:Actor={workspaceId:'org_local_sample',userId:'local_owner',actorId:'user:local_owner',kind:'session',owner:true,scopes:['read'],brandIds:null};
  await service.execute('workspace.initialize',{operationKey:randomUUID(),name:'One-recipient test proof',brandName:'Trail'},actor);
  const brand=(await db.tenant(actor.workspaceId,sql=>sql.query<{id:string}>('SELECT id FROM brands'))).rows[0]!.id;
  await service.execute('customerBilling.startTrial',{operationKey:randomUUID(),plan:'starter',simulatedCardConfirmed:true},actor);
  await service.execute('delivery.saveSender',{operationKey:randomUUID(),brandId:brand,fromName:'Trail',fromEmail:'news@trail.example.com',replyTo:'hello@trail.example.com',organization:'Synthetic Trail Shop',postalAddress:'123 Synthetic Lane, Denver CO 80202'},actor);
  await service.execute('audienceOnboarding.configure',{operationKey:randomUUID(),brandId:brand,enabled:true,purpose:'trail_news',policyVersion:'v1',consentText:'I agree to receive Trail news and can unsubscribe from every message.',sourceDomain:'trail.example.com'},actor);
  for(const email of ['reader@trail.example.com','another@trail.example.com','pending@trail.example.com']){
    await service.execute('audienceOnboarding.signup',{operationKey:randomUUID(),brandId:brand,email,consentAffirmed:true,policyVersion:'v1'},actor);
    if(email!=='pending@trail.example.com'){
      const status=await service.execute('audienceOnboarding.status',{brandId:brand},actor) as AudienceSettingsView;
      const confirmation=status.messages.find(message=>message.email===email)!;
      await service.execute('audienceOnboarding.exerciseConfirm',{operationKey:randomUUID(),brandId:brand,id:confirmation.id},actor);
    }
  }
  const subscriber=(await db.brand(actor.workspaceId,brand,sql=>sql.query<{id:string}>("SELECT id FROM subscribers WHERE email_normalized='reader@trail.example.com'"))).rows[0]!.id;
  const photo=await studioFixtureImage('#8b4764'),digest=createHash('sha256').update(photo).digest('hex');
  const upload=await service.execute('asset.uploadBatch',{operationKey:randomUUID(),brandId:brand,files:[{itemKey:randomUUID(),name:'Original-fixture.png',base64:photo.toString('base64')}]},actor) as {results:{asset:{id:string}}[]};
  const draft=await service.execute('campaign.create',{operationKey:randomUUID(),brandId:brand,content:{...emptyContent(),title:'Test an existing confirmed contact',subject:'Trail notes',fromName:'Trail',replyTo:'hello@trail.example.com',heading:'A careful test',body:'Only the explicitly selected confirmed contact receives this test.',assetIds:[upload.results[0]!.asset.id]}},actor) as Campaign;
  const initialCheck=await service.execute('delivery.preflight',{brandId:brand,campaignId:draft.id,expectedVersion:draft.version,purpose:'test',subscriberId:subscriber},actor) as CustomerCampaignPreflight;
  assert.deepEqual(initialCheck.gaps,[],'Synthetic setup uses the same canonical test preflight.');
  server.on('request',createApp(config,service,new Authenticator(db,identity,customer.billing.options)));
  await mkdir(images,{recursive:true});
  for(const width of [1280,390]){
    const page=await browser.newPage({viewport:{width,height:900}}),errors:string[]=[],calls:{name:string;body:Record<string,unknown>}[]=[];
    page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{const name=new URL(request.url()).pathname.split('/api/v1/commands/')[1];if(name&&request.method()==='POST')calls.push({name,body:request.postDataJSON()});});
    await page.goto(origin);await rejectOptionalCookies(page);
    await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Delivery',exact:true}).click();
    await page.getByText('Only reviewed one-recipient tests are allowed.',{exact:false}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Review saved campaign',exact:true}).isDisabled(),true);
    assert.equal(await page.getByLabel('Audience',{exact:true}).isDisabled(),true);
    assert.equal(await page.getByLabel('Audience',{exact:true}).textContent().then(text=>text?.includes('Not used for one-recipient tests')),true);
    await page.getByText('Delivery details for support',{exact:true}).click();
    await page.getByText('Workspace ID',{exact:true}).waitFor();
    assert.equal(await page.getByText(actor.workspaceId,{exact:true}).count(),1);
    assert.equal(await page.getByText(draft.id,{exact:true}).count(),1);
    await page.getByText('Delivery details for support',{exact:true}).click();
    assert.equal(await page.getByLabel('Schedule in your local time, optional',{exact:true}).isDisabled(),true);
    const panel=page.getByRole('region',{name:'Test one confirmed contact',exact:true});
    const picker=panel.getByRole('combobox',{name:'Test recipient',exact:true});
    await panel.getByRole('option',{name:'reader@trail.example.com',exact:true}).waitFor({state:'attached'});
    assert.equal(await panel.getByRole('option',{name:'pending@trail.example.com',exact:true}).count(),0);
    assert.equal(await picker.inputValue(),'','A recipient must be explicitly selected.');
    await picker.selectOption(subscriber);
    const reviewResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/commands/delivery.reviewTest'&&response.request().method()==='POST');
    void reviewResponse.catch(()=>{});
    const readinessResponse=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/v1/commands/delivery.preflight');
    await panel.getByRole('button',{name:'Review one-recipient test',exact:true}).click();
    const readiness=await readinessResponse;assert.equal(readiness.status(),200,await readiness.text());
    assert.deepEqual((await readiness.json()).result.gaps,[],'Synthetic confirmed-recipient test should have no setup gaps.');
    const response=await reviewResponse;assert.equal(response.status(),200,await response.text());
    const saved=(await response.json()).result as TestDeliveryReview;
    assert.equal(saved.purpose,'test');assert.equal(saved.selected,1);assert.equal(saved.testSubscriberId,subscriber);
    const review=panel.getByRole('region',{name:'One-recipient test review',exact:true});await review.waitFor();
    assert.match(await review.innerText(),/reader@trail.example.com/);assert.match(await review.innerText(),/\[TEST\]/);
    assert.equal((await db.brand(actor.workspaceId,brand,sql=>sql.query('SELECT FROM customer_delivery_captures WHERE delivery_id=$1',[saved.id]))).rowCount,0,'Review alone never sends.');
    if(width===1280){
      await page.route('**/api/v1/commands/delivery.approveTest',async route=>{await route.fetch();await route.abort('failed');},{times:1});
      await review.getByRole('button',{name:'Approve one-recipient test',exact:true}).click();
      await panel.getByRole('button',{name:'Retry same test approval',exact:true}).waitFor();
      assert.equal(await picker.isDisabled(),true,'Unknown approval must not allow a replacement test.');
      await panel.getByRole('button',{name:'Retry same test approval',exact:true}).click();
      const approvals=calls.filter(call=>call.name==='delivery.approveTest');assert.equal(approvals.length,2);assert.deepEqual(approvals[0]!.body,approvals[1]!.body,'Lost acknowledgment retries preserve the exact approval intent.');
    }else await review.getByRole('button',{name:'Approve one-recipient test',exact:true}).click();
    await review.getByRole('button',{name:'Process or reconcile test',exact:true}).waitFor();
    await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).some(button=>button.textContent?.trim()==='Refresh test'&&button.disabled));
    if(width===1280){
      await service.execute('delivery.pause',{operationKey:randomUUID(),brandId:brand,id:saved.id},actor);
      await review.getByRole('button',{name:'Refresh test',exact:true}).click();
      await review.getByRole('button',{name:'Resume unchanged test',exact:true}).waitFor();
      const resumed=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/v1/commands/delivery.resume');
      await review.getByRole('button',{name:'Resume unchanged test',exact:true}).click();assert.equal((await resumed).status(),200);
      await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).some(button=>button.textContent?.trim()==='Refresh test'&&button.disabled));
    }
    for(let step=0;step<3;step++){
      const status=await service.execute('delivery.report',{brandId:brand,id:saved.id},actor) as DeliveryView;
      if(status.state==='completed')break;
      const processed=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/v1/commands/delivery.process');
      await review.getByRole('button',{name:'Process or reconcile test',exact:true}).click();await processed;
      await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).some(button=>button.textContent?.trim()==='Refresh test'&&button.disabled));
    }
    await review.getByRole('button',{name:'View captured test message',exact:true}).waitFor();
    await review.getByRole('button',{name:'View captured test message',exact:true}).click();
    const captured=panel.getByRole('heading',{name:'Captured test message',exact:true});await captured.waitFor();
    const frame=panel.frameLocator('iframe[title="Captured test email"]');
    await frame.getByRole('heading',{name:'A careful test',exact:true}).waitFor();
    assert(await frame.locator('img').first().evaluate(async(image:HTMLImageElement)=>{await image.decode();return image.naturalWidth>0&&image.src.startsWith('data:image/png;base64,');}),'The captured preview visibly renders its original inline photo.');
    if(width===390)await panel.getByRole('group',{name:'Preview width',exact:true}).getByRole('button',{name:'Mobile',exact:true}).click();
    const payload=(await db.brand(actor.workspaceId,brand,sql=>sql.query<{payload:{to:string;subject:string;images:{sha256:string}[]}}>('SELECT payload FROM customer_delivery_captures WHERE delivery_id=$1',[saved.id]))).rows;
    assert.equal(payload.length,1);assert.equal(payload[0]!.payload.to,'reader@trail.example.com');assert.match(payload[0]!.payload.subject,/^\[TEST\] /);
    const message=await service.execute('delivery.message',{brandId:brand,id:saved.id,recipientId:saved.recipients[0]!.id},actor) as {images:{sha256:string}[]};
    assert.equal(message.images[0]!.sha256,digest,'The original photo is retained.');
    const unchanged=await service.execute('campaign.get',{id:draft.id},actor) as Campaign;assert.equal(unchanged.content.subject,'Trail notes');assert.deepEqual(unchanged.content.assetIds,draft.content.assetIds);
    const check=await service.execute('delivery.preflight',{brandId:brand,campaignId:draft.id,expectedVersion:draft.version,purpose:'test',subscriberId:subscriber},actor) as CustomerCampaignPreflight;
    assert.equal(check.testBudget?.used,width===1280?1:2,'Only one daily admission is used for each approved test despite retry.');
    const billing=await service.execute('customerBilling.status',{},actor) as CustomerBillingStatus;assert.equal(billing.usage.campaigns,0);assert.equal(billing.usage.reservedCampaigns,0,'Tests consume no campaign slots.');
    assert.equal(calls.some(call=>call.name==='delivery.review'||call.name==='delivery.approve'),false,'No broadcast review or approval is called.');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Test controls fit the viewport.');
    assert.deepEqual(errors,[]);await panel.screenshot({path:path.join(images,'single-recipient-test-'+width+'.png')});
    await page.reload();await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Delivery',exact:true}).click();
    const row=panel.locator('article.delivery-record').filter({has:page.getByRole('heading',{name:saved.subject,exact:true})}).filter({hasText:'One-recipient test'}).first();
    await row.getByRole('button',{name:'Open one-recipient test',exact:true}).click();
    await panel.getByRole('region',{name:'One-recipient test review',exact:true}).waitFor();
    assert.equal(await panel.getByRole('button',{name:'Approve one-recipient test',exact:true}).count(),0,'Restored completed tests do not offer a fresh approval.');
    await page.close();
  }
  console.info('Single confirmed-recipient review/explicit approval, lost-ack retry, capture/photo fidelity, immutable draft, daily admission and desktop/390px restore passed. Synthetic local capture only. Screenshots: '+images);
}finally{
  await browser.close();await customer?.close();await db.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await fixture.stop();
  if(!process.env.FLOCKLETTER_TEST_SEND_SCREENSHOTS)await rm(scratch,{recursive:true,force:true});
}
