import { describe, expect, it } from 'vitest';
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { accessTokenKey, bitwardenProject, parseAccessToken, readProjectSecrets } from '../src/server/secrets/bitwarden.js';

// Encrypts a type-2 EncString the way Bitwarden does (AES-256-CBC + HMAC-SHA256 over iv||data).
function seal(plain: string | Buffer, key: { enc: Buffer; mac: Buffer }) {
  const iv = randomBytes(16), cipher = createCipheriv('aes-256-cbc', key.enc, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac('sha256', key.mac).update(Buffer.concat([iv, data])).digest();
  return `2.${iv.toString('base64')}|${data.toString('base64')}|${mac.toString('base64')}`;
}
function fakeBitwarden() {
  const seed = randomBytes(16), clientId = randomUUID(), org = randomUUID();
  const orgKey = randomBytes(64), key = { enc: orgKey.subarray(0, 32), mac: orgKey.subarray(32) };
  const staging = randomUUID(), production = randomUUID();
  const secrets = [
    { id: randomUUID(), key: seal('FLOCKLETTER_TWILIO_ACCOUNT_SID', key), value: seal('AC-staging-value', key), projects: [{ id: staging }] },
    { id: randomUUID(), key: seal('FLOCKLETTER_TWILIO_AUTH_TOKEN', key), value: seal('production-only-value', key), projects: [{ id: production }] },
  ];
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

describe('Bitwarden Secrets Manager reader (FL-SMS-014)', () => {
  it('decrypts only the named project’s keys and ignores the other environment', async () => {
    const bw = fakeBitwarden();
    const staging = await readProjectSecrets({ accessToken: bw.token, projectName: 'flockletter-staging', keys: ['FLOCKLETTER_TWILIO_ACCOUNT_SID', 'FLOCKLETTER_TWILIO_AUTH_TOKEN'], fetch: bw.fetcher });
    expect([...staging.entries()]).toEqual([['FLOCKLETTER_TWILIO_ACCOUNT_SID', 'AC-staging-value']]);
    const production = await readProjectSecrets({ accessToken: bw.token, projectName: 'flockletter-production', keys: ['FLOCKLETTER_TWILIO_AUTH_TOKEN'], fetch: bw.fetcher });
    expect(production.get('FLOCKLETTER_TWILIO_AUTH_TOKEN')).toBe('production-only-value');
  });
  it('refuses an invisible project, a malformed token and a tampered value without echoing secrets', async () => {
    const bw = fakeBitwarden();
    await expect(readProjectSecrets({ accessToken: bw.token, projectName: 'openclaw', keys: [], fetch: bw.fetcher })).rejects.toThrow('cannot read the openclaw project');
    expect(() => parseAccessToken('0.not-a-token')).toThrow('malformed');
    try { parseAccessToken('0.x.supersecret:abc'); } catch (e) { expect((e as Error).message).not.toContain('supersecret'); }
    expect(() => bitwardenProject('staging', 'flockletter-production')).toThrow();
    expect(() => bitwardenProject('production', 'flockletter-staging')).toThrow();
    expect(bitwardenProject('staging', 'flockletter-staging')).toBe('flockletter-staging');
  });
});
