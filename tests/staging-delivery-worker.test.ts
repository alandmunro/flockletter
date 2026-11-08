import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { studioFixtureImage } from '../scripts/studio-fixture-image.js';
import { DeliveryWorker } from '../src/server/campaign/delivery-worker.js';
import { emptyContent, type AssetSummary, type Campaign } from '../src/shared/contracts.js';
import type { RecipientOutcome, Rehearsal, Usage } from '../src/shared/rehearsal.js';
import { RecordingProvider, startDeliveryFixture } from './staging-delivery-fixture.js';

type Outcomes = { recipients: RecipientOutcome[] };
let site: Awaited<ReturnType<typeof startDeliveryFixture>>;
let account: Awaited<ReturnType<typeof site.workspace>>;
let provider: RecordingProvider;
let draft: Campaign;
let photo: Buffer;
let sha: string;
const content = {
  ...emptyContent(),
  title: 'Test trail notes',
  subject: 'Summer trail report',
  fromName: 'Trail shop',
  replyTo: 'trail@example.test',
  heading: 'On the trail',
  body: 'The trail is open.',
};

beforeAll(async () => {
  site = await startDeliveryFixture();
  photo = await studioFixtureImage('#8b4764');
  sha = createHash('sha256').update(photo).digest('hex');
});
afterAll(async () => {
  await site?.close();
});
beforeEach(async () => {
  account = await site.workspace();
  provider = new RecordingProvider();
  const uploaded = await account.command<{ results: { ok: boolean; asset: AssetSummary }[] }>(
    'asset.uploadBatch',
    {
      operationKey: randomUUID(),
      brandId: account.brandId,
      files: [{ itemKey: randomUUID(), name: 'Trail.png', base64: photo.toString('base64') }],
    },
  );
  expect(uploaded.results[0]).toMatchObject({ ok: true, asset: { sha256: sha } });
  draft = await account.command('campaign.create', {
    operationKey: randomUUID(),
    brandId: account.brandId,
    content: { ...content, assetIds: [uploaded.results[0]!.asset.id] },
  });
});
afterEach(async () => {
  await account?.close();
});

const bound = (id: string) => ({ brandId: account.brandId, id });
const worker = () => new DeliveryWorker(site.db, site.identity.isOwner, provider);
const tick = (id: string) => worker().tick(account.workspaceId, account.brandId, id);
const report = (id: string) => account.command<Rehearsal>('rehearsal.report', bound(id));
const outcomes = (id: string) => account.command<Outcomes>('rehearsal.outcomes', bound(id));
const usage = () => account.command<{ usage: Usage }>('workspace.access', {});

async function approve(audience: 'test' | 'confirmed' = 'test', dueAt?: string) {
  const review = await account.command<Rehearsal>('rehearsal.review', {
    operationKey: randomUUID(),
    campaignId: draft.id,
    brandId: account.brandId,
    expectedVersion: draft.version,
    audience,
    transport: 'provider_test',
    ...(dueAt ? { dueAt } : {}),
  });
  const request = { ...bound(review.id), operationKey: randomUUID() };
  const result = await account.command<Rehearsal>('rehearsal.approve', request);
  expect(await account.command('rehearsal.approve', request)).toEqual(result);
  return result;
}

async function contact(email: string) {
  const id = randomUUID();
  await site.db.brand(account.workspaceId, account.brandId, (sql) =>
    sql.query(
      "INSERT INTO subscribers (workspace_id,brand_id,id,email_normalized,state) VALUES ($1,$2,$3,$4,'confirmed')",
      [account.workspaceId, account.brandId, id, email],
    ),
  );
  return id;
}
async function lookupDue(id: string) {
  await site.db.brand(account.workspaceId, account.brandId, (sql) =>
    sql.query(
      "UPDATE rehearsal_recipients SET next_check_at=now() WHERE rehearsal_id=$1 AND state='uncertain'",
      [id],
    ),
  );
}

describe('staging provider delivery through the worker, HTTP and MCP', () => {
  it('honors the schedule and latest consent, preserving one ambiguous submission and both report views', async () => {
    const removed = await contact('optout@example.test');
    await contact('keeper@example.test');
    await contact('customer@business.example');
    const scheduled = await approve('confirmed', new Date(Date.now() + 600_000).toISOString());
    expect(scheduled).toMatchObject({
      selected: 2,
      excluded: 1,
      state: 'queued',
      transport: 'provider_test',
    });
    await tick(scheduled.id);
    expect(provider.submitted).toHaveLength(0);
    expect((await outcomes(scheduled.id)).recipients.map((row) => row.state)).toEqual(['pending', 'pending']);

    await contact('later@example.test');
    await account.command('audience.unsubscribe', { brandId: account.brandId, id: removed });
    await site.db.brand(account.workspaceId, account.brandId, (sql) =>
      sql.query("UPDATE campaign_rehearsals SET due_at=now()-interval '1 second' WHERE id=$1", [
        scheduled.id,
      ]),
    );
    // Simulate a lost provider acknowledgment after it has accepted the message.
    provider.onSubmit = async () => {
      throw new Error('Synthetic provider timeout after acceptance');
    };
    for (let i = 0; i < 4; i++) await tick(scheduled.id);
    expect(provider.submitted).toHaveLength(1);
    const message = provider.submitted[0]!;
    expect(message).toMatchObject({
      workspaceId: account.workspaceId,
      brandId: account.brandId,
      to: 'keeper@example.test',
      subject: content.subject,
      html: expect.stringContaining('cid:' + sha),
      text: expect.stringContaining(content.body),
      images: [{ name: 'Trail.png', mime: 'image/png', sha256: sha, bytes: photo }],
    });
    expect(message.operationKey).toBeTruthy();
    const unresolved = await outcomes(scheduled.id);
    expect(unresolved.recipients.map((row) => row.state).sort()).toEqual(['excluded', 'uncertain']);
    expect(unresolved.recipients.find((row) => row.state === 'excluded')?.attempts).toBe(0);
    expect(unresolved.recipients.find((row) => row.state === 'uncertain')?.attempts).toBe(1);
    for (const row of unresolved.recipients) {
      expect(row).not.toHaveProperty('subscriber_id');
      expect(row).not.toHaveProperty('email_digest');
    }
    expect(JSON.stringify(unresolved)).not.toContain('@');
    expect(await account.tool('rehearsal_outcomes', bound(scheduled.id))).toEqual(unresolved);
    const pending = await report(scheduled.id);
    expect(pending).toMatchObject({ accepted: 0, uncertain: 1, skipped: 1, captured: 0 });
    expect(await account.tool('rehearsal_report', bound(scheduled.id))).toEqual(pending);
    expect((await usage()).usage.reservedMessages).toBeGreaterThanOrEqual(1);
    await lookupDue(scheduled.id);
    await tick(scheduled.id);
    expect(provider.lookedUp).toContain(message.operationKey);
    expect(provider.submitted).toHaveLength(1);
    expect((await report(scheduled.id)).uncertain).toBe(1);

    provider.lookupResult = 'accepted';
    await lookupDue(scheduled.id);
    await tick(scheduled.id);
    await tick(scheduled.id);
    const final = await report(scheduled.id);
    expect(final).toMatchObject({
      state: 'completed',
      accepted: 1,
      rejected: 0,
      uncertain: 0,
      skipped: 1,
      pending: 0,
      captured: 0,
    });
    expect(await account.tool('rehearsal_report', bound(scheduled.id))).toEqual(final);
    expect(provider.submitted).toHaveLength(1);
    expect(new Set(provider.lookedUp)).toEqual(new Set([message.operationKey]));
    expect((await usage()).usage).toMatchObject({ campaigns: 1, messages: 1, reservedMessages: 0 });
  });

  it('admits only a single submission when two workers wake for the same recipient', async () => {
    const queued = await approve();
    let entered!: () => void, release!: () => void;
    const submitting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const reply = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.onSubmit = async () => {
      entered();
      await reply;
      return 'accepted';
    };
    const first = tick(queued.id);
    await Promise.race([
      submitting,
      first.then(() => {
        throw new Error('Worker finished before submission');
      }),
    ]);
    const concurrent = tick(queued.id);
    release();
    await Promise.all([first, concurrent]);
    await tick(queued.id);
    expect(provider.submitted).toHaveLength(1);
    expect(await report(queued.id)).toMatchObject({ state: 'completed', accepted: 1, uncertain: 0 });
    expect((await outcomes(queued.id)).recipients).toMatchObject([{ state: 'accepted', attempts: 1 }]);
  });

  it('retries with the original operation key only after a definitive negative lookup', async () => {
    const queued = await approve();
    provider.onSubmit = async () => 'unknown';
    await tick(queued.id);
    await tick(queued.id);
    expect(provider.submitted).toHaveLength(1);
    expect((await outcomes(queued.id)).recipients).toMatchObject([{ state: 'uncertain', attempts: 1 }]);
    provider.lookupResult = 'not_submitted';
    await lookupDue(queued.id);
    await tick(queued.id);
    provider.onSubmit = async () => 'accepted';
    await tick(queued.id);
    expect(provider.submitted).toHaveLength(2);
    expect(provider.submitted[1]!.operationKey).toBe(provider.submitted[0]!.operationKey);
    expect((await outcomes(queued.id)).recipients).toMatchObject([{ state: 'accepted', attempts: 2 }]);
    expect((await usage()).usage).toMatchObject({ messages: 1, reservedMessages: 0 });
  });

  it('keeps a cancelled uncertain attempt available for reconciliation and settles it once', async () => {
    const queued = await approve();
    provider.onSubmit = async () => 'unknown';
    await tick(queued.id);
    await account.command('rehearsal.cancel', { ...bound(queued.id), operationKey: randomUUID() });
    expect(await report(queued.id)).toMatchObject({ state: 'cancelled', uncertain: 1 });
    expect((await usage()).usage.reservedMessages).toBe(1);
    provider.lookupResult = 'accepted';
    await lookupDue(queued.id);
    await tick(queued.id);
    await tick(queued.id);
    expect(await report(queued.id)).toMatchObject({ state: 'cancelled', accepted: 1, uncertain: 0 });
    expect(provider.submitted).toHaveLength(1);
    expect((await usage()).usage).toMatchObject({ messages: 1, reservedMessages: 0 });
  });

  it('stops a changed draft while preserving the receipt lookup of an earlier attempt', async () => {
    await contact('first@example.test');
    await contact('second@example.test');
    const queued = await approve('confirmed');
    provider.onSubmit = async () => 'unknown';
    await tick(queued.id);
    await account.command('campaign.update', {
      id: draft.id,
      expectedVersion: draft.version,
      operationKey: randomUUID(),
      content: { ...draft.content, subject: 'Edited after scheduling' },
    });
    expect(await report(queued.id)).toMatchObject({
      state: 'blocked',
      reason: 'draft_changed',
      uncertain: 1,
      pending: 0,
    });
    provider.lookupResult = 'not_submitted';
    await lookupDue(queued.id);
    await tick(queued.id);
    await tick(queued.id);
    expect(provider.submitted).toHaveLength(1);
    expect(await report(queued.id)).toMatchObject({
      state: 'blocked',
      accepted: 0,
      uncertain: 0,
      skipped: 2,
    });
    expect((await usage()).usage).toMatchObject({ campaigns: 0, messages: 0, reservedMessages: 0 });
  });

  it('blocks the provider before submission when the approved reservation is no longer available', async () => {
    const queued = await approve();
    await site.db.brand(account.workspaceId, account.brandId, (sql) =>
      sql.query('UPDATE rehearsal_reservations SET settled=true WHERE rehearsal_id=$1', [queued.id]),
    );
    await tick(queued.id);
    expect(provider.submitted).toHaveLength(0);
    expect(await report(queued.id)).toMatchObject({
      state: 'blocked',
      accepted: 0,
      uncertain: 0,
      skipped: 1,
    });
    expect((await outcomes(queued.id)).recipients).toMatchObject([{ state: 'cancelled', attempts: 0 }]);
  });

  it('isolates recipient reports and processing across brands and workspaces', async () => {
    const queued = await approve();
    const second = await site.workspace();
    try {
      expect(
        (await second.post('rehearsal.outcomes', { brandId: second.brandId, id: queued.id })).status,
      ).toBe(404);
      await expect(
        second.tool('rehearsal_outcomes', { brandId: account.brandId, id: queued.id }),
      ).rejects.toThrow();
      await worker().tick(second.workspaceId, second.brandId, queued.id);
      await worker().tick(account.workspaceId, second.brandId, queued.id);
      expect(provider.submitted).toHaveLength(0);
      expect((await outcomes(queued.id)).recipients).toMatchObject([{ state: 'pending', attempts: 0 }]);
    } finally {
      await second.close();
    }
  });

  it('reconciles an expired submitting lease across a crash before considering another submission', async () => {
    const queued = await approve();
    const {
      recipients: [original],
    } = await outcomes(queued.id);
    await site.db.brand(account.workspaceId, account.brandId, (sql) =>
      sql.query(
        "UPDATE rehearsal_recipients SET state='submitting',attempts=1,next_check_at=now()-interval '1 minute' WHERE rehearsal_id=$1",
        [queued.id],
      ),
    );
    await tick(queued.id);
    expect(provider.submitted).toHaveLength(0);
    expect(provider.lookedUp).toEqual([original!.id]);
    expect((await outcomes(queued.id)).recipients).toMatchObject([{ state: 'uncertain', attempts: 1 }]);
    await lookupDue(queued.id);
    provider.lookupResult = 'accepted';
    await tick(queued.id);
    expect(provider.submitted).toHaveLength(0);
    expect((await outcomes(queued.id)).recipients).toMatchObject([{ state: 'accepted', attempts: 1 }]);
  });

  it('processes the staging receipt through MCP and HTTP and recovers the synthetic timeout once', async () => {
    await contact('timeout@delivery.test');
    const queued = await approve('confirmed');
    const input = { ...bound(queued.id), operationKey: randomUUID() };
    await account.tool('rehearsal_process', input);
    const held = await outcomes(queued.id);
    expect(held.recipients).toMatchObject([{ state: 'uncertain', attempts: 1 }]);
    expect(await account.tool('rehearsal_outcomes', bound(queued.id))).toEqual(held);
    await account.command('rehearsal.process', { ...bound(queued.id), operationKey: randomUUID() });
    expect((await outcomes(queued.id)).recipients).toMatchObject([{ state: 'accepted', attempts: 1 }]);
    expect(await account.tool('rehearsal_report', bound(queued.id))).toMatchObject({
      accepted: 1,
      uncertain: 0,
      state: 'completed',
    });
    const receipts = await site.db.brand(account.workspaceId, account.brandId, (sql) =>
      sql.query('SELECT operation_key FROM delivery_test_receipts WHERE rehearsal_id=$1', [queued.id]),
    );
    expect(receipts.rows).toEqual([{ operation_key: held.recipients[0]!.id }]);
    expect((await usage()).usage).toMatchObject({ messages: 1, reservedMessages: 0 });
  });
});
