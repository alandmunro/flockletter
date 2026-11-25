// Real HTTP, isolated PostgreSQL, local identity and captured automation mode.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chromium,type Browser,type Page } from 'playwright-core';
import { startDatabase } from './database-fixture.js';
import { rejectOptionalCookies } from './browser-cookie-choice.js';
import { Database } from '../src/server/db.js';
import { Authenticator,localIdentity } from '../src/server/auth.js';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { CustomerWorkflows } from '../src/server/customer-runtime.js';
import { CommandService,type Actor } from '../src/server/service.js';
import { setDate } from '../src/server/subscribers/people.js';
import type { Workspace } from '../src/shared/contracts.js';

const fixture=await startDatabase(),db=new Database(fixture.url),server=createServer();
let proofPage:Page|undefined;
let customer:CustomerWorkflows|undefined,browser:Browser|undefined;
try {
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const origin='http://127.0.0.1:'+address.port;
  const config=loadConfig({APP_ENV:'local',APP_ORIGIN:origin,DATABASE_URL:fixture.url,LOCAL_TEST_IDENTITY:'true'});
  const identity=localIdentity(),actor:Actor={userId:'local_owner',workspaceId:'org_local_sample',actorId:'user:local_owner',owner:true,kind:'session',brandIds:null,scopes:['read']};
  customer=new CustomerWorkflows(db,config,identity,{FLOCKLETTER_DATE_AUTOMATIONS:'capture',FLOCKLETTER_CUSTOMER_BILLING:'exercise',FLOCKLETTER_CUSTOMER_AUDIENCE:'exercise'});
  const service=new CommandService(db,undefined,identity.isOwner,undefined,undefined,identity.team,undefined,undefined,undefined,'local',undefined,customer);
  await service.execute('workspace.initialize',{name:'Annual fixture',brandName:'Fixture brand',operationKey:randomUUID()},actor);
  const brand=((await service.execute('workspace.get',{},actor)) as Workspace).brands[0]!.id;
  await service.execute('customerBilling.startTrial',{operationKey:randomUUID(),plan:'starter',simulatedCardConfirmed:true},actor);
  const soon=new Date(Date.now()+4*86400000);
  await db.brand(actor.workspaceId,brand,async sql=>{
    const reader=randomUUID();
    await sql.query("INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state,first_name) VALUES($1,$2,$3,'fixture@example.test','confirmed','Taylor')",[actor.workspaceId,brand,reader]);
    await setDate(sql,actor.workspaceId,brand,{subscriber:reader,contact:null},'anniversary',{month:soon.getUTCMonth()+1,day:soon.getUTCDate(),year:2020},'Home anniversary');
  });
  server.on('request',createApp(config,service,new Authenticator(db,identity)));
  browser=await chromium.launch({channel:process.env.FLOCKLETTER_BROWSER_CHANNEL??'chromium'});
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors:string[]=[];
  proofPage=page;page.setDefaultTimeout(8000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await rejectOptionalCookies(page);
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Audience',exact:true}).click();
  await page.getByText('Birthday and anniversary automations',{exact:true}).click();
  const panel=page.getByRole('region',{name:'Annual greetings'});
  await panel.getByRole('combobox',{name:'Greeting',exact:true}).selectOption('anniversary');
  await panel.getByLabel('SMS greeting').fill('Happy {{label}}, {{firstName}}! {{#years}}{{years}} years!{{/years}}');
  await panel.getByRole('checkbox',{name:'Use email when the recipient is ineligible for SMS'}).check();
  await panel.getByRole('button',{name:'Preview next 30 days'}).click();
  await panel.getByRole('listitem').filter({hasText:'Happy Home anniversary, Taylor!'}).waitFor();
  await panel.getByRole('button',{name:'Save draft'}).click();
  await panel.getByRole('button',{name:'Review activation'}).click();
  await panel.getByRole('button',{name:'Confirm annual greeting'}).click();
  await panel.getByRole('button',{name:'Pause greeting'}).waitFor();
  await customer.processWorkspace(actor.workspaceId);
  await page.setViewportSize({width:390,height:844});
  await panel.getByRole('button',{name:'Refresh greetings'}).click();
  await panel.getByRole('button',{name:'Cancel this greeting'}).click();
  await panel.getByRole('combobox',{name:'Show',exact:true}).selectOption('history');
  await panel.getByRole('listitem').filter({hasText:'owner cancelled'}).waitFor();
  await panel.getByRole('button',{name:'Preview next 30 days'}).click();
  await panel.getByText('No upcoming dates on this page.').waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await panel.getByRole('button',{name:'Pause greeting'}).click();
  await panel.getByRole('button',{name:'Review activation'}).waitFor();
  const connection=await service.execute('connection.create',{name:'Automation fixture',brandIds:[brand],
    scopes:['read','automation:manage'],expiresInDays:1,operationKey:randomUUID()},actor) as {token:string};
  const {createMcpServer,apiCaller}=await import('../src/mcp/bridge.js');
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
  const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
  const bridge=createMcpServer(apiCaller(origin,connection.token)),client=new Client({name:'date-proof',version:'1'});
  const [serverSide,clientSide]=InMemoryTransport.createLinkedPair();
  try {
    await bridge.connect(serverSide);await client.connect(clientSide);
    const history=await client.callTool({name:'dateAutomation_occurrences',arguments:{brandId:brand,view:'history'}});
    assert.ok(!history.isError&&JSON.stringify(history.content).includes('owner_cancelled'));
    const denied=await client.callTool({name:'dateAutomation_activate',arguments:{brandId:brand,kind:'anniversary',
      expectedRevision:1,operationKey:randomUUID(),confirmRecurring:true}});
    assert.ok(denied.isError&&JSON.stringify(denied.content).includes('send_scope_required'));
  } finally {await client.close();await bridge.close();}
  assert.deepEqual(errors,[]);
  console.log('Desktop/mobile annual greeting preview, activation, cancellation, history, pause and scoped MCP access passed against a disposable database.');
 } catch (e) {
  if(proofPage)console.error(await proofPage.locator('details.date-controls').ariaSnapshot().catch(()=>'Panel unavailable'));
  throw e;
} finally {
  await browser?.close(); await customer?.close();
  if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
  await db.close();await fixture.stop();
}
