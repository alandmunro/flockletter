import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { z } from 'zod';
import type { CheckpointFacts, ExternalInventoryFacts, RetentionApprovalPayload, SignedDocument } from './hosted-types.js';

export class RetentionIntegrationError extends Error {
  constructor(readonly code: string) { super('Protected retention operation refused.'); }
}
export function requireRetention(value: unknown, code: string): asserts value {
  if (!value) throw new RetentionIntegrationError(code);
}
export function canonicalRetention(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalRetention).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,v])=>JSON.stringify(key)+':'+canonicalRetention(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export const retentionDigest = (value: unknown) => createHash('sha256').update(canonicalRetention(value)).digest('hex');
export const scopeSchema = z.object({
  databaseName:z.string().regex(/^flockletter_[a-z0-9_]{1,60}$/),
  workspaceId:z.string().regex(/^org_[A-Za-z0-9_-]{1,120}$/),jobId:z.uuid(),
  sourceVersion:z.string().min(1).max(256).regex(/^[^\p{Cc}\p{Cf}]+$/u),
  manifestDigest:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const digest=z.string().regex(/^[a-f0-9]{64}$/), timestamp=z.iso.datetime();
export const exceptionSchema=z.object({store:z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),policyId:z.string().min(1).max(100),policyVersion:z.string().min(1).max(100),policyMode:z.enum(['bounded','lifetime']),retainUntil:timestamp.nullable(),recordCount:z.number().int().min(0).max(10000000),digest}).strict();
export const checkpointSchema=z.object({
  version:z.literal(1),mode:z.enum(['live','capture']),sequence:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),phase:z.enum(['quarantined','erased','released']),
  scope:scopeSchema,createdAt:timestamp,erasedWorkspaces:z.array(scopeSchema.shape.workspaceId).max(1),
  suppressions:z.array(z.object({brandId:z.uuid(),subscriberId:z.uuid(),state:z.enum(['unsubscribed','hard_bounced','complained']),eventId:z.string().min(1).max(256)}).strict()).max(100000),
}).strict();
export const externalInventorySchema=z.object({version:z.literal(1),mode:z.enum(['live','capture']),scope:scopeSchema,revision:z.number().int().positive(),createdAt:timestamp,
 copies:z.array(z.object({id:z.uuid(),store:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),kind:z.enum(['s3_object','s3_marker','local_directory']),key:z.string().min(1).max(1024),versionId:z.string().min(1).max(1024).nullable(),digest}).strict()).max(1000),
 exceptions:z.array(exceptionSchema).max(20),
}).strict();
export const approvalSchema=scopeSchema.extend({
  version:z.literal(1),mode:z.enum(['live','capture']),nonce:z.uuid(),operatorId:z.string().regex(/^user_[A-Za-z0-9_-]{1,120}$/),issuedAt:timestamp,expiresAt:timestamp,
  caseId:z.uuid(),caseVersion:z.number().int().positive(),inventoryDigest:digest,
  checkpoint:z.object({versionId:z.string().min(1).max(1024),digest,sequence:z.number().int().positive()}).strict(),
  externalInventoryDigest:digest,exceptionDigest:digest,
}).strict();
const envelopeSchema=z.object({keyId:z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),payload:z.unknown(),signature:z.string().regex(/^[A-Za-z0-9_-]{86}$/)}).strict();
export type RetentionPublicKeys=Readonly<Record<string,string>>;
type Purpose='approval'|'checkpoint'|'external-inventory';
function message(purpose:Purpose,payload:unknown){return Buffer.from('flockletter.retention.'+purpose+'.v1\0'+canonicalRetention(payload));}
function parse<T>(schema:z.ZodType<T>,raw:unknown):T{const result=schema.safeParse(raw);requireRetention(result.success,'document_invalid');return result.data;}
function signed<T>(purpose:Purpose,payload:T,privatePem:string,keyId:string):SignedDocument<T>{
  requireRetention(/^[a-z][a-z0-9_-]{0,31}$/.test(keyId),'key_id_invalid');
  let key;try{key=createPrivateKey(privatePem);}catch{throw new RetentionIntegrationError('signing_key_invalid');}
  requireRetention(key.asymmetricKeyType==='ed25519','signing_key_invalid');
  return {keyId,payload,signature:sign(null,message(purpose,payload),key).toString('base64url')};
}
function checked<T>(purpose:Purpose,schema:z.ZodType<T>,raw:unknown,keys:RetentionPublicKeys):SignedDocument<T>{
  const envelope=parse(envelopeSchema,raw),payload=parse(schema,envelope.payload);
  requireRetention(Object.keys(keys).length>0&&Object.keys(keys).length<=8&&Object.hasOwn(keys,envelope.keyId),'verification_key_untrusted');
  let key;try{key=createPublicKey(keys[envelope.keyId]!);}catch{throw new RetentionIntegrationError('verification_key_invalid');}
  requireRetention(key.asymmetricKeyType==='ed25519'&&verify(null,message(purpose,payload),key,Buffer.from(envelope.signature,'base64url')),'signature_invalid');
  return {keyId:envelope.keyId,payload,signature:envelope.signature};
}
export function retentionScope(value: import('./hosted-types.js').RetentionScope){return scopeSchema.parse({databaseName:value.databaseName,workspaceId:value.workspaceId,jobId:value.jobId,sourceVersion:value.sourceVersion,manifestDigest:value.manifestDigest});}
export function sameRetentionScope(a:import('./hosted-types.js').RetentionScope,b:import('./hosted-types.js').RetentionScope){return canonicalRetention(retentionScope(a))===canonicalRetention(retentionScope(b));}
export function signRetentionApproval(payload:RetentionApprovalPayload,privatePem:string,keyId:string){return signed('approval',parse(approvalSchema,payload),privatePem,keyId);}
export function verifyRetentionApproval(raw:unknown,keys:RetentionPublicKeys,now:Date,expectedMode:'live'|'capture'){
  const envelope=checked('approval',approvalSchema,raw,keys),p=envelope.payload;
  requireRetention(p.mode===expectedMode,'approval_mode_invalid');
  const issued=Date.parse(p.issuedAt),expires=Date.parse(p.expiresAt);
  requireRetention(Number.isFinite(now.getTime())&&issued<=now.getTime()+30000&&issued>=now.getTime()-900000&&expires>now.getTime()&&expires>issued&&expires-issued<=900000,'approval_expired');
  return envelope;
}
export const signRetentionCheckpoint=(payload:CheckpointFacts,key:string,kid:string)=>signed('checkpoint',parse(checkpointSchema,payload),key,kid);
export const verifyRetentionCheckpoint=(raw:unknown,keys:RetentionPublicKeys)=>checked('checkpoint',checkpointSchema,raw,keys);
export const signExternalInventory=(payload:ExternalInventoryFacts,key:string,kid:string)=>signed('external-inventory',parse(externalInventorySchema,payload),key,kid);
export const verifyExternalInventory=(raw:unknown,keys:RetentionPublicKeys)=>checked('external-inventory',externalInventorySchema,raw,keys);
