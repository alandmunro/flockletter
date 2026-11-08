import type { Sql } from '../db.js';
import type { CustomerSenderProfile } from '../../shared/customer-delivery.js';
import type { CustomerBillingStatus } from '../../shared/customer-billing.js';
export const infrastructureSteps = [
  'tenant',
  'configuration',
  'identity',
  'topic',
  'topic_policy',
  'identity_association',
  'configuration_association',
  'event_destination',
  'subscription',
] as const;
export type InfrastructureStep = (typeof infrastructureSteps)[number];
export type InfrastructureMode = 'off' | 'capture' | 'aws';
export type InfrastructureRequest = {
  workspaceId: string;
  brandId: string;
  operationKey: string;
  domain: string;
  fromEmail: string;
  senderRevision: number;
  profile: CustomerSenderProfile;
  providerBinding: string;
  policyVersion: 'infrastructure-v1';
  step: InfrastructureStep;
};
export type InfrastructureFacts = {
  operationKey: string;
  domain: string;
  fromEmail: string;
  captured: boolean;
  verified: boolean;
  blockers?: string[];
  route: Partial<{
    region: string;
    accountId: string;
    tenant: string;
    configurationSet: string;
    from: string;
    identityArn: string;
    topicArn: string;
  }>;
  progress: { nextStep: InfrastructureStep | null; completed: InfrastructureStep[]; dnsPending: boolean };
  dns: { type: 'TXT' | 'CNAME' | 'MX'; name: string; value: string; priority?: number }[];
};
export type InfrastructureOutcome = {
  state: 'accepted' | 'unknown' | 'rejected';
  facts?: InfrastructureFacts;
};
export type InfrastructureApplyContext = { domainProof: () => Promise<boolean> };
export type InfrastructureProvider = {
  binding: string;
  close?: () => Promise<void> | void;
  inspect(request: InfrastructureRequest): Promise<InfrastructureFacts | null>;
  apply(request: InfrastructureRequest, context?: InfrastructureApplyContext): Promise<InfrastructureOutcome>;
};
export type InfrastructureOptions = {
  mode: InfrastructureMode;
  environment: 'local' | 'test' | 'staging' | 'production';
  isOwner: (user: string, workspace: string) => Promise<boolean>;
  eligibility: (
    workspace: string,
  ) => Promise<Pick<CustomerBillingStatus, 'eligible' | 'revision' | 'source'>>;
  eligibilitySql?: (
    sql: Sql,
    workspace: string,
  ) => Promise<Pick<CustomerBillingStatus, 'eligible' | 'revision' | 'source'>>;
  provider?: InfrastructureProvider;
  budgetPermit?: (sql: Sql, request: InfrastructureRequest) => Promise<boolean>;
};
