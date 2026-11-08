import {z} from 'zod';
import {createPublicKey,verify} from 'node:crypto';
import {canonicalRetention,requireRetention,sameRetentionScope,scopeSchema,type RetentionPublicKeys} from './approval.js';
import type {RetentionScope,ProtectedCheckpointRef} from './hosted-types.js';
const receipt=z.object({keyId:z.string(),signature:z.string().regex(/^[A-Za-z0-9_-]{86}$/),payload:z.object({version:z.literal(1),scope:scopeSchema,checkpoint:z.object({versionId:z.string().min(1),digest:z.string().regex(/^[a-f0-9]{64}$/),sequence:z.number().int().positive()}).strict(),instanceId:z.string().regex(/^[a-z0-9_-]{1,100}$/),bootId:z.uuid(),createdAt:z.iso.datetime(),quiesced:z.literal(true),processStopped:z.literal(true),ownedDirectoriesRemoved:z.literal(true)}).strict()}).strict();
export function verifyEngineDisposalReceipts(raw:unknown,expectedInstances:readonly string[],keys:RetentionPublicKeys,scope:RetentionScope,checkpoint:ProtectedCheckpointRef,now=new Date()){
 requireRetention(Array.isArray(raw)&&expectedInstances.length>0&&new Set(expectedInstances).size===expectedInstances.length&&raw.length===expectedInstances.length,'engine_roster_incomplete');
 const seen=new Set<string>();
 for(const item of raw){const parsed=receipt.safeParse(item);requireRetention(parsed.success,'engine_receipt_invalid');const doc=parsed.data,p=doc.payload;
  requireRetention(Object.hasOwn(keys,doc.keyId)&&Object.keys(keys).length<=8,'engine_key_untrusted');let key;try{key=createPublicKey(keys[doc.keyId]!);}catch{throw Error('Protected retention operation refused.');}
  requireRetention(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from('flockletter.retention.engine-disposal.v1\0'+canonicalRetention(p)),key,Buffer.from(doc.signature,'base64url')),'engine_signature_invalid');
  requireRetention(sameRetentionScope(p.scope,scope)&&canonicalRetention(p.checkpoint)===canonicalRetention(checkpoint)&&expectedInstances.includes(p.instanceId)&&!seen.has(p.instanceId),'engine_receipt_scope_invalid');
  requireRetention(Date.parse(p.createdAt)<=now.getTime()+30000&&Date.parse(p.createdAt)>=now.getTime()-300000,'engine_receipt_stale');seen.add(p.instanceId);
 }
 return true;
}
