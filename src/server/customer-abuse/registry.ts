import { createHash, createHmac } from 'node:crypto';
import type { Sql } from '../db.js';
export type TrialSource = 'exercise' | 'stripe_test' | 'stripe_live';
export type TrialRegistryConfig = {
  key: string;
  source: TrialSource;
  account: string;
  historyBaseline?: 'verified-empty' | 'reviewed-backfill';
  policy: {
    id: string;
    version: number;
    mode: 'lifetime' | 'bounded';
    retentionDays: number | null;
    approved: boolean;
  };
};
export type TrialIdentity = { namespace: string; workspaceDigest: string; ownerDigest: string };
/** Keyed identifiers remain personal data. Different source/account namespaces never share eligibility. */
export class TrialRegistry {
  readonly namespace: string;
  private readonly keyTag: string;
  constructor(readonly config: TrialRegistryConfig) {
    if (
      config.key.length < 32 ||
      !['exercise', 'stripe_test', 'stripe_live'].includes(config.source) ||
      !config.account ||
      !/^[a-zA-Z0-9._-]{1,80}$/.test(config.policy.id) ||
      !Number.isSafeInteger(config.policy.version) ||
      config.policy.version < 1 ||
      (config.policy.mode === 'lifetime'
        ? config.policy.retentionDays !== null
        : !Number.isSafeInteger(config.policy.retentionDays) ||
          config.policy.retentionDays! < 1 ||
          config.policy.retentionDays! > 3650) ||
      !config.policy.approved ||
      (config.source !== 'exercise' &&
        (config.policy.mode !== 'lifetime' ||
          !['verified-empty', 'reviewed-backfill'].includes(config.historyBaseline ?? '')))
    )
      throw Error('Trial protection requires an approved retention policy and stable private key.');
    this.namespace = createHash('sha256')
      .update(JSON.stringify(['flockletter-trial-v1', config.source, config.account]))
      .digest('hex');
    this.keyTag = this.hash(
      'registry-key',
      JSON.stringify(['v1', config.historyBaseline ?? 'synthetic']),
    );
  }
  private hash(kind: string, value: string) {
    return createHmac('sha256', this.config.key)
      .update(JSON.stringify([this.namespace, kind, value]))
      .digest('hex');
  }
  identity(workspace: string, verifiedOwner: string): TrialIdentity {
    return {
      namespace: this.namespace,
      workspaceDigest: this.hash('workspace', workspace),
      ownerDigest: this.hash('owner', verifiedOwner),
    };
  }
  card(verifiedFingerprint: string) {
    if (!verifiedFingerprint || verifiedFingerprint.length > 200)
      throw Error('Verified provider card required.');
    return this.hash('card', verifiedFingerprint);
  }
  async claim(
    sql: Sql,
    workspace: string,
    identity: TrialIdentity,
    intent: string,
    action: 'reserve' | 'consume' | 'status',
    cardDigest: string | null = null,
  ) {
    if (identity.namespace !== this.namespace) return 'configuration_hold';
    const p = this.config.policy;
    return (
      await sql.query<{ result: string }>(
        `SELECT flockletter_customer_jobs.trial_claim($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) result`,
        [
          workspace,
          this.namespace,
          this.keyTag,
          p.id,
          p.version,
          p.retentionDays ?? 0,
          identity.workspaceDigest,
          intent,
          identity.ownerDigest,
          cardDigest,
          action,
        ],
      )
    ).rows[0]!.result;
  }
}
/** No default secret, policy approval or live eligibility. Exercise must be explicitly separate. */
export function trialRegistryFromEnvironment(
  env: NodeJS.ProcessEnv,
  source: TrialSource,
  account: string,
) {
  const exercise = source === 'exercise',
    prefix = exercise ? 'FLOCKLETTER_EXERCISE_TRIAL_' : 'FLOCKLETTER_TRIAL_';
  const key = env[prefix + 'HMAC_KEY'];
  const baseline = env.FLOCKLETTER_TRIAL_HISTORY_BASELINE;
  if (!exercise && baseline !== 'verified-empty' && baseline !== 'reviewed-backfill') return undefined;
  const approved = exercise
    ? env.APP_ENV !== 'production'
    : env[prefix + 'RETENTION_APPROVED'] === 'true';
  const policy = {
    mode: exercise ? ('bounded' as const) : ('lifetime' as const),
    id: env[prefix + 'POLICY_ID'] ?? (exercise ? 'synthetic-v1' : ''),
    version: Number(env[prefix + 'POLICY_VERSION'] ?? (exercise ? '1' : '0')),
    retentionDays: exercise ? Number(env[prefix + 'RETENTION_DAYS'] ?? '90') : null,
    approved,
  };
  if (!key || !approved || !policy.id || !policy.version || (exercise && !policy.retentionDays))
    return undefined;
  return new TrialRegistry({
    key,
    source,
    account,
    policy,
    ...(!exercise ? { historyBaseline: baseline as 'verified-empty' | 'reviewed-backfill' } : {}),
  });
}
