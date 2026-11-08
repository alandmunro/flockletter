import { createHash, randomUUID } from 'node:crypto';
import type { SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import pg from 'pg';
import { applyMigrations } from '../scripts/apply-migrations.mjs';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { studioFixtureImage } from '../scripts/studio-fixture-image.js';
import { DeliveryWorker } from '../src/server/campaign/delivery-worker.js';
import type { DeliveryEnvelope } from '../src/server/campaign/delivery-provider.js';
import { recordCampaignFeedback, saveProviderReceipt } from '../src/server/campaign/feedback.js';
import { PrivateListmonk } from '../src/server/campaign/private-listmonk.js';
import { parseSesRoute, type SesRuntime } from '../src/server/campaign/ses-runtime.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { emptyContent, type AssetSummary, type Campaign, type Workspace } from '../src/shared/contracts.js';
import type { RecipientOutcome, Rehearsal } from '../src/shared/rehearsal.js';
import { startDeliveryFixture } from './staging-delivery-fixture.js';

type Site = Awaited<ReturnType<typeof startDeliveryFixture>>;
type Account = Awaited<ReturnType<Site['workspace']>>;
type Method = 'listmonk_test' | 'listmonk_ses';
type Rendered = { message: DeliveryEnvelope; reference: string };
type Simulate = NonNullable<SesRuntime['port']>['send'];

let site: Site;
let account: Account;
let draft: Campaign;
let photo: Buffer;
const rendered: Rendered[] = [];
const engine = {
  async render(message: DeliveryEnvelope, reference: string) {
    rendered.push({ message, reference });
  },
};
beforeAll(async () => {
  site = await startDeliveryFixture();
  photo = await studioFixtureImage('#a66351');
});
afterAll(async () => {
  await site?.close();
});
beforeEach(async () => {
  rendered.length = 0;
  account = await site.workspace();
  const uploaded = await account.command<{ results: { asset: AssetSummary }[] }>('asset.uploadBatch', {
    brandId: account.brandId,
    operationKey: randomUUID(),
    files: [{ itemKey: randomUUID(), name: 'Trail.png', base64: photo.toString('base64') }],
  });
  draft = await account.command<Campaign>('campaign.create', {
    brandId: account.brandId,
    operationKey: randomUUID(),
    content: {
      ...emptyContent(),
      title: 'Field report',
      subject: 'Forecast {{ .Subscriber.Email }}',
      fromName: 'Trail shop',
      replyTo: 'shop@example.test',
      heading: 'Trail notes',
      body: 'A day of fresh snow.',
      assetIds: [uploaded.results[0]!.asset.id],
    },
  });
});
afterEach(async () => {
  await account?.close();
});
function dispatcher(ses?: SesRuntime, acct = account) {
  return new PrivateListmonk(
    site.db,
    site.identity.isOwner,
    { workspace: acct.workspaceId, brand: acct.brandId },
    engine,
    ses,
  );
}
function commands(dispatch: PrivateListmonk, ses?: SesRuntime) {
  return new CommandService(
    site.db,
    undefined,
    site.identity.isOwner,
    undefined,
    undefined,
    undefined,
    (workspace, brand) => workspace === account.workspaceId && brand === account.brandId,
    ses,
    dispatch,
  );
}
function callback(render: Rendered) {
  return {
    from_email: render.reference,
    recipients: [{ email: render.message.to }],
    content_type: 'html',
    subject: render.message.subject,
    body: render.message.html,
    attachments: render.message.images.map((image) => ({
      name: image.name,
      header: { 'Content-Type': [image.mime] },
      content: image.bytes.toString('base64'),
    })),
  };
}
async function approve(service: CommandService, transport: Method, audience: 'test' | 'confirmed' = 'test') {
  const reviewed = (await service.execute(
    'rehearsal.review',
    {
      operationKey: randomUUID(),
      brandId: account.brandId,
      campaignId: draft.id,
      expectedVersion: draft.version,
      audience,
      transport,
    },
    account.owner,
  )) as Rehearsal;
  return (await service.execute(
    'rehearsal.approve',
    {
      operationKey: randomUUID(),
      brandId: account.brandId,
      id: reviewed.id,
    },
    account.owner,
  )) as Rehearsal;
}
const report = (id: string) => account.tool<Rehearsal>('rehearsal_report', { brandId: account.brandId, id });
const outcomes = (id: string) =>
  account.tool<{ recipients: RecipientOutcome[] }>('rehearsal_outcomes', { brandId: account.brandId, id });
const tick = (dispatch: PrivateListmonk, id: string) =>
  dispatch.tick(account.workspaceId, account.brandId, id);
async function countReceipts(id: string) {
  return site.db.brand(
    account.workspaceId,
    account.brandId,
    async (sql) =>
      (
        await sql.query<{ count: number }>(
          'SELECT count(*)::int count FROM campaign_provider_receipts WHERE rehearsal_id=$1',
          [id],
        )
      ).rows[0]!.count,
  );
}
function sesRuntime(send: Simulate, set = 'field-simulator'): SesRuntime {
  return {
    route: parseSesRoute({
      workspaceId: account.workspaceId,
      brandId: account.brandId,
      region: 'us-west-2',
      accountId: '123456789012',
      tenant: 'field-tenant',
      configurationSet: set,
      from: 'sender@shop.example.org',
      identityArn: 'arn:aws:ses:us-west-2:123456789012:identity/shop.example.org',
      topicArn: 'arn:aws:sns:us-west-2:123456789012:private-test',
    }),
    port: { send },
  };
}
async function verifiedSender() {
  await site.db.brand(account.workspaceId, account.brandId, (sql) =>
    sql.query(
      "INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge,checked_at,verified_at) VALUES($1,$2,'shop.example.org',$3,now(),now())",
      [account.workspaceId, account.brandId, randomUUID()],
    ),
  );
}
async function confirm(email: string) {
  const id = randomUUID();
  await site.db.brand(account.workspaceId, account.brandId, (sql) =>
    sql.query(
      "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,$4,'confirmed')",
      [account.workspaceId, account.brandId, id, email],
    ),
  );
  return id;
}
async function makeReconciliationDue(id: string) {
  await site.db.brand(account.workspaceId, account.brandId, (sql) =>
    sql.query(
      "UPDATE rehearsal_recipients SET next_check_at=now() WHERE rehearsal_id=$1 AND state IN ('submitting','uncertain')",
      [id],
    ),
  );
}

describe('durable private Listmonk delivery', () => {
  it('resumes the recorded handoff after restart and coalesces concurrent, identical callbacks', async () => {
    const first = dispatcher(),
      run = await approve(commands(first), 'listmonk_test');
    await Promise.all([tick(first, run.id), tick(dispatcher(), run.id)]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.message.images[0]!.bytes).toEqual(photo);
    expect((await outcomes(run.id)).recipients[0]?.attempts).toBe(0);
    expect(await countReceipts(run.id)).toBe(0);
    const restart = dispatcher(),
      event = callback(rendered[0]!);
    await Promise.all([restart.receive(event), dispatcher().receive(event)]);
    expect(await countReceipts(run.id)).toBe(0);
    await Promise.all([tick(restart, run.id), tick(dispatcher(), run.id)]);
    expect(await report(run.id)).toMatchObject({ state: 'completed', accepted: 1 });
    expect((await outcomes(run.id)).recipients).toMatchObject([
      { state: 'accepted', attempts: 1, feedback: 'delivered' },
    ]);
    await dispatcher().receive(event);
    await tick(dispatcher(), run.id);
    expect(await countReceipts(run.id)).toBe(1);
    expect(rendered).toHaveLength(1);
  });

  it('admits one outstanding renderer per brand without delaying a stored callback or a cancellation', async () => {
    const dispatch = dispatcher(),
      service = commands(dispatch);
    const first = await approve(service, 'listmonk_test'),
      second = await approve(service, 'listmonk_test');
    expect(await tick(dispatch, first.id)).toEqual({ processed: true });
    expect(await tick(dispatcher(), second.id)).toEqual({ processed: false });
    expect(rendered).toHaveLength(1);
    await dispatch.receive(callback(rendered[0]!));
    expect(await tick(dispatcher(), second.id)).toEqual({ processed: true });
    expect(rendered).toHaveLength(2);
    expect(rendered[1]!.reference).not.toBe(rendered[0]!.reference);
    // Both steps must still work while the second renderer holds its live lease.
    await tick(dispatch, first.id);
    expect(await report(first.id)).toMatchObject({ state: 'completed', accepted: 1 });
    await service.execute(
      'rehearsal.cancel',
      { id: second.id, brandId: account.brandId, operationKey: randomUUID() },
      account.owner,
    );
    expect(await report(second.id)).toMatchObject({ state: 'cancelled', skipped: 1, accepted: 0 });
    expect((await outcomes(second.id)).recipients).toMatchObject([{ state: 'cancelled', attempts: 0 }]);
    expect(
      (await account.command<{ usage: { reservedMessages: number } }>('workspace.access', {})).usage
        .reservedMessages,
    ).toBe(0);
    // Listmonk may still finish its canceled render. That cannot recreate a delivery reservation.
    await dispatch.receive(callback(rendered[1]!));
    await makeReconciliationDue(second.id);
    await tick(dispatcher(), second.id);
    expect(await report(second.id)).toMatchObject({ state: 'cancelled', skipped: 1, accepted: 0 });
    expect(await countReceipts(second.id)).toBe(0);
    expect(rendered).toHaveLength(2);
  });

  it('retains an authenticated callback that arrived before the engine response was lost', async () => {
    let queued = false;
    const primary = new PrivateListmonk(
      site.db,
      site.identity.isOwner,
      { workspace: account.workspaceId, brand: account.brandId },
      {
        async render(message, reference) {
          rendered.push({ message, reference });
          // This separate database transaction must see the intent while the HTTP request is still outstanding.
          await dispatcher().receive(callback({ message, reference }));
          queued = true;
          throw new Error('The engine response was lost after callback storage.');
        },
      },
    );
    const service = commands(primary);
    const run = await approve(service, 'listmonk_test');
    const request = { id: run.id, brandId: account.brandId, operationKey: randomUUID() };
    await service.execute('rehearsal.process', request, account.owner);
    await service.execute('rehearsal.process', request, account.owner);
    expect(queued).toBe(true);
    expect(await countReceipts(run.id)).toBe(0);
    await makeReconciliationDue(run.id);
    await tick(dispatcher(), run.id);
    expect(await report(run.id)).toMatchObject({ state: 'completed', accepted: 1 });
    expect(rendered).toHaveLength(1);
    expect(await countReceipts(run.id)).toBe(1);
  });

  it('replays migrations over a saved private review and preserves its pending handoff', async () => {
    const fixture = await startDatabase(),
      db = new Database(fixture.url);
    const migrator = new pg.Client({ connectionString: fixture.adminUrl });
    try {
      const owner: Actor = {
        kind: 'session',
        userId: 'fixture-owner',
        actorId: 'user:fixture-owner',
        owner: true,
        workspaceId: 'org_migration_fixture',
        brandIds: null,
        scopes: ['read'],
      };
      const ownerCheck = async () => true;
      const setup = new CommandService(db, undefined, ownerCheck);
      await setup.execute(
        'workspace.initialize',
        { operationKey: randomUUID(), name: 'Migration fixture', brandName: 'Private trail' },
        owner,
      );
      const brandId = ((await setup.execute('workspace.get', {}, owner)) as Workspace).brands[0]!.id;
      const dispatch = new PrivateListmonk(
        db,
        ownerCheck,
        { workspace: owner.workspaceId, brand: brandId },
        engine,
      );
      const svc = new CommandService(
        db,
        undefined,
        ownerCheck,
        undefined,
        undefined,
        undefined,
        () => true,
        undefined,
        dispatch,
      );
      const campaign = (await svc.execute(
        'campaign.create',
        { brandId, operationKey: randomUUID(), content: { ...draft.content, assetIds: [] } },
        owner,
      )) as Campaign;
      const item = (await svc.execute(
        'rehearsal.review',
        {
          brandId,
          campaignId: campaign.id,
          expectedVersion: campaign.version,
          operationKey: randomUUID(),
          audience: 'test',
          transport: 'listmonk_test',
        },
        owner,
      )) as Rehearsal;
      await svc.execute('rehearsal.approve', { id: item.id, brandId, operationKey: randomUUID() }, owner);
      await dispatch.tick(owner.workspaceId, brandId, item.id);
      expect(rendered).toHaveLength(1);
      await migrator.connect();
      // Use only this test database's migration identity; a routine web role cannot alter policy or schema.
      await applyMigrations(migrator, new URL(fixture.url).username);
      await db.verifyBoundary();
      const handoff = await db.brand(owner.workspaceId, brandId, (sql) =>
        sql.query('SELECT operation_key,reference FROM listmonk_handoffs WHERE rehearsal_id=$1', [item.id]),
      );
      expect(handoff.rows).toEqual([
        { operation_key: rendered[0]!.message.operationKey, reference: rendered[0]!.reference },
      ]);
      await dispatch.receive(callback(rendered[0]!));
      await dispatch.tick(owner.workspaceId, brandId, item.id);
      expect(await svc.execute('rehearsal.report', { brandId, id: item.id }, owner)).toMatchObject({
        state: 'completed',
        accepted: 1,
      });
    } finally {
      await migrator.end();
      await db.close();
      await fixture.stop();
    }
  });

  it('keeps both new methods out of existing capture-only connection grants', async () => {
    await verifiedSender();
    const ses = sesRuntime(async () => ({ MessageId: 'unused' })),
      dispatch = dispatcher(ses);
    const service = commands(dispatch, ses);
    const legacy = {
      ...account.owner,
      kind: 'connection' as const,
      actorId: 'connection:' + randomUUID(),
      brandIds: [account.brandId],
      scopes: account.owner.scopes.concat('campaign:rehearse', 'audience:summary'),
    };
    const listed = (await service.execute('rehearsal.methods', { brandId: account.brandId }, legacy)) as {
      methods: string[];
    };
    expect(listed.methods).not.toContain('listmonk_test');
    expect(listed.methods).not.toContain('listmonk_ses');
    for (const transport of ['listmonk_test', 'listmonk_ses']) {
      await expect(
        service.execute(
          'rehearsal.review',
          {
            brandId: account.brandId,
            campaignId: draft.id,
            expectedVersion: draft.version,
            operationKey: randomUUID(),
            audience: 'test',
            transport,
          },
          legacy,
        ),
      ).rejects.toMatchObject({ code: 'scope_required' });
    }
    const ownerMethods = (await service.execute(
      'rehearsal.methods',
      { brandId: account.brandId },
      account.owner,
    )) as { methods: string[] };
    expect(ownerMethods.methods).toEqual(expect.arrayContaining(['listmonk_test', 'listmonk_ses']));
  });

  it('refuses a changed callback and a reference from another brand or workspace', async () => {
    const dispatch = dispatcher(),
      run = await approve(commands(dispatch), 'listmonk_test');
    await tick(dispatch, run.id);
    const event = callback(rendered[0]!);
    const wrongAccount = await site.workspace();
    try {
      await expect(dispatcher(undefined, wrongAccount).receive(event)).rejects.toThrow();
      const visible = await site.db.brand(wrongAccount.workspaceId, wrongAccount.brandId, (sql) =>
        sql.query('SELECT reference FROM listmonk_handoffs WHERE reference=$1', [event.from_email]),
      );
      expect(visible.rows).toEqual([]);
      const sibling = new PrivateListmonk(
        site.db,
        site.identity.isOwner,
        { workspace: account.workspaceId, brand: randomUUID() },
        engine,
      );
      await expect(sibling.receive(event)).rejects.toThrow();
      const changed = {
        ...event,
        attachments: [{ ...event.attachments[0]!, content: Buffer.from('modified').toString('base64') }],
      };
      for (const tampered of [
        changed,
        { ...event, subject: 'Edited after review' },
        { ...event, recipients: [...event.recipients, { email: 'another@example.test' }] },
      ])
        await expect(dispatch.receive(tampered)).rejects.toThrow();
      expect(await countReceipts(run.id)).toBe(0);
      expect(await report(run.id)).toMatchObject({ accepted: 0 });
      await dispatch.receive(event);
      await expect(dispatch.receive(changed)).rejects.toThrow();
      await tick(dispatch, run.id);
      expect(await countReceipts(run.id)).toBe(1);
    } finally {
      await wrongAccount.close();
    }
  });

  it.each(['before callback', 'after callback'] as const)(
    'honors a late brand opt-out %s and settles unused allowance',
    async (when) => {
      const id = await confirm('reader@campaign.test');
      const requests: SendEmailCommandInput[] = [];
      const ses = sesRuntime(async (input) => {
        requests.push(input);
        return { MessageId: 'unexpected' };
      });
      await verifiedSender();
      const dispatch = dispatcher(ses),
        run = await approve(commands(dispatch, ses), 'listmonk_ses', 'confirmed');
      await tick(dispatch, run.id);
      expect(rendered).toHaveLength(1);
      const event = callback(rendered[0]!);
      if (when === 'after callback') await dispatch.receive(event);
      await account.command('audience.unsubscribe', { brandId: account.brandId, id });
      if (when === 'before callback') await dispatch.receive(event);
      await tick(dispatcher(ses), run.id);
      expect(await report(run.id)).toMatchObject({ accepted: 0, skipped: 1 });
      expect((await outcomes(run.id)).recipients).toMatchObject([{ state: 'excluded' }]);
      expect(await countReceipts(run.id)).toBe(0);
      expect(requests).toHaveLength(0);
      expect(
        (
          await account.command<{ usage: { reservedMessages: number; messages: number } }>(
            'workspace.access',
            {},
          )
        ).usage,
      ).toMatchObject({ reservedMessages: 0, messages: 0 });
    },
  );

  it('holds an uncertain SES attempt across restart and reconciles its positive receipt without another submission', async () => {
    const requests: SendEmailCommandInput[] = [];
    const ses = sesRuntime(async (input) => {
      requests.push(input);
      throw Error('Lost provider acknowledgment.');
    });
    await verifiedSender();
    const first = dispatcher(ses),
      run = await approve(commands(first, ses), 'listmonk_ses');
    await tick(first, run.id);
    expect(rendered).toHaveLength(1);
    const operation = rendered[0]!.message.operationKey;
    const binding = first.binding(account.workspaceId, account.brandId, 'listmonk_ses');
    expect(binding).toBeTruthy();
    await expect(
      site.db.brand(account.workspaceId, account.brandId, (sql) =>
        recordCampaignFeedback(sql, {
          workspace: account.workspaceId,
          brand: account.brandId,
          operation,
          eventId: randomUUID(),
          messageId: 'too-early',
          binding: binding!,
          transport: 'listmonk_ses',
          kind: 'delivered',
          destination: 'success@simulator.amazonses.com',
        }),
      ),
    ).rejects.toMatchObject({ code: 'feedback_unmapped' });
    expect(await countReceipts(run.id)).toBe(0);
    await first.receive(callback(rendered[0]!));
    await tick(dispatcher(ses), run.id);
    expect(requests).toHaveLength(1);
    const email = requests[0]!;
    expect(email.Destination?.ToAddresses).toEqual(['success@simulator.amazonses.com']);
    const simple = email.Content?.Simple;
    expect(simple?.Body?.Text?.Data).toEqual(rendered[0]!.message.text);
    expect(simple?.Body?.Html?.Data).toEqual(rendered[0]!.message.html);
    expect(simple?.Attachments?.[0]?.ContentId).toEqual(createHash('sha256').update(photo).digest('hex'));
    expect(Buffer.from(simple?.Attachments?.[0]?.RawContent ?? [])).toEqual(photo);
    expect(await report(run.id)).toMatchObject({ uncertain: 1, accepted: 0 });
    expect(
      (await account.command<{ usage: { reservedMessages: number } }>('workspace.access', {})).usage
        .reservedMessages,
    ).toBe(1);
    await commands(first, ses).execute(
      'rehearsal.cancel',
      { brandId: account.brandId, id: run.id, operationKey: randomUUID() },
      account.owner,
    );
    expect(await report(run.id)).toMatchObject({ state: 'cancelled', uncertain: 1, skipped: 0 });
    expect(
      (await account.command<{ usage: { reservedMessages: number } }>('workspace.access', {})).usage
        .reservedMessages,
    ).toBe(1);
    const restored = dispatcher(ses);
    await restored.receive(callback(rendered[0]!));
    await makeReconciliationDue(run.id);
    await tick(restored, run.id);
    expect(requests).toHaveLength(1);
    expect(await report(run.id)).toMatchObject({ uncertain: 1, accepted: 0 });
    expect(await countReceipts(run.id)).toBe(0);
    await site.db.brand(account.workspaceId, account.brandId, (sql) =>
      saveProviderReceipt(
        sql,
        account.workspaceId,
        account.brandId,
        run.id,
        operation,
        binding!,
        'observed-simulator-receipt',
      ),
    );
    await makeReconciliationDue(run.id);
    const stopped = new PrivateListmonk(
      site.db,
      site.identity.isOwner,
      { workspace: account.workspaceId, brand: account.brandId },
      undefined,
    );
    await tick(stopped, run.id);
    expect(await report(run.id)).toMatchObject({ state: 'cancelled', accepted: 1, uncertain: 0 });
    expect((await outcomes(run.id)).recipients).toMatchObject([{ state: 'accepted', attempts: 1 }]);
    expect(requests).toHaveLength(1);
    expect(rendered).toHaveLength(1);
  });

  it('releases a rendered but unforwarded job when its private engine is disabled', async () => {
    const dispatch = dispatcher();
    const run = await approve(commands(dispatch), 'listmonk_test');
    await tick(dispatch, run.id);
    expect(rendered).toHaveLength(1);
    expect(
      (await account.command<{ usage: { reservedMessages: number } }>('workspace.access', {})).usage
        .reservedMessages,
    ).toBe(1);
    const stopped = new PrivateListmonk(
      site.db,
      site.identity.isOwner,
      { workspace: account.workspaceId, brand: account.brandId },
      undefined,
    );
    expect(stopped.binding(account.workspaceId, account.brandId, 'listmonk_test')).toBeNull();
    await makeReconciliationDue(run.id);
    await new DeliveryWorker(site.db, site.identity.isOwner).tick(
      account.workspaceId,
      account.brandId,
      run.id,
    );
    expect(await report(run.id)).toMatchObject({ state: 'blocked', accepted: 0 });
    expect((await outcomes(run.id)).recipients).toMatchObject([{ state: 'cancelled', attempts: 0 }]);
    expect(
      (await account.command<{ usage: { reservedMessages: number } }>('workspace.access', {})).usage
        .reservedMessages,
    ).toBe(0);
    expect(await countReceipts(run.id)).toBe(0);
  });

  it('blocks a reviewed SES operation if the sender route changes before the downstream phase', async () => {
    await verifiedSender();
    const sent: SendEmailCommandInput[] = [];
    const send: Simulate = async (input) => {
      sent.push(input);
      return { MessageId: 'unexpected' };
    };
    const ses = sesRuntime(send),
      dispatch = dispatcher(ses);
    const run = await approve(commands(dispatch, ses), 'listmonk_ses');
    await tick(dispatch, run.id);
    await dispatch.receive(callback(rendered[0]!));
    const rotated = dispatcher(sesRuntime(send, 'another-configuration'));
    await tick(rotated, run.id);
    expect(await report(run.id)).toMatchObject({ state: 'blocked', accepted: 0 });
    expect(sent).toHaveLength(0);
    expect(await countReceipts(run.id)).toBe(0);
  });
});
