import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { catalog, workspaces } from './fixtures.mjs';

function requireThat(ok, message) {
  if (!ok) throw new Error(message);
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}
const feeFor = (cents) => Math.floor((cents + 5) / 10);
const token = () => randomBytes(32).toString('hex');

export class GiftLab {
  constructor(file = ':memory:', makeId = randomUUID) {
    this.makeId = makeId;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    this.atomic(() => {
      const version = this.one('PRAGMA user_version').user_version;
      if (version === 1) return;
      requireThat(version === 0, 'Unsupported lab database version');
      this.db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
      for (const name of workspaces) this.run('INSERT INTO workspace(name) VALUES(?)', name);
      this.run("INSERT INTO platform VALUES(1,0,100000,1000,'healthy',?)", token());
    });
  }
  one(sql, ...args) {
    return this.db.prepare(sql).get(...args);
  }
  all(sql, ...args) {
    return this.db.prepare(sql).all(...args);
  }
  run(sql, ...args) {
    return this.db.prepare(sql).run(...args);
  }
  atomic(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  day() {
    return this.one('SELECT day FROM platform').day;
  }
  workspace(name) {
    const ws = this.one('SELECT * FROM workspace WHERE name=?', name);
    requireThat(ws, 'Unknown lab workspace');
    return ws;
  }
  balances(name) {
    this.workspace(name);
    const { available, reserved } = this.one(
      `SELECT coalesce(sum(l.available),0) available,
      coalesce(sum(l.reserved),0) reserved FROM ledger l JOIN purchase p ON p.id=l.lot WHERE p.workspace=?`,
      name,
    );
    return { currency: 'USD', available, reserved, total: available + reserved };
  }
  entry(lot, kind, ref, available, reserved) {
    this.run(
      'INSERT INTO ledger(day,lot,kind,ref,available,reserved) VALUES(?,?,?,?,?,?)',
      this.day(),
      lot,
      kind,
      ref,
      available,
      reserved,
    );
  }
  signature(source, body) {
    return createHmac('sha256', this.one('SELECT signing_key FROM platform').signing_key)
      .update(source + '\n' + body)
      .digest('hex');
  }
  // Synthetic fixture producer. A live integration would verify the provider's wire format.
  emit(source, event) {
    const body = JSON.stringify(event);
    return this.receive(source, body, this.signature(source, body));
  }
  receive(source, body, sig) {
    requireThat(
      ['stripe', 'rewards'].includes(source) &&
        /^[a-f0-9]{64}$/.test(sig) &&
        timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(this.signature(source, body), 'hex')),
      'Invalid lab signature',
    );
    const e = JSON.parse(body);
    requireThat(typeof e.id === 'string' && e.id.length > 0, 'Missing event identity');
    return this.atomic(() => {
      const prior = this.one('SELECT payload FROM receipt WHERE source=? AND event_id=?', source, e.id);
      if (prior) {
        requireThat(prior.payload === body, 'Conflicting event replay');
        return;
      }
      this.workspace(e.workspace);
      if (source === 'stripe') this.paymentFact(e);
      else {
        requireThat(e.kind === 'order.updated', 'Unexpected provider fact');
        this.offer(e.workspace, e.offer);
        this.settle(e.workspace, e.offer);
      }
      this.run('INSERT INTO receipt VALUES(?,?,?)', source, e.id, body);
      this.updateDeficit(e.workspace);
    });
  }
  paymentFact(e) {
    requireThat(
      e.currency === 'USD' && typeof e.lot === 'string' && e.lot.length > 0,
      'Invalid payment identity or currency',
    );
    const lot = this.one('SELECT * FROM purchase WHERE id=?', e.lot);
    if (e.kind === 'paid') {
      requireThat(
        positive(e.face) && Number.isSafeInteger(e.total) && e.total === e.face + feeFor(e.face),
        'Incorrect purchase amount',
      );
      if (lot) {
        requireThat(lot.workspace === e.workspace && lot.face === e.face, 'Conflicting payment');
        return;
      }
      this.run(
        'INSERT INTO purchase(id,workspace,currency,face,fee) VALUES(?,?,?,?,?)',
        e.lot,
        e.workspace,
        'USD',
        e.face,
        feeFor(e.face),
      );
      this.entry(e.lot, 'purchase', e.lot, e.face, 0);
      return;
    }
    requireThat(lot && lot.workspace === e.workspace, 'Unknown purchase in workspace');
    if (e.kind === 'refunded') {
      requireThat(
        lot.refund_face > 0 && e.total === lot.refund_face + lot.refund_fee && lot.dispute !== 'open',
        'Refund mismatch',
      );
      if (!lot.refunded) {
        this.entry(e.lot, 'refund', e.lot, -lot.refund_face, 0);
        this.run('UPDATE purchase SET refunded=1 WHERE id=?', e.lot);
      }
      return;
    }
    requireThat(
      ['open', 'won', 'lost'].includes(e.kind) && e.total === lot.face + lot.fee,
      'Invalid full-purchase dispute',
    );
    if (lot.dispute === e.kind) return;
    requireThat(!lot.refunded && lot.refund_face === null, 'Refund/dispute overlap requires review');
    if (e.kind === 'open') {
      requireThat(lot.dispute === 'none', 'Dispute already resolved');
      this.entry(e.lot, 'freeze', e.lot, -lot.face, 0);
    } else {
      requireThat(lot.dispute === 'open', 'Missing dispute');
      if (e.kind === 'won') this.entry(e.lot, 'unfreeze', e.lot, lot.face, 0);
      if (e.kind === 'lost')
        this.run(
          'UPDATE workspace SET operator_hold=probation WHERE name=? AND operator_hold=0',
          e.workspace,
        );
    }
    this.run('UPDATE purchase SET dispute=? WHERE id=?', e.kind, e.lot);
  }
  updateDeficit(name) {
    if (this.balances(name).total < 0) {
      this.run('UPDATE workspace SET deficit_day=coalesce(deficit_day,?) WHERE name=?', this.day(), name);
    } else this.run('UPDATE workspace SET deficit_day=NULL WHERE name=?', name);
  }
  access(name) {
    const ws = this.workspace(name);
    const age = ws.deficit_day === null ? null : this.day() - ws.deficit_day;
    if (ws.closing || (age !== null && age >= 30)) return 'closed';
    if (ws.operator_hold || (age !== null && age >= 6)) return 'suspended';
    if (age !== null) return 'paused';
    return 'active';
  }
  lots(name) {
    return this.all(
      `SELECT p.*, sum(l.available) available FROM purchase p JOIN ledger l ON l.lot=p.id
      WHERE p.workspace=? GROUP BY p.id ORDER BY p.rowid`,
      name,
    );
  }
  launch(name, { label, rows, face, days, products, probationRemaining = 0 }, allowedProducts = catalog) {
    requireThat(
      typeof label === 'string' && label.length > 0 && positive(face) && [15, 30, 60].includes(days),
      'Invalid campaign terms',
    );
    requireThat(
      products.length === 1 || (products.length >= 5 && products.length <= 10),
      'Choose one or five to ten products',
    );
    requireThat(
      new Set(products).size === products.length && products.every((p) => allowedProducts.includes(p)),
      'Invalid catalog selection',
    );
    requireThat(
      rows.every((r) => positive(r.personId) && ['email', 'sms'].includes(r.channel)),
      'Invalid audience fixture',
    );
    const people = [...new Set(rows.map((r) => r.personId))].sort((a, b) => a - b);
    const cost = face * people.length;
    requireThat(positive(cost), 'Invalid reservation amount');
    const selection = JSON.stringify([...products].sort());
    const fingerprint = JSON.stringify([people, selection, face, days]);
    return this.atomic(() => {
      const ws = this.workspace(name);
      const old = this.one('SELECT id,fingerprint FROM campaign WHERE workspace=? AND label=?', name, label);
      if (old) {
        requireThat(old.fingerprint === fingerprint, 'Conflicting campaign replay');
        return old.id;
      }
      requireThat(
        this.access(name) === 'active' && ws.eligible && (!ws.realtor || ws.broker_ok),
        'Eligibility or broker hold',
      );
      if (ws.probation)
        requireThat(Number.isSafeInteger(probationRemaining) && cost <= probationRemaining, 'Probation cap');
      requireThat(this.balances(name).available >= cost, 'Insufficient gift credit');
      const id = this.makeId();
      this.run(
        'INSERT INTO campaign VALUES(?,?,?,?,?,?,?)',
        id,
        name,
        label,
        selection,
        this.day() + days,
        face,
        fingerprint,
      );
      const lots = this.lots(name).filter(
        (lot) => lot.available > 0 && lot.dispute !== 'open' && lot.dispute !== 'lost',
      );
      let index = 0;
      for (const person of people) {
        const offer = this.makeId();
        this.run("INSERT INTO offer(id,campaign,person,state) VALUES(?,?,?,'offered')", offer, id, person);
        let owed = face;
        while (owed > 0) {
          const lot = lots[index];
          requireThat(lot, 'Insufficient undisputed funds');
          const amount = Math.min(owed, lot.available);
          this.run('INSERT INTO allocation VALUES(?,?,?)', offer, lot.id, amount);
          this.entry(lot.id, 'reserve', offer, -amount, amount);
          lot.available -= amount;
          owed -= amount;
          if (!lot.available) index++;
        }
      }
      return id;
    });
  }
  offers(name) {
    return this.all(
      `SELECT o.id,o.person,o.state,o.claimed_day,c.label,c.expires,c.face FROM offer o
      JOIN campaign c ON c.id=o.campaign WHERE c.workspace=? ORDER BY o.rowid`,
      name,
    );
  }
  offer(name, id) {
    const offer = this.one(
      `SELECT o.*,c.workspace,c.products,c.face,c.expires FROM offer o JOIN campaign c ON c.id=o.campaign
      WHERE c.workspace=? AND o.id=?`,
      name,
      id,
    );
    requireThat(offer, 'Unknown offer in workspace');
    return offer;
  }
  finish(offer, state) {
    const claimed = state === 'claimed';
    for (const { lot, amount } of this.all('SELECT * FROM allocation WHERE offer=?', offer.id)) {
      this.entry(lot, claimed ? 'claim' : 'release', offer.id, claimed ? 0 : amount, -amount);
    }
    this.run(
      'UPDATE offer SET state=?,issue=NULL,claimed_day=? WHERE id=?',
      state,
      claimed ? this.day() : null,
      offer.id,
    );
    this.updateDeficit(offer.workspace);
  }
  beginClaim(name, id) {
    return this.atomic(() => {
      const o = this.offer(name, id);
      if (o.state === 'offered') {
        if (this.day() >= o.expires || this.workspace(name).closing) {
          this.finish(o, 'expired');
          return false;
        }
        this.run("UPDATE offer SET state='pending' WHERE id=?", id);
        return true;
      }
      return o.state === 'pending';
    });
  }
  claim(name, id) {
    if (this.beginClaim(name, id)) this.reconcile(name, id);
    return this.offer(name, id).state;
  }
  reconcile(name, id) {
    // The mock vendor owns an independent commit. A crash/timeout here leaves durable local intent.
    const issue = this.atomic(() => {
      const o = this.offer(name, id);
      if (o.state !== 'pending') return null;
      const platform = this.one('SELECT * FROM platform');
      if (platform.fault === 'outage') return 'Provider unavailable';
      const existing = this.one('SELECT state FROM vendor_order WHERE external_id=?', id);
      if (existing) return existing.state === 'review' ? 'Provider review' : null;
      if (platform.fault === 'unavailable') return 'Product unavailable';
      if (platform.funds < o.face) return 'Platform funding needed';
      const review = platform.fault === 'review';
      this.run(
        'INSERT INTO vendor_order VALUES(?,?,?,?,?)',
        id,
        this.makeId(),
        o.face,
        o.products,
        review ? 'review' : 'approved',
      );
      this.run('UPDATE platform SET funds=funds-?', o.face);
      if (platform.fault === 'timeout') return 'Awaiting provider lookup';
      return review ? 'Provider review' : null;
    });
    this.atomic(() => {
      if (issue) this.run("UPDATE offer SET issue=? WHERE id=? AND state='pending'", issue, id);
      else this.settle(name, id);
    });
  }
  settle(name, id) {
    const o = this.offer(name, id);
    if (o.state !== 'pending') return;
    const order = this.one('SELECT * FROM vendor_order WHERE external_id=?', id);
    if (order?.state === 'approved' && order.face === o.face && order.products === o.products)
      this.finish(o, 'claimed');
  }
  tick(days = 0, reconcilePending = true) {
    requireThat(Number.isSafeInteger(days) && days >= 0 && days <= 365, 'Invalid clock advance');
    this.atomic(() => {
      this.run('UPDATE platform SET day=day+?', days);
      for (const name of workspaces) {
        if (this.access(name) === 'closed') this.run('UPDATE workspace SET closing=1 WHERE name=?', name);
        for (const o of this.offers(name))
          if (o.state === 'offered' && (o.expires <= this.day() || this.workspace(name).closing)) {
            this.finish({ ...o, workspace: name }, 'expired');
          }
      }
    });
    if (!reconcilePending) return;
    for (const name of workspaces)
      for (const o of this.offers(name)) if (o.state === 'pending') this.reconcile(name, o.id);
  }
  closure(name) {
    this.atomic(() => {
      this.workspace(name);
      this.run('UPDATE workspace SET closing=1 WHERE name=?', name);
      for (const o of this.offers(name))
        if (o.state === 'offered') this.finish({ ...o, workspace: name }, 'expired');
    });
    return this.atomic(() => {
      const lots = this.lots(name);
      requireThat(
        !this.balances(name).reserved && lots.every((l) => l.dispute !== 'open' && l.available >= 0),
        'Closure awaiting claim, dispute or allocation review',
      );
      for (const l of lots)
        if (l.available > 0 && l.refund_face === null) {
          // Half-up proration per original lot; never refund more fee than charged.
          const fee = Number(
            (BigInt(l.fee) * BigInt(l.available) * 2n + BigInt(l.face)) / (2n * BigInt(l.face)),
          );
          this.run('UPDATE purchase SET refund_face=?,refund_fee=? WHERE id=?', l.available, fee, l.id);
        }
      return this.lots(name)
        .filter((l) => l.refund_face > 0 && !l.refunded)
        .map((l) => ({
          lot: l.id,
          credit: l.refund_face,
          fee: l.refund_fee,
          total: l.refund_face + l.refund_fee,
          currency: l.currency,
        }));
    });
  }
  disputeEvidence(name, id) {
    const purchase = this.one(
      'SELECT id,workspace,currency,face,fee,dispute FROM purchase WHERE workspace=? AND id=?',
      name,
      id,
    );
    requireThat(purchase && purchase.dispute !== 'none', 'No dispute in workspace');
    const ledger = this.all(
      'SELECT day,kind,ref,available,reserved FROM ledger WHERE lot=? ORDER BY seq',
      id,
    );
    const claims = this.all(
      `SELECT c.label,o.person,o.claimed_day,a.amount FROM allocation a
      JOIN offer o ON o.id=a.offer JOIN campaign c ON c.id=o.campaign
      WHERE a.lot=? AND c.workspace=? AND o.state='claimed' ORDER BY o.rowid`,
      id,
      name,
    );
    return { purchase, ledger, claims };
  }
  funding() {
    const { funds, buffer } = this.one('SELECT funds,buffer FROM platform');
    const liability = this.one('SELECT coalesce(sum(reserved),0) amount FROM ledger').amount;
    return { currency: 'USD', funds, liability, buffer, shortfall: Math.max(0, liability + buffer - funds) };
  }
}
