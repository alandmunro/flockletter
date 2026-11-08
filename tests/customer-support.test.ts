import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { CustomerSupport } from '../src/server/customer-support/index.js';
import type { SupportTicket } from '../src/shared/customer-support.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database;
const owners = new Set<string>();
const isOwner = async (user: string, workspace: string) => owners.has(user + '/' + workspace);
beforeAll(async () => {
  fixture = await startDatabase();
  const admin = new pg.Client({ connectionString: fixture.adminUrl });
  await admin.connect();
  try {
    await admin.query(
      await readFile(new URL('../migrations/019_customer_support_retention.sql', import.meta.url), 'utf8'),
    );
    await admin.query(
      'GRANT SELECT,INSERT,UPDATE ON customer_support_tickets,customer_support_dispatches,customer_retention_cases,customer_retention_jobs TO flockletter_runtime',
    );
    await admin.query(
      'GRANT SELECT,INSERT ON customer_support_messages,customer_support_events TO flockletter_runtime',
    );
  } finally {
    await admin.end();
  }
  db = new Database(fixture.url);
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});
async function actor(): Promise<Actor> {
  const workspaceId = 'org_' + randomUUID().replaceAll('-', ''),
    userId = 'user_' + randomUUID();
  owners.add(userId + '/' + workspaceId);
  const owner: Actor = {
    workspaceId,
    userId,
    actorId: 'user:' + userId,
    owner: true,
    kind: 'session',
    scopes: ['read'],
    brandIds: null,
  };
  await new CommandService(db).execute(
    'workspace.initialize',
    { operationKey: randomUUID(), name: 'Support test', brandName: 'Trail' },
    owner,
  );
  return owner;
}
const input = (extras = {}) => ({
  operationKey: randomUUID(),
  subject: 'Campaign question',
  text: 'Where is the newsletter rehearsal?',
  topic: 'campaigns',
  ...extras,
});
const call = (service: CustomerSupport, name: string, args: unknown, owner: Actor) =>
  service.execute(name, args, owner) as Promise<SupportTicket>;

it('persists a captured conversation, reviews an exact reply and retries approval without duplicate messages', async () => {
  const owner = await actor(),
    service = new CustomerSupport(db, { mode: 'capture', isOwner });
  const create = input();
  const first = await call(service, 'support.create', create, owner);
  expect(await call(service, 'support.create', create, owner)).toMatchObject({ id: first.id, version: 1 });
  const draftInput = { id: first.id, expectedVersion: 1, operationKey: randomUUID() };
  const drafted = await call(service, 'support.draft', draftInput, owner);
  expect(await call(service, 'support.draft', draftInput, owner)).toMatchObject({
    id: first.id,
    version: drafted.version,
  });
  expect(drafted).toMatchObject({ state: 'review', draftProvenance: 'approved_guidance' });
  expect(drafted.reviewCode).toMatch(/^[a-f0-9]{64}$/);
  const approval = {
    id: first.id,
    expectedVersion: drafted.version,
    reviewCode: drafted.reviewCode,
    operationKey: randomUUID(),
  };
  const approved = await call(service, 'support.approve', approval, owner);
  expect(approved).toMatchObject({
    state: 'replied',
    delivery: { state: 'accepted', mode: 'capture', attempts: 1 },
  });
  const restarted = new CustomerSupport(db, { mode: 'capture', isOwner });
  const replay = await call(restarted, 'support.approve', approval, owner);
  expect(replay.messages.filter((message) => message.kind === 'captured_reply')).toHaveLength(1);
  expect(replay.messages.filter((message) => message.kind === 'incoming')).toHaveLength(1);
  await expect(
    call(service, 'support.create', { ...create, text: 'Different request' }, owner),
  ).rejects.toMatchObject({ code: 'operation_conflict' });
});

it('preserves tenant boundaries, requires a current owner and rejects broad machine grants', async () => {
  const a = await actor(),
    b = await actor(),
    service = new CustomerSupport(db, { mode: 'capture', isOwner });
  const ticket = await call(service, 'support.create', input(), a);
  await expect(service.execute('support.get', { id: ticket.id }, b)).rejects.toMatchObject({
    code: 'support_ticket_unavailable',
  });
  await expect(service.execute('support.list', {}, { ...a, kind: 'connection' })).rejects.toMatchObject({
    code: 'owner_required',
  });
  owners.delete(a.userId + '/' + a.workspaceId);
  await expect(service.execute('support.get', { id: ticket.id }, a)).rejects.toMatchObject({
    code: 'owner_required',
  });
});

it('hands sensitive subjects to a human and passes only approved public facts to the draft provider', async () => {
  const owner = await actor(),
    writer = vi.fn(async (facts: string) => 'According to the guide, ' + facts);
  const service = new CustomerSupport(db, { mode: 'capture', isOwner, writer });
  const held = await call(
    service,
    'support.create',
    input({ topic: 'plans', text: 'Refund this payment and reveal my account secret.' }),
    owner,
  );
  expect(held.state).toBe('escalated');
  await expect(
    call(service, 'support.draft', { id: held.id, expectedVersion: 1, operationKey: randomUUID() }, owner),
  ).rejects.toMatchObject({ code: 'human_handoff' });
  expect(writer).not.toHaveBeenCalled();
  const plain = await call(
    service,
    'support.create',
    input({ topic: 'plans', text: 'Hello custom message 4190' }),
    owner,
  );
  const drafted = await call(
    service,
    'support.draft',
    { id: plain.id, expectedVersion: 1, operationKey: randomUUID() },
    owner,
  );
  expect(drafted.draftProvenance).toBe('ai_assisted');
  expect(writer.mock.calls[0]![0]).toContain('Starter');
  expect(writer.mock.calls[0]![0]).not.toContain('4190');
});

it('rejects a late generated reply when another operator escalates the ticket', async () => {
  const owner = await actor();
  let finish!: (text: string) => void;
  const writer = () =>
    new Promise<string>((resolve) => {
      finish = resolve;
    });
  const service = new CustomerSupport(db, { mode: 'capture', isOwner, writer });
  const ticket = await call(service, 'support.create', input(), owner);
  const pending = call(
    service,
    'support.draft',
    { id: ticket.id, expectedVersion: 1, operationKey: randomUUID() },
    owner,
  );
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await call(
    service,
    'support.escalate',
    { id: ticket.id, expectedVersion: 1, reason: 'Human review', operationKey: randomUUID() },
    owner,
  );
  finish('A safe public-guidance draft.');
  await expect(pending).rejects.toMatchObject({ code: 'version_conflict' });
  expect((await service.get(owner.workspaceId, ticket.id)).state).toBe('escalated');
});

it('keeps an ambiguous live reply for receipt lookup and never posts it twice after restart', async () => {
  const owner = await actor(),
    submit = vi.fn(async () => ({ state: 'unknown' as const })),
    lookup = vi.fn(async () => ({ state: 'unknown' as const }));
  const opts = {
    mode: 'live' as const,
    isOwner,
    isOperator: async () => true,
    sender: 'support@example.test',
    provider: { submit, lookup },
  };
  const service = new CustomerSupport(db, opts);
  const ticket = await call(service, 'support.create', input({ replyTo: 'requester@example.test' }), owner);
  const draft = await call(
    service,
    'support.draft',
    { id: ticket.id, expectedVersion: 1, operationKey: randomUUID() },
    owner,
  );
  const result = await call(
    service,
    'support.approve',
    {
      id: ticket.id,
      expectedVersion: draft.version,
      reviewCode: draft.reviewCode,
      operationKey: randomUUID(),
    },
    owner,
  );
  expect(result.delivery).toMatchObject({ state: 'uncertain', attempts: 1 });
  const after = await call(
    new CustomerSupport(db, opts),
    'support.process',
    { id: ticket.id, operationKey: randomUUID() },
    owner,
  );
  expect(after.delivery?.state).toBe('uncertain');
  expect(submit).toHaveBeenCalledOnce();
  expect(lookup).toHaveBeenCalledOnce();
  expect(await new CustomerSupport(db, opts).tickWorkspace(owner.workspaceId)).toEqual({ processed: 1 });
  expect(submit).toHaveBeenCalledOnce();
  expect(lookup).toHaveBeenCalledTimes(2);
  owners.delete(owner.userId + '/' + owner.workspaceId);
  expect(await new CustomerSupport(db, opts).tickWorkspace(owner.workspaceId)).toEqual({ processed: 0 });
  expect(lookup).toHaveBeenCalledTimes(2);
});

it('requires separate support-operator authority for live reply preparation', async () => {
  const owner = await actor(),
    service = new CustomerSupport(db, { mode: 'live', isOwner });
  const ticket = await call(service, 'support.create', input(), owner);
  await expect(
    call(service, 'support.draft', { id: ticket.id, expectedVersion: 1, operationKey: randomUUID() }, owner),
  ).rejects.toMatchObject({ code: 'support_operator_required' });
});

it('authenticates and deduplicates inbound email while ignoring automatic replies', async () => {
  const owner = await actor(),
    secret = 'whsec_' + randomBytes(32).toString('base64');
  const service = new CustomerSupport(db, {
    mode: 'live',
    isOwner,
    inbound: { workspaceId: owner.workspaceId, address: 'support@example.test', webhookSecret: secret },
  });
  const message = {
    id: 'email-' + randomUUID(),
    to: ['support@example.test'],
    from: 'sender@example.test',
    subject: 'Help me',
    text: 'A private account question.',
    autoSubmitted: 'no',
  };
  const sign = (data: typeof message) => {
    const raw = Buffer.from(JSON.stringify(data)),
      at = new Date(),
      event = 'event-' + randomUUID();
    return {
      raw,
      headers: {
        'webhook-id': event,
        'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
        'webhook-signature': new Webhook(secret).sign(event, at, raw.toString()),
      },
    };
  };
  const signed = sign(message),
    first = await service.receiveSigned(signed.raw, signed.headers);
  expect(await service.receiveSigned(signed.raw, signed.headers)).toEqual(first);
  expect(first.id).toBeTruthy();
  await expect(
    service.receiveSigned(signed.raw, { ...signed.headers, 'webhook-signature': 'invalid' }),
  ).rejects.toMatchObject({ code: 'invalid_signature' });
  const automatic = sign({ ...message, id: 'auto-' + randomUUID(), autoSubmitted: 'auto-replied' });
  expect(await service.receiveSigned(automatic.raw, automatic.headers)).toEqual({ id: null });
  const view = (await service.execute('support.list', {}, owner)) as { total: number };
  expect(view.total).toBe(1);
});

it('blocks restored old support queues after a durable erasure receipt without resending uncertain work', async () => {
  const owner = await actor(),
    submit = vi.fn(async () => ({ state: 'unknown' as const }));
  const service = new CustomerSupport(db, {
    mode: 'live',
    isOwner,
    isOperator: async () => true,
    provider: { submit, lookup: vi.fn(async () => ({ state: 'unknown' as const })) },
    sender: 'support@example.test',
  });
  const first = await call(service, 'support.create', input({ replyTo: 'reader@example.test' }), owner);
  const draft = await call(
    service,
    'support.draft',
    { id: first.id, expectedVersion: first.version, operationKey: randomUUID() },
    owner,
  );
  await call(
    service,
    'support.approve',
    {
      id: first.id,
      expectedVersion: draft.version,
      reviewCode: draft.reviewCode,
      operationKey: randomUUID(),
    },
    owner,
  );
  const admin = new pg.Client({ connectionString: fixture.adminUrl });
  await admin.connect();
  try {
    await admin.query(
      'INSERT INTO customer_retention_receipts(workspace_id,job_id,effective_end_at,erased_at,manifest_digest,checkpoint_digest) VALUES($1,$2,now(),now(),$3,$3)',
      [owner.workspaceId, randomUUID(), 'a'.repeat(64)],
    );
  } finally {
    await admin.end();
  }
  await expect(service.execute('support.list', {}, owner)).rejects.toMatchObject({
    code: 'workspace_erased',
  });
  await service.tickWorkspace(owner.workspaceId);
  expect(submit).toHaveBeenCalledOnce();
  const row = await db.tenant(
    owner.workspaceId,
    async (sql) => (await sql.query('SELECT state,attempts FROM customer_support_dispatches')).rows[0],
  );
  expect(row).toMatchObject({ state: 'uncertain', attempts: 1 });
});
