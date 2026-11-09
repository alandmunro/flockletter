import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {createApp} from '../src/server/app.js';
import {loadConfig} from '../src/server/config.js';
import {COOKIE_PREFERENCE_KEY,COOKIE_PREFERENCE_MS,newCookieChoice,savedCookieChoice,optionalCookieAllowed} from '../src/shared/cookie-consent.js';

const server=createServer();
const browser=await chromium.launch({channel:'chrome'});
const screenshots=process.env.FLOCKLETTER_COOKIE_SCREENSHOTS??path.join(tmpdir(),'flockletter-cookie-proof');
try {
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert(address&&typeof address!=='string');
  const origin='http://127.0.0.1:'+address.port;
  server.on('request',createApp(loadConfig({APP_ENV:'test',APP_ORIGIN:origin})));
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage(),errors:string[]=[],requests:string[]=[];
  context.on('request',request=>requests.push(request.url()));
  page.on('pageerror',error=>errors.push(error.message));
  await context.addCookies([{name:'__session',value:'synthetic-cookie-proof',url:origin,httpOnly:true,sameSite:'Lax'}]);
  const banner=page.locator('#flockletter-cookie-notice');
  await page.goto(origin+'/pricing');await banner.waitFor();
  const reject=page.getByRole('button',{name:'Reject optional cookies',exact:true});
  const accept=page.getByRole('button',{name:'Accept all cookies',exact:true});
  const style=async(selector:'accept'|'reject')=>(selector==='accept'?accept:reject).evaluate(button=>{
    const s=getComputedStyle(button);return {background:s.backgroundColor,color:s.color,border:s.borderColor,height:button.getBoundingClientRect().height};
  });
  assert.deepEqual(await style('accept'),await style('reject'),'Choices have equal prominence');
  await mkdir(screenshots,{recursive:true});
  await page.screenshot({path:path.join(screenshots,'flockletter-cookies-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Cookie notice fits a phone');
  await page.screenshot({path:path.join(screenshots,'flockletter-cookies-mobile.png')});
  await reject.click();await banner.waitFor({state:'hidden'});
  let raw=await page.evaluate(key=>localStorage.getItem(key),COOKIE_PREFERENCE_KEY);
  assert.equal(savedCookieChoice(raw)?.choice,'reject');
  await page.reload();await page.locator('[data-cookie-preferences-ready="true"]').waitFor();
  assert.equal(await banner.count(),0);
  await page.getByRole('button',{name:'Cookie choices',exact:true}).click();await banner.waitFor();
  await accept.click();await banner.waitFor({state:'hidden'});
  raw=await page.evaluate(key=>localStorage.getItem(key),COOKIE_PREFERENCE_KEY);
  assert.equal(savedCookieChoice(raw)?.choice,'accept');
  assert.equal(optionalCookieAllowed(raw,'analytics'),false);
  const acceptedAt=savedCookieChoice(raw)?.at;
  await page.reload();await page.locator('[data-cookie-preferences-ready="true"]').waitFor();
  assert.equal(savedCookieChoice(await page.evaluate(key=>localStorage.getItem(key),COOKIE_PREFERENCE_KEY))?.at,acceptedAt,'Refresh cannot extend consent');
  assert.equal((await context.cookies()).find(cookie=>cookie.name==='__session')?.value,'synthetic-cookie-proof');

  const other=await context.newPage();await other.goto(origin+'/help');
  await other.locator('[data-cookie-preferences-ready="true"]').waitFor();
  await other.evaluate(({key,record})=>localStorage.setItem(key,record),{key:COOKIE_PREFERENCE_KEY,record:JSON.stringify(newCookieChoice('accept',Date.now()-COOKIE_PREFERENCE_MS))});
  await banner.waitFor();
  await other.reload();await other.getByRole('button',{name:'Reject optional cookies',exact:true}).click();
  await banner.waitFor({state:'hidden'});

  for(const route of ['/','/help','/pricing','/privacy','/policies/privacy','/cookies','/operator']) {
    await page.goto(origin+route);await page.locator('[data-cookie-preferences-ready="true"]').waitFor();
    await page.getByRole('button',{name:'Cookie choices',exact:true}).click();await banner.waitFor();
    await page.getByRole('button',{name:'Close',exact:true}).click();await banner.waitFor({state:'hidden'});
    assert(await page.getByRole('button',{name:'Cookie choices',exact:true}).evaluate(button=>button===document.activeElement));
  }
  await page.goto(origin+'/privacy');await page.getByRole('heading',{name:'Privacy & cookies',exact:true}).waitFor();
  await page.getByRole('button',{name:'Manage cookie choices',exact:true}).click();await banner.waitFor();
  await reject.click();await banner.waitFor({state:'hidden'});
  await page.screenshot({path:path.join(screenshots,'flockletter-privacy-mobile.png'),fullPage:true});
  assert.equal((await context.cookies()).find(cookie=>cookie.name==='__session')?.value,'synthetic-cookie-proof','Withdrawal preserves auth storage');
  assert(requests.every(url=>new URL(url).origin===origin),'Consent cannot load an optional external tracker');
  assert.deepEqual(errors,[]);
  await context.close();

  const blocked=await browser.newContext();
  await blocked.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Storage unavailable','SecurityError');}}));
  const blockedPage=await blocked.newPage();await blockedPage.goto(origin+'/help');
  await blockedPage.getByRole('button',{name:'Accept all cookies',exact:true}).click();
  await blockedPage.getByRole('alert').filter({hasText:'Your browser could not save this choice.'}).waitFor();
  assert(await blockedPage.getByRole('heading',{name:'Flockletter support',exact:true}).isVisible());
  await blocked.close();

  const signal=await browser.newContext();
  await signal.addInitScript(()=>Object.defineProperty(navigator,'globalPrivacyControl',{value:true}));
  const signalPage=await signal.newPage();await signalPage.goto(origin+'/pricing');
  await signalPage.getByText('Your browser privacy signal is on. Optional tracking stays off.',{exact:true}).waitFor();
  await signal.close();
  console.info(JSON.stringify({passed:true,journeys:['equal choices','phone layout','reject/accept persistence','expiry across tabs','withdrawal preserves sign-in cookie','all application routes','privacy notice','storage failure','browser privacy signal','no external trackers'],screenshots}));
} finally {
  await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));
}
