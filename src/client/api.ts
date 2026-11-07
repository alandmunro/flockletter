import type { CommandName } from '../shared/contracts.js';
export type TokenGetter = (refresh?: boolean) => Promise<string | null>;
export function client(getToken: TokenGetter) {
  async function request(path: string, options: RequestInit = {}) {
    const token = await getToken();
    if (!token) throw new Error('Your sign-in expired. Sign in again to continue.');
    const send = (bearer: string) => {
      const headers = new Headers(options.headers);
      headers.set('authorization', `Bearer ${bearer}`);
      return fetch(path, { ...options, headers, cache: 'no-store' });
    };
    const response = await send(token);
    if (response.status !== 401) return response;
    const rejection = await response.clone().json().catch(() => null);
    // This response comes from authentication before the command is executed.
    if (rejection?.error?.code !== 'sign_in_required') return response;
    const refreshed = await getToken(true);
    return refreshed && refreshed !== token ? send(refreshed) : response;
  }
  return {
    async call<T>(name: CommandName, input: unknown): Promise<T> {
      const response = await request(`/api/v1/commands/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      const data = await response.json() as { result: T; error?: { message: string; details?: { path: string; message: string }[] } };
      if (!response.ok) throw new Error([data.error?.message ?? 'Request failed.', ...data.error?.details?.map(d => `${d.path}: ${d.message}`) ?? []].join(' '));
      return data.result;
    },
    async asset(id: string) {
      const response = await request(`/api/v1/assets/${id}`);
      if (!response.ok) throw new Error('This image is unavailable.');
      return URL.createObjectURL(await response.blob());
    },
  };
}
export type Api = ReturnType<typeof client>;
export const operationKey = () => crypto.randomUUID();
export function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}
