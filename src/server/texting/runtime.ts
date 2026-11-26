import { reviewerSeats } from './practice-evidence.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readProbationPolicy } from './probation-policy.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import { bitwardenProject, readProjectSecrets } from '../secrets/bitwarden.js';
import { Texting, type TextingMode } from './service.js';
import { CredentialSeal } from './twilio.js';
import { TwilioHttpMessaging, TwilioHttpPlatform } from './twilio-http.js';
import { replyForwarder, replyForwardingKey } from './reply-forwarding.js';
import type { DispatchAuthority, Forward } from './messaging.js';
import { StripeTestSetupPayment } from './setup-payment.js';

/** Secrets loaded from Bitwarden at start-up (FL-SMS-014). Mock mode needs none. */
export const textingSecretKeys = ['FLOCKLETTER_TWILIO_ACCOUNT_SID', 'FLOCKLETTER_TWILIO_API_KEY_SID', 'FLOCKLETTER_TWILIO_API_KEY_SECRET', 'FLOCKLETTER_TWILIO_AUTH_TOKEN',
  'FLOCKLETTER_TWILIO_PLATFORM_ACCOUNT_SID', 'FLOCKLETTER_TWILIO_PLATFORM_API_KEY_SID', 'FLOCKLETTER_TWILIO_PLATFORM_API_KEY_SECRET',
  'FLOCKLETTER_TWILIO_PRIMARY_PROFILE_SID', 'FLOCKLETTER_TEXTING_SEAL_KEY'] as const;
export type TextingSecrets = ReadonlyMap<string, string>;

export function textingMode(config: Config, env: NodeJS.ProcessEnv): TextingMode {
  const mode = z.enum(['off', 'mock', 'live']).parse(env.FLOCKLETTER_TEXTING ?? (config.environment === 'staging' ? 'mock' : 'off'));
  if (mode === 'mock' && config.environment === 'production') throw Error('The mock Twilio client cannot run in production.');
  if (mode === 'live' && env.FLOCKLETTER_TEXTING_ACTIVATION_APPROVED !== 'true') throw Error('Live texting requires explicit activation approval.');
  return mode;
}
/**
 * Reads the environment's own Bitwarden project only, then drops the token from this process's
 * environment. Live mode requires it; other modes skip it so phase 2 reads no secret it does not use.
 */
export async function loadTextingSecrets(config: Config, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<TextingSecrets | undefined> {
  if (textingMode(config, env) !== 'live') return undefined;
  const token = env.BWS_ACCESS_TOKEN;
  if (!token) throw Error('Live texting needs BWS_ACCESS_TOKEN for this environment’s Bitwarden machine account.');
  const project = bitwardenProject(config.environment, env.BWS_PROJECT);
  const secrets = await readProjectSecrets({ accessToken: token, projectName: project, keys: env.FLOCKLETTER_TEXTING_REPLY_FORWARDING === 'approved' ? [...textingSecretKeys, replyForwardingKey] : textingSecretKeys,
    fetch: fetcher });
  delete env.BWS_ACCESS_TOKEN;
  return secrets;
}
export type TextingRuntimeOptions = { isOwner: (user: string, workspace: string) => Promise<boolean>; wake?: (workspace: string) => Promise<void>; forward?: Forward; canDispatch?: DispatchAuthority; now?: () => Date };
export function createTexting(db: Database, config: Config, env: NodeJS.ProcessEnv, options: TextingRuntimeOptions, secrets?: TextingSecrets): Texting | undefined {
  const mode = textingMode(config, env);
  if (mode === 'off') return undefined;
  const linkOrigin = (env.FLOCKLETTER_SHORT_LINK_ORIGIN ?? config.origin + '/l').replace(/\/$/, '');
  const link = new URL(linkOrigin);
  if (link.username || link.password || link.search || link.hash || (config.environment !== 'local' && config.environment !== 'test' && link.protocol !== 'https:'))
    throw Error('FLOCKLETTER_SHORT_LINK_ORIGIN must be an exact HTTPS origin and optional path.');
  if (mode === 'mock') {
    const onboarding = z.enum(['off', 'capture', 'stripe_test']).parse(env.FLOCKLETTER_TEXTING_ONBOARDING ?? (config.environment === 'staging' ? 'capture' : 'off'));
    const stripe = onboarding === 'stripe_test' ? new StripeTestSetupPayment(env.FLOCKLETTER_TEXTING_SETUP_STRIPE_KEY ?? '',
      env.FLOCKLETTER_TEXTING_SETUP_STRIPE_WEBHOOK ?? '', env.FLOCKLETTER_TEXTING_SETUP_STRIPE_ACCOUNT ?? '', config.origin) : undefined;
    return Texting.mock(db, { origin: config.origin, linkOrigin, ...options, evidenceReviewers: reviewerSeats(env.FLOCKLETTER_TEXTING_EVIDENCE_REVIEWERS),
      mockBroadcastRelease: config.environment === 'staging' && onboarding === 'capture' ? env.FLOCKLETTER_TEXTING_MOCK_BROADCAST_RELEASE : undefined,
      evidenceDirectory: config.environment === 'staging' ? join(tmpdir(),'flockletter-synthetic-texting-evidence') : undefined,
      probationPolicy: readProbationPolicy(env.FLOCKLETTER_TEXTING_PROBATION_POLICY), onboardingCapture: onboarding !== 'off', onboardingStripe: stripe });
  }
  if (!secrets) throw Error('Live texting secrets were not loaded. Start the workflows with CustomerWorkflows.start().');
  const replyKey = secrets.get(replyForwardingKey)?.trim();
  const forwardsReplies = env.FLOCKLETTER_TEXTING_REPLY_FORWARDING === 'approved';
  if (forwardsReplies && replyKey && [
    env.FLOCKLETTER_CUSTOMER_CONFIRMATION_KEY, env.FLOCKLETTER_CUSTOMER_RESEND_KEY,
    env.FLOCKLETTER_SUPPORT_RESEND_KEY, env.FLOCKLETTER_SUPPORT_RESEND_RETRIEVE_KEY,
    env.FLOCKLETTER_CUSTOMER_CONFIRMATION_RETRIEVE_KEY, env.FLOCKLETTER_CUSTOMER_RESEND_RETRIEVE_KEY,
    env.FLOCKLETTER_RESEND_PROVISION_KEY,
  ].some(key => key?.trim() === replyKey)) throw Error('Text reply forwarding needs a separate Resend credential.');
  const forward = options.forward ?? (forwardsReplies ? replyForwarder(replyKey, env.FLOCKLETTER_TEXTING_REPLY_FROM) : undefined);
  const need = (key: (typeof textingSecretKeys)[number]) => { const value = secrets?.get(key); if (!value) throw Error(`Live texting needs ${key} in the ${env.BWS_PROJECT} Bitwarden project.`); return value; };
  const allowList = async () => {
    const rows = (await db.pool.query<{ v: string[] | null }>(`SELECT flockletter_customer_jobs.texting_setting('', 'live_recipient_allow_list') v`)).rows;
    return rows[0]?.v ?? [];
  };
  return new Texting(db, {
    mode: 'live', origin: config.origin, linkOrigin, seal: CredentialSeal.live(need('FLOCKLETTER_TEXTING_SEAL_KEY')), ...options, ...(forward ? { forward } : {}),
    platform: new TwilioHttpPlatform({ accountSid: need('FLOCKLETTER_TWILIO_PLATFORM_ACCOUNT_SID'), user: need('FLOCKLETTER_TWILIO_PLATFORM_API_KEY_SID'), secret: need('FLOCKLETTER_TWILIO_PLATFORM_API_KEY_SECRET') },
      // Twilio's published TrustHub policy SIDs for ISV secondary customer profiles and A2P messaging profiles.
      { secondaryProfile: env.FLOCKLETTER_TWILIO_SECONDARY_PROFILE_POLICY ?? 'RNdfbf3fae0e1107f8aded0e7cead80bf5', a2pProfile: env.FLOCKLETTER_TWILIO_A2P_PROFILE_POLICY ?? 'RNb0d4771c2c98518d916a3d4cd70a8f8b',
        primaryProfileSid: need('FLOCKLETTER_TWILIO_PRIMARY_PROFILE_SID') }),
    // D-063: only numbers on the operator's live-recipient allow-list can receive a real text in phase 2.
    port: new TwilioHttpMessaging(async to => (await allowList()).includes(to)),
    liveAccount: { accountSid: need('FLOCKLETTER_TWILIO_ACCOUNT_SID'), keySid: need('FLOCKLETTER_TWILIO_API_KEY_SID'), keySecret: need('FLOCKLETTER_TWILIO_API_KEY_SECRET'), authToken: need('FLOCKLETTER_TWILIO_AUTH_TOKEN') },
  });
}
