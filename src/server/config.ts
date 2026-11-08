import {loadInvitationBinding,type InvitationBinding} from './team-invitation-provider.js';
export type Config = {
  environment: 'local' | 'test' | 'staging' | 'production'; origin: string; browserOrigins: string[]; host: string; port: number;
  localIdentity: boolean; databaseUrl?: string; clerkSecretKey?: string; clerkPublishableKey?: string;
  invitationBinding?: InvitationBinding;
};
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const environment = env.APP_ENV ?? 'local';
  if (!['local', 'test', 'staging', 'production'].includes(environment)) throw new Error('APP_ENV must name a supported environment.');
  const port = Number(env.PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port.');
  const origin = env.APP_ORIGIN ?? 'http://127.0.0.1:4310';
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password) throw new Error('APP_ORIGIN must be a single exact origin.');
  const hosted = environment === 'staging' || environment === 'production';
  const host = env.HOST ?? (hosted ? '0.0.0.0' : '127.0.0.1');
  const localIdentity = env.LOCAL_TEST_IDENTITY === 'true';
  if (localIdentity && (hosted || env.RENDER || env.NODE_ENV === 'production' || host !== '127.0.0.1' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:')) throw new Error('Synthetic identity is permitted only on a local loopback development/test server.');
  if (hosted && url.protocol !== 'https:') throw new Error('Hosted environments require HTTPS.');
  const aliases = (env.APP_ADDITIONAL_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (aliases.length && (localIdentity || !hosted)) {
    throw new Error('Additional browser origins require an authenticated hosted environment.');
  }
  for (const alias of aliases) {
    const parsed = new URL(alias);
    if (parsed.protocol !== 'https:' || parsed.origin !== alias || parsed.hostname.includes('*')) {
      throw new Error('Each additional browser origin must be an exact HTTPS origin.');
    }
  }
  const browserOrigins = [...new Set([origin, ...aliases])];
  if(environment==='production' && (!env.CLERK_PUBLISHABLE_KEY?.startsWith('pk_live_') || !env.CLERK_SECRET_KEY?.startsWith('sk_live_')))
    throw new Error('Production requires a dedicated Clerk production instance.');
  return { environment: environment as Config['environment'], origin, browserOrigins, host, port, localIdentity, databaseUrl: env.DATABASE_URL, clerkSecretKey: env.CLERK_SECRET_KEY, clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY, invitationBinding:loadInvitationBinding(env) };
}
export const configurationGaps = (c: Config) => [
  ...(!c.databaseUrl ? ['database_not_configured'] : []),
  ...(!c.localIdentity && (!c.clerkSecretKey || !c.clerkPublishableKey) ? ['clerk_not_configured'] : []),
];
