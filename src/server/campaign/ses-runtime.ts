import { z } from 'zod';
import { createHash } from 'node:crypto';
import { createSesSimulatorPort, type SesSimulationBinding, type SesSimulatorPort } from './ses-simulator.js';
import { senderDomain } from '../../shared/sender.js';
import { createSesInspector, type ProviderChecks } from './ses-inspection.js';

const name = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const binding = z
  .object({
    workspaceId: z.string().regex(/^org_[A-Za-z0-9_-]{1,120}$/),
    brandId: z.uuid().transform((v) => v.toLowerCase()),
    region: z.enum(['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2']),
    accountId: z.string().regex(/^\d{12}$/),
    tenant: name,
    configurationSet: name,
    from: z.email().max(254),
    identityArn: z.string(),
    topicArn: z.string(),
  })
  .strict();
export type SesRoute = SesSimulationBinding & { topicArn: string; fingerprint: string };
export type SesRuntime = {
  route: SesRoute;
  port?: SesSimulatorPort;
  paused?: boolean;
  inspect?: () => Promise<ProviderChecks>;
  close?: () => void;
};
export type SesConfiguration =
  SesRuntime | { routes: readonly SesRuntime[]; port?: never; close: () => void };
export function parseSesRoute(raw: unknown): SesRoute {
  const b = binding.parse(raw),
    domain = b.from.split('@')[1]!;
  const senderPrefix = 'arn:aws:ses:' + b.region + ':' + b.accountId + ':identity/';
  const topicPrefix = 'arn:aws:sns:' + b.region + ':' + b.accountId + ':';
  if (
    !senderDomain.safeParse(domain).success ||
    ![senderPrefix + domain, senderPrefix + b.from].includes(b.identityArn) ||
    !b.topicArn.startsWith(topicPrefix) ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(b.topicArn.slice(topicPrefix.length))
  )
    throw Error(
      'The SES identity and dedicated SNS topic must match the configured account, sender and US region.',
    );
  return {
    ...b,
    fingerprint: createHash('sha256')
      .update(
        JSON.stringify([
          b.workspaceId,
          b.brandId,
          b.region,
          b.accountId,
          b.tenant,
          b.configurationSet,
          b.from,
          b.identityArn,
          b.topicArn,
        ]),
      )
      .digest('hex'),
  };
}
export function loadSesRuntime(env: NodeJS.ProcessEnv): SesConfiguration | undefined {
  const raw = env.FLOCKLETTER_SES_SIMULATOR_BINDING,
    accessKeyId = env.FLOCKLETTER_SES_ACCESS_KEY_ID,
    secretAccessKey = env.FLOCKLETTER_SES_SECRET_ACCESS_KEY,
    sessionToken = env.FLOCKLETTER_SES_SESSION_TOKEN;
  if (!raw && !accessKeyId && !secretAccessKey && !sessionToken) return;
  if (
    env.APP_ENV !== 'staging' ||
    !raw ||
    Boolean(accessKeyId) !== Boolean(secretAccessKey) ||
    (sessionToken && !secretAccessKey)
  )
    throw Error('SES simulator configuration requires an explicit, complete staging binding.');
  if (raw.length > 65536) throw Error('Too many SES simulator bindings.');
  const settings: unknown = JSON.parse(raw);
  const entries = z
    .array(binding.extend({ paused: z.boolean().optional() }))
    .min(1)
    .max(20)
    .parse(Array.isArray(settings) ? settings : [settings]);
  const routes = entries.map(({ paused, ...fields }) => ({
    route: parseSesRoute(fields),
    paused: paused === true,
  }));
  const workspaces = new Map<string, string>(),
    tenants = new Map<string, string>();
  const reserved = new Set<string>(),
    identities = new Map<string, string>();
  const pausedWorkspaces = new Set<string>();
  for (const { route: r, paused } of routes) {
    const tenant = [r.region, r.accountId, r.tenant].join('/');
    const ids = [
      'scope/' + r.workspaceId + '/' + r.brandId,
      'topic/' + r.topicArn,
      'set/' + r.region + '/' + r.accountId + '/' + r.configurationSet,
    ];
    if (
      ids.some((id) => reserved.has(id)) ||
      (tenants.has(tenant) && tenants.get(tenant) !== r.workspaceId) ||
      (workspaces.has(r.workspaceId) && workspaces.get(r.workspaceId) !== tenant) ||
      (identities.has(r.identityArn) && identities.get(r.identityArn) !== r.workspaceId)
    )
      throw Error('SES simulator bindings must use distinct tenant, sender, feedback and brand mappings.');
    ids.forEach((id) => reserved.add(id));
    tenants.set(tenant, r.workspaceId);
    workspaces.set(r.workspaceId, tenant);
    identities.set(r.identityArn, r.workspaceId);
    if (paused) pausedWorkspaces.add(r.workspaceId);
  }
  const scopes = routes.map(({ route }): SesRuntime => {
    const paused = pausedWorkspaces.has(route.workspaceId);
    if (!accessKeyId || !secretAccessKey) return { route, paused };
    const credentials = { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
    const inspector = createSesInspector(route, credentials);
    const port = paused ? undefined : createSesSimulatorPort(route, credentials, env.APP_ORIGIN);
    return {
      route,
      paused,
      port,
      inspect: inspector.check,
      close: () => {
        port?.destroy();
        inspector.close();
      },
    };
  });
  return scopes.length === 1
    ? scopes[0]!
    : { routes: scopes, close: () => scopes.forEach((s) => s.close?.()) };
}
export function sesScopes(runtime?: SesConfiguration): readonly SesRuntime[] {
  return !runtime ? [] : 'routes' in runtime ? runtime.routes : [runtime];
}
export function sesScope(runtime: SesConfiguration | undefined, w: string, b: string) {
  return sesScopes(runtime).find((s) => s.route.workspaceId === w && s.route.brandId === b);
}
