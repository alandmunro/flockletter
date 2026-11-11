import {
  SESv2Client,
  GetAccountCommand,
  GetConfigurationSetCommand,
  GetConfigurationSetEventDestinationsCommand,
  GetEmailIdentityCommand,
  GetTenantCommand,
  GetReputationEntityCommand,
  ListTenantResourcesCommand,
} from '@aws-sdk/client-sesv2';
import type { SesRoute } from './ses-runtime.js';
import type { SesSimulatorCredentials } from './ses-simulator.js';

// Undefined provider fields or unavailable reads cannot establish readiness. Return only
// scoped facts to the workspace. Provider errors can contain account IDs, policy and DNS details.
export type ProviderChecks = {
  account: boolean | null;
  quota: boolean | null;
  sendRate: boolean | null;
  productionAccess: boolean | null;
  tenant: boolean | null;
  resources: boolean | null;
  sender: boolean | null;
  dkim: boolean | null;
  configuration: boolean | null;
  feedback: boolean | null;
  checkedAt: string;
};

async function observed<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch {
    return null;
  }
}

async function assigned(client: Pick<SESv2Client, 'send'>, route: SesRoute, signal: AbortSignal) {
  const remaining = new Map([
    [route.identityArn, ['EMAIL_IDENTITY', 'identity']],
    [
      `arn:aws:ses:${route.region}:${route.accountId}:configuration-set/${route.configurationSet}`,
      ['CONFIGURATION_SET', 'configuration-set'],
    ],
  ]);
  let token: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const result = await client.send(
      new ListTenantResourcesCommand({ TenantName: route.tenant, PageSize: 100, NextToken: token }),
      { abortSignal: signal },
    );
    for (const item of result.TenantResources ?? [])
      if (item.ResourceArn && item.ResourceType && remaining.get(item.ResourceArn)?.includes(item.ResourceType))
        remaining.delete(item.ResourceArn);
    if (!remaining.size) return true;
    token = result.NextToken;
    if (!token) return false;
    if (seen.has(token)) return null;
    seen.add(token);
  }
  return null;
}

function enabled(value?: string) {
  return value === 'ENABLED' || value === 'REINSTATED';
}

export async function inspectSesRoute(
  client: Pick<SESv2Client, 'send'>,
  route: SesRoute,
): Promise<ProviderChecks> {
  const signal = AbortSignal.timeout(6000),
    options = { abortSignal: signal };
  const [account, tenantResult, identity, config, events, resources] = await Promise.all([
    observed(client.send(new GetAccountCommand({}), options)),
    observed(client.send(new GetTenantCommand({ TenantName: route.tenant }), options)),
    observed(
      client.send(new GetEmailIdentityCommand({ EmailIdentity: route.identityArn.split('/')[1]! }), options),
    ),
    observed(
      client.send(new GetConfigurationSetCommand({ ConfigurationSetName: route.configurationSet }), options),
    ),
    observed(
      client.send(
        new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName: route.configurationSet }),
        options,
      ),
    ),
    observed(assigned(client, route, signal)),
  ]);
  const tenant = tenantResult?.Tenant;
  const tenantPrefix = `arn:aws:ses:${route.region}:${route.accountId}:tenant/`;
  const id = tenant?.TenantId;
  const matches =
    !!id &&
    tenant.TenantName === route.tenant &&
    [tenantPrefix + id, tenantPrefix + route.tenant + '/' + id].includes(tenant.TenantArn ?? '');
  const reputation = matches
    ? await observed(
        client.send(
          new GetReputationEntityCommand({
            ReputationEntityType: 'RESOURCE',
            ReputationEntityReference: tenant.TenantArn,
          }),
          options,
        ),
      )
    : null;
  const matchingEvents = (events?.EventDestinations ?? []).filter(
    (d) => d.Enabled && d.SnsDestination?.TopicArn === route.topicArn,
  );
  const quota = account?.SendQuota,
    max = quota?.Max24HourSend,
    used = quota?.SentLast24Hours,
    rate = quota?.MaxSendRate;
  return {
    account: account ? account.SendingEnabled === true : null,
    quota: typeof max === 'number' && typeof used === 'number' ? max === -1 || max > used : null,
    sendRate: typeof rate === 'number' ? rate > 0 : null,
    productionAccess: account?.ProductionAccessEnabled ?? null,
    tenant: !tenantResult
      ? null
      : !matches || !enabled(tenant.SendingStatus)
        ? false
        : reputation?.ReputationEntity?.SendingStatusAggregate
          ? enabled(reputation.ReputationEntity.SendingStatusAggregate)
          : null,
    resources,
    sender: identity ? identity.VerifiedForSendingStatus === true : null,
    dkim: identity
      ? identity.DkimAttributes?.SigningEnabled === true && identity.DkimAttributes.Status === 'SUCCESS'
      : null,
    configuration: !config
      ? null
      : config.ConfigurationSetName !== route.configurationSet
        ? false
        : (config.SendingOptions?.SendingEnabled ?? null),
    feedback: events
      ? ['DELIVERY', 'BOUNCE', 'COMPLAINT'].every((type) =>
          matchingEvents.some((d) => d.MatchingEventTypes?.some((v) => v === type)),
        )
      : null,
    checkedAt: new Date().toISOString(),
  };
}

export function createSesInspector(route: SesRoute, credentials: SesSimulatorCredentials) {
  const client = new SESv2Client({
    region: route.region,
    credentials,
    maxAttempts: 1,
    ignoreConfiguredEndpointUrls: true,
  });
  let cached: { until: number; result: Promise<ProviderChecks> } | undefined;
  return {
    check: () => {
      if (!cached || Date.now() >= cached.until)
        cached = { until: Date.now() + 60000, result: inspectSesRoute(client, route) };
      return cached.result;
    },
    close: () => client.destroy(),
  };
}
