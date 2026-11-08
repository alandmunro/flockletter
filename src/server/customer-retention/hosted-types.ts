export interface RetentionScope {
  databaseName: string;
  workspaceId: string;
  jobId: string;
  sourceVersion: string;
  manifestDigest: string;
}

export interface CheckpointFacts {
  version: 1;
  mode: 'live' | 'capture';
  sequence: number;
  phase: 'quarantined' | 'erased' | 'released';
  scope: RetentionScope;
  createdAt: string;
  erasedWorkspaces: string[];
  suppressions: Array<{
    brandId: string;
    subscriberId: string;
    state: 'unsubscribed' | 'hard_bounced' | 'complained';
    eventId: string;
  }>;
}

export interface SignedDocument<T> {
  keyId: string;
  payload: T;
  signature: string;
}

export interface ProtectedCheckpointRef {
  versionId: string;
  digest: string;
  sequence: number;
}

export interface VerifiedCheckpoint {
  reference: ProtectedCheckpointRef;
  facts: CheckpointFacts;
  verifiedAt: string;
  retainUntil: string;
}

export interface ExternalCopy {
  id: string;
  store: string;
  kind: 's3_object' | 's3_marker' | 'local_directory';
  key: string;
  versionId: string | null;
  digest: string;
}

export interface ExternalInventoryFacts {
  version: 1;
  mode: 'live' | 'capture';
  scope: RetentionScope;
  revision: number;
  createdAt: string;
  copies: ExternalCopy[];
  exceptions: RetentionException[];
}

export interface VerifiedExternalInventory {
  facts: ExternalInventoryFacts;
  digest: string;
  verifiedAt: string;
}

export interface RetentionException {
  store: string;
  policyId: string;
  policyVersion: string;
  policyMode: 'bounded' | 'lifetime';
  retainUntil: string | null;
  recordCount: number;
  digest: string;
}

export interface RetentionPlan extends RetentionScope {
  caseId: string;
  caseVersion: number;
  inventoryDigest: string;
  checkpoint: ProtectedCheckpointRef;
  externalInventoryDigest: string;
  exceptionDigest: string;
}

export interface RetentionApprovalPayload extends RetentionPlan {
  version: 1;
  mode: 'live' | 'capture';
  nonce: string;
  operatorId: string;
  issuedAt: string;
  expiresAt: string;
}

export type ExternalCopyState = 'present' | 'absent' | 'unknown' | 'blocked';

export interface ExternalCopyDriver {
  inspect(copy: ExternalCopy, signal: AbortSignal): Promise<ExternalCopyState>;
  erase(copy: ExternalCopy, operationKey: string, signal: AbortSignal): Promise<ExternalCopyState>;
}
