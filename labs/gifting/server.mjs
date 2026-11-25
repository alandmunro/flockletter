import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { catalog, thankYou, workspaces } from './fixtures.mjs';
import { GiftLab } from './lab.mjs';
import { purchase, exampleCampaign, runExample } from './scenario.mjs';

const money = (cents) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const options = (values) => values.map((v) => `<option>${escape(v)}</option>`).join('');
const form = (action, button, fields = '') =>
  `<form method="post" action="${escape(action)}">${fields}<button>${escape(button)}</button></form>`;
const select = (name, label, values) =>
  `<label>${label}<select name="${name}">${options(values)}</select></label>`;
const page = (title, content) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)} · Gift lab</title><link rel="stylesheet" href="/lab.css"></head><body><header><strong>Flockletter</strong><span>Local gift lab · simulated USD</span></header><main><h1>${escape(title)}</h1>${content}</main></body></html>`;
function claimPath(lab, name, id) {
  return '/claim/' + name + '/' + id + '/' + lab.signature('recipient', name + '/' + id);
}
function recipient(lab, name, id, path) {
  const o = lab.offer(name, id);
  let action = '';
  if (o.state === 'claimed') {
    // Fresh, short-lived local stand-in for a provider-hosted link to the same reward.
    const { reward } = lab.one('SELECT reward FROM vendor_order WHERE external_id=?', id);
    const payload = [reward, Date.now() + 300000, randomUUID()].join('.');
    action = `<a href="/reward/${payload}/${lab.signature('redemption', payload)}">View simulated reward</a>`;
  } else if (o.state === 'offered' && o.expires > lab.day()) action = form(path, 'Claim gift');
  else if (o.state === 'pending') action = '<p>Your claim is pending. The lab worker will check again.</p>';
  else action = '<p>This offer has expired.</p>';
  return page(
    'Your thank-you gift',
    `<p>${thankYou}</p><p>${money(o.face)} · Expires on lab day ${o.expires}</p>${action}`,
  );
}
function dashboard(lab, name) {
  const path = '/workspace/' + name;
  const b = lab.balances(name),
    f = lab.funding(),
    offers = lab.offers(name),
    lots = lab.lots(name);
  const claimed = offers.filter((o) => o.state === 'claimed'),
    expired = offers.filter((o) => o.state === 'expired');
  const pending = offers.filter((o) => o.state === 'pending');
  const ledger = lab.all(
    `SELECT l.day,l.kind,l.available,l.reserved FROM ledger l JOIN purchase p ON p.id=l.lot
    WHERE p.workspace=? ORDER BY l.seq DESC LIMIT 12`,
    name,
  );
  return page(
    name,
    `<nav>${workspaces.map((w) => `<a href="/workspace/${w}">${w}</a>`).join(' ')}</nav>
    <p>Lab day ${lab.day()} · Account ${lab.access(name)}</p><section class="tiles">
    ${Object.entries({ Available: b.available, Reserved: b.reserved, Total: b.total })
      .map(([k, v]) => `<div>${k}<strong>${money(v)}</strong></div>`)
      .join('')}</section>
    <section><h2>Gift credit</h2>${form(path + '/buy', 'Simulate $550 purchase for $500 credit')}
    ${b.available < 2000 ? '<p>Available credit is below $20.</p>' : ''}</section>
    <section><h2>Appreciation campaign</h2>${
      offers.length
        ? `<p>${offers.length} recipients · ${claimed.length} claimed (${Math.round((claimed.length / offers.length) * 100)}%) · ${expired.length} expired · ${pending.length} pending</p>
    <p>Purchased ${money(claimed.reduce((n, o) => n + o.face, 0))} · Returned ${money(expired.reduce((n, o) => n + o.face, 0))}</p>
    <details><summary>Recipient offers</summary><ul>${offers.map((o) => `<li><a href="${claimPath(lab, name, o.id)}">Recipient ${o.person}</a> · ${o.state} · day ${o.claimed_day ?? o.expires}</li>`).join('')}</ul></details>`
        : form(
            path + '/launch',
            'Reserve gifts',
            select('count', 'Recipients', [100, 5, 1]) +
              select('days', 'Duration in days', [30, 15, 60]) +
              select('products', 'Product choices', [5, 1, 10]),
          )
    }</section>
    <section><h2>Worker and platform</h2><p>Open liability ${money(f.liability)} · Buffer ${money(f.buffer)} · Settled funds ${money(f.funds)} · Funding gap ${money(f.shortfall)}</p>
    <p>Provider mode: ${escape(lab.one('SELECT fault FROM platform').fault)}. Pending claims retry every 5 seconds.</p>
    ${pending.map((o) => `<p>Recipient ${o.person}: ${escape(lab.offer(name, o.id).issue ?? 'Awaiting lookup')}</p>`).join('')}
    ${form(path + '/fault', 'Set provider mode', select('mode', 'Scenario', ['healthy', 'outage', 'timeout', 'review', 'unavailable']))}
    ${form(path + '/funds', 'Set simulated settled balance', select('cents', 'Platform funds (USD cents)', [0, 10000, 100000]))}
    ${form(path + '/approve', 'Approve simulated orders in review')}${form(path + '/advance', 'Advance lab clock', select('days', 'Days', [1, 6, 15, 30, 60]))}</section>
    <section><h2>Disputes and refunds</h2>${lots
      .map(
        (l) => `<p>Purchase ${escape(l.id)} · ${money(l.face)} credit · dispute ${l.dispute}</p>
    ${l.dispute !== 'none' ? `<a href="/evidence/${name}/${encodeURIComponent(l.id)}">View dispute evidence</a>` : ''}
    ${!l.refunded && l.refund_face === null && ['none', 'open'].includes(l.dispute) ? form(path + '/dispute', 'Simulate dispute event', `<input type="hidden" name="lot" value="${escape(l.id)}">` + select('kind', 'Event', l.dispute === 'open' ? ['won', 'lost'] : ['open'])) : ''}
    ${l.refund_face && !l.refunded ? form(path + '/refund', 'Confirm simulated refund of ' + money(l.refund_face + l.refund_fee), `<input type="hidden" name="lot" value="${escape(l.id)}">`) : ''}`,
      )
      .join('')}
    ${form(path + '/close', 'Close workspace and prepare refunds')}</section>
    <section><h2>Latest ledger entries</h2><table><tr><th>Day</th><th>Entry</th><th>Available Δ</th><th>Reserved Δ</th></tr>
    ${ledger.map((l) => `<tr><td>${l.day}</td><td>${l.kind}</td><td>${money(l.available)}</td><td>${money(l.reserved)}</td></tr>`).join('')}</table></section>`,
  );
}

function operate(lab, name, action, data) {
  const day = Number(data.get('days'));
  switch (action) {
    case 'buy':
      if (lab.access(name) === 'closed') throw new Error('Workspace closed');
      return purchase(lab, name, randomUUID(), 50000);
    case 'launch': {
      const count = Number(data.get('count')),
        choices = Number(data.get('products'));
      if (![1, 5, 100].includes(count) || ![1, 5, 10].includes(choices)) throw new Error('Invalid fixture');
      return exampleCampaign(lab, name, count, day, catalog.slice(0, choices));
    }
    case 'advance':
      return lab.tick(day);
    case 'fault': {
      const mode = data.get('mode');
      if (!['healthy', 'outage', 'timeout', 'review', 'unavailable'].includes(mode))
        throw new Error('Invalid scenario');
      return lab.run('UPDATE platform SET fault=?', mode);
    }
    case 'funds': {
      const cents = Number(data.get('cents'));
      if (![0, 10000, 100000].includes(cents)) throw new Error('Invalid fixture funds');
      return lab.run('UPDATE platform SET funds=?', cents);
    }
    case 'approve':
      for (const o of lab.offers(name).filter((o) => o.state === 'pending')) {
        const change = lab.run(
          "UPDATE vendor_order SET state='approved' WHERE external_id=? AND state='review'",
          o.id,
        );
        if (change.changes)
          lab.emit('rewards', {
            id: 'approved-' + o.id,
            kind: 'order.updated',
            workspace: name,
            offer: o.id,
          });
      }
      return;
    case 'close':
      return lab.closure(name);
    case 'refund':
    case 'dispute': {
      const lot = lab.lots(name).find((l) => l.id === data.get('lot'));
      if (!lot) throw new Error('Unknown purchase');
      const kind = action === 'refund' ? 'refunded' : data.get('kind');
      if (!['refunded', 'open', 'won', 'lost'].includes(kind)) throw new Error('Invalid event');
      return lab.emit('stripe', {
        id: kind + '-' + lot.id,
        workspace: name,
        lot: lot.id,
        kind,
        currency: 'USD',
        total: kind === 'refunded' ? lot.refund_face + lot.refund_fee : lot.face + lot.fee,
      });
    }
    default:
      throw new Error('Unknown action');
  }
}
export function createLabServer(lab) {
  const server = createServer(async (req, res) => {
    const host = '127.0.0.1:' + server.address().port;
    res.setHeader('Cache-Control', 'no-store');
    // Browser POSTs carry the loopback origin. Claim and reward paths stay out of referrers.
    res.setHeader('Referrer-Policy', 'strict-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    function redirect(path) {
      res.writeHead(303, { Location: path });
      res.end();
    }
    try {
      if (req.headers.host !== host) {
        res.writeHead(403);
        res.end();
        return;
      }
      const path = new URL(req.url, 'http://' + host).pathname;
      const [, route, name, id] = path.split('/');
      if (req.method === 'POST' && req.headers.origin !== 'http://' + host) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (!['GET', 'POST'].includes(req.method)) {
        res.writeHead(405);
        res.end();
        return;
      }
      if (route === 'claim' && workspaces.includes(name) && path === claimPath(lab, name, id)) {
        if (req.method === 'POST') {
          lab.claim(name, id);
          redirect(path);
        } else res.end(recipient(lab, name, id, path));
      } else if (route === 'workspace' && workspaces.includes(name)) {
        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 2048) throw new Error('Form too large');
          }
          operate(lab, name, id, new URLSearchParams(body));
          redirect('/workspace/' + name);
        } else if (!id) res.end(dashboard(lab, name));
        else {
          res.writeHead(404);
          res.end();
        }
      } else if (req.method === 'GET' && route === 'evidence' && workspaces.includes(name)) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(lab.disputeEvidence(name, id), null, 2));
      } else if (
        req.method === 'GET' &&
        route === 'reward' &&
        id === lab.signature('redemption', name) &&
        Number(name.split('.')[1]) >= Date.now()
      ) {
        const reward = lab.one(
          "SELECT products FROM vendor_order WHERE reward=? AND state='approved'",
          name.split('.')[0],
        );
        if (!reward) {
          res.writeHead(404);
          res.end();
          return;
        }
        const choices = JSON.parse(reward.products);
        res.end(
          page(
            'Simulated provider reward',
            `<p>Products available for this gift</p><ul>${choices.map((p) => `<li>${escape(p)}</li>`).join('')}</ul><p>Store redemption is unobserved.</p>`,
          ),
        );
      } else if (req.method === 'GET' && path === '/lab.css') {
        res.setHeader('Content-Type', 'text/css');
        res.end(readFileSync(new URL('./lab.css', import.meta.url)));
      } else if (req.method === 'GET' && path === '/') redirect('/workspace/Studio');
      else {
        res.writeHead(404);
        res.end();
      }
    } catch (e) {
      res.writeHead(400);
      res.end(page('Action unavailable', `<p>${escape(e.message)}</p><a href="/">Return to the lab</a>`));
    }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--example')) console.log(JSON.stringify(runExample(), null, 2));
  else {
    const directory = new URL('../../.local/gifting-lab/', import.meta.url);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lab = new GiftLab(new URL('v1.sqlite', directory));
    const server = createLabServer(lab);
    server.listen(Number(process.env.GIFT_LAB_PORT ?? 0), '127.0.0.1', () => {
      console.log('Open the local gifting lab at http://127.0.0.1:' + server.address().port);
    });
    const worker = setInterval(() => lab.tick(0), 5000);
    function stop() {
      clearInterval(worker);
      server.close(() => lab.db.close());
    }
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
}
