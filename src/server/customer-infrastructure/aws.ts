// AWS contracts: https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_CreateTenantResourceAssociation.html
// https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-sns.html
// https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html
import { createHash } from 'node:crypto';
import {
  SESv2Client,
  GetAccountCommand,
  GetTenantCommand,
  GetConfigurationSetCommand,
  GetEmailIdentityCommand,
  GetConfigurationSetEventDestinationsCommand,
  ListTenantResourcesCommand,
  ListResourceTenantsCommand,
  CreateTenantCommand,
  CreateConfigurationSetCommand,
  CreateEmailIdentityCommand,
  CreateTenantResourceAssociationCommand,
  CreateConfigurationSetEventDestinationCommand,
  type Tag,
} from '@aws-sdk/client-sesv2';
import {
  SNSClient,
  GetTopicAttributesCommand,
  ListTagsForResourceCommand,
  ListSubscriptionsByTopicCommand,
  CreateTopicCommand,
  SetTopicAttributesCommand,
  SubscribeCommand,
  type Subscription,
} from '@aws-sdk/client-sns';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { AppError, requireCondition } from '../errors.js';
import { customerDeliveryCommands } from '../../shared/customer-delivery.js';
import {
  infrastructureSteps,
  type InfrastructureProvider,
  type InfrastructureRequest,
  type InfrastructureFacts,
  type InfrastructureOutcome,
  type InfrastructureStep,
  type InfrastructureApplyContext,
} from './types.js';

export type AwsInfrastructureClients = {
  ses: Pick<SESv2Client, 'send' | 'config'>;
  sns: Pick<SNSClient, 'send' | 'config'>;
  sts: Pick<STSClient, 'send' | 'config'>;
};
export type AwsInfrastructureConfiguration = {
  environment: 'production';
  activationApproved: true;
  accountId: string;
  region: string;
  resourcePrefix: string;
  origin: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  domainProof: (request: InfrastructureRequest) => Promise<boolean>;
  clients?: AwsInfrastructureClients;
};
const regions = new Set(['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2']);
const events = ['BOUNCE', 'COMPLAINT', 'DELIVERY'] as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const unavailable = () =>
  new AppError(
    503,
    'aws_infrastructure_unavailable',
    'The dedicated AWS infrastructure could not be verified.',
  );
const conflict = () =>
  new AppError(
    409,
    'aws_resource_conflict',
    'A named AWS resource has conflicting ownership or configuration. Operator review is required.',
  );
function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(unavailable());
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(unavailable());
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', aborted);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', aborted);
          reject(error);
        },
      );
  });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
function samePolicy(raw: string | undefined, expected: unknown) {
  if (!raw || raw.length > 32768) return false;
  try {
    return canonical(JSON.parse(raw)) === canonical(expected);
  } catch {
    return false;
  }
}
function owned(tags: Tag[] | undefined, expected: Tag[]) {
  if (!tags || new Set(tags.map((t) => t.Key)).size !== tags.length) throw conflict();
  for (const tag of expected)
    if (!tags.some((actual) => actual.Key === tag.Key && actual.Value === tag.Value)) throw conflict();
}
function absent(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    ['NotFound', 'NotFoundException'].includes(e.name ?? '') &&
    (e.$metadata?.httpStatusCode === undefined || e.$metadata.httpStatusCode === 404)
  );
}
async function read<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    if (absent(error)) return undefined;
    throw unavailable();
  }
}

export function infrastructureNames(prefix: string, workspaceId: string, brandId: string) {
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const workspaceDigest = hash(workspaceId);
  const brandDigest = hash(workspaceId + '\0' + brandId);
  return {
    workspaceDigest,
    brandDigest,
    tenant: prefix + '-t-' + workspaceDigest.slice(0, 24),
    configurationSet: prefix + '-c-' + brandDigest.slice(0, 24),
    topic: prefix + '-f-' + brandDigest.slice(0, 24),
    eventDestination: prefix + '-feedback',
  };
}

export function awsInfrastructureConfiguration(
  env: NodeJS.ProcessEnv,
  domainProof: AwsInfrastructureConfiguration['domainProof'],
  clients?: AwsInfrastructureClients,
): AwsInfrastructureConfiguration | undefined {
  if (env.APP_ENV !== 'production' || env.FLOCKLETTER_INFRASTRUCTURE_ACTIVATION_APPROVED !== 'true')
    return undefined;
  const accountId = env.FLOCKLETTER_INFRASTRUCTURE_AWS_ACCOUNT_ID,
    region = env.FLOCKLETTER_INFRASTRUCTURE_AWS_REGION,
    resourcePrefix = env.FLOCKLETTER_INFRASTRUCTURE_RESOURCE_PREFIX,
    origin = env.APP_ORIGIN,
    accessKeyId = env.FLOCKLETTER_INFRASTRUCTURE_AWS_ACCESS_KEY_ID,
    secretAccessKey = env.FLOCKLETTER_INFRASTRUCTURE_AWS_SECRET_ACCESS_KEY,
    sessionToken = env.FLOCKLETTER_INFRASTRUCTURE_AWS_SESSION_TOKEN;
  if (!accountId || !region || !resourcePrefix || !origin || !accessKeyId || !secretAccessKey)
    return undefined;
  return {
    environment: 'production',
    activationApproved: true,
    accountId,
    region,
    resourcePrefix,
    origin,
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
    domainProof,
    ...(clients ? { clients } : {}),
  };
}
export function createAwsInfrastructurePort(
  env: NodeJS.ProcessEnv,
  domainProof: AwsInfrastructureConfiguration['domainProof'],
  clients?: AwsInfrastructureClients,
) {
  const config = awsInfrastructureConfiguration(env, domainProof, clients);
  return config ? new AwsInfrastructurePort(config) : undefined;
}

type Observation = { facts: InfrastructureFacts; pendingSubscription: boolean };
export class AwsInfrastructurePort implements InfrastructureProvider {
  readonly binding: string;
  private readonly clients: AwsInfrastructureClients;
  private readonly endpoint: string;
  private readonly config: AwsInfrastructureConfiguration;
  private readonly shutdown = new AbortController();
  private destroyOwned?: () => void;
  constructor(config: AwsInfrastructureConfiguration) {
    requireCondition(
      config.environment === 'production' &&
        config.activationApproved === true &&
        /^\d{12}$/.test(config.accountId) &&
        regions.has(config.region) &&
        /^flockletter[a-z0-9-]{0,16}$/.test(config.resourcePrefix) &&
        Boolean(config.credentials.accessKeyId && config.credentials.secretAccessKey),
      503,
      'aws_activation_required',
      'Dedicated production AWS provisioning configuration and approval are required.',
    );
    let origin: URL;
    try {
      origin = new URL(config.origin);
    } catch {
      throw unavailable();
    }
    requireCondition(
      origin.protocol === 'https:' &&
        !origin.username &&
        !origin.password &&
        origin.origin === config.origin &&
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(origin.hostname),
      503,
      'aws_feedback_origin_required',
      'Configure the exact trusted HTTPS application origin.',
    );
    this.config = { ...config, credentials: { ...config.credentials } };
    this.endpoint = config.origin + '/api/v1/customer-delivery/ses-events';
    const options = {
      region: config.region,
      credentials: this.config.credentials,
      maxAttempts: 1,
      ignoreConfiguredEndpointUrls: true,
    };
    if (config.clients) this.clients = config.clients;
    else {
      const ses = new SESv2Client({
          ...options,
          endpoint: 'https://email.' + config.region + '.amazonaws.com',
        }),
        sns = new SNSClient({ ...options, endpoint: 'https://sns.' + config.region + '.amazonaws.com' }),
        sts = new STSClient({ ...options, endpoint: 'https://sts.' + config.region + '.amazonaws.com' });
      this.clients = { ses, sns, sts };
      this.destroyOwned = () => {
        ses.destroy();
        sns.destroy();
        sts.destroy();
      };
    }
    this.binding =
      'aws-infrastructure-v1-' +
      hash(JSON.stringify([config.accountId, config.region, config.resourcePrefix, this.endpoint]));
  }
  private signal(milliseconds: number, parent?: AbortSignal) {
    return AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(milliseconds),
      ...(parent ? [parent] : []),
    ]);
  }
  close() {
    this.shutdown.abort();
    this.destroyOwned?.();
    this.destroyOwned = undefined;
  }
  private async prove(
    request: InfrastructureRequest,
    signal: AbortSignal,
    proof?: InfrastructureApplyContext['domainProof'],
  ) {
    const valid = await bounded(() => (proof ? proof() : this.config.domainProof(request)), signal);
    signal.throwIfAborted();
    requireCondition(
      valid,
      409,
      'domain_proof_required',
      'Verify this exact brand domain before provisioning.',
    );
  }
  private async validate(
    request: InfrastructureRequest,
    signal: AbortSignal,
    proof?: InfrastructureApplyContext['domainProof'],
  ) {
    signal.throwIfAborted();
    const schema = customerDeliveryCommands['delivery.saveSender'].schema;
    // Explicitly rebuild the strict command input; a profile revision is checked separately.
    const checked = schema.safeParse({
      operationKey: request.operationKey,
      brandId: request.brandId,
      fromName: request.profile.fromName,
      fromEmail: request.profile.fromEmail,
      replyTo: request.profile.replyTo,
      organization: request.profile.organization,
      postalAddress: request.profile.postalAddress,
    });
    requireCondition(
      checked.success &&
        /^org_[A-Za-z0-9_-]{1,120}$/.test(request.workspaceId) &&
        request.policyVersion === 'infrastructure-v1' &&
        infrastructureSteps.includes(request.step) &&
        request.providerBinding === this.binding &&
        request.profile.fromEmail === request.fromEmail &&
        request.profile.revision === request.senderRevision &&
        Number.isSafeInteger(request.senderRevision) &&
        request.senderRevision > 0 &&
        request.domain.length <= 253 &&
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(request.domain) &&
        request.fromEmail.split('@')[1]?.toLowerCase() === request.domain,
      409,
      'aws_request_changed',
      'The saved sender, domain or provisioning binding changed. Prepare a fresh review.',
    );
    await this.prove(request, signal, proof);
    signal.throwIfAborted();
    const clientRegions = await Promise.all([
      this.clients.ses.config.region(),
      this.clients.sns.config.region(),
      this.clients.sts.config.region(),
    ]);
    requireCondition(
      clientRegions.every((region) => region === this.config.region),
      409,
      'aws_region_mismatch',
      'The AWS clients must use the approved US region.',
    );
    const caller = await this.clients.sts.send(new GetCallerIdentityCommand({}), {
      abortSignal: signal,
    });
    requireCondition(
      caller.Account === this.config.accountId &&
        typeof caller.Arn === 'string' &&
        new RegExp(
          '^arn:aws:(?:iam|sts)::' + this.config.accountId + ':(?:user|role|assumed-role)/[^\\s]+$',
        ).test(caller.Arn),
      409,
      'aws_account_mismatch',
      'The provisioning credentials do not belong to the approved AWS account.',
    );
  }
  private policy(topicArn: string, configurationArn: string) {
    return {
      Version: '2012-10-17',
      Id: 'flockletter-ses-feedback',
      Statement: [
        {
          Sid: 'AllowExactSesConfiguration',
          Effect: 'Allow',
          Principal: { Service: 'ses.amazonaws.com' },
          Action: 'sns:Publish',
          Resource: topicArn,
          Condition: {
            StringEquals: { 'AWS:SourceAccount': this.config.accountId, 'AWS:SourceArn': configurationArn },
          },
        },
      ],
    };
  }
  private async observe(
    request: InfrastructureRequest,
    signal: AbortSignal,
    proof?: InfrastructureApplyContext['domainProof'],
  ): Promise<Observation> {
    await this.validate(request, signal, proof);
    signal.throwIfAborted();
    const names = infrastructureNames(this.config.resourcePrefix, request.workspaceId, request.brandId);
    const sesArn = 'arn:aws:ses:' + this.config.region + ':' + this.config.accountId + ':',
      identityArn = sesArn + 'identity/' + request.domain,
      configurationArn = sesArn + 'configuration-set/' + names.configurationSet,
      topicArn = 'arn:aws:sns:' + this.config.region + ':' + this.config.accountId + ':' + names.topic;
    const tenantTags = [
      { Key: 'Application', Value: 'flockletter' },
      { Key: 'WorkspaceDigest', Value: names.workspaceDigest },
      { Key: 'Scope', Value: 'workspace' },
    ];
    const brandTags = [
      { Key: 'Application', Value: 'flockletter' },
      { Key: 'WorkspaceDigest', Value: names.workspaceDigest },
      { Key: 'BrandDigest', Value: names.brandDigest },
    ];
    const [tenant, configuration, identity, topic, account] = await Promise.all([
      read(() =>
        this.clients.ses.send(new GetTenantCommand({ TenantName: names.tenant }), {
          abortSignal: signal,
        }),
      ),
      read(() =>
        this.clients.ses.send(
          new GetConfigurationSetCommand({ ConfigurationSetName: names.configurationSet }),
          { abortSignal: signal },
        ),
      ),
      read(() =>
        this.clients.ses.send(new GetEmailIdentityCommand({ EmailIdentity: request.domain }), {
          abortSignal: signal,
        }),
      ),
      read(() =>
        this.clients.sns.send(new GetTopicAttributesCommand({ TopicArn: topicArn }), {
          abortSignal: signal,
        }),
      ),
      this.clients.ses.send(new GetAccountCommand({}), { abortSignal: signal }),
    ]);
    const completed = new Set<InfrastructureStep>(),
      route: InfrastructureFacts['route'] = {
        region: this.config.region,
        accountId: this.config.accountId,
        from: request.fromEmail,
      };
    const blockers: string[] = [];
    if (tenant) {
      const t = tenant.Tenant;
      if (
        !t ||
        t.TenantName !== names.tenant ||
        !t.TenantId ||
        !/^[A-Za-z0-9-]{1,128}$/.test(t.TenantId) ||
        t.TenantArn !== sesArn + 'tenant/' + names.tenant + '/' + t.TenantId
      )
        throw conflict();
      owned(t.Tags, tenantTags);
      if (
        t.SuppressionAttributes?.SuppressionScope !== 'TENANT' ||
        canonical([...(t.SuppressionAttributes?.SuppressedReasons ?? [])].sort()) !==
          canonical(['BOUNCE', 'COMPLAINT'])
      )
        throw conflict();
      completed.add('tenant');
      route.tenant = names.tenant;
      if (!['ENABLED', 'REINSTATED'].includes(t.SendingStatus ?? ''))
        blockers.push('aws_tenant_sending_disabled');
    }
    if (configuration) {
      if (
        configuration.ConfigurationSetName !== names.configurationSet ||
        configuration.TrackingOptions ||
        configuration.VdmOptions?.DashboardOptions?.EngagementMetrics !== 'DISABLED' ||
        configuration.SendingOptions?.SendingEnabled !== true ||
        configuration.SuppressionOptions?.SuppressionScope !== 'TENANT' ||
        canonical([...(configuration.SuppressionOptions?.SuppressedReasons ?? [])].sort()) !==
          canonical(['BOUNCE', 'COMPLAINT'])
      )
        throw conflict();
      owned(configuration.Tags, brandTags);
      completed.add('configuration');
      route.configurationSet = names.configurationSet;
    }
    let dns: InfrastructureFacts['dns'] = [];
    const identityVerified =
      identity?.IdentityType === 'DOMAIN' &&
      identity.VerifiedForSendingStatus === true &&
      identity.VerificationStatus === 'SUCCESS' &&
      identity.DkimAttributes?.SigningEnabled === true &&
      identity.DkimAttributes.Status === 'SUCCESS' &&
      identity.DkimAttributes.SigningAttributesOrigin === 'AWS_SES';
    if (identity) {
      if (
        identity.IdentityType !== 'DOMAIN' ||
        Object.keys(identity.Policies ?? {}).length ||
        (identity.ConfigurationSetName && identity.ConfigurationSetName !== names.configurationSet)
      )
        throw conflict();
      owned(identity.Tags, brandTags);
      completed.add('identity');
      route.identityArn = identityArn;
      const dkim = identity.DkimAttributes,
        tokens = dkim?.Tokens,
        zone = dkim?.SigningHostedZone;
      if (
        tokens?.length === 3 &&
        new Set(tokens).size === 3 &&
        tokens.every((t) => /^[a-z0-9]{16,128}$/.test(t)) &&
        zone &&
        /^dkim(?:\.(?:us-east-1|us-east-2|us-west-1|us-west-2))?\.amazonses\.com$/.test(zone)
      )
        dns = tokens.map((token) => ({
          type: 'CNAME',
          name: token + '._domainkey.' + request.domain,
          value: token + '.' + zone,
        }));
      if (!identityVerified) blockers.push(dns.length ? 'aws_dkim_pending' : 'aws_dkim_records_unavailable');
    }
    let policyMatches = false,
      pendingSubscription = false,
      subscriptionConfirmed = false;
    if (topic) {
      const attributes = topic.Attributes;
      if (
        !attributes ||
        attributes.TopicArn !== topicArn ||
        attributes.Owner !== this.config.accountId ||
        attributes.FifoTopic === 'true' ||
        attributes.SignatureVersion !== '2'
      )
        throw conflict();
      const tags = await this.clients.sns.send(new ListTagsForResourceCommand({ ResourceArn: topicArn }), {
        abortSignal: signal,
      });
      owned(tags.Tags, brandTags);
      completed.add('topic');
      route.topicArn = topicArn;
      policyMatches = samePolicy(attributes.Policy, this.policy(topicArn, configurationArn));
      if (policyMatches) completed.add('topic_policy');
      const subscriptions: Subscription[] = [];
      let next: string | undefined;
      for (let page = 0; page < 5; page++) {
        const list = await this.clients.sns.send(
          new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, ...(next ? { NextToken: next } : {}) }),
          { abortSignal: signal },
        );
        subscriptions.push(...(list.Subscriptions ?? []));
        next = list.NextToken;
        if (!next) break;
      }
      if (next) throw unavailable();
      for (const item of subscriptions)
        if (
          item.TopicArn !== topicArn ||
          item.Owner !== this.config.accountId ||
          item.Protocol !== 'https' ||
          item.Endpoint !== this.endpoint
        )
          throw conflict();
      if (subscriptions.length > 1) throw conflict();
      const subscription = subscriptions[0];
      if (subscription) {
        subscriptionConfirmed =
          typeof subscription.SubscriptionArn === 'string' &&
          new RegExp('^' + topicArn + ':[a-f0-9-]{36}$').test(subscription.SubscriptionArn);
        pendingSubscription = subscription.SubscriptionArn === 'PendingConfirmation';
        if (!subscriptionConfirmed && !pendingSubscription) throw conflict();
      }
      if (subscriptionConfirmed) completed.add('subscription');
      else blockers.push('aws_feedback_subscription_unconfirmed');
    }
    const associations = new Set<string>();
    if (tenant) {
      let next: string | undefined;
      for (let page = 0; page < 5; page++) {
        const listed = await this.clients.ses.send(
          new ListTenantResourcesCommand({
            TenantName: names.tenant,
            PageSize: 100,
            ...(next ? { NextToken: next } : {}),
          }),
          { abortSignal: signal },
        );
        for (const resource of listed.TenantResources ?? [])
          if (resource.ResourceArn) associations.add(resource.ResourceArn);
        next = listed.NextToken;
        if (!next) break;
      }
      if (next) throw unavailable();
    }
    for (const [exists, arn, step] of [
      [Boolean(identity), identityArn, 'identity_association'],
      [Boolean(configuration), configurationArn, 'configuration_association'],
    ] as const)
      if (exists) {
        let next: string | undefined,
          associated = false;
        for (let page = 0; page < 5; page++) {
          const listed = await this.clients.ses.send(
            new ListResourceTenantsCommand({
              ResourceArn: arn,
              PageSize: 100,
              ...(next ? { NextToken: next } : {}),
            }),
            { abortSignal: signal },
          );
          for (const resource of listed.ResourceTenants ?? []) {
            if (
              resource.TenantName !== names.tenant ||
              resource.ResourceArn !== arn ||
              resource.TenantId !== tenant?.Tenant?.TenantId
            )
              throw conflict();
            associated = true;
          }
          next = listed.NextToken;
          if (!next) break;
        }
        if (next) throw unavailable();
        if (associated && associations.has(arn)) completed.add(step);
        else if (associated !== associations.has(arn)) throw unavailable();
      }
    if (configuration) {
      const destinations = await this.clients.ses.send(
        new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName: names.configurationSet }),
        { abortSignal: signal },
      );
      if ((destinations.EventDestinations?.length ?? 0) > 1) throw conflict();
      const destination = destinations.EventDestinations?.[0];
      if (destination) {
        if (
          destination.Name !== names.eventDestination ||
          destination.Enabled !== true ||
          destination.SnsDestination?.TopicArn !== topicArn ||
          destination.CloudWatchDestination ||
          destination.KinesisFirehoseDestination ||
          destination.EventBridgeDestination ||
          destination.PinpointDestination ||
          canonical([...(destination.MatchingEventTypes ?? [])].sort()) !== canonical(events)
        )
          throw conflict();
        if (!topic || !policyMatches) throw conflict();
        completed.add('event_destination');
      }
    }
    if (account.SendingEnabled !== true || account.ProductionAccessEnabled !== true)
      blockers.push('aws_account_sending_unavailable');
    const ordered = infrastructureSteps.filter((step) => completed.has(step));
    const verified = ordered.length === infrastructureSteps.length && identityVerified && !blockers.length;
    const facts: InfrastructureFacts = {
      operationKey: request.operationKey,
      domain: request.domain,
      fromEmail: request.fromEmail,
      captured: false,
      verified,
      route,
      progress: {
        nextStep: infrastructureSteps.find((step) => !completed.has(step)) ?? null,
        completed: ordered,
        dnsPending: !identityVerified,
      },
      dns,
      blockers,
    };
    return { facts, pendingSubscription };
  }
  async inspect(request: InfrastructureRequest): Promise<InfrastructureFacts> {
    const signal = this.signal(10000);
    return (await bounded(() => this.observe(request, signal), signal)).facts;
  }
  async apply(
    request: InfrastructureRequest,
    context?: InfrastructureApplyContext,
  ): Promise<InfrastructureOutcome> {
    const deadline = this.signal(25000),
      beforeSignal = this.signal(10000, deadline);
    let observed: Observation;
    try {
      observed = await bounded(() => this.observe(request, beforeSignal, context?.domainProof), beforeSignal);
    } catch (error) {
      if (error instanceof AppError && error.status < 500) return { state: 'rejected' };
      return { state: 'unknown' };
    }
    if (observed.facts.progress.completed.includes(request.step))
      return { state: 'accepted', facts: observed.facts };
    if (observed.facts.progress.nextStep !== request.step)
      return { state: 'rejected', facts: observed.facts };
    if (request.step === 'subscription' && observed.pendingSubscription)
      return { state: 'unknown', facts: observed.facts };
    try {
      await this.prove(request, deadline, context?.domainProof);
    } catch (error) {
      return { state: error instanceof AppError && error.status < 500 ? 'rejected' : 'unknown' };
    }
    const names = infrastructureNames(this.config.resourcePrefix, request.workspaceId, request.brandId),
      base = 'arn:aws:ses:' + this.config.region + ':' + this.config.accountId + ':';
    const identityArn = base + 'identity/' + request.domain,
      configurationArn = base + 'configuration-set/' + names.configurationSet,
      topicArn = 'arn:aws:sns:' + this.config.region + ':' + this.config.accountId + ':' + names.topic;
    const tags = [
      { Key: 'Application', Value: 'flockletter' },
      { Key: 'WorkspaceDigest', Value: names.workspaceDigest },
      { Key: 'BrandDigest', Value: names.brandDigest },
    ];
    const options = { abortSignal: deadline };
    try {
      await bounded(async () => {
        switch (request.step) {
          case 'tenant':
            await this.clients.ses.send(
              new CreateTenantCommand({
                TenantName: names.tenant,
                Tags: tags
                  .filter((t) => t.Key !== 'BrandDigest')
                  .concat({ Key: 'Scope', Value: 'workspace' }),
                SuppressionAttributes: {
                  SuppressionScope: 'TENANT',
                  SuppressedReasons: ['BOUNCE', 'COMPLAINT'],
                },
              }),
              options,
            );
            break;
          case 'configuration':
            await this.clients.ses.send(
              new CreateConfigurationSetCommand({
                ConfigurationSetName: names.configurationSet,
                Tags: tags,
                SendingOptions: { SendingEnabled: true },
                VdmOptions: { DashboardOptions: { EngagementMetrics: 'DISABLED' } },
                SuppressionOptions: {
                  SuppressionScope: 'TENANT',
                  SuppressedReasons: ['BOUNCE', 'COMPLAINT'],
                },
              }),
              options,
            );
            break;
          case 'identity':
            await this.clients.ses.send(
              new CreateEmailIdentityCommand({
                EmailIdentity: request.domain,
                Tags: tags,
                DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
              }),
              options,
            );
            break;
          case 'topic':
            await this.clients.sns.send(
              new CreateTopicCommand({
                Name: names.topic,
                Tags: tags,
                Attributes: { SignatureVersion: '2', FifoTopic: 'false' },
              }),
              options,
            );
            break;
          case 'topic_policy':
            await this.clients.sns.send(
              new SetTopicAttributesCommand({
                TopicArn: topicArn,
                AttributeName: 'Policy',
                AttributeValue: JSON.stringify(this.policy(topicArn, configurationArn)),
              }),
              options,
            );
            break;
          case 'identity_association':
            await this.clients.ses.send(
              new CreateTenantResourceAssociationCommand({
                TenantName: names.tenant,
                ResourceArn: identityArn,
              }),
              options,
            );
            break;
          case 'configuration_association':
            await this.clients.ses.send(
              new CreateTenantResourceAssociationCommand({
                TenantName: names.tenant,
                ResourceArn: configurationArn,
              }),
              options,
            );
            break;
          case 'event_destination':
            await this.clients.ses.send(
              new CreateConfigurationSetEventDestinationCommand({
                ConfigurationSetName: names.configurationSet,
                EventDestinationName: names.eventDestination,
                EventDestination: {
                  Enabled: true,
                  MatchingEventTypes: [...events],
                  SnsDestination: { TopicArn: topicArn },
                },
              }),
              options,
            );
            break;
          case 'subscription':
            await this.clients.sns.send(
              new SubscribeCommand({
                TopicArn: topicArn,
                Protocol: 'https',
                Endpoint: this.endpoint,
                ReturnSubscriptionArn: true,
              }),
              options,
            );
            break;
        }
      }, deadline);
    } catch {
      /* A committed controller attempt must be reconciled by observation, never SDK retries. */
    }
    try {
      const afterSignal = this.signal(10000, deadline);
      const after = await bounded(
        () => this.observe(request, afterSignal, context?.domainProof),
        afterSignal,
      );
      return {
        state: after.facts.progress.completed.includes(request.step) ? 'accepted' : 'unknown',
        facts: after.facts,
      };
    } catch {
      return { state: 'unknown' };
    }
  }
}
