import {createHash} from 'node:crypto';
import {S3Client,ListObjectVersionsCommand,HeadObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {STSClient,GetCallerIdentityCommand} from '@aws-sdk/client-sts';
import pg from 'pg';
import {requireRetention,retentionDigest,RetentionIntegrationError} from './approval.js';
import type {ExternalCopy,ExternalCopyDriver,ExternalCopyState,RetentionApprovalPayload,RetentionScope,VerifiedExternalInventory} from './hosted-types.js';
import {isVerifiedExternalInventory} from './hosted.js';

export type ExternalS3Options={name:string;accountId:string;region:string;bucket:string;prefix:string;credentials?:{accessKeyId:string;secretAccessKey:string;sessionToken?:string};client?:Pick<S3Client,'send'>;identity?:Pick<STSClient,'send'>};
export class S3ExternalCopyStore implements ExternalCopyDriver {
 private client:Pick<S3Client,'send'>;private identity:Pick<STSClient,'send'>;private owned?:S3Client;private ownedIdentity?:STSClient;
 constructor(readonly options:ExternalS3Options,readonly scope:RetentionScope){
  requireRetention(/^[a-z][a-z0-9_-]{1,31}$/.test(options.name)&&/^\d{12}$/.test(options.accountId)&&['us-east-1','us-east-2','us-west-1','us-west-2'].includes(options.region)&&/^flockletter-[a-z0-9][a-z0-9-]{2,48}$/.test(options.bucket)&&/^customer-copies\/[a-z0-9_-]{1,32}\/$/.test(options.prefix),'external_configuration_invalid');
  this.client=options.client??(this.owned=new S3Client({region:options.region,credentials:options.credentials,maxAttempts:1,followRegionRedirects:false,requestHandler:{connectionTimeout:3000,requestTimeout:10000,socketTimeout:10000},endpoint:'https://s3.'+options.region+'.amazonaws.com'}));this.identity=options.identity??(this.ownedIdentity=new STSClient({region:options.region,credentials:options.credentials,maxAttempts:1,requestHandler:{connectionTimeout:3000,requestTimeout:10000,socketTimeout:10000},endpoint:'https://sts.'+options.region+'.amazonaws.com'}));
 }
 close(){this.owned?.destroy();this.ownedIdentity?.destroy();}
 prefix(){return this.options.prefix+createHash('sha256').update(this.scope.databaseName+'\0'+this.scope.workspaceId).digest('hex')+'/';}
 private base(){return {Bucket:this.options.bucket,ExpectedBucketOwner:this.options.accountId};}
 private valid(copy:ExternalCopy){requireRetention(copy.store===this.options.name&&copy.key.startsWith(this.prefix())&&copy.versionId&&copy.versionId!=='null'&&['s3_object','s3_marker'].includes(copy.kind),'external_copy_scope_invalid');}
 async inventory(signal=AbortSignal.timeout(15000)):Promise<Array<{key:string;versionId:string;kind:'s3_object'|'s3_marker'}>>{
  requireRetention((await this.identity.send(new GetCallerIdentityCommand({}),{abortSignal:signal})).Account===this.options.accountId,'external_account_mismatch');
  const all:Array<{key:string;versionId:string;kind:'s3_object'|'s3_marker'}>=[];let keyMarker:string|undefined,versionMarker:string|undefined;
  for(let page=0;page<20;page++){
   const result=await this.client.send(new ListObjectVersionsCommand({...this.base(),Prefix:this.prefix(),MaxKeys:100,KeyMarker:keyMarker,VersionIdMarker:versionMarker}),{abortSignal:signal});
   for(const [entries,kind] of [[result.Versions,'s3_object'],[result.DeleteMarkers,'s3_marker']] as const)for(const item of entries??[]){requireRetention(item.Key?.startsWith(this.prefix())&&item.VersionId&&item.VersionId!=='null','external_versioning_required');all.push({key:item.Key!,versionId:item.VersionId!,kind});}
   requireRetention(all.length<=1000,'external_inventory_limit');if(!result.IsTruncated)return all;
   requireRetention(result.NextKeyMarker&&(result.NextKeyMarker!==keyMarker||result.NextVersionIdMarker!==versionMarker),'external_pagination_invalid');keyMarker=result.NextKeyMarker;versionMarker=result.NextVersionIdMarker;
  }
  throw new RetentionIntegrationError('external_inventory_limit');
 }
 async verifyRemaining(copies:ExternalCopy[],signal=AbortSignal.timeout(15000)){
  const listed=await this.inventory(signal),allowed=new Set(copies.map(c=>{this.valid(c);return c.kind+'\0'+c.key+'\0'+c.versionId;}));
  requireRetention(listed.every(c=>allowed.has(c.kind+'\0'+c.key+'\0'+c.versionId)),'external_inventory_changed');
 }
 async verifyComplete(copies:ExternalCopy[],signal=AbortSignal.timeout(15000)){
  const listed=await this.inventory(signal);const identity=(c:{key:string;versionId:string|null;kind:string})=>c.kind+'\0'+c.key+'\0'+c.versionId;
  requireRetention(retentionDigest(listed.map(identity).sort())===retentionDigest(copies.map(c=>{this.valid(c);return identity(c);}).sort()),'external_inventory_changed');
  for(const copy of copies)requireRetention(await this.inspect(copy,signal)==='present','external_copy_unverified');
 }
 async inspect(copy:ExternalCopy,signal:AbortSignal):Promise<ExternalCopyState>{
  this.valid(copy);
  try{
   if(copy.kind==='s3_marker'){const found=(await this.inventory(signal)).some(c=>c.key===copy.key&&c.versionId===copy.versionId&&c.kind===copy.kind);return found?(copy.digest===retentionDigest({key:copy.key,versionId:copy.versionId,kind:copy.kind})?'present':'blocked'):'absent';}
   const result=await this.client.send(new HeadObjectCommand({...this.base(),Key:copy.key,VersionId:copy.versionId!,ChecksumMode:'ENABLED'}),{abortSignal:signal});
   if(result.VersionId!==copy.versionId||!result.ChecksumSHA256)return 'blocked';
   return Buffer.from(result.ChecksumSHA256,'base64').toString('hex')===copy.digest?'present':'blocked';
  }catch(error){const code=(error as {name?:string;$metadata?:{httpStatusCode?:number}});if(code.name==='NoSuchVersion'||code.name==='NotFound'&&code.$metadata?.httpStatusCode===404)return 'absent';return 'unknown';}
 }
 async erase(copy:ExternalCopy,_operationKey:string,signal:AbortSignal):Promise<ExternalCopyState>{
  this.valid(copy);try{await this.client.send(new DeleteObjectCommand({...this.base(),Key:copy.key,VersionId:copy.versionId!}),{abortSignal:signal});return this.inspect(copy,signal);}catch{return 'unknown';}
 }
}
export async function disposeExternalCopies(db:pg.Client,approval:RetentionApprovalPayload,approvalDigest:string,inventory:VerifiedExternalInventory,drivers:Readonly<Record<string,ExternalCopyDriver>>,recheck:()=>Promise<void>){
 requireRetention(approval.mode==='live'&&isVerifiedExternalInventory(inventory)&&approval.externalInventoryDigest===inventory.digest,'external_approval_invalid');
 for(const copy of inventory.facts.copies){
  requireRetention(Object.hasOwn(drivers,copy.store),'external_store_unconfigured');const driver=drivers[copy.store]!;
  const targetDigest=retentionDigest(copy),operationKey=retentionDigest({database:approval.databaseName,workspace:approval.workspaceId,job:approval.jobId,targetDigest});
  await db.query(`INSERT INTO flockletter_retention_control.operations(operation_key,workspace_id,job_id,approval_digest,target_digest,target,state) VALUES($1,$2,$3,$4,$5,$6,'pending') ON CONFLICT(operation_key) DO NOTHING`,[operationKey,approval.workspaceId,approval.jobId,approvalDigest,targetDigest,copy]);
  // A row lock plus session advisory lock prevents two operators from submitting the same durable intent.
  await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[operationKey]);
  try{
   const row=(await db.query('SELECT * FROM flockletter_retention_control.operations WHERE operation_key=$1',[operationKey])).rows[0];
   requireRetention(row&&row.target_digest===targetDigest&&row.approval_digest===approvalDigest,'external_intent_conflict');
   let state=await driver.inspect(copy,AbortSignal.timeout(15000));
   if(state==='absent'){await db.query("UPDATE flockletter_retention_control.operations SET state='complete',target='{}'::jsonb,result_digest=$2,updated_at=now() WHERE operation_key=$1",[operationKey,retentionDigest({targetDigest,state})]);continue;}
   // A lost response is never submitted a second time, even if the old object is still visible. Operator reconciliation is required.
   requireRetention(row.state==='pending'&&state==='present','external_reconciliation_required');
   await recheck();requireRetention(Date.parse(approval.expiresAt)>Date.now(),'approval_expired');
   await db.query("UPDATE flockletter_retention_control.operations SET state='submitting',updated_at=now() WHERE operation_key=$1",[operationKey]);
   try{state=await driver.erase(copy,operationKey,AbortSignal.timeout(15000));}catch{state='unknown';}
   await db.query("UPDATE flockletter_retention_control.operations SET state=$2,target=CASE WHEN $2='complete' THEN '{}'::jsonb ELSE target END,result_digest=$3,updated_at=now() WHERE operation_key=$1",[operationKey,state==='absent'?'complete':state==='blocked'?'blocked':'unknown',retentionDigest({targetDigest,state})]);
   requireRetention(state==='absent','external_reconciliation_required');
  }finally{await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[operationKey]);}
 }
}
