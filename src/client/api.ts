import type { CommandName } from '../shared/contracts.js';
export type TokenGetter = (refresh?: boolean) => Promise<string | null>;
export class ApiError extends Error {
  readonly code:string;
  constructor(readonly status:number,code:unknown,message:string){
    super(message);this.name='ApiError';
    this.code=typeof code==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(code)?code:'request_failed';
  }
}
const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 60_000;
const LONG_COMMANDS = new Set<string>([
  'asset.uploadBatch',
  'audience.previewImport',
  'audience.applyPracticeImport',
  'audienceOnboarding.import',
  'audienceOnboarding.queueImport',
  'campaign.previewImport',
  'campaign.commitImport',
]);

export async function readJsonSafe<T>(response: Response): Promise<T | null> {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function fetchWithTimeout(input: string, options: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    return await fetch(input, { ...options, signal });
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ApiError(408, 'request_timeout', 'The request timed out. Retry with the same operation key.');
    }
    throw error;
  }
}

export function client(getToken: TokenGetter) {
  async function request(path: string, options: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS, retryVerification = false) {
    const token = await getToken();
    if (!token) throw new Error('Your sign-in expired. Sign in again to continue.');
    const send = (bearer: string) => {
      const headers = new Headers(options.headers);
      headers.set('authorization', `Bearer ${bearer}`);
      return fetchWithTimeout(path, { ...options, headers, cache: 'no-store' }, timeoutMs);
    };
    let bearer = token;
    let response = await send(bearer);
    if (response.status === 401) {
      const rejection = await readJsonSafe<{error?: {code?: string}}>(response.clone());
      if (rejection?.error?.code !== 'sign_in_required') return response;
      // Authentication rejected the request before executing the command.
      const refreshed = await getToken(true);
      if (!refreshed || refreshed === token) return response;
      bearer = refreshed;
      response = await send(bearer);
    }
    if (retryVerification) {
      // Reuse this tenant's token and the original operation key across brief service failures.
      for (const delayMs of [1000, 3000]) {
        if (response.status !== 500 && response.status !== 503) break;
        const rejection = await readJsonSafe<{error?: {code?: string}}>(response.clone());
        if (!['service_error', 'membership_unavailable', 'workspace_busy'].includes(rejection?.error?.code ?? '')) break;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        response = await send(bearer);
      }
    }
    return response;
  }
  return {
    async call<T>(name: CommandName, input: unknown): Promise<T> {
      const retryVerification = name === 'sms.onboardingVerify' || name === 'sms.onboardingStatus';
      const timeoutMs = LONG_COMMANDS.has(name) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
      const response = await request(`/api/v1/commands/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }, timeoutMs, retryVerification);
      const data = await readJsonSafe<{ result: T; error?: { code?:unknown;message: string; details?: { path: string; message: string }[] } }>(response);
      if (!response.ok) {
        const message = data?.error
          ? [data.error.message ?? 'Request failed.', ...data.error.details?.map(d => `${d.path}: ${d.message}`) ?? []].join(' ')
          : response.status >= 500
            ? 'Flockletter is temporarily unavailable. Retry in a moment.'
            : `Request failed (HTTP ${response.status}).`;
        throw new ApiError(response.status, data?.error?.code ?? (response.status >= 500 ? 'service_unavailable' : 'request_failed'), message);
      }
      if (!data || !('result' in data)) throw new ApiError(502, 'invalid_response', 'Received an unexpected response from Flockletter. Retry in a moment.');
      return data.result;
    },
    async asset(id: string, format: 'blob' | 'data' = 'blob') {
      const response = await request(`/api/v1/assets/${id}`, {}, LONG_TIMEOUT_MS);
      if (!response.ok) throw new Error('This image is unavailable.');
      const blob = await response.blob();
      if (format === 'blob') return URL.createObjectURL(blob);
      // A sandboxed email iframe has an opaque origin and cannot read app-owned blob URLs.
      return imageDataUrl(blob);
    },
  };
}
export type Api = ReturnType<typeof client>;
export const operationKey = () => crypto.randomUUID();
export function imageDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('This image could not be previewed.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}
export function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}
