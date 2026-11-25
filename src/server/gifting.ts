import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandboxGiftWorkspace } from '../shared/gifting.js';
import type { GiftEvent, GiftStatus } from '../shared/gifting.js';
import { AppError, requireCondition } from './errors.js';
import type { Database, Sql } from './db.js';
import { lockWorkspace } from './workspace-lock.js';

const journal = 'gifting:capture:v1';
type CaptureModule = typeof import('../../labs/gifting/staging.mjs');
type Entry = { event: GiftEvent; seq: number; seed?: string };
const moduleUrl = pathToFileURL(path.resolve('labs/gifting/staging.mjs')).href;
async function withCapture<T>(
  sql: Sql,
  workspace: string,
  use: (engine: ReturnType<CaptureModule['openCapture']>, entries: Entry[]) => Promise<T>,
) {
  const { rows } = await sql.query<{ result: Entry }>(
    "SELECT result FROM operations WHERE actor_id=$1 ORDER BY (result->>'seq')::integer",
    [journal],
  );
  const entries = rows.map((r) => r.result);
  const { openCapture }: CaptureModule = await import(moduleUrl);
  const engine = openCapture(
    workspace,
    entries.map((r) => r.event),
  );
  try {
    return await use(engine, entries);
  } finally {
    engine.close();
  }
}
export async function giftStatus(sql: Sql, workspace: string): Promise<GiftStatus> {
  return withCapture(sql, workspace, async (engine) => engine.status());
}
// Caller holds the workspace transaction lock. Each business action has one stable identity,
// shared by all owners, recipient taps and restarts. The journal holds at most 209 events.
export async function recordGift(sql: Sql, workspace: string, event: GiftEvent) {
  const providerKinds = [
    'stripePaid',
    'sandboxReserve',
    'tremendousOrder',
    'sandboxExpire',
    'prepareRefund',
    'stripeRefund',
  ];
  if (event.kind !== 'intent')
    requireCondition(
      providerKinds.includes(event.kind) === (workspace === sandboxGiftWorkspace),
      403,
      'gift_provider_mismatch',
      'This gift uses a different provider.',
    );
  const key = 'person' in event ? event.kind + '-' + event.person : event.kind;
  const hash = JSON.stringify(event, Object.keys(event).sort());
  const prior = (
    await sql.query<{ request_hash: string }>(
      'SELECT request_hash FROM operations WHERE actor_id=$1 AND operation_key=$2',
      [journal, key],
    )
  ).rows[0];
  if (prior) {
    requireCondition(
      prior.request_hash === hash,
      409,
      'gift_terms_changed',
      'The saved exercise uses different campaign terms.',
    );
    return { recorded: true };
  }
  return withCapture(sql, workspace, async (engine, entries) => {
    const has = (kind: GiftEvent['kind']) => entries.some((e) => e.event.kind === kind);
    requireCondition(
      !has('refund') && !has('stripeRefund'),
      409,
      'gift_closed',
      'The gift exercise is closed.',
    );
    if (event.kind === 'timeout')
      requireCondition(!has('recover'), 409, 'gift_recovered', 'Provider recovery has already run.');
    if (event.kind === 'submit')
      requireCondition(
        entries.some((e) => e.event.kind === 'intent' && e.event.person === event.person),
        409,
        'gift_intent_required',
        'Confirm the claim first.',
      );
    try {
      engine.apply(event);
    } catch (error) {
      throw new AppError(
        409,
        'gift_action_unavailable',
        error instanceof Error ? error.message : 'Gift action unavailable.',
      );
    }
    const entry: Entry = { seq: entries.length + 1, event };
    if (event.kind === 'reserve' || event.kind === 'sandboxReserve')
      entry.seed = randomBytes(32).toString('hex');
    await sql.query(
      'INSERT INTO operations(workspace_id,actor_id,operation_key,request_hash,result) VALUES($1,$2,$3,$4,$5)',
      [workspace, journal, key, hash, JSON.stringify(entry)],
    );
    return { recorded: true };
  });
}
async function recipientToken(sql: Sql, workspace: string, person: number, purpose = 'claim') {
  const row = (
    await sql.query<{ seed: string }>(
      "SELECT result->>'seed' AS seed FROM operations WHERE actor_id=$1 AND operation_key IN ('reserve','sandboxReserve')",
      [journal],
    )
  ).rows[0];
  requireCondition(row?.seed, 404, 'gift_unavailable', 'This gift is unavailable.');
  return createHmac('sha256', Buffer.from(row.seed, 'hex'))
    .update(JSON.stringify([journal, purpose, workspace, person]))
    .digest('hex');
}
export async function giftLink(sql: Sql, workspace: string, person: number) {
  const token = await recipientToken(sql, workspace, person);
  return { path: '/gifts/claim#' + new URLSearchParams({ workspace, person: String(person), token }) };
}
export async function recipientGift(
  db: Database,
  workspace: string,
  person: number,
  token: string,
  claim: boolean,
  submitSandbox?: (person: number) => Promise<void>,
) {
  async function verify(sql: Sql) {
    const expected = await recipientToken(sql, workspace, person);
    requireCondition(
      /^[a-f0-9]{64}$/.test(token) &&
        timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex')),
      404,
      'gift_unavailable',
      'This gift is unavailable.',
    );
  }
  async function project(sql: Sql) {
    const status = await giftStatus(sql, workspace);
    const offer = status.offers.find((o) => o.person === person);
    requireCondition(offer, 404, 'gift_unavailable', 'This gift is unavailable.');
    return { state: offer.state, face: 500, currency: 'USD', expires: status.days, day: status.day };
  }
  if (!claim)
    return db.read(workspace, async (sql) => {
      await verify(sql);
      return project(sql);
    });
  // The intent commits before simulated submission. Repeating either step recovers the same offer.
  await db.tenant(workspace, async (sql) => {
    await verify(sql);
    await lockWorkspace(sql, workspace);
    const current = await project(sql);
    if (current.state === 'offered') await recordGift(sql, workspace, { kind: 'intent', person });
  });
  if (workspace === sandboxGiftWorkspace) {
    requireCondition(
      submitSandbox,
      503,
      'gift_provider_unavailable',
      'The sandbox provider is unavailable.',
    );
    const current = await db.read(workspace, project);
    if (current.state === 'pending') await submitSandbox(person);
    return db.read(workspace, project);
  }
  return db.tenant(workspace, async (sql) => {
    await verify(sql);
    await lockWorkspace(sql, workspace);
    const current = await project(sql);
    if (current.state !== 'pending') return current;
    await recordGift(sql, workspace, { kind: 'submit', person });
    return project(sql);
  });
}

export async function rewardLink(db: Database, workspace: string, person: number, token: string) {
  const offer = await recipientGift(db, workspace, person, token, false);
  requireCondition(
    offer.state === 'claimed',
    409,
    'gift_pending',
    'The reward is available after the order is confirmed.',
  );
  const expires = Date.now() + 300000;
  const nonce = randomBytes(12).toString('hex');
  const key = await db.read(workspace, (sql) => recipientToken(sql, workspace, person, 'reward'));
  const signature = createHmac('sha256', Buffer.from(key, 'hex'))
    .update(JSON.stringify(['reward', expires, nonce]))
    .digest('hex');
  return {
    path:
      '/gifts/reward#' +
      new URLSearchParams({
        workspace,
        person: String(person),
        expires: String(expires),
        nonce,
        signature,
      }),
  };
}
export async function viewReward(
  db: Database,
  workspace: string,
  person: number,
  expires: number,
  nonce: string,
  signature: string,
) {
  return db.read(workspace, async (sql) => {
    const token = await recipientToken(sql, workspace, person, 'reward');
    const expected = createHmac('sha256', Buffer.from(token, 'hex'))
      .update(JSON.stringify(['reward', expires, nonce]))
      .digest();
    requireCondition(
      expires > Date.now() &&
        /^[a-f0-9]{64}$/.test(signature) &&
        timingSafeEqual(expected, Buffer.from(signature, 'hex')),
      404,
      'gift_unavailable',
      'Reopen the original gift to refresh your reward link.',
    );
    const status = await giftStatus(sql, workspace);
    requireCondition(
      status.offers.some((o) => o.person === person && o.state === 'claimed'),
      404,
      'gift_unavailable',
      'The reward is unavailable.',
    );
    return { products: status.products };
  });
}
