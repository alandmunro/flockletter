import type { CommandName } from '../shared/contracts.js';
export type TokenGetter = () => Promise<string | null>;
export function client(getToken: TokenGetter) {
  const headers = async () => {
    const token = await getToken();
    if (!token) throw new Error('Your sign-in expired. Sign in again to continue.');
    return { authorization: `Bearer ${token}` };
  };
  return {
    async call<T>(name: CommandName, input: unknown): Promise<T> {
      const response = await fetch(`/api/v1/commands/${name}`, { method: 'POST', headers: { ...await headers(), 'content-type': 'application/json' }, body: JSON.stringify(input), cache: 'no-store' });
      const data = await response.json() as { result: T; error?: { message: string; details?: { path: string; message: string }[] } };
      if (!response.ok) throw new Error([data.error?.message ?? 'Request failed.', ...data.error?.details?.map(d => `${d.path}: ${d.message}`) ?? []].join(' '));
      return data.result;
    },
    async asset(id: string) {
      const response = await fetch(`/api/v1/assets/${id}`, { headers: await headers(), cache: 'no-store' });
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
