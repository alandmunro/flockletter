import type { CommandName } from '../shared/contracts.js';
export type TokenGetter = (refresh?: boolean) => Promise<string | null>;
export class ApiError extends Error {
  readonly code:string;
  constructor(readonly status:number,code:unknown,message:string){
    super(message);this.name='ApiError';
    this.code=typeof code==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(code)?code:'request_failed';
  }
}
export function client(getToken: TokenGetter) {
  async function request(path: string, options: RequestInit = {}, retryVerification = false) {
    const token = await getToken();
    if (!token) throw new Error('Your sign-in expired. Sign in again to continue.');
    const send = (bearer: string) => {
      const headers = new Headers(options.headers);
      headers.set('authorization', `Bearer ${bearer}`);
      return fetch(path, { ...options, headers, cache: 'no-store' });
    };
    let bearer = token;
    let response = await send(bearer);
    if (response.status === 401) {
      const rejection = await response.clone().json().catch(() => null);
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
        const rejection = await response.clone().json().catch(() => null);
        if (!['service_error', 'membership_unavailable', 'workspace_busy'].includes(rejection?.error?.code)) break;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        response = await send(bearer);
      }
    }
    return response;
  }
  return {
    async call<T>(name: CommandName, input: unknown): Promise<T> {
      const retryVerification = name === 'sms.onboardingVerify' || name === 'sms.onboardingStatus';
      const response = await request(`/api/v1/commands/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }, retryVerification);
      const data = await response.json() as { result: T; error?: { code?:unknown;message: string; details?: { path: string; message: string }[] } };
      if (!response.ok) throw new ApiError(response.status,data.error?.code,[data.error?.message ?? 'Request failed.', ...data.error?.details?.map(d => `${d.path}: ${d.message}`) ?? []].join(' '));
      return data.result;
    },
    async asset(id: string, format: 'blob' | 'data' = 'blob') {
      const response = await request(`/api/v1/assets/${id}`);
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
