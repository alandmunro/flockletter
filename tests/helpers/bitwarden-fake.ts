import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { accessTokenKey } from '../../src/server/secrets/bitwarden.js';

// Encrypts a type-2 EncString the way Bitwarden does (AES-256-CBC + HMAC-SHA256 over iv||data).
function seal(plain: string | Buffer, key: { enc: Buffer; mac: Buffer }) {
  const iv = randomBytes(16), cipher = createCipheriv('aes-256-cbc', key.enc, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac('sha256', key.mac).update(Buffer.concat([iv, data])).digest();
  return `2.${iv.toString('base64')}|${data.toString('base64')}|${mac.toString('base64')}`;
}
/** A Bitwarden Secrets Manager stand-in. `values` maps project name to key/value pairs. */
export function fakeBitwarden(values?: Record<'flockletter-staging' | 'flockletter-production', Record<string, string>>) {
  const seed = randomBytes(16), clientId = randomUUID(), org = randomUUID();
  const orgKey = randomBytes(64), key = { enc: orgKey.subarray(0, 32), mac: orgKey.subarray(32) };
  const staging = randomUUID(), production = randomUUID();
  const chosen = values ?? { 'flockletter-staging': { FLOCKLETTER_TWILIO_ACCOUNT_SID: 'AC-staging-value' }, 'flockletter-production': { FLOCKLETTER_TWILIO_AUTH_TOKEN: 'production-only-value' } };
  const secrets = Object.entries(chosen).flatMap(([project, pairs]) => Object.entries(pairs).map(([name, value]) =>
    ({ id: randomUUID(), key: seal(name, key), value: seal(value, key), projects: [{ id: project === 'flockletter-staging' ? staging : production }] })));
  const jwt = ['e30', Buffer.from(JSON.stringify({ organization: org })).toString('base64url'), 'sig'].join('.');
  const calls: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push(new URL(url).pathname);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/connect/token')) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get('client_id') !== clientId || form.get('scope') !== 'api.secrets') return new Response('{}', { status: 400 });
      return json({ access_token: jwt, encrypted_payload: seal(JSON.stringify({ encryptionKey: orgKey.toString('base64') }), accessTokenKey(seed)) });
    }
    if (url.endsWith(`/organizations/${org}/projects`)) return json({ data: [{ id: staging, name: seal('flockletter-staging', key) }, { id: production, name: seal('flockletter-production', key) }] });
    if (url.endsWith(`/organizations/${org}/secrets`)) return json({ secrets: secrets.map(s => ({ id: s.id, projects: s.projects })) });
    if (url.endsWith('/secrets/get-by-ids')) { const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids; return json({ data: secrets.filter(s => ids.includes(s.id)) }); }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { token: `0.${clientId}.secretpart:${seed.toString('base64')}`, fetcher, calls };
}

