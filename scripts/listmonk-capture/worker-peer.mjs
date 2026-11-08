import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { stdin, stdout, env } from 'node:process';
import { URLSearchParams } from 'node:url';
import { reviewedListmonkMessage } from './listmonk-callback.js';
import { ListmonkTestProvider } from './listmonk-test-provider.js';

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

// A successful callback only queues the observed message. It is not an SES receipt.
const references = new Map();
async function storeOnce(filename, bytes) {
  try {
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST' || (await readFile(filename, 'utf8')) !== bytes) throw error;
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
    reviewedListmonkMessage(payload, message);
    await storeOnce('/fixture/' + reference + '.callback', JSON.stringify(payload));
    // Listmonk 6.2.0 requires a 200 acknowledgment for storing the callback.
    // Provider acceptance is recorded separately after the SDK receipt.
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
      references.set(envelope.operationKey, reference);
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
      case 'callback': {
        const reference = references.get(request.operationKey);
        assert(reference, 'Unknown operation');
        try {
          reply(JSON.parse(await readFile('/fixture/' + reference + '.callback', 'utf8')));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          reply(null);
        }
        break;
      }
      case 'acknowledge': {
        const reference = references.get(request.operationKey);
        assert(reference && request.providerId === 'offline-ses-' + request.operationKey);
        const message = decode(JSON.parse(await readFile('/fixture/' + reference + '.json', 'utf8')));
        reviewedListmonkMessage(
          JSON.parse(await readFile('/fixture/' + reference + '.callback', 'utf8')),
          message,
        );
        if ((await provider.lookup(request.operationKey)) !== 'accepted') acceptedCalls.push(message.to);
        await storeOnce('/fixture/' + reference + '.accepted', 'accepted');
        reply(true);
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
