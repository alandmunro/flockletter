import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { SESv2Client, type SendEmailCommand, type SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import {
  loadSesRuntime,
  parseSesRoute,
  sesScope,
  sesScopes,
  type SesRuntime,
} from '../src/server/campaign/ses-runtime.js';
import { inspectSesRoute } from '../src/server/campaign/ses-inspection.js';
import { createSesSimulatorPort } from '../src/server/campaign/ses-simulator.js';
import { startDeliveryFixture } from './staging-delivery-fixture.js';
import type { DeliveryReadiness } from '../src/shared/sender.js';
import { CommandService } from '../src/server/service.js';
import { DeliveryWorker } from '../src/server/campaign/delivery-worker.js';
import { emptyContent, type Campaign } from '../src/shared/contracts.js';
import type { Rehearsal } from '../src/shared/rehearsal.js';

const region = 'us-east-1',
  accountId = '123456789012';
const arn = 'arn:aws:ses:' + region + ':' + accountId + ':';
function route(n: string) {
  const domain = n + '.example.com';
  return {
    region,
    accountId,
    workspaceId: 'org_' + n,
    brandId: randomUUID(),
    tenant: n,
    from: 'mail@' + domain,
    identityArn: arn + 'identity/' + domain,
    configurationSet: n,
    topicArn: 'arn:aws:sns:' + region + ':' + accountId + ':' + n,
  };
}
const settings = (routes: unknown) => ({
  APP_ENV: 'staging',
  FLOCKLETTER_SES_SIMULATOR_BINDING: JSON.stringify(routes),
  FLOCKLETTER_SES_ACCESS_KEY_ID: 'synthetic',
  FLOCKLETTER_SES_SECRET_ACCESS_KEY: 'synthetic',
});
afterEach(() => vi.restoreAllMocks());

it('maps and pauses workspaces independently, rejects ambiguous feedback routes and preserves single bindings', () => {
  const a = route('one'),
    b = route('two');
  const otherBrand = { ...route('three'), workspaceId: a.workspaceId, tenant: a.tenant };
  const config = loadSesRuntime(settings([{ ...a, paused: true }, b, otherBrand]));
  try {
    expect(sesScopes(config)).toHaveLength(3);
    for (const brand of [a, otherBrand])
      expect(sesScope(config, a.workspaceId, brand.brandId)).toMatchObject({ paused: true, port: undefined });
    expect(sesScope(config, b.workspaceId, b.brandId)?.port).toBeDefined();
    expect(sesScope(config, a.workspaceId, b.brandId)).toBeUndefined();
    expect(sesScope(config, a.workspaceId, a.brandId)?.route.fingerprint).toBe(parseSesRoute(a).fingerprint);
    for (const invalid of [
      { ...b, topicArn: a.topicArn },
      { ...b, configurationSet: a.configurationSet },
      { ...b, tenant: a.tenant },
      { ...b, workspaceId: a.workspaceId },
      { ...b, from: a.from, identityArn: a.identityArn },
      a,
    ])
      expect(() => loadSesRuntime(settings([a, invalid]))).toThrow();
  } finally {
    config?.close?.();
  }
});

it('checks verified AWS assignments across pages and keeps a reputation hold independent of sandbox access', async () => {
  const r = parseSesRoute(route('test'));
  const tenantArn = arn + 'tenant/test/test-id';
  const client = new SESv2Client({ region });
  let disabled = false;
  vi.spyOn(client, 'send').mockImplementation(async (command) => {
    switch (command.constructor.name) {
      case 'GetAccountCommand':
        return {
          SendingEnabled: true,
          ProductionAccessEnabled: false,
          SendQuota: { Max24HourSend: 200, SentLast24Hours: 2, MaxSendRate: 1 },
        };
      case 'GetTenantCommand':
        return {
          Tenant: { TenantId: 'test-id', TenantName: 'test', TenantArn: tenantArn, SendingStatus: 'ENABLED' },
        };
      case 'GetReputationEntityCommand':
        return { ReputationEntity: { SendingStatusAggregate: disabled ? 'DISABLED' : 'REINSTATED' } };
      case 'GetEmailIdentityCommand':
        return {
          VerifiedForSendingStatus: true,
          DkimAttributes: { SigningEnabled: true, Status: 'SUCCESS' },
        };
      case 'GetConfigurationSetCommand':
        return { ConfigurationSetName: 'test', SendingOptions: { SendingEnabled: true } };
      case 'GetConfigurationSetEventDestinationsCommand':
        return {
          EventDestinations: [
            {
              Enabled: true,
              SnsDestination: { TopicArn: r.topicArn },
              MatchingEventTypes: ['DELIVERY', 'BOUNCE', 'COMPLAINT'],
            },
          ],
        };
      case 'ListTenantResourcesCommand':
        return 'NextToken' in command.input && command.input.NextToken
          ? {
              TenantResources: [
                { ResourceArn: arn + 'configuration-set/test', ResourceType: 'CONFIGURATION_SET' },
              ],
            }
          : {
              TenantResources: [{ ResourceArn: r.identityArn, ResourceType: 'EMAIL_IDENTITY' }],
              NextToken: 'page-two',
            };
      default:
        throw Error('unexpected call');
    }
  });
  try {
    expect(await inspectSesRoute(client, r)).toMatchObject({
      tenant: true,
      account: true,
      quota: true,
      productionAccess: false,
      configuration: true,
      feedback: true,
      resources: true,
      dkim: true,
      sender: true,
    });
    disabled = true;
    expect((await inspectSesRoute(client, r)).tenant).toBe(false);
  } finally {
    client.destroy();
  }
});

it('returns actionable and brand-isolated readiness through HTTP and MCP without credentials', async () => {
  const site = await startDeliveryFixture();
  const a = await site.workspace(),
    b = await site.workspace();
  try {
    const result = await a.command<DeliveryReadiness>('sender.deliveryReadiness', { brandId: a.brandId });
    expect(await a.tool('sender_deliveryReadiness', { brandId: a.brandId })).toEqual(result);
    expect(result).toMatchObject({
      simulatorConfigured: false,
      customerSendingEnabled: false,
      providerCheckedAt: null,
    });
    expect(result.checks).toContainEqual(
      expect.objectContaining({ label: 'Provider route', state: 'action_needed' }),
    );
    expect((await a.post('sender.deliveryReadiness', { brandId: b.brandId })).status).toBe(404);
  } finally {
    await a.close();
    await b.close();
    await site.close();
  }
});

it('treats unavailable account and tenant reads as unverified without exposing provider errors', async () => {
  const client = new SESv2Client({region});
  vi.spyOn(client,'send').mockImplementation(async () => {throw Error('sensitive provider diagnostic');});
  try {
    const checks = await inspectSesRoute(client,parseSesRoute(route('shop')));
    expect(checks).toMatchObject({account:null,tenant:null,resources:null,dkim:null,feedback:null,productionAccess:null});
    expect(JSON.stringify(checks)).not.toContain('sensitive');
  } finally { client.destroy(); }
});

it('only forwards the exact issued unsubscribe header pair on simulator messages', async () => {
  const r = parseSesRoute(route('test')),
    origin = 'https://mail.example.com';
  const wire = vi
    .spyOn(SESv2Client.prototype, 'send')
    .mockImplementation(async () => ({ MessageId: 'fixture' }));
  const port = createSesSimulatorPort(r, { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, origin);
  const url = origin + '/mail/unsubscribe?t=v1.' + 'a'.repeat(22) + '.' + randomUUID() + '.' + 'b'.repeat(43);
  const input = (value: string): SendEmailCommandInput => ({
    Destination: { ToAddresses: ['success@simulator.amazonses.com'] },
    EmailTags: [{ Name: 'fl_operation', Value: randomUUID() }],
    Content: {
      Simple: {
        Subject: { Data: 'Test' },
        Body: { Text: { Data: 'Test' } },
        Headers: [
          { Name: 'List-Unsubscribe', Value: '<' + value + '>' },
          { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
          { Name: 'X-SES-TENANT', Value: 'another-workspace' },
        ],
      },
    },
  });
  try {
    await expect(port.send(input(url.replace(origin, 'https://other.example.com')))).rejects.toThrow(
      'unsubscribe',
    );
    await expect(port.send(input(url + '\r\nX-Other: bad'))).rejects.toThrow('unsubscribe');
    expect(wire).not.toHaveBeenCalled();
    await port.send(input(url));
    expect(
      (wire.mock.calls[0]![0] as SendEmailCommand).input.Content?.Simple?.Headers?.map((h) => h.Name),
    ).toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post']);
  } finally {
    port.destroy();
  }
});

it('stops a queued review for a paused workspace, delivers its neighbor once and requires a fresh review on resume', async () => {
  const site = await startDeliveryFixture();
  const a = await site.workspace(),
    b = await site.workspace();
  const accounts = [a, b];
  const sent: SendEmailCommandInput[] = [];
  const scopes: SesRuntime[] = accounts.map((workspace, i) => ({
    route: parseSesRoute({
      ...route('retailer' + i),
      workspaceId: workspace.workspaceId,
      brandId: workspace.brandId,
    }),
    port: {
      async send(input) {
        sent.push(input);
        return { MessageId: randomUUID() };
      },
    },
  }));
  const directory = { routes: scopes, close() {} };
  const service = new CommandService(
    site.db,
    undefined,
    site.identity.isOwner,
    undefined,
    undefined,
    undefined,
    () => true,
    directory,
  );
  const worker = new DeliveryWorker(site.db, site.identity.isOwner, undefined, directory);
  async function queue(account: typeof a, campaign: Campaign) {
    const review = (await service.execute(
      'rehearsal.review',
      {
        operationKey: randomUUID(),
        brandId: account.brandId,
        campaignId: campaign.id,
        expectedVersion: campaign.version,
        audience: 'test',
        transport: 'ses_simulator',
      },
      account.owner,
    )) as Rehearsal;
    await service.execute(
      'rehearsal.approve',
      { operationKey: randomUUID(), brandId: account.brandId, id: review.id },
      account.owner,
    );
    return review.id;
  }
  try {
    const campaigns: Campaign[] = [],
      ids: string[] = [];
    for (const [i, account] of accounts.entries()) {
      await site.db.brand(account.workspaceId, account.brandId, (sql) =>
        sql.query(
          'INSERT INTO sender_domains(workspace_id,brand_id,domain,challenge,checked_at,verified_at) VALUES($1,$2,$3,$4,now(),now())',
          [account.workspaceId, account.brandId, scopes[i]!.route.from.split('@')[1], randomUUID()],
        ),
      );
      const campaign = await account.command<Campaign>('campaign.create', {
        operationKey: randomUUID(),
        brandId: account.brandId,
        content: {
          ...emptyContent(),
          title: 'Test shop',
          fromName: 'Retailer',
          replyTo: 'shop@example.test',
          subject: 'New arrivals',
          heading: 'Trail notes',
          body: 'A new edition.',
        },
      });
      campaigns.push(campaign);
      ids.push(await queue(account, campaign));
    }
    const port = scopes[0]!.port;
    scopes[0]!.port = undefined;
    scopes[0]!.paused = true;
    await Promise.all(
      accounts.map((account, i) => worker.tick(account.workspaceId, account.brandId, ids[i])),
    );
    expect(sent.map((s) => s.TenantName)).toEqual([scopes[1]!.route.tenant]);
    expect(await a.command('rehearsal.report', { id: ids[0], brandId: a.brandId })).toMatchObject({
      state: 'blocked',
      accepted: 0,
    });
    expect(await b.command('rehearsal.report', { id: ids[1], brandId: b.brandId })).toMatchObject({
      state: 'completed',
      accepted: 1,
    });
    scopes[0]!.port = port;
    scopes[0]!.paused = false;
    await worker.tick(a.workspaceId, a.brandId, ids[0]);
    const fresh = await queue(a, campaigns[0]!);
    await worker.tick(a.workspaceId, a.brandId, fresh);
    expect(sent.map((s) => s.TenantName)).toEqual([scopes[1]!.route.tenant, scopes[0]!.route.tenant]);
  } finally {
    await a.close();
    await b.close();
    await site.close();
  }
});
