import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyContent, type Campaign } from '../src/shared/contracts.js';
import { CommandService, type Actor } from '../src/server/service.js';
import { loadSesRuntime, parseSesRoute, type SesRuntime } from '../src/server/campaign/ses-runtime.js';
import { DeliveryWorker } from '../src/server/campaign/delivery-worker.js';
import type { Rehearsal } from '../src/shared/rehearsal.js';
import { startDeliveryFixture } from './staging-delivery-fixture.js';
const routeFields = {
  region: 'us-west-2',
  accountId: '123456789012',
  tenant: 'retailer-a',
  configurationSet: 'private-pilot',
  from: 'news@brand.example.com',
  identityArn: 'arn:aws:ses:us-west-2:123456789012:identity/brand.example.com',
  topicArn: 'arn:aws:sns:us-west-2:123456789012:pilot-notifications',
};
describe('SES simulator operator gate', () => {
  it('requires a dedicated binding, explicit credentials and an exact account, identity and topic', () => {
    const model = { ...routeFields, workspaceId: 'org_fixture', brandId: randomUUID() };
    expect(
      loadSesRuntime({ APP_ENV: 'staging', AWS_ACCESS_KEY_ID: 'ambient', AWS_SECRET_ACCESS_KEY: 'ambient' }),
    ).toBeUndefined();
    expect(
      loadSesRuntime({ APP_ENV: 'staging', FLOCKLETTER_SES_SIMULATOR_BINDING: JSON.stringify(model) })?.port,
    ).toBeUndefined();
    expect(() =>
      loadSesRuntime({ APP_ENV: 'test', FLOCKLETTER_SES_SIMULATOR_BINDING: JSON.stringify(model) }),
    ).toThrow();
    expect(() => loadSesRuntime({ APP_ENV: 'staging', FLOCKLETTER_SES_ACCESS_KEY_ID: 'partial' })).toThrow();
    for (const change of [
      { accountId: '000000000000' },
      { region: 'us-east-1' },
      { from: 'a@different.example.com' },
      { topicArn: model.topicArn + '/other' },
    ])
      expect(() => parseSesRoute({ ...model, ...change })).toThrow();
    expect(parseSesRoute({ ...model, tenant: 'new' }).fingerprint).not.toBe(parseSesRoute(model).fingerprint);
  });
  let site: Awaited<ReturnType<typeof startDeliveryFixture>>;
  beforeAll(async () => {
    site = await startDeliveryFixture();
  });
  afterAll(async () => {
    await site?.close();
  });
  it('requires current sender ownership, freezes provider configuration and never substitutes local delivery on rotation', async () => {
    const a = await site.workspace();
    try {
      const w = a.workspaceId,
        b = a.brandId,
        userId = 'test-owner-' + w;
      const actor: Actor = {
        workspaceId: w,
        userId,
        actorId: 'user:' + userId,
        owner: true,
        kind: 'session',
        scopes: ['read'],
        brandIds: null,
      };
      const route = parseSesRoute({ ...routeFields, workspaceId: w, brandId: b });
      let calls = 0;
      const ses: SesRuntime = {
        route,
        port: {
          send: async () => {
            calls++;
            return { MessageId: 'simulated-acceptance' };
          },
        },
      };
      const service = new CommandService(
        site.db,
        undefined,
        site.identity.isOwner,
        undefined,
        undefined,
        undefined,
        (workspace, brand) => workspace === w && brand === b,
        ses,
      );
      const methods = () => service.execute('rehearsal.methods', { brandId: b }, actor);
      expect(await methods()).toEqual({ methods: ['capture', 'provider_test', 'feedback_test'] });
      const campaign = await a.command<Campaign>('campaign.create', {
        brandId: b,
        operationKey: randomUUID(),
        content: {
          ...emptyContent(),
          title: 'Release check',
          subject: 'One reviewed edition',
          fromName: 'Test shop',
          replyTo: 'shop@example.test',
          heading: 'What is new',
          body: 'A verified staging edition.',
        },
      });
      const review = () =>
        service.execute(
          'rehearsal.review',
          {
            operationKey: randomUUID(),
            brandId: b,
            campaignId: campaign.id,
            expectedVersion: campaign.version,
            audience: 'test',
            transport: 'ses_simulator',
          },
          actor,
        ) as Promise<Rehearsal>;
      await expect(review()).rejects.toMatchObject({ code: 'worker_not_configured' });
      await site.db.brand(w, b, (sql) =>
        sql.query(
          "INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge,checked_at,verified_at) VALUES($1,$2,$3,$4,now()-interval '2 days',now()-interval '2 days')",
          [w, b, 'brand.example.com', randomUUID()],
        ),
      );
      await expect(review()).rejects.toMatchObject({ code: 'worker_not_configured' });
      await site.db.brand(w, b, (sql) =>
        sql.query('UPDATE sender_domains SET checked_at=now(),verified_at=now()'),
      );
      expect(await methods()).toMatchObject({ methods: expect.arrayContaining(['ses_simulator']) });
      // Tokens issued for purely local captures cannot discover, review or process these new methods.
      const legacy: Actor = {
        ...actor,
        kind: 'connection',
        actorId: 'connection:' + randomUUID(),
        scopes: ['read', 'campaign:rehearse', 'audience:summary'],
        brandIds: [b],
      };
      expect(await service.execute('rehearsal.methods', { brandId: b }, legacy)).toEqual({
        methods: ['capture', 'provider_test'],
      });
      for (const transport of ['ses_simulator', 'feedback_test']) {
        await expect(
          service.execute(
            'rehearsal.review',
            {
              brandId: b,
              campaignId: campaign.id,
              expectedVersion: campaign.version,
              audience: 'test',
              operationKey: randomUUID(),
              transport,
            },
            legacy,
          ),
        ).rejects.toMatchObject({ code: 'scope_required' });
      }
      await expect(
        service.execute(
          'connection.create',
          {
            operationKey: randomUUID(),
            name: 'Invalid scope combination',
            expiresInDays: 1,
            brandIds: [b],
            scopes: ['read', 'campaign:simulate'],
          },
          actor,
        ),
      ).rejects.toMatchObject({ code: 'invalid_rehearsal_grant' });
      const item = await review();
      await expect(
        service.execute('rehearsal.process', { brandId: b, id: item.id, operationKey: randomUUID() }, legacy),
      ).rejects.toMatchObject({ code: 'scope_required' });
      await service.execute(
        'rehearsal.approve',
        { brandId: b, id: item.id, operationKey: randomUUID() },
        actor,
      );
      const rotated = {
        ...ses,
        route: parseSesRoute({ ...routeFields, workspaceId: w, brandId: b, configurationSet: 'rotated' }),
      };
      await new DeliveryWorker(site.db, site.identity.isOwner, undefined, rotated).tick(w, b, item.id);
      expect(await a.tool('rehearsal_report', { brandId: b, id: item.id })).toMatchObject({
        state: 'blocked',
        reason: 'simulator_unavailable',
        accepted: 0,
      });
      expect(calls).toBe(0);
      const next = await review();
      await service.execute(
        'rehearsal.approve',
        { brandId: b, id: next.id, operationKey: randomUUID() },
        actor,
      );
      await service.execute(
        'rehearsal.process',
        { brandId: b, id: next.id, operationKey: randomUUID() },
        actor,
      );
      expect(calls).toBe(1);
      expect(await a.tool('rehearsal_outcomes', { brandId: b, id: next.id })).toMatchObject({
        recipients: [{ state: 'accepted', attempts: 1 }],
      });
    } finally {
      await a.close();
    }
  });
});
