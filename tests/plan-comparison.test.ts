import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { recordAccess } from '../scripts/complimentary-access.js';
import { startDatabase } from '../scripts/database-fixture.js';
import { PlanComparisonDetails } from '../src/client/PlanComparisonPanel.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { commands, emptyContent, plans, type Campaign, type Workspace } from '../src/shared/contracts.js';
import type { PlanComparison } from '../src/shared/plan-comparison.js';
import type { PlanId, Rehearsal } from '../src/shared/rehearsal.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database, admin: Database;
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  admin = new Database(fixture.adminUrl);
  await db.verifyBoundary();
});
afterAll(async () => { await db?.close(); await admin?.close(); await fixture?.stop(); });
const keyed = <T extends object>(input: T) => ({ ...input, operationKey: randomUUID() });
function operatorService(total: number | null) {
  const members = vi.fn(async () => {
    if (total === null) throw Error('private identity provider error');
    return { total, members: [] };
  });
  return { members, service: new CommandService(db, undefined, async () => true, undefined, undefined, {
    members, membership: async () => 'owner',
  }) };
}
async function workspace(service: CommandService, name: string) {
  const owner: Actor = { kind: 'session', owner: true, scopes: ['read'], brandIds: null,
    actorId: 'user:tester', userId: 'tester', workspaceId: 'org_' + randomUUID() };
  await service.execute('workspace.initialize', keyed({ name, brandName: name }), owner);
  const brand = ((await service.execute('workspace.get', {}, owner)) as Workspace).brands[0]!.id;
  return { owner, brand };
}
async function contacts(owner: Actor, brand: string, confirmed: number) {
  await db.brand(owner.workspaceId, brand, sql => sql.query(
    `INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state)
     SELECT $1,$2,gen_random_uuid(),'sub-'||n||'@shop.test',CASE WHEN n<=$3 THEN 'confirmed' ELSE 'unsubscribed' END
     FROM generate_series(1,$3::int+1) AS n`, [owner.workspaceId, brand, confirmed],
  ));
}
function compare(service: CommandService, owner: Actor, plan: PlanId) {
  return service.execute('billing.comparePlan', { plan }, owner) as Promise<PlanComparison>;
}

describe('owner plan comparison', () => {
  it('checks a Growth-to-Starter comparison across brands while preserving subscriber and billing state', async () => {
    const { service, members } = operatorService(3);
    const { owner, brand } = await workspace(service, 'Main brand');
    const foreign = await workspace(service, 'Foreign shop');
    await recordAccess(admin, owner.workspaceId, {
      workspaceId: owner.workspaceId, operator: 'tester', reason: 'plan comparison', plan: 'growth', operationKey: randomUUID(),
    });
    const company = await service.execute('company.create', keyed({ name: 'Second company' }), owner) as { id: string };
    const second = await service.execute('brand.create', keyed({ companyId: company.id, name: 'Second brand' }), owner) as { id: string };
    await contacts(owner, brand, 1300);
    await contacts(owner, second.id, 1201);
    await contacts(foreign.owner, foreign.brand, 300);
    const draft = await service.execute('campaign.create', keyed({ brandId: brand, content: {
      ...emptyContent(), title: 'Fixture', subject: 'Fixture', fromName: 'Store', replyTo: 'store@shop.test', heading: 'News', body: 'Hello.',
    } }), owner) as Campaign;
    const review = await service.execute('rehearsal.review', keyed({
      campaignId: draft.id, brandId: brand, expectedVersion: draft.version, audience: 'test',
    }), owner) as Rehearsal;
    await service.execute('rehearsal.approve', keyed({ brandId: brand, id: review.id }), owner);
    const result = await compare(service, owner, 'starter');
    expect(result).toMatchObject({ current: { source: 'complimentary', plan: 'growth' }, fit: 'over_limit',
      target: plans[0], brands: [{ name: 'Main brand', confirmed: 1300 }, { name: 'Second brand', confirmed: 1201 }],
      practice: { reservedMessages: 1 }, });
    expect(result.capacity.map(row => [row.status, row.count, row.limit])).toEqual([
      ['over', 2, 1], ['over', 2, 1], ['over', 3, 1], ['over', 2501, 2500],
    ]);
    expect(result.capacity.every(row => row.guidance)).toBe(true);
    expect(members).toHaveBeenCalledWith(owner.workspaceId, 0, 1);
    expect(await compare(service, owner, 'starter')).toEqual(result);
    expect(await service.execute('billing.status', {}, owner)).toMatchObject({ complimentary: true, status: 'not_started' });
    const html = renderToStaticMarkup(createElement(PlanComparisonDetails, { result }));
    expect(html).toContain('Some workspace counts exceed this tier');
    expect(html).toContain('Practice usage');
    expect(html).toContain('Main brand');
    expect(html).not.toContain('Foreign shop');
  });

  it('shows unknown Clerk totals, preserves unlimited Pro seats and refuses foreign or delegated access', async () => {
    const { service } = operatorService(null);
    const { owner } = await workspace(service, 'Independent');
    const starter = await compare(service, owner, 'starter');
    expect(starter.fit).toBe('needs_verification');
    expect(starter.capacity.find(row => row.label === 'Members')).toMatchObject({ count: null, limit: 1, status: 'unknown' });
    const pro = await compare(service, owner, 'pro');
    expect(pro.fit).toBe('within_limits');
    expect(pro.capacity.find(row => row.label === 'Members')).toMatchObject({ count: null, limit: null, status: 'unknown' });
    expect(renderToStaticMarkup(createElement(PlanComparisonDetails, { result: pro }))).toContain('Unlimited');
    expect(commands['billing.comparePlan']).toMatchObject({ scope: 'owner', mutation: false });
    await expect(service.execute('billing.comparePlan', { plan: 'starter', workspaceId: 'org_other' }, owner)).rejects.toThrow();
    await expect(compare(service, { ...owner, owner: false }, 'starter')).rejects.toMatchObject({ code: 'owner_required' });
    await expect(compare(service, { ...owner, kind: 'connection' }, 'starter')).rejects.toMatchObject({ code: 'owner_required' });
  });

  it('requires a verified sandbox subscription before showing a current sandbox tier', async () => {
    const { service } = operatorService(30);
    const { owner } = await workspace(service, 'Sandbox comparison');
    await admin.tenant(owner.workspaceId, sql => sql.query(
      `INSERT INTO sandbox_checkouts(workspace_id,id,operation_key,actor_id,plan,sandbox_account,provider_price,customer_id,subscription_id,status)
       VALUES($1,$2,$3,'user:tester','growth','acct_fixture','price_fixture',$4,$5,'active')`,
      [owner.workspaceId, randomUUID(), randomUUID(), 'cus_' + randomUUID(), 'sub_' + randomUUID()],
    ));
    expect((await compare(service, owner, 'pro')).current).toEqual({ source: 'preparation', plan: null });
    await admin.tenant(owner.workspaceId, sql => sql.query('UPDATE sandbox_checkouts SET observed_at=now() WHERE workspace_id=$1', [owner.workspaceId]));
    const verified = await compare(service, owner, 'pro');
    expect(verified.current).toEqual({ source: 'stripe_sandbox', plan: 'growth' });
    expect(verified.capacity.find(row => row.label === 'Members')).toMatchObject({ count: 30, limit: null, status: 'within' });
    expect(verified.fit).toBe('within_limits');
  });

  it('includes the target tier’s exact contact, company, brand and member ceilings', async () => {
    const { service } = operatorService(1);
    const { owner, brand } = await workspace(service, 'Exact limit');
    await contacts(owner, brand, plans[0].contacts);
    const result = await compare(service, owner, 'starter');
    expect(result.fit).toBe('within_limits');
    expect(result.capacity.every(row => row.status === 'within' && row.count === row.limit)).toBe(true);
    expect(result.brands[0]?.exceedsCampaignLimit).toBe(false);
    await db.brand(owner.workspaceId, brand, sql => sql.query(
      "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'extra@shop.test','confirmed')",
      [owner.workspaceId, brand, randomUUID()],
    ));
    expect((await compare(service, owner, 'starter')).brands[0]?.exceedsCampaignLimit).toBe(true);
  });
});
