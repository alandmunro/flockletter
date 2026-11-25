import { createHash } from 'node:crypto';
import { createClerkClient } from '@clerk/backend';
import { z } from 'zod';
import type {
  GiftAlertPreferences,
  GiftNoticeSummary,
  GiftNotificationView,
} from '../../shared/workspace-gifts.js';
import type { Config } from '../config.js';
import { ResendSupportProvider, type SupportProvider } from '../customer-support/provider.js';
import type { Database, Sql } from '../db.js';
import { requireCondition } from '../errors.js';
import { lockWorkspace } from '../workspace-lock.js';
import { actorFor, all, available, one, put, type GiftOffer } from './store.js';

const defaults: GiftAlertPreferences = { lowCredit: true, campaignEnded: true };
const preferencesSchema = z.object({ lowCredit: z.boolean(), campaignEnded: z.boolean() }).strict();
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (cents: number) => usd.format(cents / 100);
const hash = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

const requiredMessages = {
  disputeOpened: 'A gift credit purchase was disputed. Review the purchase and its balance.',
  paymentFailed: 'Payment failed for a gift credit purchase. Review the purchase before retrying.',
  paused: 'Workspace gifting and sending are paused. Review the account hold.',
  suspended: 'Your workspace is suspended. Review the gift account hold.',
  closed: 'Your gift account was closed after an unresolved hold. Review the account history.',
};
type OptionalKind = keyof GiftAlertPreferences;
type Kind = OptionalKind | keyof typeof requiredMessages;
export type GiftNoticeEvent =
  | { kind: keyof typeof requiredMessages; reference: string; at: string }
  | { kind: 'lowCredit'; reference: string; at: string; available: number; threshold: number }
  | { kind: 'campaignEnded'; reference: string; at: string; released: number };
type OwnerDelivery = {
  user: string;
  state: 'queued' | 'submitting' | 'accepted' | 'review' | 'skipped';
  providerId?: string;
};
export type GiftNoticeRecord = {
  id: string;
  kind: Kind;
  at: string;
  message: string;
  source: string;
  muted: boolean;
  email: GiftNoticeSummary['email'];
  owners?: OwnerDelivery[];
  nextCheck?: string;
  capture?: { to: string; subject: string; text: string };
};
const optional = (kind: Kind): kind is OptionalKind => kind === 'lowCredit' || kind === 'campaignEnded';

export function giftLowThreshold(scheduledCents: number) {
  if (!Number.isSafeInteger(scheduledCents) || scheduledCents < 0)
    throw Error('Invalid scheduled gift value.');
  return Math.max(2000, scheduledCents);
}

/** Called inside the same locked tenant transaction as the verified source transition. */
export async function recordGiftNotice(sql: Sql, workspace: string, event: GiftNoticeEvent) {
  const id = hash(workspace, event.kind, event.reference);
  if (await one(sql, 'notice', id)) return;
  const prefs = (await one(sql, 'noticePrefs', 'current')) ?? defaults;
  const muted = optional(event.kind) && !prefs[event.kind];
  let message: string;
  switch (event.kind) {
    case 'lowCredit':
      message =
        'Gift credit is low. Available credit is ' +
        money(event.available) +
        ' and the low-credit threshold is ' +
        money(event.threshold) +
        '.';
      break;
    case 'campaignEnded':
      message = 'A gift campaign ended. ' + money(event.released) + ' in unused credit was released.';
      break;
    default:
      message = requiredMessages[event.kind];
  }
  await put(sql, workspace, 'notice', id, {
    id,
    kind: event.kind,
    at: event.at,
    message,
    muted,
    source: process.env.APP_ENV ?? 'local',
    email: muted ? 'suppressed' : 'queued',
  });
}

/** Owner session only. Both optional notices default on for both channels. */
export async function saveGiftNotificationPreferences(
  sql: Sql,
  workspace: string,
  operationKey: string,
  preferences: GiftAlertPreferences,
) {
  const value = preferencesSchema.parse(preferences);
  const key = 'change/' + z.uuid().parse(operationKey);
  await lockWorkspace(sql, workspace);
  const previous = await one(sql, 'noticePrefs', key);
  if (previous) {
    requireCondition(
      previous.lowCredit === value.lowCredit && previous.campaignEnded === value.campaignEnded,
      409,
      'gift_preference_conflict',
      'These preferences differ from the original request.',
    );
    return;
  }
  await put(sql, workspace, 'noticePrefs', key, value);
  await put(sql, workspace, 'noticePrefs', 'current', value);
}

const latestNotices = `SELECT DISTINCT ON(request_hash) result FROM operations
  WHERE workspace_id=current_setting('app.workspace_id') AND actor_id=$1 ORDER BY request_hash,operation_key DESC`;

/** Owner-only status projection. Mail addresses, membership identifiers and provider receipts stay private. */
export async function giftNotificationView(sql: Sql): Promise<GiftNotificationView> {
  const preferences = (await one(sql, 'noticePrefs', 'current')) ?? defaults;
  const result = await sql.query<{ result: GiftNoticeRecord }>(
    `SELECT result FROM (${latestNotices}) latest
    WHERE result->>'muted'='false' ORDER BY result->>'at' DESC, result->>'id' LIMIT 50`,
    [actorFor('notice')],
  );
  return {
    preferences,
    notices: result.rows.map(({ result: { id, message, at, email } }) => ({ id, message, at, email })),
  };
}

type Scheduled = { campaign: string; person: string; due: Date };
const week = 7 * 86400000;
export function scheduledGiftValue(
  offers: Pick<GiftOffer, 'id' | 'state' | 'person' | 'campaign' | 'face' | 'expires'>[],
  scheduled: Scheduled[],
  now: Date,
) {
  const open = new Map(
    offers.filter((o) => o.state === 'offered').map((o) => [o.campaign + '/' + o.person, o]),
  );
  const seen = new Set<string>();
  let total = 0;
  for (const item of scheduled) {
    const offer = open.get(item.campaign + '/' + item.person);
    const due = item.due.getTime();
    if (
      !offer ||
      seen.has(offer.id) ||
      due < now.getTime() ||
      due >= now.getTime() + week ||
      due >= Date.parse(offer.expires)
    )
      continue;
    seen.add(offer.id);
    total += offer.face;
  }
  return total;
}

async function scheduledForBrand(sql: Sql, w: string, b: string, now: Date) {
  // Both delivery attachment paths preserve a canonical campaign/person pair.
  return (
    await sql.query<Scheduled>(
      `
    SELECT a.result->>'campaignId' campaign,binding.value->>'personId' person,d.due_at due
    FROM customer_deliveries d JOIN operations a ON a.workspace_id=d.workspace_id
      AND a.actor_id='workspace-gifts:delivery:v1' AND a.operation_key=d.id::text AND a.result->>'brandId'=d.brand_id::text
    CROSS JOIN LATERAL jsonb_each(a.result->'bindings') binding
    JOIN customer_delivery_recipients p ON p.workspace_id=d.workspace_id AND p.brand_id=d.brand_id AND p.delivery_id=d.id AND p.id::text=binding.key
    WHERE d.workspace_id=$1 AND d.brand_id=$2 AND d.state='queued' AND p.state IN ('pending','preparing','prepared')
      AND d.due_at >= $3 AND d.due_at < $4
    UNION ALL
    SELECT r.settings->>'giftCampaignId', coalesce(c.subscriber_id,c.contact_id)::text, o.due_at
    FROM date_occurrences o JOIN date_automations a USING(workspace_id,brand_id,kind,revision)
    JOIN date_automation_revisions r USING(workspace_id,brand_id,kind,revision)
    JOIN contact_dates c ON (c.workspace_id,c.brand_id,c.id)=(o.workspace_id,o.brand_id,o.date_id)
    WHERE o.workspace_id=$1 AND o.brand_id=$2 AND o.state='planned' AND a.enabled AND c.cleared_at IS NULL
      AND r.settings ? 'giftCampaignId' AND o.due_at >= $3 AND o.due_at < $4`,
      [w, b, now, new Date(now.getTime() + week)],
    )
  ).rows;
}

async function observeGiftBalances(sql: Sql, w: string, now: Date) {
  const lots = await all(sql, 'lot');
  if (!lots.length) return;
  const offers = await all(sql, 'offer');
  const campaigns = await all(sql, 'campaign');
  const grouped = new Map<string, GiftOffer[]>();
  for (const offer of offers) {
    const group = grouped.get(offer.campaign) ?? [];
    group.push(offer);
    grouped.set(offer.campaign, group);
  }
  for (const c of campaigns) {
    const members = grouped.get(c.id) ?? [];
    if (
      Date.parse(c.expires) > now.getTime() ||
      members.some((o) => o.state === 'offered' || o.state === 'pending')
    )
      continue;
    const released = members.reduce((n, o) => n + (o.state === 'expired' ? o.face : 0), 0);
    if (released > 0)
      await recordGiftNotice(sql, w, {
        kind: 'campaignEnded',
        reference: c.id,
        at: now.toISOString(),
        released,
      });
  }

  if (await one(sql, 'closure', 'closed')) return;
  const scheduled: Scheduled[] = [];
  for (const brand of new Set(offers.filter((o) => o.state === 'offered').map((o) => o.brand))) {
    // This is a dedicated worker transaction; the date planner's RLS requires each brand context.
    await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [brand]);
    scheduled.push(...(await scheduledForBrand(sql, w, brand, now)));
  }
  const threshold = giftLowThreshold(scheduledGiftValue(offers, scheduled, now));
  const balance = lots.reduce((n, l) => n + available(l), 0);
  const low = balance < threshold;
  const prior = (await one(sql, 'lowEpisode', 'current')) ?? { low: false, count: 0 };
  if (low === prior.low) return;
  const count = prior.count + (low ? 1 : 0);
  if (low)
    await recordGiftNotice(sql, w, {
      kind: 'lowCredit',
      reference: String(count),
      at: now.toISOString(),
      available: balance,
      threshold,
    });
  await put(sql, w, 'lowEpisode', 'current', { low, count });
}

type OwnerDirectory = {
  owners(workspace: string): Promise<string[]>;
  verifiedEmail(workspace: string, user: string): Promise<string | null>;
};
type LiveEmail = {
  mode: 'live';
  environment: 'production';
  directory: OwnerDirectory;
  from: string;
  provider: SupportProvider;
};
export type GiftNotificationEmail =
  | LiveEmail
  | { mode: 'off'; environment: string }
  | { mode: 'capture'; environment: 'staging' | 'test' | 'local' };

type Clerk = ReturnType<typeof createClerkClient>;
export function clerkGiftOwners(clerk: {
  organizations: Pick<Clerk['organizations'], 'getOrganizationMembershipList'>;
  users: Pick<Clerk['users'], 'getUser'>;
}): OwnerDirectory {
  const unavailable = () => Error('The workspace owner directory requires verification.');
  return {
    async owners(workspace) {
      const ids = new Set<string>();
      let expected: number | undefined;
      for (let offset = 0; offset < 10000; offset += 100) {
        const page = await clerk.organizations.getOrganizationMembershipList({
          organizationId: workspace,
          role: ['org:admin'],
          offset,
          limit: 100,
          orderBy: '+created_at',
        });
        if (
          !Number.isSafeInteger(page.totalCount) ||
          page.totalCount < 1 ||
          page.totalCount > 10000 ||
          (expected !== undefined && expected !== page.totalCount) ||
          page.data.length !== Math.min(100, page.totalCount - offset)
        )
          throw unavailable();
        expected = page.totalCount;
        for (const row of page.data) {
          const id = row.publicUserData?.userId;
          if (!id || ids.has(id) || row.organization.id !== workspace || row.role !== 'org:admin')
            throw unavailable();
          ids.add(id);
        }
        if (ids.size === expected) return [...ids];
      }
      throw unavailable();
    },
    async verifiedEmail(workspace, user) {
      const profile = await clerk.users.getUser(user);
      const member = await clerk.organizations.getOrganizationMembershipList({
        organizationId: workspace,
        userId: [user],
        limit: 2,
      });
      if (member.totalCount === 0 && member.data.length === 0) return null;
      const row = member.data[0];
      if (
        member.totalCount !== 1 ||
        member.data.length !== 1 ||
        row?.organization.id !== workspace ||
        row.publicUserData?.userId !== user ||
        profile.id !== user
      )
        throw unavailable();
      if (row.role !== 'org:admin') return null;
      const primary = profile.emailAddresses.find((e) => e.id === profile.primaryEmailAddressId);
      if (
        profile.banned ||
        profile.locked ||
        primary?.verification?.status !== 'verified' ||
        !z.email().safeParse(primary.emailAddress).success
      )
        throw unavailable();
      return primary.emailAddress;
    },
  };
}

export function configuredGiftNotificationEmail(
  config: Pick<Config, 'environment'>,
  env: NodeJS.ProcessEnv = process.env,
): GiftNotificationEmail {
  const environment = config.environment;
  if (environment !== 'production' && (env.APP_ENV ?? 'local') === environment)
    return { mode: 'capture', environment };
  if (
    environment === 'production' &&
    env.APP_ENV === 'production' &&
    env.FLOCKLETTER_WORKSPACE_GIFTS === 'live' &&
    env.FLOCKLETTER_GIFT_OWNER_EMAIL === 'live' &&
    env.CLERK_SECRET_KEY?.startsWith('sk_live_') &&
    env.CLERK_PUBLISHABLE_KEY?.startsWith('pk_live_') &&
    env.FLOCKLETTER_GIFT_OWNER_EMAIL_KEY?.trim() &&
    env.FLOCKLETTER_GIFT_OWNER_EMAIL_FROM &&
    z.email().safeParse(env.FLOCKLETTER_GIFT_OWNER_EMAIL_FROM).success
  ) {
    return {
      mode: 'live',
      environment,
      from: env.FLOCKLETTER_GIFT_OWNER_EMAIL_FROM,
      provider: new ResendSupportProvider(env.FLOCKLETTER_GIFT_OWNER_EMAIL_KEY),
      directory: clerkGiftOwners(
        createClerkClient({
          secretKey: env.CLERK_SECRET_KEY,
          publishableKey: env.CLERK_PUBLISHABLE_KEY,
        }),
      ),
    };
  }
  return { mode: 'off', environment };
}

async function locked<T>(db: Database, w: string, fn: (sql: Sql) => Promise<T>) {
  return db.tenant(w, async (sql) => {
    await lockWorkspace(sql, w);
    return fn(sql);
  });
}
const subject = 'Flockletter gift account update';
function envelope(message: string) {
  return { subject, text: message + ' Open Gifts in your Flockletter workspace for details.' };
}

async function editNotice<T>(
  db: Database,
  w: string,
  id: string,
  edit: (n: GiftNoticeRecord, sql: Sql) => Promise<T>,
) {
  return locked(db, w, async (sql) => {
    const n = await one(sql, 'notice', id);
    if (!n) throw Error('The gift notice is unavailable.');
    const before = JSON.stringify(n),
      result = await edit(n, sql);
    if (before !== JSON.stringify(n)) await put(sql, w, 'notice', id, n);
    return result;
  });
}
async function enabled(sql: Sql, n: GiftNoticeRecord) {
  if (optional(n.kind) && !((await one(sql, 'noticePrefs', 'current')) ?? defaults)[n.kind]) {
    n.email = 'suppressed';
    return false;
  }
  return true;
}
function deliveryState(n: GiftNoticeRecord): GiftNoticeSummary['email'] {
  if (n.owners?.some((d) => d.state === 'queued')) return 'queued';
  if (n.owners?.some((d) => d.state === 'submitting' || d.state === 'review')) return 'review';
  return n.owners?.some((d) => d.state === 'accepted') ? 'accepted' : 'suppressed';
}

async function deliverLive(db: Database, w: string, id: string, email: LiveEmail) {
  const current = await db.read(w, (sql) => one(sql, 'notice', id));
  if (!current || current.email !== 'queued') return;
  const ids = current.owners?.map((d) => d.user) ?? (await email.directory.owners(w));
  if (!ids.length) throw Error('Owner verification is pending.');
  await editNotice(db, w, id, async (n) => {
    n.owners ??= ids.map((user) => ({ user, state: 'queued' }));
  });
  for (const user of ids) {
    if (current.owners && current.owners.find((d) => d.user === user)?.state !== 'queued') continue;
    let to: string | null;
    try {
      to = await email.directory.verifiedEmail(w, user);
    } catch {
      continue;
    }
    const claimed = await editNotice(db, w, id, async (n, sql) => {
      const dest = n.owners?.find((d) => d.user === user);
      if (
        n.source !== 'production' ||
        n.email !== 'queued' ||
        dest?.state !== 'queued' ||
        !(await enabled(sql, n))
      )
        return;
      dest.state = to ? 'submitting' : 'skipped';
      n.email = deliveryState(n);
      return to ? envelope(n.message) : undefined;
    });
    if (!claimed || !to) continue;
    // An unresolved submission stays in review across crashes and retries; never submit it again.
    const key = hash(w, id, user);
    let result: Awaited<ReturnType<SupportProvider['submit']>> = { state: 'unknown' };
    try {
      result = await email.provider.submit({
        ...claimed,
        workspaceId: w,
        operationKey: key,
        from: email.from,
        to,
      });
    } catch {
      /* Outcome is unknown. */
    }
    await editNotice(db, w, id, async (n) => {
      const dest = n.owners?.find((d) => d.user === user);
      if (dest?.state !== 'submitting') return;
      dest.state = result.state === 'accepted' ? 'accepted' : 'review';
      if (result.state === 'accepted') dest.providerId = result.id;
      if (n.email !== 'suppressed') n.email = deliveryState(n);
    });
  }
}

/** Run after the gift worker settles the ledger, outside its transaction. */
export async function processGiftNotifications(
  db: Database,
  w: string,
  email: GiftNotificationEmail,
  now = new Date(),
) {
  const items = await locked(db, w, async (sql) => {
    await observeGiftBalances(sql, w, now);
    if (email.mode === 'off' || email.environment !== (process.env.APP_ENV ?? 'local')) return [];
    const rows = await sql.query<{ result: GiftNoticeRecord }>(
      `SELECT result FROM (${latestNotices}) latest
      WHERE result->>'email'='queued' AND result->>'source'=$2 AND coalesce(result->>'nextCheck','') <= $3
      ORDER BY coalesce(result->>'nextCheck',''), result->>'at',result->>'id' LIMIT 10`,
      [actorFor('notice'), email.environment, now.toISOString()],
    );
    for (const { result: n } of rows.rows) {
      if (!(await enabled(sql, n))) {
        await put(sql, w, 'notice', n.id, n);
        continue;
      }
      if (email.mode === 'capture') {
        n.capture = { to: 'owner-' + hash(w).slice(0, 16) + '@example.invalid', ...envelope(n.message) };
        n.email = 'captured';
      } else n.nextCheck = new Date(now.getTime() + 60000).toISOString();
      await put(sql, w, 'notice', n.id, n);
    }
    return rows.rows.filter(({ result }) => result.email === 'queued').map(({ result }) => result.id);
  });
  if (email.mode === 'live')
    for (const id of items) {
      try {
        await deliverLive(db, w, id, email);
      } catch {
        /* Persisted intent is retried after a directory outage. */
      }
    }
}
