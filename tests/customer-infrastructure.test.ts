import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startDatabase } from '../scripts/database-fixture.js';
import { Database } from '../src/server/db.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { CustomerInfrastructure } from '../src/server/customer-infrastructure/index.js';
import {
  infrastructureSteps,
  type InfrastructureFacts,
  type InfrastructureOptions,
  type InfrastructureProvider,
  type InfrastructureRequest,
} from '../src/server/customer-infrastructure/types.js';
import type { InfrastructureStatus } from '../src/shared/customer-infrastructure.js';
import type { CustomerSenderProfile } from '../src/shared/customer-delivery.js';
let fixture: Awaited<ReturnType<typeof startDatabase>>, db: Database;
const owners = new Set<string>(),
  isOwner = async (user: string, w: string) => owners.has(user + '/' + w);
const eligibility = async () => ({ eligible: true, revision: 1, source: 'exercise' as const });
const defaults: InfrastructureOptions = {
  mode: 'capture',
  environment: 'test',
  isOwner,
  eligibility,
  eligibilitySql: async () => eligibility(),
};
beforeAll(async () => {
  fixture = await startDatabase();
  db = new Database(fixture.url);
});
afterAll(async () => {
  await db?.close();
  await fixture?.stop();
});
async function owner() {
  const actor: Actor = {
    workspaceId: 'org_' + randomUUID().replaceAll('-', ''),
    userId: 'user_' + randomUUID(),
    actorId: 'user:' + randomUUID(),
    owner: true,
    kind: 'session',
    scopes: ['read'],
    brandIds: null,
  };
  owners.add(actor.userId + '/' + actor.workspaceId);
  await new CommandService(db, undefined, isOwner).execute(
    'workspace.initialize',
    { name: 'Infrastructure test', brandName: 'Trail', operationKey: randomUUID() },
    actor,
  );
  const brand = (await db.tenant(
    actor.workspaceId,
    async (sql) => (await sql.query<{ id: string }>('SELECT id FROM brands')).rows[0],
  ))!.id;
  const profile: CustomerSenderProfile = {
    fromName: 'Trail News',
    fromEmail: 'news@trail.example.com',
    replyTo: 'help@trail.example.com',
    organization: 'Trail LLC',
    postalAddress: '123 Trail Road, Denver, CO 80202, US',
    revision: 1,
  };
  await db.brand(actor.workspaceId, brand, (sql) =>
    sql.query('INSERT INTO customer_sender_profiles(workspace_id,brand_id,profile) VALUES($1,$2,$3)', [
      actor.workspaceId,
      brand,
      profile,
    ]),
  );
  return { actor, brand, profile };
}
const call = (infra: CustomerInfrastructure, name: string, input: unknown, actor: Actor) =>
  infra.execute(name, input, actor) as Promise<InfrastructureStatus>;
async function approved(infra: CustomerInfrastructure, actor: Actor, brand: string) {
  const review = { operationKey: randomUUID(), brandId: brand, senderRevision: 1 };
  let state = await call(infra, 'infrastructure.review', review, actor),
    plan = state.plans[0]!;
  state = await call(
    infra,
    'infrastructure.approve',
    {
      operationKey: randomUUID(),
      brandId: brand,
      id: plan.id,
      expectedVersion: plan.version,
      reviewDigest: plan.reviewDigest,
    },
    actor,
  );
  plan = state.plans[0]!;
  return plan;
}
function facts(
  request: InfrastructureRequest,
  completed = [...infrastructureSteps],
  verified = true,
): InfrastructureFacts {
  return {
    operationKey: request.operationKey,
    domain: request.domain,
    fromEmail: request.fromEmail,
    captured: false,
    verified,
    route: {
      region: 'us-west-2',
      accountId: '123456789012',
      tenant: 'tenant_test',
      configurationSet: 'config_test',
      from: request.fromEmail,
      identityArn: 'arn:aws:ses:us-west-2:123456789012:identity/' + request.domain,
      topicArn: 'arn:aws:sns:us-west-2:123456789012:topic_test',
    },
    progress: {
      completed,
      nextStep: infrastructureSteps.find((step) => !completed.includes(step)) ?? null,
      dnsPending: !verified,
    },
    dns: [{ type: 'CNAME', name: 'token._domainkey.' + request.domain, value: 'token.dkim.amazonses.com' }],
  };
}
it('captures a reviewed exact sender plan durably without provider calls or usable live DNS', async () => {
  const { actor, brand } = await owner(),
    apply = vi.fn(),
    inspect = vi.fn();
  const infra = new CustomerInfrastructure(db, {
    ...defaults,
    provider: { binding: 'poison', apply, inspect },
  });
  const row = await approved(infra, actor, brand);
  const state = await call(
    infra,
    'infrastructure.process',
    { operationKey: randomUUID(), brandId: brand, id: row.id },
    actor,
  );
  expect(state.plans[0]).toMatchObject({
    state: 'captured',
    captured: true,
    verified: false,
    attempts: 1,
    domain: 'trail.example.com',
  });
  expect(
    state.plans[0]?.dns.every(
      (record) => record.name.endsWith('.invalid') && record.value.endsWith('.invalid'),
    ),
  ).toBe(true);
  expect(apply).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
  expect(await infra.verifiedRoute(actor.workspaceId, brand)).toBeNull();
  expect(await infra.routeCandidates(actor.workspaceId)).toEqual([]);
  const restarted = new CustomerInfrastructure(db, defaults);
  await restarted.tickWorkspace(actor.workspaceId);
  expect((await restarted.status(actor.workspaceId, brand)).plans[0]?.attempts).toBe(1);
});
it('enforces exact profile versions, review digest, tenant scope, strict inputs and stable operation keys', async () => {
  const { actor, brand } = await owner(),
    other = await owner(),
    infra = new CustomerInfrastructure(db, defaults);
  const input = { operationKey: randomUUID(), brandId: brand, senderRevision: 1 };
  const first = await call(infra, 'infrastructure.review', input, actor);
  expect((await call(infra, 'infrastructure.review', input, actor)).plans).toEqual(first.plans);
  await expect(
    call(infra, 'infrastructure.review', { ...input, senderRevision: 2 }, actor),
  ).rejects.toMatchObject({ code: 'operation_conflict' });
  await expect(
    call(
      infra,
      'infrastructure.review',
      { ...input, operationKey: randomUUID(), identityArn: 'arn:attacker' },
      actor,
    ),
  ).rejects.toThrow();
  await expect(call(infra, 'infrastructure.status', { brandId: brand }, other.actor)).rejects.toMatchObject({
    code: 'brand_unavailable',
  });
  await expect(
    call(infra, 'infrastructure.status', { brandId: brand }, { ...actor, kind: 'connection' }),
  ).rejects.toMatchObject({ code: 'owner_required' });
  const row = first.plans[0]!;
  await expect(
    call(
      infra,
      'infrastructure.approve',
      {
        operationKey: randomUUID(),
        brandId: brand,
        id: row.id,
        expectedVersion: row.version,
        reviewDigest: 'f'.repeat(64),
      },
      actor,
    ),
  ).rejects.toMatchObject({ code: 'infrastructure_review_changed' });
  await db.brand(actor.workspaceId, brand, (sql) =>
    sql.query(
      "UPDATE customer_sender_profiles SET profile=jsonb_set(profile,'{revision}','2') WHERE brand_id=$1",
      [brand],
    ),
  );
  await expect(
    call(
      infra,
      'infrastructure.approve',
      {
        operationKey: randomUUID(),
        brandId: brand,
        id: row.id,
        expectedVersion: row.version,
        reviewDigest: row.reviewDigest,
      },
      actor,
    ),
  ).rejects.toMatchObject({ code: 'infrastructure_review_changed' });
});
it('requires a committed budget claim before each new external step and reconciles unknown outcomes without another mutation', async () => {
  const { actor, brand } = await owner();
  let last: InfrastructureRequest | undefined,
    observed: InfrastructureFacts | null = null;
  const provider: InfrastructureProvider = {
    binding: 'aws-fixed-binding',
    apply: vi.fn(async (request: InfrastructureRequest) => {
      last = request;
      const persisted = await db.tenant(
        actor.workspaceId,
        async (sql) =>
          (
            await sql.query('SELECT state,step_attempts FROM customer_infrastructure_intents WHERE id=$1', [
              request.operationKey,
            ])
          ).rows[0],
      );
      expect(persisted).toMatchObject({ state: 'provisioning', step_attempts: 1 });
      return { state: 'unknown' as const };
    }),
    inspect: vi.fn(async () => observed),
  };
  const permit = vi.fn(async () => false),
    infra = new CustomerInfrastructure(db, { ...defaults, mode: 'aws', provider, budgetPermit: permit });
  await approved(infra, actor, brand);
  await infra.tickWorkspace(actor.workspaceId);
  let state = await infra.status(actor.workspaceId, brand);
  expect(state.plans[0]).toMatchObject({
    state: 'held',
    reason: 'operator_budget_approval_required',
    attempts: 0,
  });
  expect(provider.apply).not.toHaveBeenCalled();
  permit.mockResolvedValue(true);
  let held = state.plans[0]!;
  await call(
    infra,
    'infrastructure.retry',
    { operationKey: randomUUID(), brandId: brand, id: held.id, expectedVersion: held.version },
    actor,
  );
  await infra.tickWorkspace(actor.workspaceId);
  expect(provider.apply).toHaveBeenCalledOnce();
  await new CustomerInfrastructure(db, { ...infra.options }).tickWorkspace(actor.workspaceId);
  expect(provider.apply).toHaveBeenCalledOnce();
  expect(provider.inspect).toHaveBeenCalledOnce();
  state = await infra.status(actor.workspaceId, brand);
  expect(state.plans[0]?.state).toBe('uncertain');
  held = state.plans[0]!;
  await expect(
    call(
      infra,
      'infrastructure.retry',
      { operationKey: randomUUID(), brandId: brand, id: held.id, expectedVersion: held.version },
      actor,
    ),
  ).rejects.toMatchObject({ code: 'infrastructure_retry_unsafe' });
  observed = facts(last!, ['tenant'], false);
  expect(await infra.routeCandidates(actor.workspaceId)).toEqual([]);
  await infra.tickWorkspace(actor.workspaceId);
  state = await infra.status(actor.workspaceId, brand);
  expect(state.plans[0]?.state).toBe('queued');
  expect(provider.apply).toHaveBeenCalledOnce();
  await infra.tickWorkspace(actor.workspaceId);
  expect(provider.apply).toHaveBeenCalledTimes(2);
  expect(last?.step).toBe('configuration');
  expect(permit).toHaveBeenCalledTimes(3);
});
it('requires current original owner, rejects production captures and never publishes mismatched provider facts', async () => {
  const { actor, brand } = await owner(),
    apply = vi.fn(async (request: InfrastructureRequest) => ({
      state: 'accepted' as const,
      facts: { ...facts(request), operationKey: randomUUID() },
    }));
  const infra = new CustomerInfrastructure(db, {
    ...defaults,
    mode: 'aws',
    provider: { binding: 'aws-fixed', apply, inspect: async () => null },
    budgetPermit: async () => true,
  });
  await approved(infra, actor, brand);
  owners.delete(actor.userId + '/' + actor.workspaceId);
  await infra.tickWorkspace(actor.workspaceId);
  expect(apply).not.toHaveBeenCalled();
  owners.add(actor.userId + '/' + actor.workspaceId);
  let held = (await infra.status(actor.workspaceId, brand)).plans[0]!;
  await call(
    infra,
    'infrastructure.retry',
    { operationKey: randomUUID(), brandId: brand, id: held.id, expectedVersion: held.version },
    actor,
  );
  await infra.tickWorkspace(actor.workspaceId);
  held = (await infra.status(actor.workspaceId, brand)).plans[0]!;
  expect(held.state).toBe('uncertain');
  expect(await infra.verifiedRoute(actor.workspaceId, brand)).toBeNull();
  expect(() => new CustomerInfrastructure(db, { ...defaults, environment: 'production' })).toThrow(
    'Captured infrastructure',
  );
});
it('hydrates feedback-only routes separately from freshly verified delivery readiness', async () => {
  const { actor, brand } = await owner();
  let observed: InfrastructureFacts | null = null;
  const provider: InfrastructureProvider = {
    binding: 'aws-fixed',
    apply: async (request) => {
      observed = facts(request, [...infrastructureSteps], false);
      return { state: 'accepted', facts: observed };
    },
    inspect: async () => observed,
  };
  const infra = new CustomerInfrastructure(db, {
    ...defaults,
    mode: 'aws',
    provider,
    budgetPermit: async () => true,
  });
  await approved(infra, actor, brand);
  await infra.tickWorkspace(actor.workspaceId);
  expect((await infra.status(actor.workspaceId, brand)).plans[0]?.state).toBe('awaiting_dns');
  expect(await infra.routeCandidates(actor.workspaceId)).toHaveLength(1);
  expect(await infra.verifiedRoute(actor.workspaceId, brand)).toBeNull();
  observed = {
    ...observed!,
    verified: true,
    progress: { completed: [...infrastructureSteps], nextStep: null, dnsPending: false },
  };
  await infra.tickWorkspace(actor.workspaceId);
  expect((await infra.status(actor.workspaceId, brand)).plans[0]?.state).toBe('verified');
  expect(await infra.verifiedRoute(actor.workspaceId, brand)).toMatchObject({
    workspaceId: actor.workspaceId,
    brandId: brand,
    from: 'news@trail.example.com',
  });
  const plan = (await infra.status(actor.workspaceId, brand)).plans[0]!;
  await call(
    infra,
    'infrastructure.cancel',
    { operationKey: randomUUID(), brandId: brand, id: plan.id, expectedVersion: plan.version },
    actor,
  );
  expect(await infra.verifiedRoute(actor.workspaceId, brand)).toBeNull();
  expect(await infra.routeCandidates(actor.workspaceId)).toHaveLength(1);
});

it('bounds pending plans per workspace and brand and permits a fresh review after safe cancellation', async () => {
  const { actor, brand, profile } = await owner(),
    infra = new CustomerInfrastructure(db, defaults);
  const first = (
    await call(
      infra,
      'infrastructure.review',
      { operationKey: randomUUID(), brandId: brand, senderRevision: 1 },
      actor,
    )
  ).plans[0]!;
  await expect(
    call(
      infra,
      'infrastructure.review',
      { operationKey: randomUUID(), brandId: brand, senderRevision: 1 },
      actor,
    ),
  ).rejects.toMatchObject({ code: 'infrastructure_brand_pending' });
  for (let i = 0; i < 4; i++) {
    const next = randomUUID();
    await db.tenant(actor.workspaceId, (sql) =>
      sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
        actor.workspaceId,
        next,
        'Additional' + i,
      ]),
    );
    await db.brand(actor.workspaceId, next, (sql) =>
      sql.query('INSERT INTO customer_sender_profiles(workspace_id,brand_id,profile) VALUES($1,$2,$3)', [
        actor.workspaceId,
        next,
        profile,
      ]),
    );
    await call(
      infra,
      'infrastructure.review',
      { operationKey: randomUUID(), brandId: next, senderRevision: 1 },
      actor,
    );
  }
  const sixth = randomUUID();
  await db.tenant(actor.workspaceId, (sql) =>
    sql.query('INSERT INTO brands(workspace_id,id,name) VALUES($1,$2,$3)', [
      actor.workspaceId,
      sixth,
      'Sixth',
    ]),
  );
  await db.brand(actor.workspaceId, sixth, (sql) =>
    sql.query('INSERT INTO customer_sender_profiles(workspace_id,brand_id,profile) VALUES($1,$2,$3)', [
      actor.workspaceId,
      sixth,
      profile,
    ]),
  );
  await expect(
    call(
      infra,
      'infrastructure.review',
      { operationKey: randomUUID(), brandId: sixth, senderRevision: 1 },
      actor,
    ),
  ).rejects.toMatchObject({ code: 'infrastructure_workspace_limit' });
  await call(
    infra,
    'infrastructure.cancel',
    { operationKey: randomUUID(), brandId: brand, id: first.id, expectedVersion: first.version },
    actor,
  );
  expect(
    (
      await call(
        infra,
        'infrastructure.review',
        { operationKey: randomUUID(), brandId: brand, senderRevision: 1 },
        actor,
      )
    ).plans[0]?.state,
  ).toBe('reviewed');
});

it('preserves a late external receipt after cancellation without enabling its route', async () => {
  const { actor, brand } = await owner();
  let entered!: () => void, release!: (fact: InfrastructureFacts) => void, last!: InfrastructureRequest;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  const provider: InfrastructureProvider = {
    binding: 'aws-fixed',
    apply: async (request) => {
      last = request;
      entered();
      const fact = await new Promise<InfrastructureFacts>((resolve) => (release = resolve));
      return { state: 'accepted', facts: fact };
    },
    inspect: async () => null,
  };
  const infra = new CustomerInfrastructure(db, {
    ...defaults,
    mode: 'aws',
    provider,
    budgetPermit: async () => true,
  });
  const plan = await approved(infra, actor, brand);
  const processing = call(
    infra,
    'infrastructure.process',
    { operationKey: randomUUID(), brandId: brand, id: plan.id },
    actor,
  );
  await waiting;
  const current = (await infra.status(actor.workspaceId, brand)).plans[0]!;
  const cancelling = call(
    infra,
    'infrastructure.cancel',
    { operationKey: randomUUID(), brandId: brand, id: plan.id, expectedVersion: current.version },
    actor,
  );
  await waitForLockWaiter();
  release(facts(last));
  await Promise.all([processing, cancelling]);
  const after = (await infra.status(actor.workspaceId, brand)).plans[0]!;
  expect(after).toMatchObject({ state: 'cancelled', verified: false, reason: 'cancelled_after_attempt' });
  expect(await infra.verifiedRoute(actor.workspaceId, brand)).toBeNull();
  expect(await infra.routeCandidates(actor.workspaceId)).toHaveLength(1);
});

it('retries only a proven rejected named step after its pre-mutation hold is fixed', async () => {
  const { actor, brand } = await owner();
  let allowed = false;
  const apply = vi.fn(async (request: InfrastructureRequest) =>
    allowed ? { state: 'accepted' as const, facts: facts(request) } : { state: 'rejected' as const },
  );
  const infra = new CustomerInfrastructure(db, {
    ...defaults,
    mode: 'aws',
    provider: { binding: 'aws-fixed', apply, inspect: async () => null },
    budgetPermit: async () => true,
  });
  await approved(infra, actor, brand);
  await infra.tickWorkspace(actor.workspaceId);
  const held = (await infra.status(actor.workspaceId, brand)).plans[0]!;
  expect(held).toMatchObject({ state: 'held', retryable: true, attempts: 1, reason: 'provider_rejected' });
  allowed = true;
  await call(
    infra,
    'infrastructure.retry',
    { operationKey: randomUUID(), brandId: brand, id: held.id, expectedVersion: held.version },
    actor,
  );
  await infra.tickWorkspace(actor.workspaceId);
  expect(apply).toHaveBeenCalledTimes(2);
  expect((await infra.status(actor.workspaceId, brand)).plans[0]).toMatchObject({
    state: 'verified',
    attempts: 2,
    retryable: false,
  });
});

it('does not return a delivery route when cancellation races its fresh provider inspection', async () => {
  const { actor, brand } = await owner();
  let observed!: InfrastructureFacts,
    paused = false,
    entered!: () => void,
    release!: () => void;
  const signal = new Promise<void>((resolve) => (entered = resolve)),
    resume = new Promise<void>((resolve) => (release = resolve));
  const provider: InfrastructureProvider = {
    binding: 'aws-fixed',
    apply: async (request) => {
      observed = facts(request);
      return { state: 'accepted', facts: observed };
    },
    inspect: async () => {
      if (paused) {
        entered();
        await resume;
      }
      return observed;
    },
  };
  const infra = new CustomerInfrastructure(db, {
    ...defaults,
    mode: 'aws',
    provider,
    budgetPermit: async () => true,
  });
  await approved(infra, actor, brand);
  await infra.tickWorkspace(actor.workspaceId);
  paused = true;
  const check = infra.verifiedRoute(actor.workspaceId, brand);
  await signal;
  const row = (await infra.status(actor.workspaceId, brand)).plans[0]!;
  await call(
    infra,
    'infrastructure.cancel',
    { operationKey: randomUUID(), brandId: brand, id: row.id, expectedVersion: row.version },
    actor,
  );
  release();
  expect(await check).toBeNull();
});

it('replays a process request without advancing another named mutation under the same operation key', async () => {
  const { actor, brand } = await owner();
  const apply = vi.fn(async (request: InfrastructureRequest) => ({
    state: 'accepted' as const,
    facts: facts(request, infrastructureSteps.slice(0, infrastructureSteps.indexOf(request.step) + 1), false),
  }));
  const infra = new CustomerInfrastructure(db, {
    ...defaults,
    mode: 'aws',
    provider: { binding: 'aws-fixed', apply, inspect: async () => null },
    budgetPermit: async () => true,
  });
  const row = await approved(infra, actor, brand),
    input = { operationKey: randomUUID(), brandId: brand, id: row.id };
  expect((await call(infra, 'infrastructure.process', input, actor)).plans[0]?.state).toBe('queued');
  await call(infra, 'infrastructure.process', input, actor);
  expect(apply).toHaveBeenCalledOnce();
  await call(infra, 'infrastructure.process', { ...input, operationKey: randomUUID() }, actor);
  expect(apply).toHaveBeenCalledTimes(2);
});

async function waitForLockWaiter() {
  const admin = new pg.Client({ connectionString: fixture.adminUrl });
  await admin.connect();
  try {
    for (let i = 0; i < 100; i++)
      if (
        (await admin.query("SELECT FROM pg_locks WHERE locktype='advisory' AND NOT granted LIMIT 1")).rowCount
      )
        return;
    throw Error('Expected a queued workspace operation.');
  } finally {
    await admin.end();
  }
}

it.each(['profile', 'cancel', 'erase'] as const)(
  'rechecks %s after durable claim and before the provider handoff',
  async (variant) => {
    const { actor, brand } = await owner();
    let entered!: () => void, release!: () => void;
    const claimed = new Promise<void>((resolve) => (entered = resolve)),
      allow = new Promise<void>((resolve) => (release = resolve));
    const apply = vi.fn(async (request: InfrastructureRequest) => ({
      state: 'accepted' as const,
      facts: facts(request),
    }));
    const infra = new CustomerInfrastructure(db, {
      ...defaults,
      mode: 'aws',
      provider: { binding: 'aws-fixed', apply, inspect: async () => null },
      budgetPermit: async () => {
        entered();
        await allow;
        return true;
      },
    });
    const row = await approved(infra, actor, brand);
    const processing = infra.tickWorkspace(actor.workspaceId);
    await claimed;
    let change: Promise<unknown>;
    if (variant === 'profile')
      change = db.brand(actor.workspaceId, brand, async (sql) => {
        await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [actor.workspaceId]);
        await sql.query(
          "UPDATE customer_sender_profiles SET profile=jsonb_set(profile,'{revision}','2') WHERE brand_id=$1",
          [brand],
        );
      });
    else if (variant === 'cancel')
      change = call(
        infra,
        'infrastructure.cancel',
        { operationKey: randomUUID(), brandId: brand, id: row.id, expectedVersion: row.version + 1 },
        actor,
      );
    else
      change = (async () => {
        const admin = new pg.Client({ connectionString: fixture.adminUrl });
        await admin.connect();
        try {
          await admin.query('BEGIN');
          await admin.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [actor.workspaceId]);
          await admin.query(
            'INSERT INTO customer_retention_receipts(workspace_id,job_id,effective_end_at,erased_at,manifest_digest,checkpoint_digest) VALUES($1,$2,now(),now(),$3,$3)',
            [actor.workspaceId, randomUUID(), 'a'.repeat(64)],
          );
          await admin.query('COMMIT');
        } finally {
          await admin.end();
        }
      })();
    await waitForLockWaiter();
    release();
    await Promise.all([processing, change]);
    expect(apply).not.toHaveBeenCalled();
    const stored = await db.tenant(
      actor.workspaceId,
      async (sql) =>
        (
          await sql.query(
            'SELECT state,step_attempts,reason FROM customer_infrastructure_intents WHERE id=$1',
            [row.id],
          )
        ).rows[0],
    );
    expect(stored).toMatchObject({
      state: variant === 'cancel' ? 'cancelled' : 'held',
      step_attempts: 0,
      reason:
        variant === 'profile'
          ? 'sender_profile_changed'
          : variant === 'cancel'
            ? 'cancelled_before_handoff'
            : 'workspace_erased',
    });
  },
);

it('confirms only the exact currently authorized AWS feedback subscription, never capture, cancellation or erasure', async () => {
  const { actor, brand } = await owner();
  const provider: InfrastructureProvider = {
    binding: 'aws-fixed',
    apply: async (request) => ({
      state: 'accepted',
      facts: facts(
        request,
        infrastructureSteps.filter((step) => step !== 'subscription'),
        false,
      ),
    }),
    inspect: async () => null,
  };
  const infra = new CustomerInfrastructure(db, {
    ...defaults,
    mode: 'aws',
    provider,
    budgetPermit: async () => true,
  });
  await approved(infra, actor, brand);
  await infra.tickWorkspace(actor.workspaceId);
  const route = (await infra.routeCandidates(actor.workspaceId))[0]!;
  expect(await infra.canConfirmRoute(route)).toBe(true);
  expect(await new CustomerInfrastructure(db, defaults).canConfirmRoute(route)).toBe(false);
  expect(await infra.canConfirmRoute({ ...route, configurationSet: 'other-config' })).toBe(false);
  const current = (await infra.status(actor.workspaceId, brand)).plans[0]!;
  await call(
    infra,
    'infrastructure.cancel',
    { operationKey: randomUUID(), brandId: brand, id: current.id, expectedVersion: current.version },
    actor,
  );
  expect(await infra.canConfirmRoute(route)).toBe(false);
  const other = await owner(),
    second = new CustomerInfrastructure(db, {
      ...defaults,
      mode: 'aws',
      provider,
      budgetPermit: async () => true,
    });
  await approved(second, other.actor, other.brand);
  await second.tickWorkspace(other.actor.workspaceId);
  const secondRoute = (await second.routeCandidates(other.actor.workspaceId))[0]!;
  expect(await second.canConfirmRoute(secondRoute)).toBe(true);
  const admin = new pg.Client({ connectionString: fixture.adminUrl });
  await admin.connect();
  try {
    await admin.query(
      'INSERT INTO customer_retention_receipts(workspace_id,job_id,effective_end_at,erased_at,manifest_digest,checkpoint_digest) VALUES($1,$2,now(),now(),$3,$3)',
      [other.actor.workspaceId, randomUUID(), 'a'.repeat(64)],
    );
  } finally {
    await admin.end();
  }
  expect(await second.canConfirmRoute(secondRoute)).toBe(false);
});
