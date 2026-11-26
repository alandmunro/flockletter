import { enrollmentDraftFields, type DraftAccess, type EnrollmentDraftFields } from '../shared/texting-onboarding.js';

export type BrowserDraft = { version: string; fields: EnrollmentDraftFields };
export const draftStorageKey = (id: string) => 'flockletter.texting.draft.' + id;
const toBase64 = (data: Uint8Array) => btoa(String.fromCharCode(...data));
const fromBase64 = (encoded: string) => Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
const conflict = 'Another tab changed this draft. Reload Texting to review it.';

function cipherKey(access: DraftAccess) {
  return crypto.subtle.importKey('raw', fromBase64(access.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function envelope(raw: string) {
  if (raw.length > 32_000) throw Error('Invalid private draft.');
  const data = JSON.parse(raw);
  if (typeof data?.version !== 'string' || typeof data.iv !== 'string' || typeof data.ciphertext !== 'string')
    throw Error('Invalid private draft.');
  return { version: data.version as string, iv: data.iv as string, ciphertext: data.ciphertext as string };
}

export async function readBrowserDraft(access: DraftAccess): Promise<BrowserDraft | null> {
  const raw = localStorage.getItem(draftStorageKey(access.id));
  if (!raw) return null;
  const data = envelope(raw);
  const binding = new TextEncoder().encode(access.id + '/' + data.version);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(data.iv), additionalData: binding },
    await cipherKey(access), fromBase64(data.ciphertext));
  return { version: data.version, fields: enrollmentDraftFields.parse(JSON.parse(new TextDecoder().decode(plain))) };
}

function checkVersion(storage: string, expected: string | null) {
  const raw = localStorage.getItem(storage);
  if ((raw ? envelope(raw).version : null) !== expected) throw Error(conflict);
}

export async function writeBrowserDraft(access: DraftAccess, fields: EnrollmentDraftFields | null, expected: string | null) {
  const storage = draftStorageKey(access.id);
  if (!navigator.locks) throw Error('Private draft storage is unavailable in this browser.');
  return navigator.locks.request(storage, async () => {
    checkVersion(storage, expected);
    if (!fields) { localStorage.removeItem(storage); return null; }
    const version = crypto.randomUUID();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const binding = new TextEncoder().encode(access.id + '/' + version);
    const plain = new TextEncoder().encode(JSON.stringify(enrollmentDraftFields.parse(fields)));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: binding }, await cipherKey(access), plain);
    localStorage.setItem(storage, JSON.stringify({ version, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) }));
    return version;
  });
}

export async function acceptBrowserDraft(id: string, expected: string | null, accept: () => Promise<unknown>) {
  const storage = draftStorageKey(id);
  // Storage may be disabled entirely. Completing the ordinary form still works in that case.
  try { localStorage.getItem(storage); } catch { await accept(); return; }
  const finish = async () => {
    checkVersion(storage, expected);
    await accept();
    localStorage.removeItem(storage);
  };
  if (navigator.locks) await navigator.locks.request(storage, finish);
  else await finish();
}
