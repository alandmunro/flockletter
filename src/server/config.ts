export type Config = {
  environment: 'local' | 'test' | 'staging'; origin: string; host: string; port: number;
  localIdentity: boolean; databaseUrl?: string; clerkSecretKey?: string; clerkPublishableKey?: string;
};
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const environment = env.APP_ENV ?? 'local';
  if (!['local', 'test', 'staging'].includes(environment)) throw new Error('Only local, test and staging environments are supported by this foundation.');
  const port = Number(env.PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port.');
  const origin = env.APP_ORIGIN ?? 'http://127.0.0.1:4310';
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password) throw new Error('APP_ORIGIN must be a single exact origin.');
  const host = env.HOST ?? (environment === 'staging' ? '0.0.0.0' : '127.0.0.1');
  const localIdentity = env.LOCAL_TEST_IDENTITY === 'true';
  if (localIdentity && (environment === 'staging' || env.RENDER || env.NODE_ENV === 'production' || host !== '127.0.0.1' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:')) throw new Error('Synthetic identity is permitted only on a local loopback development/test server.');
  if (environment === 'staging' && url.protocol !== 'https:') throw new Error('Staging requires HTTPS.');
  return { environment: environment as Config['environment'], origin, host, port, localIdentity, databaseUrl: env.DATABASE_URL, clerkSecretKey: env.CLERK_SECRET_KEY, clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY };
}
export const configurationGaps = (c: Config) => [
  ...(!c.databaseUrl ? ['database_not_configured'] : []),
  ...(!c.localIdentity && (!c.clerkSecretKey || !c.clerkPublishableKey) ? ['clerk_not_configured'] : []),
];
