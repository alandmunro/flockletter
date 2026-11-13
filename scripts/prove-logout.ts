import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

// Exercise the real header/button with a controlled sign-out promise, never a real account.
const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Header} from '/src/client/App.tsx';
import {LogoutButton} from '/src/client/LogoutButton.tsx';
import '/src/client/app.css';
window.logoutCalls=0;
function Fixture(){
  const [signedIn,setSignedIn]=React.useState(true);
  const signOut=()=>{window.logoutCalls++;return new Promise((resolve,reject)=>{
    window.finishLogout=()=>{setSignedIn(false);resolve()};
    window.failLogout=()=>reject(new Error('private-provider-error'));
  })};
  return React.createElement(React.Fragment,null,
    React.createElement(Header,{account:signedIn?React.createElement(React.Fragment,null,React.createElement('span',null,'Synthetic workspace'),React.createElement(LogoutButton,{signOut})):null}),
    React.createElement('main',{className:'main'},React.createElement('h1',null,signedIn?'Synthetic signed-in workspace':'Sign in to Flockletter')));
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script></body></html>`;

const screenshots = await mkdtemp(path.join(tmpdir(), 'flockletter-logout-'));
const server = await createServer({ configFile: false, plugins: [react(), {
  name: 'logout-proof-only', configureServer(vite) {
    vite.middlewares.use('/__logout-proof', (_req, res, next) => {
      void vite.transformIndexHtml('/__logout-proof', html).then(value => {
        res.setHeader('Content-Type', 'text/html'); res.end(value);
      }).catch(next);
    });
  },
}], server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const address = server.httpServer!.address(); assert(address && typeof address !== 'string');
  browser = await chromium.launch({ channel: process.env.FLOCKLETTER_BROWSER_CHANNEL ?? 'chrome' });
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/__logout-proof`);
    const logout = page.getByRole('button', { name: 'Log out', exact: true });
    await logout.waitFor();
    assert.equal(await logout.isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(screenshots, `logout-${width}.png`), fullPage: true });
    await logout.focus(); await page.keyboard.press('Enter');
    const busy = page.getByRole('button', { name: 'Logging out…', exact: true });
    await busy.waitFor(); assert.equal(await busy.isDisabled(), true);
    await busy.evaluate(button => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.equal(await page.evaluate('window.logoutCalls'), 1);
    await page.evaluate('window.failLogout()');
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /could not log you out/);
    assert.equal((await page.locator('body').innerText()).includes('private-provider-error'), false);
    assert.equal(await logout.isEnabled(), true);
    await logout.click();
    await busy.waitFor(); assert.equal(await page.evaluate('window.logoutCalls'), 2);
    assert.equal(await page.getByRole('alert').count(), 0);
    await page.evaluate('window.finishLogout()');
    await page.getByRole('heading', { name: 'Sign in to Flockletter', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Log.*out/ }).count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`Logout captured browser proof passed (desktop and 390px). Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await server.close();
}
