import { z } from 'zod';
export const senderDomain = z
  .string()
  .trim()
  .max(253)
  .toLowerCase()
  .refine((domain) => {
    if (
      !domain.includes('.') ||
      !/[a-z]/.test(domain.split('.').at(-1) ?? '') ||
      /(^|\.)(localhost|local|internal|arpa|test|invalid|example|onion|lan|home|localdomain)$/.test(domain)
    )
      return false;
    return domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  }, 'Enter a public domain name without a URL or port.');
export type SenderStatus = {
  domain: string | null;
  recordName: string | null;
  recordValue: string | null;
  status: 'not_configured' | 'awaiting_dns' | 'ownership_verified';
  checkedAt: string | null;
  verifiedAt: string | null;
  providerVerified: false;
};

export type DeliveryCheck = { label: string; state: 'ready'|'action_needed'|'unverified'; detail: string };
export type DeliveryReadiness = {
  checks: DeliveryCheck[]; simulatorConfigured: boolean; providerCheckedAt: string | null;
  customerSendingEnabled: false;
};
