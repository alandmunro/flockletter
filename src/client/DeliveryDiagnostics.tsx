import type { CustomerDeliveryStatus } from '../shared/customer-delivery.js';

interface DeliveryDiagnosticsProps {
  status: CustomerDeliveryStatus;
  brand: { id: string; name: string };
  campaign: { id: string; version: number; title: string } | null;
}

function formatSendingService(mode: CustomerDeliveryStatus['mode']): string {
  switch (mode) {
    case 'ses':
      return 'AWS SES';
    case 'resend':
      return 'Resend';
    case 'capture':
      return 'Captured';
    case 'off':
      return 'Off';
  }
}

function formatSendingScope(scope: CustomerDeliveryStatus['scope']): string {
  return scope === 'tests' ? 'Single-contact tests' : 'Broadcasts and tests';
}

function formatBoolean(value: boolean | null): string {
  if (value === null) return 'Unknown';
  return value ? 'Yes' : 'No';
}

export function DeliveryDiagnostics({ status, brand, campaign }: DeliveryDiagnosticsProps) {
  return (
    <details>
      <summary>Delivery details for support</summary>
      <dl>
        <dt>Environment</dt>
        <dd>{status.context.environment}</dd>

        <dt>Workspace ID</dt>
        <dd>{status.context.workspaceId}</dd>

        <dt>Brand name</dt>
        <dd>{brand.name}</dd>

        <dt>Brand ID</dt>
        <dd>{brand.id}</dd>

        <dt>Saved campaign ID</dt>
        <dd>{campaign ? campaign.id : 'No saved campaign selected'}</dd>

        <dt>Saved campaign</dt>
        <dd>{campaign ? campaign.title : 'No saved campaign selected'}</dd>

        <dt>Saved version</dt>
        <dd>{campaign ? campaign.version : 'No saved campaign selected'}</dd>

        <dt>Sending service</dt>
        <dd>{formatSendingService(status.mode)}</dd>

        <dt>Sending scope</dt>
        <dd>{formatSendingScope(status.scope)}</dd>

        <dt>Renderer configured</dt>
        <dd>{formatBoolean(status.rendererConfigured)}</dd>

        <dt>This service provider route configured</dt>
        <dd>{formatBoolean(status.providerConfigured)}</dd>

        <dt>Sender checks current</dt>
        <dd>{formatBoolean(status.senderVerified)}</dd>

        <dt>Observed at</dt>
        <dd>{status.context.observedAt}</dd>

      </dl>
      <p>If your intended draft is missing, verify the sign-in account, workspace and environment, save the draft and refresh saved campaigns. Do not substitute another campaign or search another workspace through these controls.</p>
    </details>
  );
}
