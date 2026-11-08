import { z } from 'zod';
import { createHash } from 'node:crypto';
import { createSesSimulatorPort, type SesSimulationBinding, type SesSimulatorPort } from './ses-simulator.js';
import { senderDomain } from '../../shared/sender.js';

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
export type SesRuntime = { route: SesRoute; port?: SesSimulatorPort; close?: () => void };
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
export function loadSesRuntime(env: NodeJS.ProcessEnv): SesRuntime | undefined {
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
  const route = parseSesRoute(JSON.parse(raw));
  if (!accessKeyId || !secretAccessKey) return { route }; // Signed feedback can drain after new submissions are disabled.
  const port = createSesSimulatorPort(route, {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  });
  return { route, port, close: () => port.destroy() };
}
export function sesScope(runtime: SesRuntime | undefined, w: string, b: string) {
  return runtime?.route.workspaceId === w && runtime.route.brandId === b ? runtime : undefined;
}
