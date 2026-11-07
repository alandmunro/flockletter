import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { recordAccess } from '../scripts/complimentary-access.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { emptyContent, type Campaign, type CommandName, type Workspace } from '../src/shared/contracts.js';
import { type Rehearsal, type Usage } from '../src/shared/rehearsal.js';
import { CaptureWorker, captureBinding } from '../src/server/campaign/worker.js';
import { workspaceAccess } from '../src/server/campaign/access.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>,
  db: Database,
  admin: Database,
  service: CommandService;
let owner: Actor,
  brand: string,
  draft: Campaign,
  revoked = false;
const id = randomUUID;
const run = <T>(name: CommandName, input: unknown, actor = owner) =>
  service.execute(name, input, actor) as Promise<T>;
const keyed = <T extends object>(input: T) => ({ ...input, operationKey: id() });
const content = {
  ...emptyContent(),
  title: 'Winter field notes',
  subject: 'First snowfall',
  fromName: 'Alpine shop',
  replyTo: 'shop@example.test',
  heading: 'First snow',
  body: 'The trail is open.',
};
const grant = (plan: 'starter' | 'growth' | null, key: string = id()) =>
  recordAccess(admin, owner.workspaceId, {
    workspaceId: owner.workspaceId,
    plan,
    operator: 'fixture operator',
    reason: 'Isolated practice',
    operationKey: key,
  });
const review = (
  audience: 'test' | 'confirmed' = 'test',
  extra: Record<string, unknown> = {},
  actor = owner,
) =>
  run<Rehearsal>(
    'rehearsal.review',
    keyed({ campaignId: draft.id, brandId: brand, expectedVersion: draft.version, audience, ...extra }),
    actor,
  );
const approve = (item: Rehearsal, actor = owner) =>
  run<Rehearsal>('rehearsal.approve', keyed({ brandId: brand, id: item.id }), actor);
const report = (item: Rehearsal) => run<Rehearsal>('rehearsal.report', { brandId: brand, id: item.id });
const worker = () => new CaptureWorker(db, async () => !revoked);
const tick = () => worker().tick(owner.workspaceId, brand);
async function contact(email: string, state: string = 'confirmed') {
  const person = id();
  await db.brand(owner.workspaceId, brand, (sql) =>
    sql.query(
      'INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,$4,$5)',
      [owner.workspaceId, brand, person, email, state],
    ),
  );
  return person;
}
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  admin = new Database(fixture.adminUrl);
  await db.verifyBoundary();
});
afterAll(async () => {
  await admin?.close();
  await db?.close();
  await fixture?.stop();
});
beforeEach(async () => {
  revoked = false;
  service = new CommandService(db, undefined, async () => !revoked);
  owner = {
    workspaceId: 'org_' + id().replaceAll('-', ''),
    userId: 'owner',
    actorId: 'user:owner',
    kind: 'session',
    owner: true,
    scopes: ['read'],
    brandIds: null,
  };
  await run('workspace.initialize', keyed({ name: 'Pilot test', brandName: 'Test brand' }));
  brand = (await run<Workspace>('workspace.get', {})).brands[0]!.id;
  draft = await run<Campaign>('campaign.create', keyed({ brandId: brand, content }));
});
describe('captured campaign lifecycle', () => {
  it('keeps complimentary access operator-only, versioned, idempotent and workspace-bound', async () => {
    const key = id(),
      input = {
        workspaceId: owner.workspaceId,
        plan: 'growth',
        operator: 'test',
        reason: 'Isolated practice',
        operationKey: key,
      };
    await expect(recordAccess(db, owner.workspaceId, input)).rejects.toMatchObject({ code: '42501' });
    await expect(recordAccess(admin, 'org_other', input)).rejects.toThrow('target');
    expect(await recordAccess(admin, owner.workspaceId, input)).toEqual({ revision: 1, plan: 'growth' });
    expect(await recordAccess(admin, owner.workspaceId, input)).toEqual({ revision: 1, plan: 'growth' });
    await expect(recordAccess(admin, owner.workspaceId, { ...input, plan: 'pro' })).rejects.toThrow(
      'different grant',
    );
    expect(await run('workspace.get', {})).toMatchObject({ entitlement: 'complimentary' });
    expect(await db.tenant('org_other', workspaceAccess)).toMatchObject({
      status: 'preparation',
      revision: 0,
    });
    expect(await grant(null)).toEqual({ revision: 2, plan: null });
    expect(await run('workspace.get', {})).toMatchObject({ entitlement: 'not_activated' });
  });
  it('captures exactly the reviewed version once across concurrent worker attempts without any real recipients', async () => {
    const original = await review();
    await expect(run('rehearsal.message', { brandId: brand, id: original.id })).rejects.toMatchObject({
      code: 'mailbox_empty',
    });
    const input = keyed({ brandId: brand, id: original.id });
    expect(await run('rehearsal.approve', input)).toMatchObject({ state: 'queued', selected: 1 });
    expect(await run('rehearsal.approve', input)).toMatchObject({ state: 'queued' });
    const results = await Promise.all([tick(), tick()]);
    expect(results.filter((result) => result.processed)).toHaveLength(1);
    expect(await report(original)).toMatchObject({
      state: 'completed',
      captured: 1,
      pending: 0,
      excluded: 0,
    });
    expect(await run('rehearsal.message', { brandId: brand, id: original.id })).toMatchObject({
      mailbox: 'reader@campaign.test',
      version: 1,
      subject: content.subject,
      text: expect.stringContaining(content.body),
    });
    expect(await run('workspace.access', {})).toMatchObject({
      access: { status: 'preparation' },
      usage: { messages: 1, campaigns: 0, reservedMessages: 0 },
    });
  });
  it('freezes eligible synthetic subscribers and removes later opt-outs without adding new signups', async () => {
    const first = await contact('first@example.test');
    await contact('second@example.test');
    await contact('pending@example.test', 'pending');
    await contact('customer@business.example');
    await expect(review('confirmed')).rejects.toMatchObject({ code: 'access_required' });
    await grant('starter');
    const original = await review('confirmed');
    expect(original).toMatchObject({ selected: 2, excluded: 2 });
    await approve(original);
    await contact('added@example.test');
    await run('audience.unsubscribe', { brandId: brand, id: first });
    await tick();
    expect(await report(original)).toMatchObject({
      state: 'completed',
      selected: 2,
      captured: 1,
      skipped: 1,
      pending: 0,
    });
    expect(await tick()).toEqual({ processed: false });
  });
  it('requires fresh content and membership both at approval and execution', async () => {
    let item = await review();
    await run(
      'campaign.update',
      keyed({ id: draft.id, expectedVersion: 1, content: { ...content, subject: 'Changed' } }),
    );
    await expect(approve(item)).rejects.toMatchObject({ code: 'version_conflict' });
    draft = await run('campaign.get', { id: draft.id });
    item = await review();
    await approve(item);
    await run('campaign.update', keyed({ id: draft.id, expectedVersion: draft.version, content }));
    await tick();
    expect(await report(item)).toMatchObject({ state: 'blocked', reason: 'draft_changed', captured: 0 });
    draft = await run('campaign.get', { id: draft.id });
    item = await review();
    await approve(item);
    revoked = true;
    await tick();
    expect(await report(item)).toMatchObject({ state: 'blocked', reason: 'authority_revoked' });
    expect(await run('workspace.access', {})).toMatchObject({ usage: { messages: 0, reservedMessages: 0 } });
  });
  it('reserves shared periods atomically, cancels safely, and rechecks complimentary revision', async () => {
    await contact('one@example.test');
    await grant('starter');
    const items = await Promise.all([review('confirmed'), review('confirmed'), review('confirmed')]);
    const booked = await Promise.allSettled(items.map((item) => approve(item)));
    expect(booked.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
    const success = booked.findIndex((x) => x.status === 'fulfilled'),
      failed = booked.findIndex((x) => x.status === 'rejected');
    const info = await run<{ usage: Usage }>('workspace.access', {});
    expect(info.usage.reservedCampaigns).toBe(2);
    await run('rehearsal.cancel', keyed({ brandId: brand, id: items[success]!.id }));
    await approve(items[failed]!);
    await grant(null);
    await tick();
    await tick();
    expect(await report(items[failed]!)).toMatchObject({
      state: 'blocked',
      reason: 'access_changed',
      captured: 0,
    });
  });
  it('isolates tenant/brand records and expires reviewed confirmations, honoring due time', async () => {
    const item = await review('test', { dueAt: new Date(Date.now() + 3600000).toISOString() });
    await approve(item);
    expect(await tick()).toEqual({ processed: false });
    await expect(run('rehearsal.report', { brandId: id(), id: item.id })).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (await db.brand('org_other', brand, (sql) => sql.query('SELECT id FROM campaign_rehearsals'))).rows,
    ).toEqual([]);
    expect(
      (await db.brand(owner.workspaceId, id(), (sql) => sql.query('SELECT id FROM rehearsal_recipients')))
        .rows,
    ).toEqual([]);
    const old = await review();
    await db.brand(owner.workspaceId, brand, (sql) =>
      sql.query("UPDATE campaign_rehearsals SET reviewed_at=now()-interval '31 minutes' WHERE id=$1", [
        old.id,
      ]),
    );
    await expect(approve(old)).rejects.toMatchObject({ code: 'review_expired' });
    await run('rehearsal.cancel', keyed({ brandId: brand, id: item.id }));
    expect(await tick()).toEqual({ processed: false });
  });
  it('blocks legacy connection scopes, cross-brand replay, and revoked capture grants', async () => {
    const old: Actor = {
      ...owner,
      kind: 'connection',
      actorId: 'connection:' + id(),
      scopes: ['read', 'draft:write'],
      brandIds: [brand],
    };
    await expect(review('test', {}, old)).rejects.toMatchObject({ code: 'scope_required' });
    await expect(
      run(
        'connection.create',
        keyed({ name: 'Capture test', expiresInDays: 1, scopes: ['campaign:rehearse'], brandIds: [brand] }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_rehearsal_grant' });
    const conn = await run<{ connection: { id: string } }>(
      'connection.create',
      keyed({
        name: 'Capture test',
        expiresInDays: 1,
        scopes: ['read', 'campaign:rehearse'],
        brandIds: [brand],
      }),
    );
    const actor: Actor = {
      ...old,
      actorId: 'connection:' + conn.connection.id,
      scopes: ['read', 'campaign:rehearse'],
    };
    const item = await review('test', {}, actor);
    await expect(approve(item, owner)).rejects.toMatchObject({ code: 'reviewer_required' });
    await approve(item, actor);
    await run('connection.revoke', keyed({ id: conn.connection.id }));
    await tick();
    expect(await report(item)).toMatchObject({ state: 'blocked', reason: 'authority_revoked' });
    expect(() => captureBinding({ FLOCKLETTER_CAPTURE_WORKSPACE: 'org_x' })).toThrow();
  });
});
