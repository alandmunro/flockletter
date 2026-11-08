import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordCampaignFeedback } from '../src/server/campaign/feedback.js';
import { emptyContent, type Campaign } from '../src/shared/contracts.js';
import type { RecipientOutcome, Rehearsal } from '../src/shared/rehearsal.js';
import { startDeliveryFixture } from './staging-delivery-fixture.js';

type Fixture = Awaited<ReturnType<typeof startDeliveryFixture>>;
type Workspace = Awaited<ReturnType<Fixture['workspace']>>;
type FeedbackInput = Parameters<typeof recordCampaignFeedback>[1];
type Outcomes = { recipients: RecipientOutcome[] };
let site: Fixture;
let account: Workspace;
let draft: Campaign;

beforeAll(async () => {
  site = await startDeliveryFixture();
});
afterAll(async () => {
  await site?.close();
});
beforeEach(async () => {
  account = await site.workspace();
  draft = await account.command('campaign.create', {
    brandId: account.brandId,
    operationKey: randomUUID(),
    content: {
      ...emptyContent(),
      title: 'November trail notes',
      subject: 'A weekend at the trailhead',
      fromName: 'Trail shop',
      replyTo: 'shop@example.test',
      heading: 'The trail forecast',
      body: 'A clear weekend ahead.',
    },
  });
});
afterEach(async () => {
  await account?.close();
});

const args = (id: string) => ({ brandId: account.brandId, id });
const outcomes = (id: string) => account.command<Outcomes>('rehearsal.outcomes', args(id));
async function approve(transport: 'feedback_test' | 'provider_test', audience: 'test' | 'confirmed') {
  const item = await account.command<Rehearsal>('rehearsal.review', {
    brandId: account.brandId,
    campaignId: draft.id,
    expectedVersion: draft.version,
    transport,
    audience,
    operationKey: randomUUID(),
  });
  return account.command<Rehearsal>('rehearsal.approve', { ...args(item.id), operationKey: randomUUID() });
}

async function process(item: Rehearsal) {
  // Each call processes one recipient; the review fixes the size of the batch.
  for (let i = 0; i < item.selected; i++) {
    await account.tool('rehearsal_process', { ...args(item.id), operationKey: randomUUID() });
  }
  const result = await account.command<Rehearsal>('rehearsal.report', args(item.id));
  expect(await account.tool('rehearsal_report', args(item.id))).toEqual(result);
  return result;
}
async function seed(email: string, workspace = account.workspaceId, brand = account.brandId) {
  const id = randomUUID();
  await site.db.brand(workspace, brand, (sql) =>
    sql.query(
      "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,$4,'confirmed')",
      [workspace, brand, id, email],
    ),
  );
  return id;
}
async function stateOf(id: string, workspace = account.workspaceId, brand = account.brandId) {
  const { rows } = await site.db.brand(workspace, brand, (sql) =>
    sql.query<{ state: string }>('SELECT state FROM subscribers WHERE id=$1', [id]),
  );
  return rows[0]!.state;
}
async function suppressionCount(id: string) {
  const { rows } = await site.db.brand(account.workspaceId, account.brandId, (sql) =>
    sql.query<{ count: number }>(
      "SELECT count(*)::int count FROM subscriber_consent_events WHERE subscriber_id=$1 AND event='suppressed'",
      [id],
    ),
  );
  return rows[0]!.count;
}
const verifiedEvent = (
  operation: string,
  destination: string,
  kind: FeedbackInput['kind'],
): FeedbackInput => ({
  workspace: account.workspaceId,
  brand: account.brandId,
  operation,
  destination,
  kind,
  eventId: randomUUID(),
  messageId: 'local-' + operation,
  transport: 'feedback_test',
  binding: 'local-feedback-v1',
});
const record = (input: FeedbackInput) =>
  site.db.brand(input.workspace, input.brand, (sql) => recordCampaignFeedback(sql, input));

describe('campaign provider feedback through PostgreSQL, HTTP and MCP', () => {
  it('distinguishes acceptance from delivered mail for both generations of test approvals', async () => {
    for (const mode of ['provider_test', 'feedback_test'] as const) {
      const item = await approve(mode, 'test');
      expect(await process(item)).toMatchObject({ state: 'completed', accepted: 1, captured: 0 });
      const result = await outcomes(item.id);
      expect(await account.tool('rehearsal_outcomes', args(item.id))).toEqual(result);
      expect(result.recipients).toHaveLength(1);
      expect(result.recipients[0]!.state).toBe('accepted');
      expect(result.recipients[0]!.feedback ?? null).toBe(mode === 'feedback_test' ? 'delivered' : null);
    }
  });

  it('excludes newly suppressed recipients from previously approved mail while temporary failures stay eligible', async () => {
    const addresses = [
      'success@example.test',
      'bounce@delivery.test',
      'complaint@delivery.test',
      'delay@delivery.test',
    ];
    const contacts = [];
    for (const address of addresses) contacts.push(await seed(address));
    const first = await approve('feedback_test', 'confirmed'),
      queued = await approve('feedback_test', 'confirmed');
    expect([first.selected, queued.selected]).toEqual([4, 4]);
    expect(await process(first)).toMatchObject({ state: 'completed', accepted: 4, rejected: 0 });
    const initial = await outcomes(first.id);
    expect(initial.recipients.map((row) => row.feedback).sort()).toEqual([
      'complaint',
      'delivered',
      'permanent_bounce',
      'temporary_bounce',
    ]);
    expect(await account.tool('rehearsal_outcomes', args(first.id))).toEqual(initial);
    expect(JSON.stringify(initial)).not.toContain('@');
    for (const contact of contacts) expect(JSON.stringify(initial)).not.toContain(contact);
    expect(await Promise.all(contacts.map((id) => stateOf(id)))).toEqual([
      'confirmed',
      'hard_bounced',
      'complained',
      'confirmed',
    ]);
    expect(await process(queued)).toMatchObject({ state: 'completed', selected: 4, accepted: 2, skipped: 2 });
    const later = await outcomes(queued.id);
    expect(later.recipients.filter((row) => row.state === 'excluded').map((row) => row.attempts)).toEqual([
      0, 0,
    ]);
    const fresh = await approve('feedback_test', 'confirmed');
    expect(fresh).toMatchObject({ selected: 2, excluded: 2 });
  });

  it('keeps a complaint through duplicate and out-of-order events while recording each suppression transition once', async () => {
    const destination = 'member@example.test',
      subscriber = await seed(destination);
    const item = await approve('feedback_test', 'confirmed');
    await process(item);
    const operation = (await outcomes(item.id)).recipients[0]!.id;
    const secondItem = await approve('feedback_test', 'confirmed');
    await process(secondItem);
    const secondOperation = (await outcomes(secondItem.id)).recipients[0]!.id;
    const bounce = verifiedEvent(operation, destination, 'permanent_bounce');
    await Promise.all([record(bounce), record(bounce)]);
    expect(await stateOf(subscriber)).toBe('hard_bounced');
    expect(await suppressionCount(subscriber)).toBe(1);
    await expect(record({ ...bounce, kind: 'complaint' })).rejects.toMatchObject({
      code: 'feedback_conflict',
    });
    await expect(
      record({ ...bounce, operation: secondOperation, messageId: 'local-' + secondOperation }),
    ).rejects.toMatchObject({ code: 'feedback_conflict' });
    expect((await outcomes(secondItem.id)).recipients[0]!.feedback).toBe('delivered');
    expect(await stateOf(subscriber)).toBe('hard_bounced');
    const complaint = verifiedEvent(operation, destination, 'complaint');
    await record(complaint);
    await record(complaint);
    await record(verifiedEvent(operation, destination, 'delivered'));
    await record(verifiedEvent(operation, destination, 'temporary_bounce'));
    await record(bounce);
    expect(await stateOf(subscriber)).toBe('complained');
    expect(await suppressionCount(subscriber)).toBe(2);
    const audit = await site.db.brand(account.workspaceId, account.brandId, (sql) =>
      sql.query('SELECT event,source FROM subscriber_consent_events WHERE subscriber_id=$1', [subscriber]),
    );
    expect(audit.rows).toEqual(Array(2).fill({ event: 'suppressed', source: 'campaign-feedback_test' }));
    expect(await account.tool('rehearsal_outcomes', args(item.id))).toMatchObject({
      recipients: [{ id: operation, state: 'accepted', feedback: 'complaint', attempts: 1 }],
    });
    expect(await account.command('rehearsal.report', args(item.id))).toMatchObject({ accepted: 1 });
  });

  it('keeps delivery visible when a temporary bounce arrives afterward', async () => {
    const destination = 'delay@delivery.test';
    const subscriber = await seed(destination);

    const item = await approve('feedback_test', 'confirmed');
    expect(await process(item)).toMatchObject({ state: 'completed', selected: 1, accepted: 1 });

    const initial = await outcomes(item.id);
    expect(initial.recipients).toHaveLength(1);
    expect(initial.recipients[0]).toMatchObject({ state: 'accepted', feedback: 'temporary_bounce' });
    expect(await stateOf(subscriber)).toBe('confirmed');
    expect(await suppressionCount(subscriber)).toBe(0);

    const operation = initial.recipients[0]!.id;
    await record(verifiedEvent(operation, destination, 'delivered'));
    await record(verifiedEvent(operation, destination, 'temporary_bounce'));

    const result = await outcomes(item.id);
    expect(await account.tool('rehearsal_outcomes', args(item.id))).toEqual(result);
    expect(result.recipients[0]).toMatchObject({ id: operation, state: 'accepted', feedback: 'delivered' });
    expect(await stateOf(subscriber)).toBe('confirmed');
    expect(await suppressionCount(subscriber)).toBe(0);
  });

  it('preserves the new subscriber address when late feedback arrives for the old recipient snapshot', async () => {
    const original = 'old@example.test',
      subscriber = await seed(original);
    const item = await approve('feedback_test', 'confirmed');
    await process(item);
    const operation = (await outcomes(item.id)).recipients[0]!.id;
    await site.db.brand(account.workspaceId, account.brandId, (sql) =>
      sql.query('UPDATE subscribers SET email_normalized=$2 WHERE id=$1', [subscriber, 'new@example.test']),
    );
    await record(verifiedEvent(operation, original, 'permanent_bounce'));
    expect(await stateOf(subscriber)).toBe('confirmed');
    expect(await suppressionCount(subscriber)).toBe(0);
    expect((await outcomes(item.id)).recipients[0]).toMatchObject({
      state: 'accepted',
      feedback: 'permanent_bounce',
    });
  });

  it('requires the deterministic offline receipt before reconciling an ambiguous first acknowledgment', async () => {
    const item = await approve('feedback_test', 'test');
    const operation = (await outcomes(item.id)).recipients[0]!.id;
    await site.db.brand(account.workspaceId, account.brandId, (sql) =>
      sql.query("UPDATE rehearsal_recipients SET state='uncertain', attempts=1 WHERE rehearsal_id=$1", [
        item.id,
      ]),
    );
    const event = verifiedEvent(operation, 'reader@campaign.test', 'delivered');
    await expect(record({ ...event, messageId: 'unknown-message' })).rejects.toMatchObject({
      code: 'feedback_unmapped',
    });
    expect((await outcomes(item.id)).recipients[0]!.state).toBe('uncertain');
    await record(event);
    expect(await account.command('rehearsal.report', args(item.id))).toMatchObject({
      state: 'completed',
      accepted: 1,
      uncertain: 0,
    });
    expect(await account.tool('rehearsal_outcomes', args(item.id))).toMatchObject({
      recipients: [{ id: operation, state: 'accepted', feedback: 'delivered', attempts: 1 }],
    });
  });

  it('requires the attempted operation, original destination, provider binding and workspace before recording feedback', async () => {
    const address = 'shared@example.test',
      original = await seed(address);
    const item = await approve('feedback_test', 'confirmed');
    const operation = (await outcomes(item.id)).recipients[0]!.id;
    const event = verifiedEvent(operation, address, 'complaint');
    const refused = { code: 'feedback_unmapped' };
    await expect(record(event)).rejects.toMatchObject(refused);
    await process(item);
    const second = await site.workspace();
    try {
      const otherSubscriber = await seed(address, second.workspaceId, second.brandId);
      const siblingBrand = randomUUID();
      await site.db.tenant(account.workspaceId, (sql) =>
        sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
          account.workspaceId,
          siblingBrand,
          'Other brand',
        ]),
      );
      const siblingSubscriber = await seed(address, account.workspaceId, siblingBrand);
      for (const mismatch of [
        { messageId: 'different-message' },
        { binding: 'someone-else' },
        { destination: 'unrelated@example.test' },
        { transport: 'ses_simulator' as const },
        { workspace: second.workspaceId, brand: second.brandId },
        { brand: siblingBrand },
      ])
        await expect(record({ ...event, ...mismatch })).rejects.toMatchObject(refused);
      expect(await stateOf(original)).toBe('confirmed');
      expect((await outcomes(item.id)).recipients[0]!.feedback).toBe('delivered');
      expect((await second.post('rehearsal.outcomes', { brandId: second.brandId, id: item.id })).status).toBe(
        404,
      );
      await record(event);
      expect(await stateOf(original)).toBe('complained');
      expect(await stateOf(otherSubscriber, second.workspaceId, second.brandId)).toBe('confirmed');
      expect(await stateOf(siblingSubscriber, account.workspaceId, siblingBrand)).toBe('confirmed');
    } finally {
      await second.close();
    }
  });
});
