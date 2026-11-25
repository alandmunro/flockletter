import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { GiftLab } from './lab.mjs';
import { catalog, contacts } from './fixtures.mjs';
import { exampleCampaign, purchase, runExample } from './scenario.mjs';
import { createLabServer } from './server.mjs';

function fixture(t, file) {
  const lab = new GiftLab(file);
  t.after(() => lab.db.close());
  return lab;
}
function pathFor(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flock-gift-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'lab.sqlite');
}
const studio = 'Studio',
  orchard = 'Orchard';
const proposal = (overrides = {}) => ({
  label: 'Thanks',
  face: 500,
  days: 15,
  products: catalog.slice(0, 5),
  rows: contacts(2),
  ...overrides,
});
const fact = (kind, total = 1100) => ({
  workspace: studio,
  currency: 'USD',
  id: kind,
  kind,
  lot: 'p',
  total,
});
function fundedOffer(lab) {
  purchase(lab, studio, 'p', 1000);
  exampleCampaign(lab, studio, 1, 15);
  return lab.offers(studio)[0].id;
}

test('WA-09-AT01: 100 recipients across 200 channel rows, 5 claims, 95 releases and exact fee refund', () => {
  const r = runExample();
  assert.equal(r.refund.fee, 4750);
  assert.equal(r.reserved.reserved, 50000);
});

test('R01/R02: verified purchase identity, tenant binding, atomic reservation and immutable terms', (t) => {
  const lab = fixture(t);
  const event = { ...fact('paid'), face: 1000 };
  assert.throws(() => lab.receive('stripe', JSON.stringify(event), '00'.repeat(32)), /signature/);
  for (const edit of [{ total: 1000 }, { currency: 'EUR' }, { face: 0 }]) {
    assert.throws(() => lab.emit('stripe', { ...event, ...edit }));
  }
  assert.equal(lab.balances(studio).available, 0);
  lab.emit('stripe', event);
  lab.emit('stripe', event);
  lab.emit('stripe', { ...event, id: 'another-receipt' });
  assert.throws(() => lab.emit('stripe', { ...event, id: 'foreign', workspace: orchard }), /Conflicting/);
  assert.throws(() => lab.launch(studio, proposal({ face: 501 })), /Insufficient/);
  assert.equal(lab.offers(studio).length, 0);
  const id = lab.launch(studio, proposal());
  assert.equal(lab.launch(studio, proposal({ rows: contacts(2).reverse() })), id);
  assert.throws(() => lab.launch(studio, proposal({ days: 60 })), /Conflicting/);
  assert.equal(lab.balances(studio).reserved, 1000);
  assert.equal(lab.balances(orchard).total, 0);
  assert.throws(() => lab.db.exec('UPDATE ledger SET available=0'), /append-only/);
});

test('R03/R08: eligibility, broker approval, probation budget and constrained catalog', (t) => {
  const lab = fixture(t);
  purchase(lab, studio, 'p', 3000);
  for (const bad of [[], catalog.slice(0, 4), ['unknown'], Array(5).fill(catalog[0])]) {
    assert.throws(() => lab.launch(studio, proposal({ products: bad })));
  }
  assert.throws(() => lab.launch(studio, proposal({ days: 45 })), /terms/);
  lab.run('UPDATE workspace SET realtor=1,probation=1 WHERE name=?', studio);
  assert.throws(() => lab.launch(studio, proposal()), /broker/);
  lab.run('UPDATE workspace SET broker_ok=1,eligible=0 WHERE name=?', studio);
  assert.throws(() => lab.launch(studio, proposal()), /Eligibility/);
  lab.run('UPDATE workspace SET eligible=1 WHERE name=?', studio);
  assert.throws(() => lab.launch(studio, proposal({ probationRemaining: 999 })), /cap/);
  lab.launch(studio, proposal({ days: 60, products: catalog.slice(0, 1), probationRemaining: 1000 }));
  assert.equal(lab.offers(studio)[0].expires, 60);
});

async function race(file, offer, actions) {
  const gate = new SharedArrayBuffer(4);
  const workers = actions.map(
    (action) =>
      new Worker(new URL('./race-worker.mjs', import.meta.url), {
        workerData: { file, offer, gate, action },
      }),
  );
  const exits = workers.map((worker) => once(worker, 'exit'));
  try {
    await Promise.all(workers.map((worker) => once(worker, 'message')));
    const barrier = new Int32Array(gate);
    Atomics.store(barrier, 0, 1);
    Atomics.notify(barrier, 0);
    assert.deepEqual(
      await Promise.all(exits),
      actions.map(() => [0]),
    );
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

for (const actions of [
  ['claim', 'claim'],
  ['claim', 'expire'],
  ['worker', 'webhook'],
]) {
  test('WA-09-AT02: ' + actions.join(' races '), async (t) => {
    const file = pathFor(t);
    const lab = fixture(t, file),
      offer = fundedOffer(lab);
    if (actions.includes('webhook')) {
      lab.run("UPDATE platform SET fault='timeout'");
      assert.equal(lab.claim(studio, offer), 'pending');
    }
    await race(file, offer, actions);
    const won = lab.offer(studio, offer).state === 'claimed';
    if (!actions.includes('expire')) assert.equal(won, true);
    assert.equal(lab.one('SELECT count(*) n FROM vendor_order').n, won ? 1 : 0);
    assert.equal(lab.one("SELECT count(*) n FROM ledger WHERE kind='claim'").n, won ? 1 : 0);
    assert.equal(lab.balances(studio).available, won ? 500 : 1000);
    assert.equal(lab.balances(studio).reserved, 0);
  });
}

test('AT03: restart after provider commit, pending closure, exactly one verified refund', (t) => {
  const file = pathFor(t),
    first = new GiftLab(file);
  let id;
  try {
    id = fundedOffer(first);
    first.run("UPDATE platform SET fault='timeout'");
    assert.equal(first.claim(studio, id), 'pending');
    assert.throws(() => first.closure(studio), /awaiting/);
    assert.equal(first.balances(studio).reserved, 500);
  } finally {
    first.db.close();
  }
  const lab = fixture(t, file);
  lab.tick(60);
  assert.equal(lab.offer(studio, id).state, 'claimed');
  assert.equal(lab.claim(studio, id), 'claimed');
  assert.equal(lab.one('SELECT count(*) n FROM vendor_order').n, 1);
  assert.deepEqual(lab.closure(studio), [{ lot: 'p', credit: 500, fee: 50, total: 550, currency: 'USD' }]);
  assert.throws(() => lab.emit('stripe', fact('refunded', 549)), /mismatch/);
  const refund = fact('refunded', 550);
  lab.emit('stripe', refund);
  lab.emit('stripe', refund);
  lab.emit('stripe', { ...refund, id: 'again' });
  assert.equal(lab.balances(studio).total, 0);
  assert.deepEqual(lab.closure(studio), []);
});

test('R05: prorated fee follows original lots, unused funds survive expiry', (t) => {
  const lab = fixture(t);
  purchase(lab, studio, 'first', 333);
  purchase(lab, studio, 'second', 333);
  const id = lab.launch(studio, proposal({ rows: contacts(1), face: 500 }));
  lab.claim(studio, lab.one('SELECT id FROM offer WHERE campaign=?', id).id);
  lab.tick(365);
  assert.deepEqual(lab.closure(studio), [
    { lot: 'second', credit: 166, fee: 16, total: 182, currency: 'USD' },
  ]);
});

test('R06: shortfall, outage, catalog withdrawal and review retain intent through expiry', (t) => {
  const lab = fixture(t),
    id = fundedOffer(lab);
  lab.run('UPDATE platform SET funds=0,buffer=100');
  assert.equal(lab.claim(studio, id), 'pending');
  assert.equal(lab.funding().shortfall, 600);
  assert.match(lab.offer(studio, id).issue, /funding/);
  lab.tick(15);
  for (const fault of ['outage', 'unavailable', 'review']) {
    lab.run('UPDATE platform SET funds=1000,fault=?', fault);
    lab.tick(0);
    assert.equal(lab.offer(studio, id).state, 'pending');
    assert.equal(lab.balances(studio).reserved, 500);
  }
  assert.equal(lab.one('SELECT state FROM vendor_order').state, 'review');
  const approved = { id: 'approved', workspace: studio, kind: 'order.updated', offer: id };
  lab.emit('rewards', approved);
  assert.equal(lab.offer(studio, id).state, 'pending');
  lab.run("UPDATE vendor_order SET state='approved'");
  assert.throws(() => lab.receive('rewards', JSON.stringify(approved), 'ff'.repeat(32)), /signature/);
  assert.throws(() => lab.emit('rewards', { ...approved, id: 'cross', workspace: orchard }), /workspace/);
  lab.emit('rewards', { ...approved, id: 'settled' });
  lab.emit('rewards', { ...approved, id: 'settled' });
  assert.equal(lab.balances(studio).reserved, 0);
});

test('R07: dispute preserves promised gift, pauses after spend, day 6/30 and resolution', (t) => {
  const lab = fixture(t),
    id = fundedOffer(lab);
  const opened = fact('open');
  lab.emit('stripe', opened);
  lab.emit('stripe', { ...opened, id: 'replay' });
  assert.throws(() => lab.launch(studio, proposal({ label: 'New' })), /Insufficient/);
  assert.equal(lab.balances(studio).reserved, 500);
  assert.equal(lab.claim(studio, id), 'claimed');
  assert.equal(lab.balances(studio).total, -500);
  assert.equal(lab.access(studio), 'paused');
  lab.tick(5);
  assert.equal(lab.access(studio), 'paused');
  lab.tick(1);
  assert.equal(lab.access(studio), 'suspended');
  lab.tick(24);
  assert.equal(lab.access(studio), 'closed');
  lab.emit('stripe', fact('won'));
  lab.emit('stripe', fact('won'));
  assert.equal(lab.access(studio), 'closed');
  assert.equal(lab.balances(studio).available, 500);
  assert.equal(lab.closure(studio)[0].total, 550);
  const evidence = lab.disputeEvidence(studio, 'p');
  assert.equal(evidence.claims[0].amount, 500);
  assert.equal(evidence.claims[0].claimed_day, 0);
  assert.throws(() => lab.disputeEvidence(orchard, 'p'), /workspace/);
});

test('R07: dispute won before closure lifts pause; loss during probation holds for operator', (t) => {
  const lab = fixture(t),
    id = fundedOffer(lab);
  lab.claim(studio, id);
  lab.emit('stripe', fact('open'));
  lab.emit('stripe', fact('won'));
  assert.equal(lab.access(studio), 'active');
  purchase(lab, orchard, 'o', 1000);
  lab.run('UPDATE workspace SET probation=1 WHERE name=?', orchard);
  for (const kind of ['open', 'lost'])
    lab.emit('stripe', { ...fact(kind), id: 'o-' + kind, lot: 'o', workspace: orchard });
  assert.equal(lab.access(orchard), 'suspended');
  assert.equal(lab.access(studio), 'active');
});

test('AT04: GET and scans only display; POST claims once; reward links refresh and workspace is bound', async (t) => {
  const lab = fixture(t),
    id = fundedOffer(lab);
  const server = createLabServer(lab);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const home = await (await fetch(origin)).text();
  const path = home.match(/href="(\/claim\/[^"]+)"/)[1];
  const url = origin + path;
  assert.equal((await fetch(url.replace('/Studio/', '/Orchard/'))).status, 404);
  assert.equal((await fetch(url, { method: 'POST' })).status, 403);
  assert.throws(() => lab.claim(orchard, id), /workspace/);
  for (let i = 0; i < 2; i++) assert.match(await (await fetch(url)).text(), /Claim gift/);
  assert.equal(lab.one('SELECT count(*) n FROM vendor_order').n, 0);
  const result = await fetch(url, { method: 'POST', headers: { Origin: origin } });
  const link = (html) => html.match(/href="(\/reward\/[^"]+)"/)[1];
  const first = link(await result.text()),
    second = link(await (await fetch(url)).text());
  assert.notEqual(first, second);
  const reward = await fetch(origin + second);
  assert.equal(reward.status, 200);
  const choices = await reward.text();
  assert.match(choices, /sample-5/);
  assert.doesNotMatch(choices, /sample-6/);
  assert.equal(lab.offer(studio, id).state, 'claimed');
  assert.doesNotMatch(
    JSON.stringify(lab.all('SELECT * FROM receipt')) + JSON.stringify(lab.all('SELECT * FROM ledger')),
    /\/claim\/|\/reward\//,
  );
});
