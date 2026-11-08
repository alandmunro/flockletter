import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { stdin, stdout, env } from 'node:process';
import { URLSearchParams } from 'node:url';
import { ListmonkTestProvider } from './listmonk-test-provider.ts';

const { fetch, AbortSignal } = globalThis;
const engine = 'http://engine:9000';
const { FIXTURE_CAPTURE_SECRET: secret, FIXTURE_WORKSPACE: workspaceId, FIXTURE_BRAND: brandId } = env;
assert(secret && workspaceId && brandId);
const authorization = 'Basic ' + Buffer.from('fixture:' + secret).toString('base64');
const acceptedCalls = [];
let submissions = 0;

const decode = (message) => ({
  ...message,
  images: message.images.map((image) => ({ ...image, bytes: Buffer.from(image.bytes, 'base64') })),
});

// Only the private messenger knows this credential. Its receipt is authoritative only for the
// registered operation that matches this caller's exact reviewed recipient, message and photos.
function assertWorkerCapture(payload, message, reference) {
  assert.equal(payload.from_email, reference);
  assert.ok(Array.isArray(payload.recipients));
  assert.equal(payload.recipients.length, 1);
  assert.equal(payload.recipients[0]?.email, message.to);
  assert.equal(payload.subject, message.subject);
  assert.equal(payload.content_type, 'html');
  assert.equal(payload.body, message.html);
  const files = payload.attachments ?? [];
  assert.ok(Array.isArray(files));
  assert.equal(files.length, message.images.length);
  for (const [index, image] of message.images.entries()) {
    const attachment = files[index];
    assert.equal(attachment?.name, image.name);
    assert.equal(attachment.header?.['Content-Type']?.[0]?.split(';')[0], image.mime);
    assert.equal(typeof attachment.content, 'string');
    const observed = Buffer.from(attachment.content, 'base64');
    assert.deepEqual(observed, image.bytes);
    assert.equal(createHash('sha256').update(observed).digest('hex'), image.sha256);
  }
}

const capture = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/message') return response.writeHead(404).end();
  if (request.headers.authorization !== authorization) return response.writeHead(401).end();
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) return response.writeHead(413).end();
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const reference = payload.from_email;
    assert.match(reference, /^fl-[a-f0-9]{56}@receipt\.test$/);
    const message = decode(JSON.parse(await readFile('/fixture/' + reference + '.json', 'utf8')));
    assertWorkerCapture(payload, message, reference);
    await writeFile('/fixture/' + reference + '.accepted', 'accepted');
    acceptedCalls.push(message.to);
    response.writeHead(200).end();
  } catch {
    response.writeHead(422).end();
  }
});
capture.listen(8080, '0.0.0.0');
await once(capture, 'listening');
try {
  const login = await fetch(engine + '/admin/login', {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
    body: new URLSearchParams({ username: 'fixture-owner', password: env.LISTMONK_ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 302);
  const session = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .find((value) => value.startsWith('session='));
  assert(session);
  const template = await fetch(engine + '/api/templates', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: { cookie: session, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Flockletter fixture transaction',
      type: 'tx',
      subject: 'Field notes',
      body: '{{ Safe .Tx.Data.html }}',
    }),
  });
  assert.equal(template.status, 200);
  const templateId = (await template.json()).data.id;
  const provider = new ListmonkTestProvider({
    workspaceId,
    brandId,
    session,
    templateId,
    async reserve(reference, envelope) {
      const expected = {
        ...envelope,
        images: envelope.images.map((image) => ({ ...image, bytes: image.bytes.toString('base64') })),
      };
      try {
        await writeFile('/fixture/' + reference + '.json', JSON.stringify(expected), {
          flag: 'wx',
          mode: 0o600,
        });
        return true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const registered = JSON.parse(await readFile('/fixture/' + reference + '.json', 'utf8'));
        assert.deepEqual(expected, registered, 'Conflicting content for this reserved operation');
        return false;
      }
    },
    async accepted(reference) {
      try {
        return (await readFile('/fixture/' + reference + '.accepted', 'utf8')) === 'accepted';
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    },
  });
  const reply = (value) => stdout.write(JSON.stringify(value) + '\n');
  reply({ ready: true });
  for await (const line of createInterface({ input: stdin })) {
    const request = JSON.parse(line);
    switch (request.action) {
      case 'submit': {
        submissions++;
        const state = await provider.submit(decode(request.message));
        // Drop only the worker-facing acknowledgment, after Listmonk has been contacted.
        reply(request.loseAcknowledgment ? 'unknown' : state);
        break;
      }
      case 'lookup':
        reply(await provider.lookup(request.operationKey));
        break;
      case 'stats':
        reply({ submissions, acceptedCalls });
        break;
      default:
        throw new Error('Unknown fixture request');
    }
  }
} finally {
  await new Promise((resolve) => capture.close(resolve));
}
