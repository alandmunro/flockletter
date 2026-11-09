import assert from 'node:assert/strict';
import type {Page,Request} from 'playwright-core';

function bounded<T>(promise:Promise<T>):Promise<T> {
  let timer:ReturnType<typeof setTimeout>;
  const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Delivery preflight browser request exceeded its deadline.')),15000);});
  return Promise.race([promise,expired]).finally(()=>clearTimeout(timer));
}
/** Synthetic response failures test the real UI; they never create or approve a send. */
export async function proveDeliveryPreflight(page:Page,groupId:string) {
  const pattern='**/api/v1/commands/delivery.preflight';
  let reviews=0;
  const count=(request:Request)=>{if(new URL(request.url()).pathname==='/api/v1/commands/delivery.review')reviews++;};
  page.on('request',count);
  try {
    await page.route(pattern,async route=>{
      const response=await route.fetch(),body=await response.json();
      await route.fulfill({response,json:{result:{...body.result,gaps:[
        {area:'content',code:'proof_content',title:'Proof content issue',detail:'Resolve the synthetic content issue.'},
        {area:'sender',code:'proof_sender',title:'Proof sender issue',detail:'Resolve the synthetic sender issue.'},
      ]}}});
    },{times:1});
    await page.getByRole('button',{name:'Review saved campaign',exact:true}).click();
    const gaps=page.getByRole('region',{name:'Delivery preparation gaps',exact:true});
    await gaps.getByText('Proof content issue',{exact:true}).waitFor();
    await gaps.getByText('Proof sender issue',{exact:true}).waitFor();
    assert.equal(reviews,0,'A blocked preflight must not create a review.');

    let release!:()=>void,intercepted!:()=>void;
    const held=new Promise<void>(resolve=>{intercepted=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    await page.route(pattern,async route=>{
      const response=await route.fetch();intercepted();await gate;await route.fulfill({response});
    },{times:1});
    try {
      const reply=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/commands/delivery.preflight');
      await page.getByRole('button',{name:'Review saved campaign',exact:true}).click();await bounded(held);
      await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Campaigns',exact:true}).click();
      await page.getByRole('button',{name:'Edit Trail Notes browser proof',exact:true}).waitFor();
      release();await bounded((await reply).finished());
      await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
      assert.equal(reviews,0,'Leaving the view before preflight completes must not create background work.');
    }finally{release();await page.unroute(pattern);}
    await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Delivery',exact:true}).click();
    await page.getByRole('combobox',{name:'Audience',exact:true}).selectOption(groupId);
  }finally{page.off('request',count);await page.unroute(pattern);}
}
