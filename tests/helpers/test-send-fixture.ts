import { randomUUID } from 'node:crypto';
import type { Database } from '../../src/server/db.js';
import { CommandService, type Actor } from '../../src/server/service.js';
import { CustomerBilling } from '../../src/server/customer-billing/service.js';
import { createCustomerOptOut } from '../../src/server/customer-audience/service.js';
import { customerEligibility } from '../../src/server/customer-billing/service.js';
import { CustomerDelivery } from '../../src/server/customer-delivery/service.js';
import type { DeliveryOptions } from '../../src/server/customer-delivery/types.js';
import type { DeliveryEnvelope } from '../../src/server/campaign/delivery-provider.js';

export async function createTestSendFixture(
  db: Database,
  override: Partial<DeliveryOptions> = {},
) {
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

  let currentClock = new Date();
  const now = () => currentClock;
  function setClock(d: Date) {
    currentClock = d;
  }

  let currentOwnership = true;
  function setOwner(v: boolean) {
    currentOwnership = v;
  }

  const core = new CommandService(db);
  await core.execute(
    'workspace.initialize',
    { name: 'Shop', brandName: 'Trail', operationKey: randomUUID() },
    actor,
  );

  const workspace = (await core.execute('workspace.get', {}, actor)) as {
    brands: { id: string }[];
  };
  const brandId = workspace.brands[0]!.id;

  const campaign = (await core.execute(
    'campaign.create',
    {
      operationKey: randomUUID(),
      brandId,
      content: {
        title: 'Trail',
        subject: 'Trail news',
        fromName: 'Shop',
        replyTo: 'shop@example.test',
        heading: 'New',
        body: 'News',
        preheader: '',
        ctaLabel: '',
        ctaUrl: '',
        assetIds: [],
      },
    },
    actor,
  )) as { id: string };

  const billing = new CustomerBilling(db, {
    environment: 'test',
    exerciseEnabled: true,
    now,
  });

  await billing.execute(
    'customerBilling.startTrial',
    { operationKey: randomUUID(), plan: 'growth', simulatedCardConfirmed: true },
    actor,
  );

  await billing.execute(
    'customerBilling.exercisePayment',
    { operationKey: randomUUID(), result: 'succeeded' },
    actor,
  );

  const subscriberId = randomUUID();
  await db.brand(workspaceId, brandId, (sql) =>
    sql.query(
      "INSERT INTO subscribers(workspace_id,brand_id,id,email_normalized,state) VALUES($1,$2,$3,'confirmed@shop.test','confirmed')",
      [workspaceId, brandId, subscriberId],
    ),
  );

  const renderCalls: DeliveryEnvelope[] = [];

  const options: DeliveryOptions = {
    mode: 'capture',
    origin: 'http://localhost:3000',
    environment: 'test',
    billing,
    isOwner: async () => currentOwnership,
    now,
    render: async (msg) => {
      renderCalls.push(msg);
    },
    optOut: createCustomerOptOut,
    eligibilitySql: (sql, workspace) =>
      customerEligibility(sql, workspace, { environment: 'test', exerciseEnabled: true }, now()),
    liveConsent: async () => true,
    ...override,
  };

  const delivery = new CustomerDelivery(db, options);

  return {
    workspaceId,
    brandId,
    actor,
    campaign,
    subscriberId,
    delivery,
    core,
    billing,
    options,
    renderCalls,
    setClock,
    now,
    setOwner,
  };
}
