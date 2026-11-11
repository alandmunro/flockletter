import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { recordAccess, inspectAccess } from '../scripts/complimentary-access.js';
import { CustomerBilling } from '../src/server/customer-billing/service.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../src/mcp/bridge.js';
import {makeAudienceConnection} from './helpers/audience-connection.js';
import type {CommandName} from '../src/shared/contracts.js';

let fixture: Awaited<ReturnType<typeof startDatabase>>;
let db: Database, admin: Database;

beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
  admin = new Database(fixture.adminUrl);
});

afterAll(async () => {
  await db?.close();
  await admin?.close();
  await fixture?.stop();
});

async function createShop() {
  const workspaceId = 'org_' + randomUUID().replaceAll('-', '');
  const userId = 'user_' + randomUUID();
  const actor: Actor = {
    workspaceId,
    userId,
    actorId: 'user:' + userId,
    owner: true,
    kind: 'session',
    scopes: ['read'],
    brandIds: null,
  };
  const core = new CommandService(db);
  await core.execute(
    'workspace.initialize',
    { name: 'Shop', brandName: 'Trail', operationKey: randomUUID() },
    actor,
  );
  const workspace = (await core.execute('workspace.get', {}, actor)) as {
    brands: { id: string; name: string }[];
  };
  const brandId = workspace.brands[0]!.id;
  return { workspaceId, actor, brandId };
}

it('grants a guarded Growth plan and verifies billing status and isolation', async () => {
  const shop = await createShop();

  const initial = await inspectAccess(admin, shop.workspaceId, {
    workspaceId: shop.workspaceId,
    plan: 'growth',
    operator: 'Test Operator',
    reason: 'Initial grant',
    operationKey: randomUUID(),
  }, {
    expectedRevision: 0,
    expectedWorkspaceName: 'Shop',
    expectedBrandId: shop.brandId,
    expectedBrandName: 'Trail',
    requireNoBillingHistory: true,
  });

  expect(initial).toMatchObject({
    workspaceId: shop.workspaceId,
    workspaceName: 'Shop',
    brandId: shop.brandId,
    brandName: 'Trail',
    currentRevision: 0,
    currentPlan: null,
    requestedPlan: 'growth',
    replayed: false,
  });

  const key = randomUUID();
  const changeInput = {
    workspaceId: shop.workspaceId,
    plan: 'growth' as const,
    operator: 'Test Operator',
    reason: 'Initial grant',
    operationKey: key,
  };

  const guard = {
    expectedRevision: 0,
    expectedWorkspaceName: 'Shop',
    expectedBrandId: shop.brandId,
    expectedBrandName: 'Trail',
    requireNoBillingHistory: true,
  };

  const grant = await recordAccess(admin, shop.workspaceId, changeInput, guard);
  expect(grant).toMatchObject({ revision: 1, plan: 'growth' });

  const billing = new CustomerBilling(db, { environment: 'production', exerciseEnabled: false });
  const status = await billing.status(shop.workspaceId);

  expect(status).toMatchObject({
    source: 'complimentary',
    state: 'active',
    plan: 'growth',
    eligible: true,
    limits: {
      campaigns: 5,
      emails: 25000,
      contacts: 5000,
      users: 3,
      companies: 3,
      brands: 3,
    },
  });

  const commands=new CommandService(db),connection=await makeAudienceConnection(db,shop.actor,[shop.brandId],['read']);
  expect(await commands.execute('workspace.get',{},shop.actor)).toMatchObject({entitlement:'complimentary'});
  const bridge=createMcpServer((name,input)=>commands.execute(name as CommandName,input,connection.actor));
  const client=new Client({name:'complimentary-read-test',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await bridge.connect(serverTransport);await client.connect(clientTransport);
  try{
    const read=await client.callTool({name:'workspace_access',arguments:{}});
    expect(read.isError).not.toBe(true);
    expect(JSON.parse((read.content as {text:string}[])[0]!.text)).toMatchObject({access:{status:'complimentary',plan:'growth',revision:1}});
    expect((await client.listTools()).tools.some(tool=>/grant.*access|access.*grant|complimentary.*apply/i.test(tool.name))).toBe(false);
  }finally{await client.close();await bridge.close();}

  for (const table of ['customer_billing_intents','customer_subscriptions','sandbox_checkouts'] as const) {
    const result=await db.read(shop.workspaceId,sql=>sql.query('SELECT count(*)::int n FROM '+table));
    expect(result.rows[0].n).toBe(0);
  }

  await expect(
    db.tenant(shop.workspaceId, (sql) =>
      sql.query('INSERT INTO workspace_access_events(workspace_id, revision, operation_key, plan, operator_name, reason) VALUES($1, 999, $2, \'pro\', \'Hacker\', \'Bad\')', [shop.workspaceId, randomUUID()]),
    ),
  ).rejects.toMatchObject({code:'42501'});
});

it('handles concurrent idempotent grants, conflicts, and revocation', async () => {
  const shop = await createShop();
  const key = randomUUID();
  const input = {
    workspaceId: shop.workspaceId,
    plan: 'growth' as const,
    operator: 'Op',
    reason: 'Reason A',
    operationKey: key,
  };

  const [r1, r2] = await Promise.all([
    recordAccess(admin, shop.workspaceId, input),
    recordAccess(admin, shop.workspaceId, input),
  ]);

  expect(r1).toEqual(r2);
  expect(r1.revision).toBe(1);
  expect((await db.read(shop.workspaceId,sql=>sql.query('SELECT FROM workspace_access_events'))).rowCount).toBe(1);

  const badInput = { ...input, reason: 'Reason B' };
  await expect(recordAccess(admin, shop.workspaceId, badInput)).rejects.toThrow('Operation key already used for a different grant.');

  const staleGuard = {
    expectedRevision: 0,
    expectedWorkspaceName: 'Shop',
    expectedBrandId: shop.brandId,
    expectedBrandName: 'Trail',
    requireNoBillingHistory: true,
  };


  const r3 = await recordAccess(admin, shop.workspaceId, input, staleGuard);
  expect(r3).toMatchObject({ revision: 1, plan: 'growth' });

  const revokeKey = randomUUID();
  const currentRevision = r1.revision;

  await recordAccess(admin, shop.workspaceId, {
    workspaceId: shop.workspaceId,
    plan: null,
    operator: 'Op',
    reason: 'Revoke',
    operationKey: revokeKey,
  }, {
    expectedRevision: currentRevision,
    expectedWorkspaceName: 'Shop',
    expectedBrandId: shop.brandId,
    expectedBrandName: 'Trail',
    requireNoBillingHistory: true,
  });

  const r4 = await recordAccess(admin, shop.workspaceId, input);
  expect(r4).toMatchObject({ revision: 1, plan: 'growth' });

  const billing = new CustomerBilling(db, { environment: 'production', exerciseEnabled: false });
  const status = await billing.status(shop.workspaceId);
  expect(status.plan).toBeNull();
  expect((await db.read(shop.workspaceId,sql=>sql.query('SELECT revision FROM workspace_access_events ORDER BY revision'))).rows).toEqual([{revision:1},{revision:2}]);
});

it('rejects invalid guards and missing contexts', async () => {
  const shop = await createShop();

  await expect(
    recordAccess(admin, shop.workspaceId, {
      workspaceId: shop.workspaceId,
      plan: 'growth',
      operator: 'Op',
      reason: 'R',
      operationKey: randomUUID(),
    }, {
      expectedRevision: 5,
      expectedWorkspaceName: 'Shop',
      expectedBrandId: shop.brandId,
      expectedBrandName: 'Trail',
      requireNoBillingHistory: true,
    }),
  ).rejects.toThrow();

  await expect(
    recordAccess(admin, shop.workspaceId, {
      workspaceId: shop.workspaceId,
      plan: 'growth',
      operator: 'Op',
      reason: 'R',
      operationKey: randomUUID(),
    }, {
      expectedRevision: 0,
      expectedWorkspaceName: 'Wrong Name',
      expectedBrandId: shop.brandId,
      expectedBrandName: 'Trail',
      requireNoBillingHistory: true,
    }),
  ).rejects.toThrow();

  const otherShop = await createShop();
  await expect(
    recordAccess(admin, shop.workspaceId, {
      workspaceId: shop.workspaceId,
      plan: 'growth',
      operator: 'Op',
      reason: 'R',
      operationKey: randomUUID(),
    }, {
      expectedRevision: 0,
      expectedWorkspaceName: 'Shop',
      expectedBrandId: otherShop.brandId,
      expectedBrandName: 'Trail',
      requireNoBillingHistory: true,
    }),
  ).rejects.toThrow();

  await expect(
    recordAccess(admin, otherShop.workspaceId, {
      workspaceId: shop.workspaceId,
      plan: 'growth',
      operator: 'Op',
      reason: 'R',
      operationKey: randomUUID(),
    }),
  ).rejects.toThrow('The operator target must match the configured complimentary workspace.');

  const missing='org_'+randomUUID().replaceAll('-','');
  await expect(recordAccess(admin,missing,{workspaceId:missing,plan:'growth',operator:'Op',reason:'Missing workspace',operationKey:randomUUID()})).rejects.toThrow('Initialize the target workspace first.');

  expect((await db.read(shop.workspaceId,sql=>sql.query('SELECT FROM workspace_access_events'))).rowCount).toBe(0);
});

it('inspectAccess has no writes and reports initial state', async () => {
  const shop = await createShop();

  const countBefore=(await db.read(shop.workspaceId,sql=>sql.query('SELECT FROM workspace_access_events'))).rowCount;

  const result = await inspectAccess(admin, shop.workspaceId, {
    workspaceId: shop.workspaceId,
    plan: 'growth',
    operator: 'Op',
    reason: 'R',
    operationKey: randomUUID(),
  }, {
    expectedRevision: 0,
    expectedWorkspaceName: 'Shop',
    expectedBrandId: shop.brandId,
    expectedBrandName: 'Trail',
    requireNoBillingHistory: true,
  });

  expect(result).toMatchObject({
    workspaceId: shop.workspaceId,
    currentRevision: 0,
    replayed: false,
  });

  const countAfter=(await db.read(shop.workspaceId,sql=>sql.query('SELECT FROM workspace_access_events'))).rowCount;
  expect(countAfter).toBe(countBefore);
});
