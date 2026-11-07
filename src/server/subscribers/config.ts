import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { normalizedEmail } from '../../shared/subscriber.js';
import type { Config } from '../config.js';

export type IntakeBinding = {
  workspaceId: string;
  brandId: string;
  sourceDomain: string;
  origin: string;
  mode: 'capture' | 'live';
  key: Buffer;
  recipients: ReadonlySet<string>;
  sender: string;
  webhookSecret?: string;
};
export type LinkBinding = Pick<IntakeBinding, 'workspaceId' | 'brandId' | 'origin' | 'key'>;
export function loadLinkBinding(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): LinkBinding | undefined {
  const workspaceId = env.FLOCKLETTER_INTAKE_WORKSPACE ?? '',
    brand = env.FLOCKLETTER_INTAKE_BRAND ?? '';
  const key = env.FLOCKLETTER_CONFIRMATION_SIGNING_KEY ?? '';
  if (
    !/^org_[A-Za-z0-9_-]{1,120}$/.test(workspaceId) ||
    !z.uuid().safeParse(brand).success ||
    !/^[a-f0-9]{64}$/i.test(key)
  )
    return;
  return { workspaceId, brandId: brand.toLowerCase(), origin: config.origin, key: Buffer.from(key, 'hex') };
}

// A missing or malformed optional intake configuration keeps only this feature off.
export function loadIntakeBinding(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): IntakeBinding | undefined {
  const mode = env.FLOCKLETTER_CONFIRMATION_MODE;
  if (mode !== 'capture' && mode !== 'live') return;
  const links = loadLinkBinding(config, env);
  if (!links) return;
  const sourceDomain = env.FLOCKLETTER_INTAKE_SOURCE_DOMAIN ?? '';
  const recipients = (env.FLOCKLETTER_CONFIRMATION_RECIPIENTS ?? '')
    .split(',')
    .map((x) => normalizedEmail.safeParse(x));
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(sourceDomain) ||
    recipients.length > 25 ||
    recipients.some((x) => !x.success)
  )
    return;
  const allowed = new Set(recipients.flatMap((x) => (x.success ? [x.data] : [])));
  const sender = env.FLOCKLETTER_CONFIRMATION_FROM ?? '';
  const webhookSecret = env.FLOCKLETTER_CONFIRMATION_FEEDBACK_SECRET;
  if (
    mode === 'capture' &&
    [...allowed].some((email) => !/@(?:example\.(?:com|net|org)|[a-z0-9.-]+\.test)$/.test(email))
  )
    return;
  if (
    mode === 'live' &&
    (env.FLOCKLETTER_CONFIRMATION_LIVE_APPROVED !== 'true' ||
      config.environment !== 'staging' ||
      !config.origin.startsWith('https://') ||
      !normalizedEmail.safeParse(sender).success ||
      !webhookSecret?.startsWith('whsec_'))
  )
    return;
  return { ...links, sourceDomain, mode, recipients: allowed, sender, webhookSecret };
}

export function fingerprint(binding: IntakeBinding) {
  return createHmac('sha256', binding.key)
    .update(
      JSON.stringify([
        'intake-configuration-v1',
        binding.workspaceId,
        binding.brandId,
        binding.sourceDomain,
        binding.mode,
        binding.origin,
        binding.sender,
        [...binding.recipients].sort(),
      ]),
    )
    .digest('hex');
}
