import type { DeliveryCheck, DeliveryReadiness, SenderStatus } from '../../shared/sender.js';
import type { SesRuntime } from './ses-runtime.js';

export async function deliveryReadiness(
  sender: SenderStatus,
  scope: SesRuntime | undefined,
  worker: boolean,
): Promise<DeliveryReadiness> {
  const checks: DeliveryCheck[] = [];
  function add(label: string, value: boolean | null | undefined, detail: string) {
    checks.push({ label, state: value == null ? 'unverified' : value ? 'ready' : 'action_needed', detail });
  }
  const domain = scope?.route.from.split('@')[1];
  const fresh = sender.verifiedAt && Date.parse(sender.verifiedAt) > Date.now() - 86400000;
  add(
    'Sender ownership',
    Boolean(fresh && (!domain || sender.domain === domain)),
    'Verify the brand domain’s TXT record within 24 hours of a rehearsal.',
  );
  add('Staging worker', worker, 'Bind this brand to the staging delivery worker.');
  add(
    'Provider route',
    Boolean(scope),
    'Map this workspace and brand to their SES tenant, sender, configuration set and feedback topic.',
  );
  add(
    'Workspace submissions',
    scope ? !scope.paused : null,
    'Paused workspaces can still receive feedback about earlier submissions.',
  );
  add(
    'Simulator access',
    Boolean(scope?.port),
    'Use dedicated staging credentials for the AWS mailbox simulator.',
  );
  const remote = await scope?.inspect?.();
  add('Provider account', remote?.account, 'Verify sending is enabled in the selected AWS region.');
  add(
    'Provider sending rate',
    remote?.sendRate,
    'Verify the regional sending rate permits a simulator submission.',
  );
  add(
    'Tenant sending status',
    remote?.tenant,
    'Verify this tenant and its combined AWS and operator reputation status.',
  );
  add(
    'Tenant resource assignments',
    remote?.resources,
    'Assign the exact sender identity and configuration set to this tenant.',
  );
  add('Sender verified by provider', remote?.sender, 'Verify the sending identity in SES.');
  add('DKIM signing', remote?.dkim, 'Enable DKIM and complete the DNS setup for this identity.');
  add('Configuration set', remote?.configuration, 'Verify the bound configuration set is enabled.');
  add(
    'Feedback destination',
    remote?.feedback,
    'Enable delivery, bounce and complaint notifications to the dedicated topic.',
  );
  const simulatorConfigured = checks.every((item) => item.state === 'ready');
  add('Daily customer-mail quota', remote?.quota, 'Ordinary mail needs daily capacity. AWS excludes simulator messages from that quota.');
  add(
    'AWS production access',
    remote?.productionAccess,
    'Required for a later customer-inbox pilot. The simulator works in the AWS sandbox.',
  );
  return {
    checks,
    simulatorConfigured,
    providerCheckedAt: remote?.checkedAt ?? null,
    customerSendingEnabled: false,
  };
}
