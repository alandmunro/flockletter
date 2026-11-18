// A minimal Bitwarden Secrets Manager reader (FL-SMS-014). No dependency: the official SDK's licence
// is not compatible with this repository's licensing rules (owner decision, 2026-11-18).
// It reads only; it never logs a token, key or value, and keeps decrypted values in memory.
import { createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export type BitwardenEndpoints = { identity: string; api: string };
const defaultEndpoints: BitwardenEndpoints = { identity: 'https://identity.bitwarden.com', api: 'https://api.bitwarden.com' };
type Key = { enc: Buffer; mac: Buffer };

/** Parses `0.<client id>.<client secret>:<base64 key seed>` without echoing it on failure. */
export function parseAccessToken(token: string) {
  const match = /^0\.([0-9a-f-]{36})\.([A-Za-z0-9]+):([A-Za-z0-9+/=]+)$/.exec(token.trim());
  if (!match) throw Error('The Bitwarden machine-account token is malformed.');
  const seed = Buffer.from(match[3]!, 'base64');
  if (seed.length !== 16) throw Error('The Bitwarden machine-account token is malformed.');
  return { clientId: match[1]!, clientSecret: match[2]!, seed };
}
/** HKDF-Expand (RFC 5869, SHA-256) with a fixed PRK derived from the access-token seed. */
export function accessTokenKey(seed: Buffer): Key {
  const prk = createHmac('sha256', 'bitwarden-accesstoken').update(seed).digest();
  const okm = Buffer.alloc(64);
  let previous = Buffer.alloc(0);
  for (let i = 0, offset = 0; offset < 64; i++) {
    previous = createHmac('sha256', prk).update(Buffer.concat([previous, Buffer.from('sm-access-token'), Buffer.from([i + 1])])).digest();
    previous.copy(okm, offset); offset += previous.length;
  }
  return { enc: okm.subarray(0, 32), mac: okm.subarray(32, 64) };
}
/** Decrypts a type-2 EncString: AES-256-CBC with HMAC-SHA256 over iv||ciphertext. */
export function decryptEncString(value: string, key: Key): Buffer {
  const match = /^2\.([A-Za-z0-9+/=]+)\|([A-Za-z0-9+/=]+)\|([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw Error('Unsupported Bitwarden encryption type.');
  const [iv, data, mac] = [match[1]!, match[2]!, match[3]!].map(part => Buffer.from(part, 'base64')) as [Buffer, Buffer, Buffer];
  const expected = createHmac('sha256', key.mac).update(Buffer.concat([iv, data])).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) throw Error('A Bitwarden value failed its integrity check.');
  const decipher = createDecipheriv('aes-256-cbc', key.enc, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
const keyFrom = (bytes: Buffer): Key => { if (bytes.length !== 64) throw Error('Unexpected Bitwarden key length.'); return { enc: bytes.subarray(0, 32), mac: bytes.subarray(32) }; };

const tokenResponse = z.object({ access_token: z.string().min(1), encrypted_payload: z.string().min(1) });
const projectList = z.object({ data: z.array(z.object({ id: z.uuid(), name: z.string() })) });
const secretList = z.object({ secrets: z.array(z.object({ id: z.uuid(), projects: z.array(z.object({ id: z.uuid() })).optional() })) });
const secretValues = z.object({ data: z.array(z.object({ id: z.uuid(), key: z.string(), value: z.string(), projects: z.array(z.object({ id: z.uuid() })).optional() })) });

export type SecretsReadOptions = { accessToken: string; projectName: string; keys: readonly string[]; endpoints?: BitwardenEndpoints; fetch?: typeof fetch; timeoutMs?: number };
/**
 * Logs in with the machine-account token, checks that the named project is visible, and returns the
 * requested keys from that project only. Keys from any other project are ignored, so a token that can
 * also read another environment's project cannot load its values here.
 */
export async function readProjectSecrets(options: SecretsReadOptions): Promise<Map<string, string>> {
  const { clientId, clientSecret, seed } = parseAccessToken(options.accessToken);
  const endpoints = options.endpoints ?? defaultEndpoints, call = options.fetch ?? fetch, timeout = options.timeoutMs ?? 10000;
  const request = async (url: string, init: RequestInit) => {
    const response = await call(url, { ...init, signal: AbortSignal.timeout(timeout), redirect: 'error' });
    if (!response.ok) throw Error(`Bitwarden ${new URL(url).pathname.split('/').slice(0, 3).join('/')} returned ${response.status}.`);
    const text = await response.text();
    if (text.length > 4_000_000) throw Error('Bitwarden response too large.');
    return JSON.parse(text) as unknown;
  };
  const login = tokenResponse.parse(await request(endpoints.identity + '/connect/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'device-type': '21' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'api.secrets', client_id: clientId, client_secret: clientSecret }),
  }));
  const payload = z.object({ encryptionKey: z.string() }).parse(JSON.parse(decryptEncString(login.encrypted_payload, accessTokenKey(seed)).toString('utf8')));
  const orgKey = keyFrom(Buffer.from(payload.encryptionKey, 'base64'));
  const claims = z.object({ organization: z.uuid() }).parse(JSON.parse(Buffer.from(login.access_token.split('.')[1] ?? '', 'base64url').toString('utf8')));
  const auth = { authorization: 'Bearer ' + login.access_token, 'content-type': 'application/json' };
  const projects = projectList.parse(await request(`${endpoints.api}/organizations/${claims.organization}/projects`, { headers: auth }));
  const matching = projects.data.filter(project => decryptEncString(project.name, orgKey).toString('utf8') === options.projectName);
  if (matching.length !== 1) throw Error(`The machine account cannot read the ${options.projectName} project.`);
  const projectId = matching[0]!.id;
  const listed = secretList.parse(await request(`${endpoints.api}/organizations/${claims.organization}/secrets`, { headers: auth }));
  const ids = listed.secrets.filter(secret => secret.projects?.some(project => project.id === projectId)).map(secret => secret.id);
  const found = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const values = secretValues.parse(await request(`${endpoints.api}/secrets/get-by-ids`, { method: 'POST', headers: auth, body: JSON.stringify({ ids: ids.slice(i, i + 100) }) }));
    for (const secret of values.data) {
      if (!secret.projects?.some(project => project.id === projectId)) continue;
      const name = decryptEncString(secret.key, orgKey).toString('utf8');
      if (options.keys.includes(name)) {
        if (found.has(name)) throw Error(`The ${options.projectName} project holds ${name} twice.`);
        found.set(name, decryptEncString(secret.value, orgKey).toString('utf8'));
      }
    }
  }
  return found;
}

/** The project each deployment may read. Production never reads staging values and vice versa. */
export function bitwardenProject(environment: 'local' | 'test' | 'staging' | 'production', configured: string | undefined) {
  const expected = environment === 'production' ? 'flockletter-production' : environment === 'staging' ? 'flockletter-staging' : configured;
  if (!expected || configured !== expected) throw Error('BWS_PROJECT must name this environment’s Bitwarden project.');
  return expected;
}
