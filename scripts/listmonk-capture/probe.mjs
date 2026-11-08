import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createServer } from 'node:http';
import { once } from 'node:events';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { URLSearchParams } from 'node:url';

const { fetch, AbortSignal } = globalThis;
const engine = 'http://engine:9000';
const password = process.env.LISTMONK_ADMIN_PASSWORD;
const sharedSecret = process.env.FIXTURE_CAPTURE_SECRET;
assert.ok(password && sharedSecret, 'Missing disposable fixture credentials');

async function waitUntil(check, description) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(200);
  }
  throw Error('Timed out waiting for ' + description);
}

const captured = [];
const captureAuthorization = 'Basic ' + Buffer.from('fixture:' + sharedSecret).toString('base64');
const capture = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/message') return response.writeHead(404).end();
  if (request.headers.authorization !== captureAuthorization) return response.writeHead(401).end();
  if (request.headers['content-type'] !== 'application/json') return response.writeHead(415).end();
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 65536) return response.writeHead(413).end();
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    captured.push(payload);
    response.writeHead(200).end();
  } catch {
    response.writeHead(400).end();
  }
});

async function prove() {
  await waitUntil(async () => {
    try {
      return (await fetch(engine + '/health', { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  }, 'the isolated engine');
  const login = await fetch(engine + '/admin/login', {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
    body: new URLSearchParams({ username: 'fixture-owner', password }),
  });
  assert.equal(login.status, 302, 'Fixture login failed');
  const session = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .find((value) => value.startsWith('session='));
  assert.ok(session, 'Fixture login did not return a local session cookie');
  async function api(method, path, body) {
    const result = await fetch(engine + '/api' + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { cookie: session, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(result.status, 200, method + ' ' + path + ' failed with ' + result.status);
    return (await result.json()).data;
  }
  const list = await api('POST', '/lists', { name: 'Field notes fixture', type: 'private', optin: 'double' });
  const contact = await api('POST', '/subscribers', {
    email: 'reader@campaign.test',
    name: 'Casey Field',
    status: 'enabled',
    lists: [list.id],
    preconfirm_subscriptions: true,
  });
  const pending = await api('POST', '/subscribers', {
    email: 'pending@example.test',
    name: 'Pending Reader',
    status: 'enabled',
    lists: [list.id],
    preconfirm_subscriptions: false,
  });
  for (const [id, expected] of [
    [contact.id, 'confirmed'],
    [pending.id, 'unconfirmed'],
  ]) {
    const sub = await api('GET', '/subscribers/' + id);
    assert.equal(sub.lists.find((item) => item.id === list.id)?.subscription_status, expected);
  }
  const layout = await api('POST', '/templates', {
    name: 'Fixture body only',
    type: 'campaign',
    body: '{{ template "content" . }}',
  });
  const campaign = await api('POST', '/campaigns', {
    name: 'November field notes',
    type: 'regular',
    lists: [list.id],
    messenger: 'fixture',
    content_type: 'plain',
    template_id: layout.id,
    subject: 'Field notes for {{ .Subscriber.Name }}',
    from_email: 'Field Notes <sender@example.test>',
    body: 'Hello {{ .Subscriber.Name }},\nThe trail opens Friday.',
  });
  assert.equal(campaign.status, 'draft');
  assert.equal(contact.email, 'reader@campaign.test');
  const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
  assert.match(contact.uuid, uuid);
  assert.match(campaign.uuid, uuid);
  await api('PUT', '/campaigns/' + campaign.id + '/status', { status: 'running' });
  let finished;
  await waitUntil(async () => {
    finished = await api('GET', '/campaigns/' + campaign.id);
    assert.ok(
      ['running', 'finished'].includes(finished.status),
      'Unexpected campaign state ' + finished.status,
    );
    return finished.status === 'finished';
  }, 'the engine to finish its campaign');
  assert.equal(finished.sent, 1);
  assert.equal(captured.length, 1, 'Expected one HTTP callback for the confirmed subscriber only');
  assertCapture(captured[0], {
    campaignUUID: campaign.uuid,
    subscriberUUID: contact.uuid,
    email: contact.email,
    subject: 'Field notes for Casey Field',
    body: 'Hello Casey Field,\nThe trail opens Friday.',
  });
  await verifyStudio(api, list, layout, contact);
  console.log(
    'Listmonk 6.2.0 finished. One confirmed recipient reached the private HTTP messenger; the unconfirmed recipient was excluded. Campaign UUID, subscriber UUID, rendered subject and body matched.',
  );
}

// Only immutable application-rendered strings reach this fixture. Encode the Go string literal so
// neither Listmonk shorthand rewriting nor template evaluation can interpret customer-authored text.
function literal(value, asHtml = false) {
  const quoted = JSON.stringify(value).replace(
    /[{}<>]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
  return '{{ ' + (asHtml ? 'Safe ' : '') + quoted + ' }}';
}
async function verifyStudio(api, list, layout, contact) {
  const snapshot = JSON.parse(process.env.FLOCKLETTER_STUDIO_FIXTURE);
  assert.ok(snapshot.html.includes('<!--[if mso]'));
  assert.equal(snapshot.html.split('src="cid:' + snapshot.digest + '"').length - 1, 3);
  assert.ok(snapshot.text.includes('{{ .Subscriber.Email }}'));
  for (const [type, body] of [
    ['html', snapshot.html],
    ['plain', snapshot.text],
  ]) {
    const before = captured.length;
    const campaign = await api('POST', '/campaigns', {
      name: 'Studio ' + type,
      type: 'regular',
      lists: [list.id],
      messenger: 'fixture',
      template_id: layout.id,
      content_type: type,
      subject: literal(snapshot.subject),
      from_email: 'Studio <sender@example.test>',
      body: literal(body, true),
      ...(type === 'html' ? { altbody: literal(snapshot.text, true) } : {}),
    });
    const saved = await api('GET', '/campaigns/' + campaign.id);
    if (type === 'html') assert.equal(saved.altbody, literal(snapshot.text, true));
    await api('PUT', '/campaigns/' + campaign.id + '/status', { status: 'running' });
    await waitUntil(
      async () => (await api('GET', '/campaigns/' + campaign.id)).status === 'finished',
      'the Studio ' + type + ' capture',
    );
    assert.equal(captured.length, before + 1, 'Only the confirmed synthetic recipient reaches the messenger');
    assertCapture(captured[before], {
      campaignUUID: campaign.uuid,
      subscriberUUID: contact.uuid,
      email: contact.email,
      subject: snapshot.subject,
      body,
      contentType: type,
    });
  }
  console.log(
    'Studio HTML and text each survived the isolated Listmonk messenger byte-for-byte, including original image CID, Outlook conditional markup and literal template-like text.',
  );
}

capture.listen(8080, '0.0.0.0');
await once(capture, 'listening');
try {
  await prove();
} finally {
  await new Promise((resolve) => capture.close(resolve));
}

function assertCapture(payload, expected) {
  const { campaignUUID, subscriberUUID, email, subject, body } = expected;
  assert.equal(payload?.subject, subject);
  assert.equal(payload?.body, body);
  assert.equal(payload?.content_type, expected.contentType ?? 'plain');
  assert.equal(payload?.campaign?.uuid, campaignUUID);
  assert.ok(Array.isArray(payload?.recipients));
  assert.equal(payload.recipients.length, 1);
  const [recipient] = payload.recipients;
  assert.equal(recipient?.uuid, subscriberUUID);
  assert.equal(recipient?.email, email);
  assert.equal(recipient?.status, 'enabled');
}
