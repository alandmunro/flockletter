import {configuredGiftNotificationEmail, giftNotificationView, processGiftNotifications, recordGiftNotice, saveGiftNotificationPreferences, type GiftNotificationEmail} from './notifications.js';
import { createHash } from 'node:crypto';
import type { Database, Sql } from '../db.js';
import type { Actor } from '../service.js';
import { AppError, requireCondition } from '../errors.js';
import { giftServiceEnded, reconcileGiftServiceEnd } from './retention.js';
import { retentionServiceEndSql } from '../customer-billing/service.js';
import { lockWorkspace } from '../workspace-lock.js';
import { workspaceGiftCommands as cmds, type WorkspaceGiftCommand } from '../../shared/workspace-gifts.js';
import { eligibleGiftRecipients, giftWorkspaceOnboardingFacts } from './audience.js';
import { all, available, entry, feeFor, one, put, unused, type GiftOffer, type Lot } from './store.js';
import { authenticateOffer, fund, inputHash, offerPath, reserve, transition } from './ledger.js';
import { WorkspaceGiftProvider, type GiftGateway } from './provider.js';

type Options = {
  email?:GiftNotificationEmail;
  live: boolean;
  waitMs: number | null;
  monthlyCap: number | null;
  clock?: () => Date;
  fixture?: boolean;
  verifiedBrands?: ReadonlySet<string>;
  completedProbation?: ReadonlySet<string>;
};
const day = 86400000;
function operationId(w: string, b: string, key: string) {
  const h = createHash('sha256')
    .update(JSON.stringify(['flockletter:gifts:v1', w, b, key]))
    .digest('hex');
  return (
    h.slice(0, 8) +
    '-' +
    h.slice(8, 12) +
    '-5' +
    h.slice(13, 16) +
    '-8' +
    h.slice(17, 20) +
    '-' +
    h.slice(20, 32)
  );
}
export async function giftSendingHold(sql: Sql) {
  const r = await one(sql, 'signal', 'access');
  return r && ['paused', 'suspended', 'closed'].includes(r.kind) ? r.kind : null;
}
export class WorkspaceGifts {
  constructor(
    readonly db: Database,
    readonly provider: GiftGateway,
    readonly opts: Options,
  ) {}
  private now() {
    return this.opts.clock?.() ?? new Date();
  }
  private fixture(w: string) {
    return (
      this.opts.fixture === true &&
      !this.opts.live &&
      ['test', 'local', 'staging'].includes(process.env.APP_ENV ?? '') &&
      /^fixture:gifting:audience:v1:(studio|orchard)$/.test(w)
    );
  }
  private tx<T>(w: string, fn: (sql: Sql) => Promise<T>) {
    return this.db.tenant(w, async (sql) => {
      await lockWorkspace(sql, w);
      return fn(sql);
    });
  }
  private async eligibility(sql: Sql, w: string, b: string, lots: Lot[], extra = 0) {
    const f = await giftWorkspaceOnboardingFacts(sql, w, b),
      first = lots
        .filter((l) => l.paidAt)
        .map((l) => Date.parse(l.paidAt!))
        .sort((a, b) => a - b)[0];
    const now = this.now(),
      reasons: string[] = [];
    if (await one(sql, 'closure', 'closed') || giftServiceEnded(await retentionServiceEndSql(sql,w,undefined,now),now))
      reasons.push('gifting_closed');
    if (await giftSendingHold(sql)) reasons.push('account_on_hold');
    const fixture = this.fixture(w);
    if (
      !fixture &&
      (!f.companyId ||
        f.registrationState !== 'approved' ||
        !f.industry ||
        f.probationState === 'paused' ||
        (!this.opts.live && !f.probationState))
    )
      reasons.push('registration_required');
    if (this.opts.live && (!this.opts.verifiedBrands?.has(b) || f.registrationSource !== 'sms_registration'))
      reasons.push('operator_verification_required');
    if (first === undefined || this.opts.waitMs === null || now.getTime() - first < this.opts.waitMs)
      reasons.push('cleared_payment_wait');
    const probation = this.opts.live
      ? !this.opts.completedProbation?.has(b)
      : f.probationState !== 'complete';
    if (probation) {
      const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
      const reserved = (await all(sql, 'entry'))
        .filter((e) => e.kind === 'reserved' && Date.parse(e.at) >= start)
        .reduce((n, e) => n + e.amount, 0);
      if (this.opts.monthlyCap === null || extra + reserved > this.opts.monthlyCap)
        reasons.push('probation_budget');
    }
    return {
      eligible: reasons.length === 0,
      reasons,
      brokerRequired: f.industry === 'REAL_ESTATE' || (!f.industry && !fixture),
    };
  }
  async execute(name: WorkspaceGiftCommand, raw: unknown, actor: Actor) {
    const input = cmds[name].schema.parse(raw),
      w = actor.workspaceId,
      b = input.brandId;
    requireCondition(
      actor.kind === 'session'
        ? name === 'gifts.status' || actor.owner
        : name === 'gifts.status' && actor.owner && actor.scopes.includes('gifts:read'),
      403,
      'gift_access',
      'Current workspace gift access is required.',
    );
    requireCondition(
      actor.brandIds === null || actor.brandIds.includes(b),
      404,
      'gift_unavailable',
      'The brand is unavailable.',
    );
    await this.db.brand(w, b, async (sql) => {
      requireCondition(
        (await sql.query('SELECT FROM brands WHERE id=$1', [b])).rowCount,
        404,
        'gift_unavailable',
        'The brand is unavailable.',
      );
    });
    switch (name) {
      case 'gifts.status':
        return this.status(w, b, actor.owner && actor.kind === 'session');
      case 'gifts.notificationPreferences': {
        const d=cmds[name].schema.parse(raw);
        await this.db.tenant(w,sql=>saveGiftNotificationPreferences(sql,w,d.operationKey,{lowCredit:d.lowCredit,campaignEnded:d.campaignEnded}));
        return {saved:true};
      }
      case 'gifts.catalog':
        return { products: await this.provider.products(cmds[name].schema.parse(raw).face) };
      case 'gifts.purchase': {
        const d = cmds[name].schema.parse(raw);
        return this.purchase(w, b, d.operationKey, d.face);
      }
      case 'gifts.reconcile': {
        const d = cmds[name].schema.parse(raw);
        return this.reconcile(w, b, d.purchaseId);
      }
      case 'gifts.launch': {
        const terms = cmds[name].schema.parse(raw);
        const checkPrior = async (sql: Sql) => {
          const c = await one(sql, 'campaign', terms.operationKey);
          if (c)
            requireCondition(
              c.brand === b && c.hash === inputHash(terms),
              409,
              'gift_terms_changed',
              'The campaign terms differ from the original.',
            );
          return c;
        };
        const old = await this.db.read(w, checkPrior);
        if (old) return { id: old.id };
        const choices = new Set((await this.provider.products(terms.face)).map((p) => p.id));
        requireCondition(
          new Set(terms.products).size === terms.products.length &&
            terms.products.every((id) => choices.has(id)),
          422,
          'gift_product_unavailable',
          'Review the product selection for this amount.',
        );
        return this.db.brand(w, b, async (sql) => {
          await lockWorkspace(sql, w);
          const existing = await checkPrior(sql);
          if (existing) return { id: existing.id };
          const requested = new Set(terms.personIds),
            people = (await eligibleGiftRecipients(sql, w, b, this.opts.live ? 'live' : 'exercise')).filter(
              (p) => requested.has(p.id),
            );
          requireCondition(
            people.length === requested.size,
            422,
            'gift_audience_changed',
            'Review eligible contacts again.',
          );
          const e = await this.eligibility(sql, w, b, await all(sql, 'lot'), people.length * terms.face);
          requireCondition(
            e.eligible,
            409,
            'gift_ineligible',
            'Gifting eligibility or the probation budget requires review.',
          );
          requireCondition(
            !e.brokerRequired || terms.brokerConfirmed,
            422,
            'broker_approval_required',
            'Confirm your broker has approved thank-you gifts.',
          );
          const c = await reserve(sql, w, terms, people, this.now());
          return { id: c.id };
        });
      }
      case 'gifts.link': {
        const d = cmds[name].schema.parse(raw);
        return this.db.read(w, async (sql) => {
          const o = (await all(sql, 'offer')).find(
            (o) => o.brand === b && o.campaign === d.campaignId && o.person === d.personId,
          );
          requireCondition(o && o.state !== 'expired', 404, 'gift_unavailable', 'The offer is unavailable.');
          return { path: offerPath(w, o) };
        });
      }
      case 'gifts.close':
        await this.tx(w, async (sql) => {
          if (!(await one(sql, 'closure', 'closed')))
            await put(sql, w, 'closure', 'closed', { brand: b, at: this.now().toISOString() });
        });
        await this.tick(w);
        return this.status(w, b, true);
    }
  }
  private async status(w: string, b: string, manage: boolean) {
    return this.db.brand(w, b, async (sql) => {
      const lots = await all(sql, 'lot'),
        offers = await all(sql, 'offer'),
        campaigns = await all(sql, 'campaign'),
        ledger = await all(sql, 'entry');
      const visibleLots = manage ? lots : lots.filter((l) => l.brand === b);
      const balance = visibleLots.reduce((n, l) => n + available(l), 0);
      const eligibility = await this.eligibility(sql, w, b, lots);
      const rows = offers.filter((o) => o.brand === b);
      return {
        currency: 'USD',
        canManage: manage,
        eligibility,
        available: balance,
        reserved: visibleLots.reduce((n, l) => n + l.reserved, 0),
        spent: visibleLots.reduce((n, l) => n + l.spent, 0),
        refunded: visibleLots.reduce((n, l) => n + l.returned, 0),
        purchases: lots
          .filter((l) => l.brand === b)
          .map((l) => ({ id: l.id, face: l.face, total: l.total, state: l.state })),
        closed: !!(await one(sql, 'closure', 'closed')),
        people: manage
          ? (await eligibleGiftRecipients(sql, w, b, this.opts.live ? 'live' : 'exercise')).map(
              ({ id, label }) => ({ id, label }),
            )
          : [],
        campaigns: campaigns
          .filter((c) => c.brand === b)
          .map((c) => {
            const members = rows.filter((o) => o.campaign === c.id);
            const count = (s: GiftOffer['state']) => members.filter((o) => o.state === s).length;
            return {
              id: c.id,
              title: c.title,
              offered: members.length,
              claimed: count('claimed'),
              expired: count('expired'),
              reserved: (count('offered') + count('pending')) * c.face,
              spent: count('claimed') * c.face,
              fees: feeFor(count('claimed') * c.face),
              released: count('expired') * c.face,
              expiresAt: c.expires,
              recipients: members.map((o) => ({
                id: o.person,
                state: o.state,
                claimedAt: o.claimedAt ?? null,
              })),
            };
          }),
        ledger: ledger.filter((e) => e.brand === b),
        ...(manage?{ownerNotifications:await giftNotificationView(sql)}:{}),
        alerts: [
          ...(balance < 2000 && lots.length ? ['Gift credit is low.'] : []),
          ...new Set(
            rows
              .filter((o) => o.state === 'pending' && o.reason)
              .map(() => 'A claim is awaiting provider reconciliation.'),
          ),
        ],
      };
    });
  }
  private async purchase(w: string, b: string, k: string, face: number) {
    const id = operationId(w, b, k);
    const lot = await this.tx(w, async (sql) => {
      const now = this.now();
      requireCondition(
        !(await one(sql, 'closure', 'closed')) && !giftServiceEnded(await retentionServiceEndSql(sql,w,undefined,now),now),
        409,
        'gift_closed',
        'Workspace gifting is closed.',
      );
      const old = await one(sql, 'lot', id);
      if (old) {
        requireCondition(
          old.face === face && old.brand === b,
          409,
          'gift_terms_changed',
          'The original purchase amount differs.',
        );
        return old;
      }
      const fee = feeFor(face);
      const l: Lot = {
        id,
        brand: b,
        account: this.provider.account,
        face,
        fee,
        total: face + fee,
        created: this.now().toISOString(),
        state: 'checkout',
        spent: 0,
        reserved: 0,
        returned: 0,
        disputed: 0,
        lost: 0,
        disputes: {},
      };
      await put(sql, w, 'lot', id, l);
      return l;
    });
    if (lot.state !== 'checkout') return { id, url: null, state: lot.state };
    const checkout = await this.provider.checkout(w, lot);
    await this.tx(w, async (sql) => {
      const current = (await one(sql, 'lot', id))!;
      requireCondition(
        !current.session || current.session === checkout.id,
        409,
        'gift_payment_conflict',
        'The original session needs review.',
      );
      current.session = checkout.id;
      if (checkout.expired && current.state === 'checkout') current.state = 'expired';
      await put(sql, w, 'lot', id, current);
    });
    return { id, url: checkout.url, state: checkout.expired ? 'expired' : 'checkout' };
  }
  async paymentFailure(w:string,b:string,id:string,eventId:string){
    await this.tx(w,async sql=>{
      const l=await one(sql,'lot',id);
      requireCondition(l?.brand===b&&l.account===this.provider.account,409,'gift_payment_conflict','The failed payment needs review.');
      if(l.state==='checkout')await recordGiftNotice(sql,w,{kind:'paymentFailed',reference:eventId,at:this.now().toISOString()});
    });
  }
  async processed(w: string, id: string) {
    return this.db.read(w, async (sql) => Boolean(await one(sql, 'event', id)));
  }
  async markProcessed(w: string, id: string) {
    await this.tx(w, async (sql) => {
      if (!(await one(sql, 'event', id))) await put(sql, w, 'event', id, { at: this.now().toISOString() });
    });
  }
  async checkoutEvent(w: string, b: string, id: string, session: string) {
    const lot = await this.db.read(w, (sql) => one(sql, 'lot', id));
    requireCondition(
      lot && lot.brand === b && (!lot.session || lot.session === session),
      409,
      'gift_payment_conflict',
      'The purchase binding requires review.',
    );
    if (!lot.session) {
      const verified = await this.provider.checkout(w, { ...lot, session });
      requireCondition(
        verified.id === session,
        409,
        'gift_payment_conflict',
        'The checkout requires review.',
      );
      await this.tx(w, async (sql) => {
        const current = (await one(sql, 'lot', id))!;
        requireCondition(
          !current.session || current.session === session,
          409,
          'gift_payment_conflict',
          'The checkout binding changed.',
        );
        current.session = session;
        await put(sql, w, 'lot', id, current);
      });
    }
    return this.reconcile(w, b, id);
  }
  async reconcile(w: string, b: string, id: string) {
    let lot = await this.db.read(w, (sql) => one(sql, 'lot', id));
    requireCondition(lot && lot.brand === b, 404, 'gift_purchase_missing', 'This purchase is unavailable.');
    if (lot.state !== 'checkout') return { id, state: lot.state };
    if (!lot.session) {
      const session = await this.provider.checkout(w, lot);
      await this.tx(w, async (sql) => {
        const l = (await one(sql, 'lot', id))!;
        requireCondition(
          !l.session || l.session === session.id,
          409,
          'gift_payment_conflict',
          'This purchase needs review.',
        );
        l.session = session.id;
        await put(sql, w, 'lot', id, l);
      });
      lot = { ...lot, session: session.id };
    }
    const payment = await this.provider.payment(w, lot);
    if (!payment) {
      const s = await this.provider.checkout(w, lot);
      if (s.expired)
        await this.tx(w, async (sql) => {
          const l = (await one(sql, 'lot', id))!;
          if (l.state === 'checkout') {
            l.state = 'expired';
            await put(sql, w, 'lot', id, l);
          }
        });
      return { id, state: s.expired ? 'expired' : 'checkout' };
    }
    await this.tx(w, async (sql) => fund(sql, w, (await one(sql, 'lot', id))!, payment));
    return { id, state: 'funded' };
  }
  async recipient(w: string, id: string, token: string, claim: boolean) {
    const before = await this.tx(w, async (sql) => {
      const o = await authenticateOffer(sql, id, token);
      const now = this.now();
      if (o.state === 'offered' && (Date.parse(o.expires) <= now.getTime()
        || giftServiceEnded(await retentionServiceEndSql(sql,w,undefined,now),now)))
        await transition(sql, w, o, 'expired', now);
      if (claim && o.state === 'offered') {
        o.state = 'pending';
        await put(sql, w, 'offer', id, o);
      }
      return o;
    });
    if (claim && before.state === 'pending') await this.settle(w, before);
    const value = await this.db.read(w, async (sql) => {
      const o = await authenticateOffer(sql, id, token);
      const brand =
        (await sql.query<{ name: string }>('SELECT name FROM brands WHERE id=$1', [o.brand])).rows[0]?.name ??
        'Your gift';
      return { state: o.state, brand, face: o.face, expiresAt: o.expires, reward: o.reward };
    });
    const { reward, ...projection } = value;
    return {
      ...projection,
      ...(reward && value.state === 'claimed' ? { rewardUrl: await this.provider.link(reward) } : {}),
    };
  }
  private async settle(w: string, o: GiftOffer) {
    const c = await this.db.read(w, (sql) => one(sql, 'campaign', o.campaign));
    requireCondition(c, 409, 'gift_campaign_missing', 'Gift terms require review.');
    let receipt: { order: string; reward: string };
    try {
      receipt = await this.provider.order(o, c);
    } catch (e) {
      await this.tx(w, async (sql) => {
        const latest = (await one(sql, 'offer', o.id))!;
        if (latest.state !== 'pending') return;
        latest.reason = e instanceof AppError ? e.code : 'gift_provider_pending';
        latest.retryAt = new Date(this.now().getTime() + 60000).toISOString();
        await put(sql, w, 'offer', o.id, latest);
        await put(sql, w, 'signal', 'claim:' + o.id, {
          kind: latest.reason,
          at: this.now().toISOString(),
          ref: o.id,
        });
      });
      return;
    }
    await this.tx(w, async (sql) => {
      const latest = (await one(sql, 'offer', o.id))!;
      if (latest.state === 'claimed') {
        requireCondition(
          latest.order === receipt.order && latest.reward === receipt.reward,
          409,
          'gift_order_conflict',
          'Order references require review.',
        );
        return;
      }
      await transition(sql, w, latest, 'claimed', this.now(), receipt);
    });
  }
  private async closeLots(w: string) {
    const refunds = await this.tx(w, async (sql) => {
      if (!(await one(sql, 'closure', 'closed'))) return [];
      const lots = await all(sql, 'lot'),
        offers = await all(sql, 'offer');
      if (
        offers.some((o) => o.state === 'offered' || o.state === 'pending') ||
        lots.some((l) => l.disputed || l.state === 'checkout')
      )
        return [];
      // A lost dispute can exceed the free face value on its original purchase.
      // Settle that deficit from other lots before fixing any additional refund.
      let remaining = Math.max(
        0,
        lots.reduce((sum, l) => sum + available(l), 0),
      );
      const due: Lot[] = [];
      for (const l of lots) {
        if (l.state === 'refunding') {
          due.push(l);
          continue;
        }
        if (l.state !== 'funded') continue;
        const face = Math.min(remaining, Math.max(0, available(l)));
        if (!face) continue;
        l.refundFace = face;
        l.state = 'refunding';
        l.refundStarted = this.now().toISOString();
        await put(sql, w, 'lot', l.id, l);
        due.push(l);
        remaining -= face;
      }
      return due;
    });
    for (const l of refunds) {
      const face = l.refundFace ?? unused(l),
        amount = face + Math.round((l.fee * face) / l.face),
        result = await this.provider.refund(w, l, amount);
      requireCondition(
        result.amount === amount,
        503,
        'gift_refund_unverified',
        'The refund requires reconciliation.',
      );
      await this.tx(w, async (sql) => {
        const current = (await one(sql, 'lot', l.id))!;
        if (current.state === 'refunded') return;
        requireCondition(
          current.state === 'refunding' &&
            !current.disputed &&
            current.refundFace === face &&
            unused(current) - current.lost >= face,
          409,
          'gift_refund_review',
          'The settled refund requires review.',
        );
        current.returned = amount;
        current.state = 'refunded';
        current.refundId = result.id;
        await put(sql, w, 'lot', current.id, current);
        await entry(sql, w, 'refund:' + l.id, {
          kind: 'refunded',
          amount,
          brand: l.brand,
          at: this.now().toISOString(),
          ref: l.id,
        });
      });
    }
  }
  async tick(w: string) {
    if (w.startsWith('fixture:gifting:audience:') && !this.fixture(w)) return;
    const lots = await this.db.read(w, (sql) => all(sql, 'lot'));
    if (!lots.length) return;
    const now = this.now();
    const closing = await this.tx(w, async (sql) => {
      await reconcileGiftServiceEnd(sql,w,await retentionServiceEndSql(sql,w,undefined,now),now);
      return one(sql,'closure','closed');
    });
    const checks = lots
      .filter((l) => l.state === 'checkout' && (!l.nextCheck || Date.parse(l.nextCheck) <= now.getTime()))
      .sort((a, b) => (a.nextCheck ?? '').localeCompare(b.nextCheck ?? ''))
      .slice(0, 10);
    for (const l of checks) {
      // Other lots, expiry and uncertain claims continue while one purchase awaits a provider.
      await this.tx(w, async (sql) => {
        const current = await one(sql, 'lot', l.id);
        if (current?.state === 'checkout') {
          current.nextCheck = new Date(now.getTime() + 300000).toISOString();
          await put(sql, w, 'lot', l.id, current);
        }
      });
      try {
        await this.reconcile(w, l.brand, l.id);
      } catch {
        await this.tx(w, async (sql) => {
          if (!(await one(sql, 'signal', 'payment:' + l.id)))
            await put(sql, w, 'signal', 'payment:' + l.id, {
              kind: 'payment_review',
              at: now.toISOString(),
              ref: l.id,
            });
        });
      }
    }
    const pending = await this.tx(w, async (sql) => {
      const offers = await all(sql, 'offer');
      for (const o of offers)
        if (o.state === 'offered' && Date.parse(o.expires) <= now.getTime())
          await transition(sql, w, o, 'expired', now);
      return offers
        .filter((o) => o.state === 'pending' && (!o.retryAt || Date.parse(o.retryAt) <= now.getTime()))
        .slice(0, 20);
    });
    for (const o of pending) await this.settle(w, o);
    if (closing) await this.closeLots(w);
    await this.tx(w, (sql) => this.recheckHold(sql, w));
    if(this.opts.email)await processGiftNotifications(this.db,w,this.opts.email,now);
  }
  private async recheckHold(sql: Sql, w: string) {
    const lots = await all(sql, 'lot'),
      prior = await one(sql, 'signal', 'access');
    const debt = lots.reduce((n, l) => n + available(l), 0) < 0;
    const hadProbationLoss = await one(sql, 'signal', 'probation_loss');
    const hasLoss = hadProbationLoss?.kind === 'review_required';
    if (!debt && !hasLoss && !prior) return;
    const now = this.now(),
      since = prior && prior.kind !== 'clear' ? prior.at : now.toISOString();
    const age = now.getTime() - Date.parse(since);
    const kind =
      prior?.kind === 'closed' || (debt && age >= 30 * day)
        ? 'closed'
        : hasLoss || (debt && age >= 6 * day)
          ? 'suspended'
          : debt
            ? 'paused'
            : 'clear';
    if (prior?.kind !== kind) {
      await put(sql,w,'signal','access',{kind,at:since,ref:'gift_dispute'});
      if(kind!=='clear')await recordGiftNotice(sql,w,{kind,at:now.toISOString(),reference:'hold/'+since+'/'+kind});
    }
    if (kind === 'closed' && !(await one(sql, 'closure', 'closed')))
      await put(sql, w, 'closure', 'closed', { at: now.toISOString(), brand: lots[0]!.brand });
  }
  async disputeEvidence(w: string, id: string, disputeId: string) {
    return this.tx(w, async (sql) => {
      const previous = await one(sql, 'evidence', disputeId);
      if (previous) return previous.summary;
      const lot = await one(sql, 'lot', id);
      requireCondition(
        lot?.paidAt,
        409,
        'gift_payment_unverified',
        'Verified purchase evidence is required.',
      );
      const claims = (await all(sql, 'offer')).filter(
        (o) => o.state === 'claimed' && o.alloc.some((a) => a.id === id),
      );
      const rows = claims.map((o) => [o.claimedAt, o.alloc.find((a) => a.id === id)!.amount, o.order]);
      const summary = JSON.stringify({
        description: 'Flockletter prepaid gift credit',
        currency: 'USD',
        purchase: lot.id,
        paidAt: lot.paidAt,
        total: lot.total,
        face: lot.face,
        purchaseFee: lot.fee,
        claimed: lot.spent,
        refunded: lot.returned,
        totalClaims: claims.length,
        claims: rows.slice(0, 100),
      });
      await put(sql, w, 'evidence', disputeId, { summary });
      return summary;
    });
  }
  async dispute(d: {
    id: string;
    workspace: string;
    lot: string;
    charge: string;
    payment: string;
    amount: number;
    state: string;
    opened: string;
  }) {
    return this.tx(d.workspace, async (sql) => {
      const l = await one(sql, 'lot', d.lot);
      requireCondition(
        l && l.charge === d.charge && l.payment === d.payment && l.account === this.provider.account,
        409,
        'gift_dispute_unmatched',
        'This dispute needs reconciliation.',
      );
      const face = Math.min(l.face, Math.round((d.amount * l.face) / l.total)),
        prior = l.disputes[d.id];
      if (prior?.state === d.state) return;
      if (prior && ['won', 'lost', 'warning_closed'].includes(prior.state)) return;
      l.disputes[d.id] = { amount: face, state: d.state, opened: d.opened };
      const allDisputes = Object.values(l.disputes);
      l.disputed = Math.min(
        l.face,
        allDisputes
          .filter((v) => !['won', 'lost', 'warning_closed'].includes(v.state))
          .reduce((n, v) => n + v.amount, 0),
      );
      l.lost = Math.min(
        l.face,
        allDisputes.filter((v) => v.state === 'lost').reduce((n, v) => n + v.amount, 0),
      );
      if (d.state === 'lost') {
        await sql.query("SELECT set_config('app.intake_brand_id',$1,true)", [l.brand]);
        const f = await giftWorkspaceOnboardingFacts(sql, d.workspace, l.brand);
        if (this.opts.live ? !this.opts.completedProbation?.has(l.brand) : f.probationState !== 'complete')
          await put(sql, d.workspace, 'signal', 'probation_loss', {
            kind: 'review_required',
            at: this.now().toISOString(),
            ref: l.id,
          });
      }
      if(!prior)await recordGiftNotice(sql,d.workspace,{kind:'disputeOpened',at:this.now().toISOString(),reference:d.id});
      await put(sql, d.workspace, 'lot', l.id, l);
      await entry(sql, d.workspace, 'dispute:' + d.id + ':' + d.state, {
        kind: 'dispute_' + d.state,
        amount: face,
        brand: l.brand,
        at: this.now().toISOString(),
        ref: l.id,
      });
      await this.recheckHold(sql, d.workspace);
    });
  }
}
export function configuredWorkspaceGifts(
  db: Database,
  config: Parameters<typeof WorkspaceGiftProvider.configured>[0],
  env = process.env,
) {
  const provider = WorkspaceGiftProvider.configured(config, env);
  if (!provider) return null;
  const integer = (s: string | undefined) =>
    s && /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null;
  const days = integer(env.FLOCKLETTER_GIFT_WAIT_DAYS);
  return new WorkspaceGifts(db, provider, {
    live: provider.live,
    email:configuredGiftNotificationEmail(config,env),
    waitMs: days === null ? null : days * day,
    monthlyCap: integer(env.FLOCKLETTER_GIFT_PROBATION_CENTS),
    completedProbation: new Set(
      (env.FLOCKLETTER_GIFT_PROBATION_COMPLETED_BRANDS ?? '').split(',').filter(Boolean),
    ),
    verifiedBrands: new Set((env.FLOCKLETTER_GIFT_VERIFIED_BRANDS ?? '').split(',').filter(Boolean)),
  });
}
