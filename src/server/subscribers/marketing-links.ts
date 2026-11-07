import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Database, Sql } from '../db.js';
import { AppError, requireCondition } from '../errors.js';
import { unsubscribeContact } from './audience.js';
import { hash } from './tokens.js';

export const marketingUnsubscribePath = '/mail/unsubscribe';
const scopeSchema = z
  .object({ workspaceId: z.string().regex(/^org_[A-Za-z0-9_-]{1,120}$/), brandId: z.uuid().toLowerCase() })
  .strict();
type Scope = z.infer<typeof scopeSchema>;
export type MarketingLinks = {
  origin: string;
  scopes: ReadonlyMap<string, Scope>;
  signingKey?: Buffer;
};
const invalidConfig = () => new Error('Invalid marketing unsubscribe configuration.');
const capability =
  /^v1\.([A-Za-z0-9_-]{22})\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.[A-Za-z0-9_-]{43}$/;
function selector(origin: string, scope: Scope) {
  return createHash('sha256')
    .update(JSON.stringify(['marketing-scope-v1', origin, scope.workspaceId, scope.brandId]))
    .digest('base64url')
    .slice(0, 22);
}

export function loadMarketingLinks(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
): MarketingLinks | undefined {
  const raw = env.FLOCKLETTER_UNSUBSCRIBE_BINDINGS;
  const key = env.FLOCKLETTER_UNSUBSCRIBE_SIGNING_KEY;
  if (!raw && !key) return;
  if (!raw || raw.length > 20000 || (key && !/^[a-f\d]{64}$/i.test(key))) throw invalidConfig();
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw invalidConfig();
  }
  if (url.protocol !== 'https:' || url.origin !== origin) throw invalidConfig();
  if (key && key.toLowerCase() === env.FLOCKLETTER_CONFIRMATION_SIGNING_KEY?.toLowerCase())
    throw invalidConfig();
  let settings: Scope[];
  try {
    settings = z.array(scopeSchema).min(1).max(64).parse(JSON.parse(raw));
  } catch {
    throw invalidConfig();
  }
  const scopes = new Map<string, Scope>();
  for (const scope of settings) {
    const id = selector(origin, scope);
    if (scopes.has(id)) throw invalidConfig();
    scopes.set(id, scope);
  }
  return { origin, scopes, ...(key ? { signingKey: Buffer.from(key, 'hex') } : {}) };
}
function tokenFor(key: Buffer, origin: string, scope: Scope, id: string) {
  const signature = createHmac('sha256', key)
    .update(JSON.stringify(['marketing-opt-out-v1', origin, scope.workspaceId, scope.brandId, id]))
    .digest('base64url');
  return 'v1.' + selector(origin, scope) + '.' + id + '.' + signature;
}
type LinkRow = { id: string; token_hash: string };

// Internal worker boundary. The caller has already authorized the exact recipient and holds its brand transaction.
export async function buildMarketingMessageLinks(
  sql: Sql,
  settings: MarketingLinks,
  recipient: Scope & { subscriberId: string },
) {
  const scope = settings.scopes.get(selector(settings.origin, recipient));
  requireCondition(
    scope && settings.signingKey,
    503,
    'unsubscribe_unavailable',
    'Marketing unsubscribe links are unavailable.',
  );
  // Use the same lock order as opt-out and confirmation. Wrong workspace/brand transactions cannot issue links.
  await sql.query('SELECT enabled FROM subscriber_intake_settings FOR UPDATE');
  const person = await sql.query(
    "SELECT id FROM subscribers WHERE workspace_id=$1 AND brand_id=$2 AND id=$3 AND state='confirmed' FOR UPDATE",
    [scope.workspaceId, scope.brandId, recipient.subscriberId],
  );
  requireCondition(person.rowCount, 409, 'recipient_ineligible', 'The marketing recipient is ineligible.');
  const fingerprint = createHmac('sha256', settings.signingKey)
    .update(JSON.stringify(['marketing-signer-v1', settings.origin]))
    .digest('hex');
  const id = randomUUID();
  const candidate = tokenFor(settings.signingKey, settings.origin, scope, id);
  await sql.query(
    `INSERT INTO subscriber_marketing_links(workspace_id,brand_id,id,subscriber_id,signer_fingerprint,token_hash)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id,brand_id,subscriber_id,signer_fingerprint) DO NOTHING`,
    [scope.workspaceId, scope.brandId, id, recipient.subscriberId, fingerprint, hash(candidate)],
  );
  const row = (
    await sql.query<LinkRow>(
      'SELECT id,token_hash FROM subscriber_marketing_links WHERE subscriber_id=$1 AND signer_fingerprint=$2',
      [recipient.subscriberId, fingerprint],
    )
  ).rows[0];
  const token = row && tokenFor(settings.signingKey, settings.origin, scope, row.id);
  requireCondition(
    token && row && hash(token) === row.token_hash,
    503,
    'unsubscribe_unavailable',
    'Marketing unsubscribe links are unavailable.',
  );
  const bodyUrl = settings.origin + marketingUnsubscribePath + '?t=' + token;
  return {
    bodyUrl,
    headers: {
      'List-Unsubscribe': '<' + bodyUrl + '>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    requiredDkimHeaders: ['list-unsubscribe', 'list-unsubscribe-post'] as const,
  };
}

export async function redeemMarketingLink(db: Database, settings: MarketingLinks, token: string) {
  const match = capability.exec(token);
  const scope = match && settings.scopes.get(match[1]!);
  if (!match || !scope) return;
  await db.brand(scope.workspaceId, scope.brandId, async (sql) => {
    const row = (
      await sql.query<{ subscriber_id: string; token_hash: string }>(
        'SELECT subscriber_id,token_hash FROM subscriber_marketing_links WHERE id=$1',
        [match[2]],
      )
    ).rows[0];
    // Previously issued links remain valid across a paused sender or a signing-key rotation.
    if (!row || !timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(hash(token), 'hex'))) return;
    try {
      await unsubscribeContact(sql, row.subscriber_id, 'marketing-unsubscribe-link');
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'contact_unavailable')) throw error;
    }
  });
}
