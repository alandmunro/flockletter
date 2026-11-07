import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { startDatabase } from '../scripts/database-fixture.js';
import { recordAccess } from '../scripts/complimentary-access.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { emptyContent, type CommandName } from '../src/shared/contracts.js';
import type { CompanyDirectory } from '../src/shared/companies.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>,
  db: Database,
  operator: Database,
  service: CommandService;
const key = () => randomUUID();
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  operator = new Database(fixture.adminUrl);
  service = new CommandService(db);
  await db.verifyBoundary();
});
afterAll(async () => {
  await db?.close();
  await operator?.close();
  await fixture?.stop();
});
const cmd = <T>(actor: Actor, name: CommandName, input: unknown) =>
  service.execute(name, input, actor) as Promise<T>;
async function setup(label = 'Paper merchant') {
  const actor: Actor = {
    workspaceId: 'org_' + key().replaceAll('-', ''),
    userId: 'sample-owner',
    actorId: 'user:sample-owner',
    owner: true,
    kind: 'session',
    scopes: ['read'],
    brandIds: null,
  };
  const input = { name: label, brandName: 'Newsroom', operationKey: key() };
  await Promise.all([cmd(actor, 'workspace.initialize', input), cmd(actor, 'workspace.initialize', input)]);
  const data = await cmd<CompanyDirectory>(actor, 'company.list', {});
  return { actor, company: data.companies[0]!, brand: data.companies[0]!.brands[0]! };
}
function plan(actor: Actor, level: 'starter' | 'growth' | 'pro' | null) {
  return recordAccess(operator, actor.workspaceId, {
    workspaceId: actor.workspaceId,
    plan: level,
    operator: 'fixture',
    reason: 'Company test',
    operationKey: key(),
  });
}
describe('workspace companies and brands', () => {
  it('atomically creates one default company and first brand, permits the same names in another tenant, and enforces preparation limits', async () => {
    const a = await setup(),
      b = await setup();
    expect(a.company.id).not.toBe(b.company.id);
    expect(a.company.id).toMatch(/^[a-f0-9]{8}-.{4}-8.{3}-8.{3}-.{12}$/);
    const data = await cmd<CompanyDirectory>(a.actor, 'company.list', {});
    expect(data).toMatchObject({
      companies: [{ id: a.company.id, name: 'Paper merchant', isDefault: true, brands: [a.brand] }],
      brandCount: 1,
      limits: { companies: 1, brands: 1 },
      planName: 'Preparation',
    });
    await expect(
      cmd(a.actor, 'company.create', { name: 'Another entity', operationKey: key() }),
    ).rejects.toMatchObject({ code: 'company_limit' });
    await expect(
      cmd(a.actor, 'brand.create', { companyId: a.company.id, name: 'Another sender', operationKey: key() }),
    ).rejects.toMatchObject({ code: 'brand_limit' });
    await expect(
      cmd({ ...a.actor, kind: 'connection', brandIds: [a.brand.id] }, 'company.list', {}),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      cmd({ ...a.actor, owner: false }, 'brand.rename', {
        id: a.brand.id,
        name: 'Blocked',
        operationKey: key(),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('deduplicates retried creates and serializes competing requests at the shared Growth limits', async () => {
    const { actor, company } = await setup();
    await plan(actor, 'growth');
    const input = { name: 'Equipment', operationKey: key() };
    const pair = await Promise.all([
      cmd(actor, 'company.create', input),
      cmd(actor, 'company.create', input),
    ]);
    expect(pair[0]).toEqual(pair[1]);
    await expect(
      cmd(actor, 'company.create', { name: '  EQUIPMENT ', operationKey: key() }),
    ).rejects.toMatchObject({ code: 'name_in_use' });
    const adds = await Promise.allSettled(
      ['Clothing', 'Outfitters'].map((name) => cmd(actor, 'company.create', { name, operationKey: key() })),
    );
    expect(adds.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(adds.find((r) => r.status === 'rejected')).toHaveProperty('reason.code', 'company_limit');
    const second = await cmd<{ id: string }>(actor, 'brand.create', {
      name: 'Winter notes',
      companyId: company.id,
      operationKey: key(),
    });
    await expect(
      cmd(actor, 'brand.rename', { id: second.id, name: 'NEWSROOM', operationKey: key() }),
    ).rejects.toMatchObject({ code: 'name_in_use' });
    const brands = await Promise.allSettled(
      ['Outdoor', 'Retail'].map((name) =>
        cmd(actor, 'brand.create', { name, companyId: company.id, operationKey: key() }),
      ),
    );
    expect(brands.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(brands.find((r) => r.status === 'rejected')).toHaveProperty('reason.code', 'brand_limit');
    const list = await cmd<CompanyDirectory>(actor, 'company.list', {});
    expect(list).toMatchObject({ limits: { companies: 3, brands: 3 }, brandCount: 3 });
    expect(list.companies).toHaveLength(3);
    await expect(
      db.tenant(actor.workspaceId, (sql) =>
        sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
          actor.workspaceId,
          key(),
          ' WiNtEr NoTeS ',
        ]),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
  it('keeps a reassigned brand and its records intact, rejects foreign associations and preserves over-limit records on downgrade', async () => {
    const a = await setup(),
      b = await setup();
    await plan(a.actor, 'pro');
    const owned = await cmd<{ id: string }>(a.actor, 'company.create', {
      name: 'Second entity',
      operationKey: key(),
    });
    const brandTwo = await cmd<{ id: string }>(a.actor, 'brand.create', {
      name: 'Second brand',
      companyId: owned.id,
      operationKey: key(),
    });
    const draft = await cmd<{ id: string }>(a.actor, 'campaign.create', {
      brandId: a.brand.id,
      content: emptyContent(),
      operationKey: key(),
    });
    await db.brand(a.actor.workspaceId, a.brand.id, (sql) =>
      sql.query(
        "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'synthetic@example.test','confirmed')",
        [a.actor.workspaceId, a.brand.id, key()],
      ),
    );
    await cmd(a.actor, 'brand.move', { id: a.brand.id, companyId: owned.id, operationKey: key() });
    await cmd(a.actor, 'brand.rename', { id: a.brand.id, name: 'New label', operationKey: key() });
    await cmd(a.actor, 'company.rename', { id: owned.id, name: 'Revised entity', operationKey: key() });
    const revised = await cmd<CompanyDirectory>(a.actor, 'company.list', {});
    expect(revised.limits).toEqual({ companies: 5, brands: 5 });
    expect(revised.companies.find((c) => c.id === owned.id)?.brands).toContainEqual({
      id: a.brand.id,
      name: 'New label',
    });
    expect((await cmd<{ brandId: string }>(a.actor, 'campaign.get', { id: draft.id })).brandId).toBe(
      a.brand.id,
    );
    expect(
      (await cmd<{ confirmed: number }>(a.actor, 'audience.summary', { brandId: a.brand.id })).confirmed,
    ).toBe(1);
    for (const [name, input] of [
      ['company.rename', { id: b.company.id, name: 'Foreign' }],
      ['brand.rename', { id: b.brand.id, name: 'Foreign' }],
      ['brand.create', { companyId: b.company.id, name: 'Foreign' }],
      ['brand.move', { id: a.brand.id, companyId: b.company.id }],
      ['brand.move', { id: b.brand.id, companyId: owned.id }],
    ] as const)
      await expect(cmd(a.actor, name, { ...input, operationKey: key() })).rejects.toMatchObject({
        status: 404,
      });
    await expect(
      db.tenant(a.actor.workspaceId, (sql) =>
        sql.query('UPDATE company_brands SET company_id=$1 WHERE brand_id=$2', [b.company.id, a.brand.id]),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      db.tenant(a.actor.workspaceId, (sql) =>
        sql.query('INSERT INTO companies(workspace_id,id,name) VALUES($1,$2,$3)', [
          b.actor.workspaceId,
          key(),
          'Foreign',
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await plan(a.actor, 'starter');
    const limited = await cmd<CompanyDirectory>(a.actor, 'company.list', {});
    expect(limited.companies).toHaveLength(2);
    expect(limited.brandCount).toBe(2);
    expect(limited.limits.brands).toBe(1);
    await expect(
      cmd(a.actor, 'brand.create', { name: 'Extra', companyId: owned.id, operationKey: key() }),
    ).rejects.toMatchObject({ code: 'brand_limit' });
    await expect(
      cmd(a.actor, 'company.create', { name: 'Extra entity', operationKey: key() }),
    ).rejects.toMatchObject({ code: 'company_limit' });
    await cmd(a.actor, 'brand.rename', { id: brandTwo.id, name: 'Renamed within plan', operationKey: key() });
    await plan(a.actor, null);
    expect((await cmd<CompanyDirectory>(a.actor, 'company.list', {})).brandCount).toBe(2);
  });
});
describe('legacy company upgrade', () => {
  it('backfills existing workspaces under a non-superuser migrator and preserves duplicate names and reassigned companies on reruns', async () => {
    const admin = new pg.Client({ connectionString: fixture.adminUrl }),
      adminUrl = new URL(fixture.adminUrl);
    const role = 'flockletter_company_migrator',
      database = 'flockletter_company_upgrade',
      password = randomBytes(16).toString('hex');
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      await admin.query(`CREATE DATABASE ${database} OWNER ${role}`);
    } finally {
      await admin.end();
    }
    adminUrl.pathname = '/' + database;
    adminUrl.username = role;
    adminUrl.password = password;
    const migration = new pg.Client({ connectionString: adminUrl.href });
    await migration.connect();
    const base = await readFile(new URL('../migrations/001_foundation.sql', import.meta.url), 'utf8');
    const upgrade = await readFile(new URL('../migrations/006_companies.sql', import.meta.url), 'utf8');
    const selectWorkspace = (w: string) =>
      migration.query("SELECT set_config('app.workspace_id',$1,false)", [w]);
    try {
      await migration.query(base);
      const original = key(),
        other = key(),
        workspace = 'org_legacy',
        second = 'org_legacy_two';
      await selectWorkspace(workspace);
      await migration.query('INSERT INTO workspaces(workspace_id,name) VALUES($1,$2)', [
        workspace,
        'Legacy company',
      ]);
      for (const [id, name] of [
        [original, 'Newsroom'],
        [other, 'NEWSROOM'],
      ])
        await migration.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
          workspace,
          id,
          name,
        ]);
      await selectWorkspace(second);
      await migration.query('INSERT INTO workspaces(workspace_id,name) VALUES($1,$2)', [
        second,
        'Second company',
      ]);
      await selectWorkspace('');
      expect((await migration.query('SELECT workspace_id FROM workspaces')).rows).toEqual([]);
      await migration.query(upgrade);
      expect((await migration.query('SELECT id FROM companies')).rows).toEqual([]);
      await selectWorkspace(workspace);
      const company = (await migration.query('SELECT id,name,is_default FROM companies')).rows[0]!;
      expect(company).toMatchObject({ name: 'Legacy company', is_default: true });
      expect(
        (
          await migration.query('SELECT brand_id FROM company_brands WHERE company_id=$1 ORDER BY brand_id', [
            company.id,
          ])
        ).rows
          .map((r) => r.brand_id)
          .sort(),
      ).toEqual([original, other].sort());
      expect(
        (await migration.query('SELECT name FROM brands ORDER BY name')).rows.map((r) => r.name).sort(),
      ).toEqual(['NEWSROOM', 'Newsroom'].sort());
      await expect(
        migration.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
          workspace,
          key(),
          ' newsroom ',
        ]),
      ).rejects.toMatchObject({ code: '23505' });
      const manual = key();
      await migration.query('INSERT INTO companies(workspace_id,id,name) VALUES($1,$2,$3)', [
        workspace,
        manual,
        'Another company',
      ]);
      await migration.query('UPDATE company_brands SET company_id=$1 WHERE brand_id=$2', [manual, original]);
      await migration.query("UPDATE companies SET name='Renamed company' WHERE is_default");
      await migration.query(upgrade);
      const preserved = (await migration.query('SELECT id,name FROM companies WHERE is_default')).rows[0]!;
      expect(preserved).toEqual({ id: company.id, name: 'Renamed company' });
      expect(
        (await migration.query('SELECT company_id FROM company_brands WHERE brand_id=$1', [original]))
          .rows[0],
      ).toEqual({ company_id: manual });
      await selectWorkspace(second);
      const different = (await migration.query('SELECT id FROM companies WHERE is_default')).rows[0]!;
      expect(different.id).not.toBe(company.id);
      expect(
        (
          await migration.query(
            "SELECT policyname FROM pg_policies WHERE policyname LIKE 'companies_migration%'",
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await migration.end();
    }
  });
});
