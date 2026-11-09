import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Page} from 'playwright-core';
import type {Database} from '../src/server/db.js';
import type {CommandService,Actor} from '../src/server/service.js';
import type {CustomerWorkflows} from '../src/server/customer-runtime.js';
import {emptyContent,type Campaign} from '../src/shared/contracts.js';
import type {DeliveryView} from '../src/shared/customer-delivery.js';

function bounded<T>(promise:Promise<T>):Promise<T> {
  let timer:ReturnType<typeof setTimeout>;
  const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Outcome browser request exceeded its deadline.')),15000);});
  return Promise.race([promise,expired]).finally(()=>clearTimeout(timer));
}
/** Only disposable synthetic data; never activates or approves a delivery. */
export async function proveDeliveryOutcomes(page:Page,db:Database,service:CommandService,customer:CustomerWorkflows,actor:Actor,brandId:string,screenshotPath?:string) {
  const batch=randomUUID(),emails=Array.from({length:61},(_,index)=>'outcome-'+batch+'-'+index+'@trail.example.com');
  await db.brand(actor.workspaceId,brandId,sql=>sql.query(`INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state)
    SELECT $1,$2,gen_random_uuid(),email,'confirmed' FROM unnest($3::text[]) email`,[actor.workspaceId,brandId,emails]));
  const group=await service.execute('segment.create',{operationKey:randomUUID(),brandId,name:'Outcome proof '+batch},actor) as {id:string};
  await service.execute('segment.members',{operationKey:randomUUID(),brandId,segmentId:group.id,action:'add',emails},actor);
  const draft=await service.execute('campaign.create',{operationKey:randomUUID(),brandId,content:{...emptyContent(),title:'Outcome proof '+batch,
    subject:'Outcome pagination '+batch,fromName:'Trail',replyTo:'hello@trail.example.com',heading:'Test outcomes',body:'Synthetic report data only.'}},actor) as Campaign;
  const review=await customer.delivery.execute('delivery.review',{operationKey:randomUUID(),brandId,campaignId:draft.id,expectedVersion:1,segmentId:group.id},actor) as DeliveryView;
  const last=(await db.brand(actor.workspaceId,brandId,sql=>sql.query<{id:string}>('SELECT id FROM customer_delivery_recipients WHERE delivery_id=$1 ORDER BY id DESC LIMIT 1',[review.id]))).rows[0]!.id;
  await db.brand(actor.workspaceId,brandId,sql=>sql.query("UPDATE customer_delivery_recipients SET state='accepted',attempts=1 WHERE id=(SELECT id FROM customer_delivery_recipients WHERE delivery_id=$1 ORDER BY id LIMIT 1)",[review.id]));
  await db.brand(actor.workspaceId,brandId,sql=>sql.query("UPDATE customer_delivery_recipients SET state='uncertain',attempts=1,reason='provider_unknown' WHERE id=$1",[last]));
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Delivery',exact:true}).click();
  const record=page.locator('article.delivery-record').filter({has:page.getByRole('heading',{name:draft.content.subject,exact:true})});
  await record.getByRole('button',{name:'Show recipient outcomes',exact:true}).click();
  await record.getByText('Showing 25 loaded outcomes · 61 match at last check.',{exact:true}).waitFor();
  await record.getByText('Accepted in captured exercise',{exact:true}).waitFor();
  await record.getByText('Captured outcomes do not establish delivery to a real inbox.',{exact:true}).waitFor();
  await record.getByRole('button',{name:'Load more outcomes',exact:true}).click();
  await record.getByText('Showing 50 loaded outcomes · 61 match at last check.',{exact:true}).waitFor();
  await record.getByRole('button',{name:'Load more outcomes',exact:true}).click();
  await record.getByText('Showing 61 loaded outcomes · 61 match at last check.',{exact:true}).waitFor();
  const list=record.getByRole('list',{name:'Recipient outcomes',exact:true});
  assert.equal(await list.getByRole('listitem').count(),61);
  await record.getByRole('combobox',{name:'Status',exact:true}).selectOption('uncertain');
  await record.getByText('Showing 1 loaded outcomes · 1 match at last check.',{exact:true}).waitFor();
  await record.getByText('Recipient '+last,{exact:true}).waitFor();
  await record.getByText('The provider may have accepted this message. Use Process or reconcile above; do not resend it while the outcome is unknown.',{exact:true}).waitFor();
  await record.getByRole('combobox',{name:'Provider feedback',exact:true}).selectOption('hard_bounce');
  await record.getByText('No matching recipient outcomes.',{exact:true}).waitFor();
  await record.getByRole('combobox',{name:'Status',exact:true}).selectOption('');
  await record.getByText('No matching recipient outcomes.',{exact:true}).waitFor();
  await record.getByRole('combobox',{name:'Provider feedback',exact:true}).selectOption('');
  await record.getByText('Showing 25 loaded outcomes · 61 match at last check.',{exact:true}).waitFor();

  // A late response from a closed view must not replace the newly opened view.
  let intercepted!:()=>void,release!:()=>void,completed!:()=>void;
  const held=new Promise<void>(resolve=>{intercepted=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;}),done=new Promise<void>(resolve=>{completed=resolve;});
  let holdNext=true;
  const routePattern='**/api/v1/commands/delivery.outcomes';
  await page.route(routePattern,async route=>{
    if(!holdNext){await route.continue();return;}
    holdNext=false;
    try {
      const response=await route.fetch(),body=await response.json();intercepted();await gate;
      await route.fulfill({response,json:{result:{...body.result,total:999,items:[]}}});
    }finally{completed();}
  });
  try {
    await record.getByRole('button',{name:'Refresh outcomes',exact:true}).click();await bounded(held);
    await record.getByRole('button',{name:'Close recipient outcomes',exact:true}).click();
    await record.getByRole('button',{name:'Show recipient outcomes',exact:true}).click();
    await record.getByText('Showing 25 loaded outcomes · 61 match at last check.',{exact:true}).waitFor();
    release();await bounded(done);
    assert.equal(await record.getByText(/999 match/).count(),0,'Closed request cannot replace newer evidence.');
  }finally{release();await bounded(done);await page.unroute(routePattern);}
  await page.route(routePattern,route=>route.fulfill({status:503,json:{error:{message:'Synthetic outcome read unavailable'}}}),{times:1});
  await record.getByRole('button',{name:'Refresh outcomes',exact:true}).click();
  await record.getByRole('alert').filter({hasText:'Synthetic outcome read unavailable'}).waitFor();
  await record.getByRole('button',{name:'Retry outcomes',exact:true}).click();
  await record.getByText('Showing 25 loaded outcomes · 61 match at last check.',{exact:true}).waitFor();
  assert.equal(await record.getByRole('alert').count(),0);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Recipient IDs wrap on a phone.');
  if(screenshotPath){await record.locator('.delivery-outcomes').getByRole('heading').scrollIntoViewIfNeeded();await page.screenshot({path:screenshotPath,fullPage:false});}
  await record.getByRole('button',{name:'Close recipient outcomes',exact:true}).click();
}
