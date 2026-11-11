import { createHash } from 'node:crypto';
import { S3Client, GetBucketVersioningCommand, GetObjectLockConfigurationCommand, GetObjectCommand, GetObjectRetentionCommand, HeadObjectCommand, ListObjectVersionsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { canonicalRetention, requireRetention, retentionDigest, verifyRetentionCheckpoint, RetentionIntegrationError, type RetentionPublicKeys } from './approval.js';
import type { CheckpointFacts, RetentionScope, SignedDocument, VerifiedCheckpoint } from './hosted-types.js';

const verified=new WeakSet<object>();
export function isProtectedCheckpoint(value:VerifiedCheckpoint){return verified.has(value);}
export type ProtectedStoreOptions={
  accountId:string;region:string;bucket:string;prefix:string;minimumRetentionMs:number;maxAgeMs:number;
  publicKeys:RetentionPublicKeys;credentials?:{accessKeyId:string;secretAccessKey:string;sessionToken?:string};
  client?:Pick<S3Client,'send'>;identity?:Pick<STSClient,'send'>;now?:()=>Date;
};
export class ProtectedCheckpointStore {
  private readonly client:Pick<S3Client,'send'>;
  private readonly identity:Pick<STSClient,'send'>;
  private readonly owned:S3Client|undefined;
  private readonly ownedIdentity:STSClient|undefined;
  constructor(readonly options:ProtectedStoreOptions){
    requireRetention(/^\d{12}$/.test(options.accountId)&&['us-east-1','us-east-2','us-west-1','us-west-2'].includes(options.region),'checkpoint_configuration_invalid');
    requireRetention(/^flockletter-[a-z0-9][a-z0-9-]{2,48}$/.test(options.bucket)&&/^retention\/[a-z0-9_-]{1,32}\/$/.test(options.prefix),'checkpoint_configuration_invalid');
    requireRetention(Number.isSafeInteger(options.minimumRetentionMs)&&options.minimumRetentionMs>=86400000&&options.minimumRetentionMs<=3650*86400000&&Number.isSafeInteger(options.maxAgeMs)&&options.maxAgeMs>=60000&&options.maxAgeMs<=86400000,'checkpoint_policy_invalid');
    this.client=options.client??(this.owned=new S3Client({region:options.region,credentials:options.credentials,maxAttempts:1,followRegionRedirects:false,requestHandler:{connectionTimeout:3000,requestTimeout:10000,socketTimeout:10000},endpoint:'https://s3.'+options.region+'.amazonaws.com'}));
    this.identity=options.identity??(this.ownedIdentity=new STSClient({region:options.region,credentials:options.credentials,maxAttempts:1,requestHandler:{connectionTimeout:3000,requestTimeout:10000,socketTimeout:10000},endpoint:'https://sts.'+options.region+'.amazonaws.com'}));
  }
  close(){this.owned?.destroy();this.ownedIdentity?.destroy();}
  key(scope:RetentionScope){return this.options.prefix+createHash('sha256').update(scope.databaseName+'\0'+scope.workspaceId).digest('hex')+'/checkpoint.json';}
  private async account(signal:AbortSignal){
    const owner=await this.identity.send(new GetCallerIdentityCommand({}),{abortSignal:signal});
    requireRetention(owner.Account===this.options.accountId,'checkpoint_account_mismatch');
    const base={Bucket:this.options.bucket,ExpectedBucketOwner:this.options.accountId};
    const versioning=await this.client.send(new GetBucketVersioningCommand(base),{abortSignal:signal});
    const lock=await this.client.send(new GetObjectLockConfigurationCommand(base),{abortSignal:signal});
    requireRetention(versioning.Status==='Enabled'&&lock.ObjectLockConfiguration?.ObjectLockEnabled==='Enabled','checkpoint_bucket_unprotected');
  }
  async load(scope:RetentionScope,expected?:{versionId:string;digest:string;sequence:number}):Promise<VerifiedCheckpoint>{
    const signal=AbortSignal.timeout(10000);await this.account(signal);
    const base={Bucket:this.options.bucket,Key:this.key(scope),ExpectedBucketOwner:this.options.accountId};
    const object=await this.client.send(new GetObjectCommand(base),{abortSignal:signal});
    requireRetention(object.VersionId&&object.VersionId!=='null'&&!object.DeleteMarker&&object.ContentLength!==undefined&&object.ContentLength>0&&object.ContentLength<=1048576&&object.Body,'checkpoint_object_invalid');
    requireRetention(Symbol.asyncIterator in object.Body,'checkpoint_object_invalid');
    const chunks:Buffer[]=[];let size=0;for await(const chunk of object.Body as AsyncIterable<Uint8Array>){size+=chunk.length;requireRetention(size<=1048576,'checkpoint_object_invalid');chunks.push(Buffer.from(chunk));}const bytes=Buffer.concat(chunks);requireRetention(bytes.length===object.ContentLength,'checkpoint_object_invalid');
    let raw:unknown;try{raw=JSON.parse(Buffer.from(bytes).toString('utf8'));}catch{throw new RetentionIntegrationError('checkpoint_object_invalid');}
    const document=verifyRetentionCheckpoint(raw,this.options.publicKeys),facts=document.payload,now=this.options.now?.()??new Date();
    requireRetention(facts.scope.databaseName===scope.databaseName&&facts.scope.workspaceId===scope.workspaceId,'checkpoint_scope_mismatch');
    requireRetention(facts.erasedWorkspaces.every(w=>w===scope.workspaceId)&&new Set(facts.suppressions.map(s=>s.brandId+'\0'+s.subscriberId)).size===facts.suppressions.length,'checkpoint_scope_mismatch');
    const age=now.getTime()-Date.parse(facts.createdAt);requireRetention(age>=-30000&&age<=this.options.maxAgeMs,'checkpoint_stale');
    const ref={versionId:object.VersionId,digest:retentionDigest(document),sequence:facts.sequence};
    if(expected)requireRetention(canonicalRetention(expected)===canonicalRetention(ref),'checkpoint_version_changed');
    const retention=await this.client.send(new GetObjectRetentionCommand({...base,VersionId:object.VersionId}),{abortSignal:signal});
    requireRetention(retention.Retention?.Mode==='COMPLIANCE'&&retention.Retention.RetainUntilDate&&retention.Retention.RetainUntilDate.getTime()>=now.getTime()+this.options.minimumRetentionMs,'checkpoint_retention_insufficient');
    const result:VerifiedCheckpoint={reference:ref,facts,verifiedAt:now.toISOString(),retainUntil:retention.Retention.RetainUntilDate.toISOString()};verified.add(result);return result;
  }
  async publish(document:SignedDocument<CheckpointFacts>,previous:{versionId:string;digest:string;sequence:number}|null){
    const checked=verifyRetentionCheckpoint(document,this.options.publicKeys),scope=checked.payload.scope,signal=AbortSignal.timeout(15000),now=this.options.now?.()??new Date();
    const signedAt=Date.parse(checked.payload.createdAt), age=now.getTime()-signedAt;
    requireRetention(age>=-30000&&age<=this.options.maxAgeMs,'checkpoint_stale');
    // Keep the full remaining lock through the last valid read.
    const retainUntil=new Date(signedAt+this.options.maxAgeMs+this.options.minimumRetentionMs+60000);
    await this.account(signal);let etag:string|undefined;
    if(previous){const current=await this.load(scope,previous);requireRetention(current.facts.sequence+1===checked.payload.sequence,'checkpoint_sequence_invalid');const object=await this.client.send(new HeadObjectCommand({Bucket:this.options.bucket,Key:this.key(scope),ExpectedBucketOwner:this.options.accountId}),{abortSignal:signal});requireRetention(object.VersionId===previous.versionId&&object.ETag,'checkpoint_version_changed');etag=object.ETag;}
    else {requireRetention(checked.payload.sequence===1,'checkpoint_sequence_invalid');const history=await this.client.send(new ListObjectVersionsCommand({Bucket:this.options.bucket,Prefix:this.key(scope),MaxKeys:1,ExpectedBucketOwner:this.options.accountId}),{abortSignal:signal});requireRetention(!(history.Versions?.length||history.DeleteMarkers?.length),'checkpoint_history_exists');}
    const bytes=Buffer.from(canonicalRetention(checked)),digest=createHash('sha256').update(bytes).digest('base64');
    // Conditional writes prevent replacing a concurrent checkpoint. An unknown response is reconciled by load, never a blind Put retry.
    const result=await this.client.send(new PutObjectCommand({Bucket:this.options.bucket,Key:this.key(scope),ExpectedBucketOwner:this.options.accountId,Body:bytes,ContentType:'application/json',ChecksumSHA256:digest,ObjectLockMode:'COMPLIANCE',ObjectLockRetainUntilDate:retainUntil,...(etag?{IfMatch:etag}:{IfNoneMatch:'*'})}),{abortSignal:signal});
    requireRetention(result.VersionId&&result.VersionId!=='null','checkpoint_object_invalid');
    return this.load(scope,{versionId:result.VersionId,digest:retentionDigest(checked),sequence:checked.payload.sequence});
  }
}
