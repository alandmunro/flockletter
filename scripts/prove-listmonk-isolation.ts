import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EmbeddedListmonk } from '../src/server/campaign/embedded-listmonk.js';
import { PrivateListmonk, listmonkBinding } from '../src/server/campaign/private-listmonk.js';
import { privateMessenger } from '../src/server/campaign/private-messenger.js';
import { CommandService } from '../src/server/service.js';
import { emptyContent, type Campaign } from '../src/shared/contracts.js';
import type { Rehearsal, RecipientOutcome } from '../src/shared/rehearsal.js';
import { startDeliveryFixture } from '../tests/staging-delivery-fixture.js';

type Site = Awaited<ReturnType<typeof startDeliveryFixture>>;
type Customer = Awaited<ReturnType<Site['workspace']>>;

// Use the actual private HTTP listener/engine/dispatcher but retain the synthetic callbacks
// inside this exercise so we can deliberately cross-wire the two listeners. Never print a secret or message.
async function boot(site: Site, customer: Customer) {
  const {workspaceId:workspace,brandId:brand} = customer;
  const secret = randomBytes(32).toString('hex');
  const callbacks = new Map<string,unknown>();
  const server = createServer(privateMessenger(secret, async (body) => {
    await dispatcher.receive(body);
    const subject = (body as {subject: string}).subject;
    callbacks.set(subject,body);
  }));
  const listening = once(server,'listening');
  server.listen(0,'127.0.0.1');
  await listening;
  const address = server.address();
  assert(address && typeof address !== 'string');
  const endpoint = 'http://127.0.0.1:' + address.port + '/message';
  const engine = new EmbeddedListmonk(endpoint,secret);
  const dispatcher = new PrivateListmonk(site.db,site.identity.isOwner,{workspace,brand},engine);
  const service = new CommandService(site.db,undefined,site.identity.isOwner,undefined,undefined,undefined,
    (w,b) => dispatcher.owns(w,b),undefined,dispatcher);
  return {
    dispatcher, service, callbacks, secret, endpoint,
    async close() {
      const closed = new Promise<void>((resolve,reject) => server.close((error) => error ? reject(error) : resolve()));
      await engine.close();
      await closed;
    },
  };
}
type Handler = Awaited<ReturnType<typeof boot>>;

async function prepare(customer: Customer, handler: Handler, subject: string) {
  const {brandId,owner} = customer;
  const draft = await customer.command<Campaign>('campaign.create', {
    operationKey:randomUUID(),brandId,content:{
      ...emptyContent(),title:subject,subject,fromName:'Synthetic retailer',replyTo:'sample@sender.test',
      heading:'Field notes',body:'Local engine isolation exercise.',
    },
  });
  const run = await handler.service.execute('rehearsal.review',{
    operationKey:randomUUID(),brandId,campaignId:draft.id,expectedVersion:draft.version,audience:'test',transport:'listmonk_test',
  },owner) as Rehearsal;
  await handler.service.execute('rehearsal.approve',{operationKey:randomUUID(),brandId,id:run.id},owner);
  return {id:run.id,subject};
}
type Run = Awaited<ReturnType<typeof prepare>>;

async function render(customer: Customer, handler: Handler, run: Run) {
  const started = performance.now();
  await handler.dispatcher.tick(customer.workspaceId,customer.brandId,run.id);
  const deadline = Date.now()+30_000;
  while (!handler.callbacks.has(run.subject) && Date.now()<deadline) await delay(50);
  const body = handler.callbacks.get(run.subject);
  assert(body,'Listmonk did not produce the expected authenticated callback.');
  return {body, elapsedMs:Math.round(performance.now()-started)};
}

async function settle(site: Site, customer: Customer, handler: Handler, run: Run) {
  const {workspaceId,brandId} = customer;
  await handler.dispatcher.tick(workspaceId,brandId,run.id);
  const args = {brandId,id:run.id};
  const report = await customer.command<Rehearsal>('rehearsal.report',args);
  assert.equal(report.state,'completed');
  assert.equal(report.accepted,1);
  const results = await customer.command<{recipients: RecipientOutcome[]}>('rehearsal.outcomes',args);
  assert.deepEqual(await customer.tool('rehearsal_outcomes',args),results);
  assert.equal(results.recipients.length,1);
  assert.equal(results.recipients[0]?.attempts,1);
  assert.equal(results.recipients[0]?.feedback,'delivered');
  const receipts = await site.db.brand(workspaceId,brandId,(sql) => sql.query(
    'SELECT operation_key,provider_binding FROM campaign_provider_receipts WHERE rehearsal_id=$1',[run.id],
  ));
  assert.deepEqual(receipts.rows,[{operation_key:results.recipients[0]!.id,provider_binding:listmonkBinding(workspaceId,brandId,'listmonk_test')}]);
}

async function replay(endpoint: string, secret: string, body: unknown) {
  const result = await fetch(endpoint,{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{authorization:'Basic '+Buffer.from('flockletter:'+secret).toString('base64'),'content-type':'application/json'},
    body:JSON.stringify(body),
  });
  await result.body?.cancel();
  return result.status;
}

const originalTmp = process.env.TMPDIR;
const root = await mkdtemp(path.join(tmpdir(),'flockletter-listmonk-isolation-'));
const site = await startDeliveryFixture().catch(async (error) => {
  await rm(root,{force:true,recursive:true});
  throw error;
});
const dirs = async () => (await readdir(root)).filter((name) => name.startsWith('flockletter-private-engine-')).sort();
async function nativeDatabase(dir: string) {
  const expected = path.join(root,dir,'pg');
  const [pid,directory,,port] = (await readFile(path.join(expected,'postmaster.pid'),'utf8')).split('\n');
  assert(directory && pid && port && /^\d+$/.test(pid) && /^\d+$/.test(port));
  assert.equal(await realpath(directory),await realpath(expected),'A renderer must use its own temporary PostgreSQL data directory.');
  return {pid,port};
}
let left: Customer | undefined, right: Customer | undefined, a: Handler | undefined, b: Handler | undefined;
try {
  process.env.TMPDIR = root;
  left = await site.workspace();
  right = await site.workspace();
  a = await boot(site,left);
  b = await boot(site,right);
  const aFirst = await prepare(left,a,'Northern sample one');
  const bFirst = await prepare(right,b,'Southern sample one');
  const started = performance.now();
  const [firstA,firstB] = await Promise.all([render(left,a,aFirst),render(right,b,bFirst)]);
  const concurrentMs = Math.round(performance.now()-started);
  const initialDirs = await dirs();
  assert.equal(initialDirs.length,2,'Two independent native engines must be running.');
  const databases = new Map(await Promise.all(initialDirs.map(async dir => [dir,await nativeDatabase(dir)] as const)));
  assert.equal(new Set([...databases.values()].map((instance) => instance.pid)).size,2);
  assert.equal(new Set([...databases.values()].map((instance) => instance.port)).size,2);
  assert.equal(a.callbacks.size,1);
  assert.equal(b.callbacks.size,1);
  assert.equal(await replay(b.endpoint,a.secret,firstA.body),401);
  assert.equal(await replay(b.endpoint,b.secret,firstA.body),409);
  assert.equal(await replay(a.endpoint,a.secret,firstB.body),409);
  assert.equal(await replay(a.endpoint,a.secret,firstA.body),200);
  assert.deepEqual(await b.dispatcher.tick(left.workspaceId,left.brandId,aFirst.id),{processed:false});
  assert.equal((await right.post('rehearsal.report',{brandId:left.brandId,id:aFirst.id})).status,404);

  const retiredSecret = a.secret;
  await a.close();
  a = undefined;
  const surviving = await dirs();
  assert.equal(surviving.length,1);
  assert(initialDirs.includes(surviving[0]!));
  await settle(site,right,b,bFirst);
  const bSecond = await prepare(right,b,'Southern sample while the north is stopped');
  const warm = await render(right,b,bSecond);
  await settle(site,right,b,bSecond);
  assert.deepEqual(await dirs(),surviving,'The other workspace must keep its own engine during the stop.');
  assert.deepEqual(await nativeDatabase(surviving[0]!),databases.get(surviving[0]!));
  assert.equal((await site.db.brand(right.workspaceId,right.brandId,(sql) => sql.query(
    'SELECT 1 FROM listmonk_handoffs WHERE rehearsal_id=$1',[aFirst.id]))).rowCount,0);

  a = await boot(site,left);
  assert.equal(await replay(a.endpoint,retiredSecret,firstA.body),401);
  assert.equal(await replay(a.endpoint,a.secret,firstA.body),200);
  await settle(site,left,a,aFirst);
  const aNext = await prepare(left,a,'Northern sample after restart');
  const bNext = await prepare(right,b,'Southern sample during northern restart');
  const [restarted,otherWarm] = await Promise.all([render(left,a,aNext),render(right,b,bNext)]);
  await Promise.all([settle(site,left,a,aNext),settle(site,right,b,bNext)]);
  const afterRestart = await dirs();
  assert.equal(afterRestart.length,2);
  assert(afterRestart.includes(surviving[0]!));
  assert.equal(afterRestart.filter((name) => initialDirs.includes(name)).length,1);
  assert.deepEqual(await nativeDatabase(surviving[0]!),databases.get(surviving[0]!));
  for (const [customer,count] of [[left,2],[right,3]] as const) {
    const receipts = await site.db.brand(customer.workspaceId,customer.brandId,(sql) =>
      sql.query('SELECT count(*)::int AS total FROM campaign_provider_receipts'));
    assert.equal(receipts.rows[0].total,count);
  }
  console.log(JSON.stringify({
    platform:process.platform,architecture:process.arch,node:process.version,listmonk:'6.2.0',transport:'local capture',
    concurrentColdCallbacksMs:concurrentMs,coldWorkspaceMs:[firstA.elapsedMs,firstB.elapsedMs],
    warmWhilePeerStoppedMs:warm.elapsedMs,restartedWorkspaceMs:restarted.elapsedMs,
    warmWhilePeerRestartsMs:otherWarm.elapsedMs,localReceipts:[2,3],
  }));
} finally {
  try {
    await Promise.all([a?.close(),b?.close()]);
    assert.deepEqual(await dirs(),[],'Both disposable engine directories must be retired.');
  } finally {
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR=originalTmp;
    await Promise.all([left?.close(),right?.close()]);
    await site.close();
    await rm(root,{force:true,recursive:true});
  }
}
