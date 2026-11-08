// Local Qwen drafted the injected SDK dispatch scaffold. Chat corrected its types, profile shape,
// client injection, returned metadata and creation-input persistence before using it. No AWS network.
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  AwsInfrastructurePort,
  createAwsInfrastructurePort,
  infrastructureNames,
  type AwsInfrastructureClients,
  type AwsInfrastructureConfiguration,
} from '../src/server/customer-infrastructure/aws.js';
import {
  infrastructureSteps,
  type InfrastructureRequest,
  type InfrastructureStep,
} from '../src/server/customer-infrastructure/types.js';
type Data = Record<string, unknown>;
type Command = { constructor: { name: string }; input: unknown };
const object = (value: unknown) => value as Data;
function fixture() {
  const workspaceId = 'org_fixture',
    brandId = randomUUID(),
    operationKey = randomUUID(),
    domain = 'shop.example.test',
    fromEmail = 'news@' + domain;
  const state: {
    tenant?: Data;
    configuration?: Data;
    identity?: Data;
    identityDomain?: string;
    topic?: Data;
    topicTags: unknown[];
    subscriptions: Data[];
    destinations: Data[];
    stsAccount: string;
    accountReady: boolean;
  } = {
    topicTags: [],
    subscriptions: [],
    destinations: [],
    stsAccount: '123456789012',
    accountReady: true,
  };
  const writes: { name: string; input: Data }[] = [],
    reads: string[] = [],
    associations = new Set<string>(),
    lostAfter = new Set<string>(),
    lostBefore = new Set<string>(),
    overrides = new Map<string, unknown>(),
    signals = new Set<AbortSignal>();
  const config: AwsInfrastructureConfiguration = {
    environment: 'production',
    activationApproved: true,
    accountId: '123456789012',
    region: 'us-east-1',
    resourcePrefix: 'flockletter',
    origin: 'https://mail.example.test',
    credentials: { accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret' },
    domainProof: async () => true,
  };
  const names = infrastructureNames(config.resourcePrefix, workspaceId, brandId),
    sesArn = 'arn:aws:ses:us-east-1:123456789012:';
  const missing = () => Object.assign(Error('Synthetic resource missing.'), { name: 'NotFoundException' });
  function read<T>(value: T | undefined): T {
    if (!value) throw missing();
    return value;
  }
  function committed(name: string, input: Data) {
    writes.push({ name, input });
    if (lostAfter.delete(name)) throw Error('Synthetic lost response.');
    return {};
  }
  async function sesSend(command: Command, options?: { abortSignal?: AbortSignal }) {
    if (options?.abortSignal) signals.add(options.abortSignal);
    const name = command.constructor.name,
      input = object(command.input);
    reads.push(name);
    if (overrides.has(name)) return overrides.get(name);
    if (lostBefore.delete(name)) {
      writes.push({ name, input });
      throw Error('Synthetic request outcome unknown.');
    }
    switch (name) {
      case 'GetAccountCommand':
        return { SendingEnabled: state.accountReady, ProductionAccessEnabled: state.accountReady };
      case 'GetTenantCommand':
        return read(
          state.tenant && object(state.tenant.Tenant).TenantName === input.TenantName
            ? state.tenant
            : undefined,
        );
      case 'GetConfigurationSetCommand':
        return read(
          state.configuration?.ConfigurationSetName === input.ConfigurationSetName
            ? state.configuration
            : undefined,
        );
      case 'GetEmailIdentityCommand':
        return read(state.identityDomain === input.EmailIdentity ? state.identity : undefined);
      case 'ListTenantResourcesCommand':
        return {
          TenantResources: [...associations].map((ResourceArn) => ({ ResourceArn })),
          NextToken: undefined,
        };
      case 'ListResourceTenantsCommand':
        return {
          ResourceTenants: associations.has(String(input.ResourceArn))
            ? [{ TenantName: names.tenant, TenantId: 'tenant-fixture', ResourceArn: input.ResourceArn }]
            : [],
        };
      case 'GetConfigurationSetEventDestinationsCommand':
        return { EventDestinations: state.destinations };
      case 'CreateTenantCommand':
        state.tenant = {
          Tenant: {
            TenantName: input.TenantName,
            TenantId: 'tenant-fixture',
            TenantArn: sesArn + 'tenant/' + String(input.TenantName) + '/tenant-fixture',
            Tags: input.Tags,
            SuppressionAttributes: input.SuppressionAttributes,
            SendingStatus: 'ENABLED',
          },
        };
        break;
      case 'CreateConfigurationSetCommand':
        state.configuration = {
          ConfigurationSetName: input.ConfigurationSetName,
          Tags: input.Tags,
          TrackingOptions: input.TrackingOptions,
          SuppressionOptions: input.SuppressionOptions,
          SendingOptions: input.SendingOptions,
          VdmOptions: input.VdmOptions,
        };
        break;
      case 'CreateEmailIdentityCommand':
        state.identityDomain = String(input.EmailIdentity);
        state.identity = {
          IdentityType: 'DOMAIN',
          Tags: input.Tags,
          VerifiedForSendingStatus: false,
          VerificationStatus: 'PENDING',
          DkimAttributes: {
            SigningEnabled: true,
            Status: 'PENDING',
            SigningAttributesOrigin: 'AWS_SES',
            Tokens: ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)],
            SigningHostedZone: 'dkim.amazonses.com',
          },
        };
        break;
      case 'CreateTenantResourceAssociationCommand':
        associations.add(String(input.ResourceArn));
        break;
      case 'CreateConfigurationSetEventDestinationCommand':
        state.destinations.push({ Name: input.EventDestinationName, ...object(input.EventDestination) });
        break;
      default:
        throw Error('Unimplemented synthetic SES command ' + name);
    }
    return committed(name, input);
  }
  async function snsSend(command: Command, options?: { abortSignal?: AbortSignal }) {
    if (options?.abortSignal) signals.add(options.abortSignal);
    const name = command.constructor.name,
      input = object(command.input);
    reads.push(name);
    if (overrides.has(name)) return overrides.get(name);
    if (lostBefore.delete(name)) {
      writes.push({ name, input });
      throw Error('Synthetic request outcome unknown.');
    }
    switch (name) {
      case 'GetTopicAttributesCommand':
        return read(
          state.topic && object(state.topic.Attributes).TopicArn === input.TopicArn ? state.topic : undefined,
        );
      case 'ListTagsForResourceCommand':
        return { Tags: state.topicTags };
      case 'ListSubscriptionsByTopicCommand':
        return { Subscriptions: state.subscriptions };
      case 'CreateTopicCommand':
        state.topicTags = input.Tags as unknown[];
        state.topic = {
          Attributes: {
            TopicArn: 'arn:aws:sns:us-east-1:123456789012:' + String(input.Name),
            Owner: '123456789012',
            Policy: '',
            ...object(input.Attributes),
          },
        };
        break;
      case 'SetTopicAttributesCommand':
        object(state.topic!.Attributes)[String(input.AttributeName)] = input.AttributeValue;
        break;
      case 'SubscribeCommand':
        state.subscriptions.push({
          TopicArn: input.TopicArn,
          Owner: '123456789012',
          Protocol: input.Protocol,
          Endpoint: input.Endpoint,
          SubscriptionArn: 'PendingConfirmation',
        });
        break;
      default:
        throw Error('Unimplemented synthetic SNS command ' + name);
    }
    return committed(name, input);
  }
  const clients = {
    ses: { send: sesSend, config: { region: async () => config.region } },
    sns: { send: snsSend, config: { region: async () => config.region } },
    sts: {
      send: async (command: Command, options?: { abortSignal?: AbortSignal }) => {
        if (options?.abortSignal) signals.add(options.abortSignal);
        reads.push(command.constructor.name);
        return { Account: state.stsAccount, Arn: 'arn:aws:iam::' + state.stsAccount + ':user/provisioner' };
      },
      config: { region: async () => config.region },
    },
  } as unknown as AwsInfrastructureClients;
  config.clients = clients;
  const port = new AwsInfrastructurePort(config);
  const request: InfrastructureRequest = {
    workspaceId,
    brandId,
    operationKey,
    domain,
    fromEmail,
    senderRevision: 1,
    profile: {
      fromName: 'Synthetic shop',
      fromEmail,
      replyTo: 'support@shop.example.test',
      organization: 'Synthetic Shop LLC',
      postalAddress: '100 Example Lane, Denver, CO 80202',
      revision: 1,
    },
    providerBinding: port.binding,
    policyVersion: 'infrastructure-v1',
    step: 'tenant',
  };
  const verify = () => {
    state.identity!.VerifiedForSendingStatus = true;
    state.identity!.VerificationStatus = 'SUCCESS';
    object(state.identity!.DkimAttributes).Status = 'SUCCESS';
    state.subscriptions[0]!.SubscriptionArn = String(state.subscriptions[0]!.TopicArn) + ':' + randomUUID();
  };
  return {
    port,
    request,
    state,
    writes,
    reads,
    config,
    clients,
    names,
    associations,
    lostAfter,
    lostBefore,
    overrides,
    signals,
    verify,
  };
}
async function advance(f: ReturnType<typeof fixture>, through: InfrastructureStep = 'subscription') {
  for (const step of infrastructureSteps) {
    const already = (await f.port.inspect(f.request)).progress.completed.includes(step);
    const before = f.writes.length;
    const result = await f.port.apply({ ...f.request, step });
    expect(f.writes.length - before).toBe(already ? 0 : 1);
    expect(result.state).toBe(step === 'subscription' ? 'unknown' : 'accepted');
    if (step === through) return result;
  }
  throw Error('Unknown fixture step.');
}

it('creates exactly one deterministic, tagged AWS resource step at a time and never claims pending DNS or subscription ready', async () => {
  const f = fixture();
  const empty = await f.port.inspect(f.request);
  expect(empty).toMatchObject({
    captured: false,
    verified: false,
    progress: { completed: [], nextStep: 'tenant' },
    dns: [],
  });
  expect(empty.route.tenant).toBeUndefined();
  expect(f.writes).toHaveLength(0);
  await advance(f);
  const pending = await f.port.inspect(f.request);
  expect(pending.verified).toBe(false);
  expect(pending.progress.completed).not.toContain('subscription');
  expect(pending.dns).toEqual(
    ['a', 'b', 'c'].map((letter) => ({
      type: 'CNAME',
      name: letter.repeat(32) + '._domainkey.' + f.request.domain,
      value: letter.repeat(32) + '.dkim.amazonses.com',
    })),
  );
  const tenant = f.writes.find((w) => w.name === 'CreateTenantCommand')!.input;
  expect(tenant).toMatchObject({
    TenantName: f.names.tenant,
    Tags: expect.arrayContaining([
      { Key: 'Application', Value: 'flockletter' },
      { Key: 'WorkspaceDigest', Value: f.names.workspaceDigest },
    ]),
  });
  const config = f.writes.find((w) => w.name === 'CreateConfigurationSetCommand')!.input;
  expect(config).toMatchObject({
    ConfigurationSetName: f.names.configurationSet,
    VdmOptions: { DashboardOptions: { EngagementMetrics: 'DISABLED' } },
  });
  expect(config.TrackingOptions).toBeUndefined();
  expect(f.writes.find((w) => w.name === 'CreateEmailIdentityCommand')!.input).toMatchObject({
    EmailIdentity: f.request.domain,
    DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
  });
  const policy = JSON.parse(
    String(f.writes.find((w) => w.name === 'SetTopicAttributesCommand')!.input.AttributeValue),
  );
  expect(policy.Statement).toEqual([
    {
      Sid: 'AllowExactSesConfiguration',
      Effect: 'Allow',
      Principal: { Service: 'ses.amazonaws.com' },
      Action: 'sns:Publish',
      Resource: pending.route.topicArn,
      Condition: {
        StringEquals: {
          'AWS:SourceAccount': f.config.accountId,
          'AWS:SourceArn': 'arn:aws:ses:us-east-1:123456789012:configuration-set/' + f.names.configurationSet,
        },
      },
    },
  ]);
  expect(
    f.writes.find((w) => w.name === 'CreateConfigurationSetEventDestinationCommand')!.input.EventDestination,
  ).toMatchObject({ Enabled: true, MatchingEventTypes: ['BOUNCE', 'COMPLAINT', 'DELIVERY'] });
  expect(f.writes.find((w) => w.name === 'SubscribeCommand')!.input).toMatchObject({
    Protocol: 'https',
    Endpoint: f.config.origin + '/api/v1/customer-delivery/ses-events',
  });
  const writes = f.writes.length;
  expect((await f.port.apply({ ...f.request, step: 'subscription' })).state).toBe('unknown');
  expect(f.writes).toHaveLength(writes);
  f.verify();
  const ready = await f.port.inspect(f.request);
  expect(ready).toMatchObject({
    captured: false,
    verified: true,
    progress: { completed: [...infrastructureSteps], nextStep: null, dnsPending: false },
  });
  expect((await f.port.apply({ ...f.request, step: 'tenant' })).state).toBe('accepted');
  expect(f.writes).toHaveLength(writes);
});

it('requires explicit production approval and dedicated complete configuration, with no fallback to delivery credentials', () => {
  const f = fixture();
  expect(createAwsInfrastructurePort({}, async () => true)).toBeUndefined();
  expect(
    createAwsInfrastructurePort(
      { APP_ENV: 'staging', FLOCKLETTER_INFRASTRUCTURE_ACTIVATION_APPROVED: 'true' },
      async () => true,
    ),
  ).toBeUndefined();
  expect(
    createAwsInfrastructurePort(
      {
        APP_ENV: 'production',
        FLOCKLETTER_INFRASTRUCTURE_ACTIVATION_APPROVED: 'true',
        FLOCKLETTER_CUSTOMER_SES_ACCESS_KEY_ID: 'delivery',
        FLOCKLETTER_CUSTOMER_SES_SECRET_ACCESS_KEY: 'delivery',
      },
      async () => true,
    ),
  ).toBeUndefined();
  expect(() => new AwsInfrastructurePort({ ...f.config, region: 'eu-west-1' })).toThrow();
  expect(() => new AwsInfrastructurePort({ ...f.config, resourcePrefix: 'cadence' })).toThrow();
  expect(() => new AwsInfrastructurePort({ ...f.config, origin: 'https://127.0.0.1' })).toThrow();
  expect(f.writes).toHaveLength(0);
  expect(f.reads).toHaveLength(0);
});

it('checks exact caller account, client region, sender revision, from-domain and current domain proof before any mutation', async () => {
  const f = fixture();
  f.state.stsAccount = '999999999999';
  await expect(f.port.inspect(f.request)).rejects.toMatchObject({ code: 'aws_account_mismatch' });
  expect((await f.port.apply(f.request)).state).toBe('rejected');
  expect(f.writes).toHaveLength(0);
  f.state.stsAccount = f.config.accountId;
  const wrongRegion = new AwsInfrastructurePort({
    ...f.config,
    clients: {
      ...f.clients,
      sns: { ...f.clients.sns, config: { ...f.clients.sns.config, region: async () => 'eu-west-1' } },
    },
  });
  await expect(wrongRegion.inspect(f.request)).rejects.toMatchObject({ code: 'aws_region_mismatch' });
  expect((await f.port.apply({ ...f.request, fromEmail: 'attacker@other.example.test' })).state).toBe(
    'rejected',
  );
  expect((await f.port.apply({ ...f.request, senderRevision: 2 })).state).toBe('rejected');
  const unproved = new AwsInfrastructurePort({ ...f.config, domainProof: async () => false });
  expect((await unproved.apply(f.request)).state).toBe('rejected');
  expect(f.writes).toHaveLength(0);
});

it('never adopts or mutates foreign ownership tags, ARNs, tenant associations or feedback subscriptions', async () => {
  const f = fixture();
  await advance(f);
  const original = f.state.topicTags;
  f.state.topicTags = [{ Key: 'Application', Value: 'another-app' }];
  const before = f.writes.length;
  await expect(f.port.inspect(f.request)).rejects.toMatchObject({ code: 'aws_resource_conflict' });
  expect((await f.port.apply({ ...f.request, step: 'topic_policy' })).state).toBe('rejected');
  expect(f.writes).toHaveLength(before);
  f.state.topicTags = original;
  object(f.state.tenant!.Tenant).Tags = [
    { Key: 'Application', Value: 'flockletter' },
    { Key: 'WorkspaceDigest', Value: 'other-workspace' },
    { Key: 'Scope', Value: 'workspace' },
  ];
  expect((await f.port.apply({ ...f.request, step: 'tenant' })).state).toBe('rejected');
  expect(f.writes).toHaveLength(before);
  const second = fixture();
  await advance(second, 'identity');
  second.state.identity!.Tags = [{ Key: 'Application', Value: 'ffa' }];
  expect((await second.port.apply({ ...second.request, step: 'identity' })).state).toBe('rejected');
  expect(second.writes.filter((w) => w.name === 'CreateEmailIdentityCommand')).toHaveLength(1);
  const third = fixture();
  await advance(third);
  third.state.subscriptions[0]!.Endpoint = 'https://another-app.example.test/feedback';
  expect((await third.port.apply({ ...third.request, step: 'subscription' })).state).toBe('rejected');
  expect(third.writes.filter((w) => w.name === 'SubscribeCommand')).toHaveLength(1);
});

it('reconciles an ambiguous accepted named mutation with read-only inspection and never invents DKIM records', async () => {
  const f = fixture();
  f.lostAfter.add('CreateTenantCommand');
  expect((await f.port.apply(f.request)).state).toBe('accepted');
  const before = f.writes.length;
  expect((await f.port.inspect(f.request)).progress.completed).toEqual(['tenant']);
  expect(f.writes).toHaveLength(before);
  await advance({ ...f, request: { ...f.request, step: 'tenant' } }, 'identity');
  object(f.state.identity!.DkimAttributes).Tokens = ['bad.invalid-token'];
  expect((await f.port.inspect(f.request)).dns).toEqual([]);
  expect((await f.port.inspect(f.request)).verified).toBe(false);
});

it('does not retry an unknown named creation while subsequent observation still shows no resource', async () => {
  const f = fixture();
  f.lostBefore.add('CreateTenantCommand');
  const result = await f.port.apply(f.request);
  expect(result.state).toBe('unknown');
  expect(f.writes.map((w) => w.name)).toEqual(['CreateTenantCommand']);
  expect((await f.port.inspect(f.request)).progress.completed).toEqual([]);
  expect((await f.port.inspect(f.request)).progress.nextStep).toBe('tenant');
  expect(f.writes).toHaveLength(1);
});

it('rejects cross-tenant resource associations, wrong AWS topic metadata, and any open/click event tracking', async () => {
  const f = fixture();
  await advance(f, 'identity');
  f.overrides.set('ListResourceTenantsCommand', {
    ResourceTenants: [
      {
        TenantName: 'another-app-tenant',
        TenantId: 'foreign',
        ResourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/' + f.request.domain,
      },
    ],
  });
  const writes = f.writes.length;
  await expect(f.port.inspect(f.request)).rejects.toMatchObject({ code: 'aws_resource_conflict' });
  expect((await f.port.apply({ ...f.request, step: 'identity_association' })).state).toBe('rejected');
  expect(f.writes).toHaveLength(writes);
  const second = fixture();
  await advance(second);
  second.overrides.set('GetTopicAttributesCommand', {
    Attributes: { ...object(second.state.topic!.Attributes), Owner: '999999999999' },
  });
  await expect(second.port.inspect(second.request)).rejects.toMatchObject({ code: 'aws_resource_conflict' });
  second.overrides.delete('GetTopicAttributesCommand');
  second.state.destinations[0]!.MatchingEventTypes = ['OPEN', 'CLICK'];
  const before = second.writes.length;
  expect((await second.port.apply({ ...second.request, step: 'event_destination' })).state).toBe('rejected');
  expect(second.writes).toHaveLength(before);
});

it('keeps completed resources ineligible while AWS production access or observed DKIM readiness is missing', async () => {
  const f = fixture();
  await advance(f);
  f.verify();
  f.state.accountReady = false;
  expect(await f.port.inspect(f.request)).toMatchObject({
    verified: false,
    blockers: ['aws_account_sending_unavailable'],
    progress: { completed: [...infrastructureSteps], nextStep: null, dnsPending: false },
  });
  f.state.accountReady = true;
  object(f.state.identity!.DkimAttributes).SigningEnabled = false;
  expect((await f.port.inspect(f.request)).verified).toBe(false);
  const env = {
    APP_ENV: 'production',
    FLOCKLETTER_INFRASTRUCTURE_ACTIVATION_APPROVED: 'true',
    APP_ORIGIN: f.config.origin,
    FLOCKLETTER_INFRASTRUCTURE_AWS_ACCOUNT_ID: f.config.accountId,
    FLOCKLETTER_INFRASTRUCTURE_AWS_REGION: f.config.region,
    FLOCKLETTER_INFRASTRUCTURE_RESOURCE_PREFIX: f.config.resourcePrefix,
    FLOCKLETTER_INFRASTRUCTURE_AWS_ACCESS_KEY_ID: 'isolated-provisioning-key',
    FLOCKLETTER_INFRASTRUCTURE_AWS_SECRET_ACCESS_KEY: 'isolated-provisioning-secret',
  };
  expect(createAwsInfrastructurePort(env, async () => true, f.clients)?.binding).toBe(f.port.binding);
});

it('shares one abort signal across an entire observation pass and closes pending reads without destroying injected clients', async () => {
  const f = fixture();
  await f.port.inspect(f.request);
  expect(f.signals.size).toBe(1);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const destroy = vi.fn();
  const blocked = {
    ...f.clients.sts,
    destroy,
    send: (async () => {
      entered();
      return new Promise<never>(() => {});
    }) as typeof f.clients.sts.send,
  };
  const port = new AwsInfrastructurePort({ ...f.config, clients: { ...f.clients, sts: blocked } });
  const read = port.inspect({ ...f.request, providerBinding: port.binding });
  const rejection = expect(read).rejects.toMatchObject({ code: 'aws_infrastructure_unavailable' });
  await ready;
  port.close();
  port.close();
  await rejection;
  expect(destroy).not.toHaveBeenCalled();
  expect(f.writes).toHaveLength(0);
});

it('abandons a committed in-flight named mutation as unknown when closed, without another mutation or post-close reads', async () => {
  const f = fixture();
  let entered!: () => void,
    attempts = 0;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    original = f.clients.ses.send as unknown as (command: Command, options: unknown) => Promise<unknown>;
  const blocked = {
    ...f.clients.ses,
    send: (async (command: Command, options: unknown) => {
      if (command.constructor.name === 'CreateTenantCommand') {
        attempts++;
        entered();
        return new Promise<never>(() => {});
      }
      return original(command, options);
    }) as typeof f.clients.ses.send,
  };
  const port = new AwsInfrastructurePort({ ...f.config, clients: { ...f.clients, ses: blocked } });
  const apply = port.apply({ ...f.request, providerBinding: port.binding });
  await ready;
  const before = f.reads.length;
  port.close();
  expect(await apply).toEqual({ state: 'unknown' });
  expect(attempts).toBe(1);
  expect(f.reads).toHaveLength(before);
});

it('uses only the trusted apply-context proof during pre/post observation and mutation, leaving standalone inspection strict', async () => {
  const f = fixture(),
    defaultProof = vi.fn(async () => false),
    scopedProof = vi.fn(async () => true);
  const port = new AwsInfrastructurePort({ ...f.config, domainProof: defaultProof });
  await expect(port.inspect(f.request)).rejects.toMatchObject({ code: 'domain_proof_required' });
  defaultProof.mockClear();
  expect((await port.apply(f.request, { domainProof: scopedProof })).state).toBe('accepted');
  expect(scopedProof).toHaveBeenCalledTimes(3);
  expect(scopedProof.mock.calls.every((args) => args.length === 0)).toBe(true);
  expect(defaultProof).not.toHaveBeenCalled();
  expect(f.writes.map((w) => w.name)).toEqual(['CreateTenantCommand']);
  await expect(port.inspect(f.request)).rejects.toMatchObject({ code: 'domain_proof_required' });
});

it('rechecks the scoped proof immediately before mutation and never lets context override request or resource ownership guards', async () => {
  const f = fixture(),
    changingProof = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
  expect((await f.port.apply(f.request, { domainProof: changingProof })).state).toBe('rejected');
  expect(changingProof).toHaveBeenCalledTimes(2);
  expect(f.writes).toHaveLength(0);
  const scopedProof = vi.fn(async () => true);
  expect(
    (await f.port.apply({ ...f.request, providerBinding: 'foreign-binding' }, { domainProof: scopedProof }))
      .state,
  ).toBe('rejected');
  expect(
    (
      await f.port.apply(
        { ...f.request, fromEmail: 'another@foreign.example.test' },
        { domainProof: scopedProof },
      )
    ).state,
  ).toBe('rejected');
  expect(scopedProof).not.toHaveBeenCalled();
  expect(f.writes).toHaveLength(0);
  await advance(f, 'tenant');
  object(f.state.tenant!.Tenant).Tags = [{ Key: 'Application', Value: 'another-app' }];
  const before = f.writes.length;
  expect(
    (await f.port.apply({ ...f.request, step: 'configuration' }, { domainProof: scopedProof })).state,
  ).toBe('rejected');
  expect(f.writes).toHaveLength(before);
});
