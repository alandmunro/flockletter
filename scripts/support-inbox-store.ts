import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { supportDraft, type LocalWriter } from '../src/server/support-draft.js';
import { type SupportTopic } from '../src/shared/support.js';

// A rehearsal never ingests a real message or address. Each scenario is a captured email fixture.
export const supportSamples = {
  plans: 'How many newsletters can I send on each plan?',
  trial: 'When does my card-required trial start?',
  audience: 'How do I honor an unsubscribe?',
  campaigns: 'Where can I find my campaign rehearsal?',
  billing: 'Could you refund the last payment?',
  security: 'An unfamiliar person signed in to my workspace.',
  privacy: 'Please export my customer records.',
  recovery: 'I lost access to my account.',
  other: 'I have a question about something else.',
  'auto-reply': 'Automatic reply: I am away from my desk.',
} satisfies Record<SupportTopic | 'auto-reply', string>;

type Scenario = keyof typeof supportSamples;
type State = 'received' | 'ignored' | 'acknowledged' | 'drafted' | 'approved' | 'escalated' | 'closed';
type Action = 'acknowledge' | 'approve' | 'escalate' | 'close';
type TicketRow = {
  id: string; scenario: Scenario; state: State; draft: string | null; facts: string | null;
  sender: string; subject: string; body: string;
};
const envelopeSchema = z.strictObject({
  kind: z.literal('flockletter.support-rehearsal.v1'),
  messageId: z.string().regex(/^mail-[a-z0-9-]{1,48}$/),
  from: z.email().max(100).endsWith('.test'),
  to: z.literal('support@flockletter.test'),
  subject: z.string().min(1).max(160).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value)),
  text: z.string().min(1).max(2048).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\r\n\t]/g, ''))),
  autoSubmitted: z.enum(['no', 'auto-replied', 'auto-generated']),
});
const maxTickets = 250;
const applicationId = 0x46534c31;
const statesForAction: Record<Action, { next: State; from: readonly State[] }> = {
  acknowledge: { next: 'acknowledged', from: ['received'] },
  approve: { next: 'approved', from: ['drafted'] },
  escalate: { next: 'escalated', from: ['received', 'acknowledged', 'drafted'] },
  close: { next: 'closed', from: ['approved', 'escalated'] },
};

export function isSupportScenario(value: string): value is Scenario {
  return Object.hasOwn(supportSamples, value);
}

function openPrivateDatabase(directory: string) {
  if (!isAbsolute(directory)) throw Error('Choose an absolute, private support rehearsal directory.');
  const folder = lstatSync(directory);
  if (!folder.isDirectory() || folder.uid !== process.getuid?.() || (folder.mode & 0o077))
    throw Error('The support rehearsal directory must be owned by this operator and private (0700).');
  const path = join(directory, 'support-rehearsal.sqlite');
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1 || file.uid !== folder.uid || (file.mode & 0o077))
      throw Error('Use a private, regular support rehearsal database file.');
  } finally {
    closeSync(fd);
  }
  return new DatabaseSync(path);
}

function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function reviewCode(row: TicketRow) {
  if (!row.draft || !row.facts) return null;
  return createHash('sha256').update(JSON.stringify([row.id, row.facts, row.draft])).digest('hex').slice(0, 20);
}

export function openSupportInbox(directory: string) {
  const db = openPrivateDatabase(directory);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    transaction(db, () => {
      const id = db.prepare('PRAGMA application_id').get()?.application_id;
      if (id === applicationId) return;
      if (id !== 0 || db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get())
        throw Error('The selected file is not a Flockletter support rehearsal.');
      db.exec(`
        CREATE TABLE tickets(
          id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, scenario TEXT NOT NULL, state TEXT NOT NULL,
          sender TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, draft TEXT, facts TEXT
        ) STRICT;
        CREATE TABLE history(
          entry INTEGER PRIMARY KEY, ticket TEXT NOT NULL REFERENCES tickets(id), state TEXT NOT NULL,
          at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(ticket,state)
        ) STRICT;
        PRAGMA application_id=${applicationId};
      `);
    });
  } catch (error) {
    db.close();
    throw error;
  }
  function get(id: string) {
    const events = db.prepare(`
      SELECT t.*,h.state AS event,h.at
      FROM tickets t JOIN history h ON h.ticket=t.id WHERE t.id=? ORDER BY h.entry
    `).all(id) as Array<TicketRow & { event: State; at: string }>;
    const row = events[0];
    if (!row) throw Error('Unknown support ticket.');
    const history = events.map(({ event, at }) => ({ state: event, at }));
    const messages = [];
    for (const { state, at } of history) {
      if (state === 'received' || state === 'ignored')
        messages.push({ kind: 'incoming_fixture', at, text: row.body });
      if (state === 'acknowledged')
        messages.push({ kind: 'captured_acknowledgment', at, text: 'We received your support request.' });
      if (state === 'approved' && row.draft)
        messages.push({ kind: 'captured_reply', at, text: row.draft });
    }
    return {
      id: row.id, scenario: row.scenario, state: row.state, draft: row.draft, facts: row.facts,
      from: row.sender, subject: row.subject, reviewCode: reviewCode(row), history, messages,
    };
  }
  function record(id: string, state: State) {
    db.prepare('UPDATE tickets SET state=? WHERE id=?').run(state, id);
    db.prepare('INSERT INTO history(ticket,state) VALUES(?,?)').run(id, state);
    return get(id);
  }
  function act(id: string, action: Action, expectedReview?: string) {
    return transaction(db, () => {
      const current = get(id);
      if (action === 'approve' && (!current.reviewCode || current.reviewCode !== expectedReview))
        throw Error('Read the stored facts and draft, then approve its exact review code.');
      const { next, from } = statesForAction[action];
      if (current.history.some(event => event.state === next)) return current;
      if (!from.includes(current.state)) throw Error(`Cannot ${action} a ticket in state ${current.state}.`);
      return record(id, next);
    });
  }
  function ingest(input: unknown) {
    const parsed = envelopeSchema.safeParse(input);
    if (!parsed.success) throw Error('Use a synthetic support envelope, its reserved .test addresses and plain text.');
    const envelope = parsed.data;
    const publicMatch = (Object.keys(supportSamples) as Scenario[]).find(topic =>
      topic !== 'auto-reply' && supportSamples[topic] === envelope.subject && supportSamples[topic] === envelope.text);
    const scenario: Scenario = envelope.autoSubmitted === 'no' ? publicMatch ?? 'other' : 'auto-reply';
    const fingerprint = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
    return transaction(db, () => {
      const id = envelope.messageId;
      const prior = db.prepare('SELECT fingerprint FROM tickets WHERE id=?').get(id);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw Error('This message ID was received with different content.');
        return get(id);
      }
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM tickets').get() as { count: number };
      if (count >= maxTickets) throw Error('This rehearsal holds at most 250 tickets. Start a new private directory.');
      const initial = scenario === 'auto-reply' ? 'ignored' : 'received';
      db.prepare('INSERT INTO tickets(id,fingerprint,scenario,state,sender,subject,body) VALUES(?,?,?,?,?,?,?)')
        .run(id, fingerprint, scenario, initial, envelope.from, envelope.subject, envelope.text);
      return record(id, initial);
    });
  }
  return {
    get, act, ingest,
    list: () => db.prepare('SELECT id,scenario,state FROM tickets ORDER BY rowid').all(),
    close: () => db.close(),
    receive(id: string, scenario: Scenario) {
      if (!isSupportScenario(scenario)) throw Error('Choose a listed support scenario.');
      return ingest({
        kind: 'flockletter.support-rehearsal.v1', messageId: id, from: 'retailer@shop.test', to: 'support@flockletter.test',
        subject: supportSamples[scenario], text: supportSamples[scenario], autoSubmitted: scenario === 'auto-reply' ? 'auto-replied' : 'no',
      });
    },
    async prepare(id: string, writer: LocalWriter) {
      const initial = get(id);
      if (initial.state === 'drafted') return initial;
      if (!['received', 'acknowledged'].includes(initial.state) || initial.scenario === 'auto-reply')
        throw Error(`Cannot draft a ticket in state ${initial.state}.`);
      const prepared = await supportDraft(initial.scenario, writer);
      if (prepared.kind === 'human_review') return act(id, 'escalate');
      return transaction(db, () => {
        const latest = get(id);
        if (latest.state === 'drafted') return latest;
        if (latest.state !== initial.state)
          throw Error('The ticket changed while the draft was being prepared. Review the current ticket.');
        db.prepare('UPDATE tickets SET draft=?, facts=? WHERE id=?').run(prepared.draft, prepared.approvedFacts, id);
        return record(id, 'drafted');
      });
    },
  };
}
