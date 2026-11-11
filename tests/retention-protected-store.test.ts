import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {expect,it} from 'vitest';
import type {S3Client} from '@aws-sdk/client-s3';
import type {STSClient} from '@aws-sdk/client-sts';
import {ProtectedCheckpointStore} from '../src/server/customer-retention/protected-store.js';
import {signRetentionCheckpoint,retentionDigest,canonicalRetention} from '../src/server/customer-retention/approval.js';
const key=generateKeyPairSync('ed25519'),privatePem=key.privateKey.export({type:'pkcs8',format:'pem'}).toString(),publicPem=key.publicKey.export({type:'spki',format:'pem'}).toString();
const now=new Date('2026-11-08T16:00:00Z'),scope={databaseName:'flockletter_test',workspaceId:'org_workspace',jobId:randomUUID(),sourceVersion:'closure1',manifestDigest:'a'.repeat(64)};
function fixture(overrides:{version?:string;age?:number;mode?:'COMPLIANCE'|'GOVERNANCE';owner?:string;mutate?:boolean}={}){
 const document=signRetentionCheckpoint({version:1,mode:'live',sequence:1,phase:'quarantined',scope,createdAt:new Date(now.getTime()-(overrides.age??0)).toISOString(),erasedWorkspaces:[],suppressions:[]},privatePem,'seal');if(overrides.mutate)document.payload.phase='released';const bytes=Buffer.from(canonicalRetention(document)),calls:Array<{name:string;input:Record<string,unknown>}>=[];
 const client={send:async(command:{constructor:{name:string};input:Record<string,unknown>})=>{calls.push({name:command.constructor.name,input:command.input});switch(command.constructor.name){case'GetBucketVersioningCommand':return {Status:'Enabled'};case'GetObjectLockConfigurationCommand':return {ObjectLockConfiguration:{ObjectLockEnabled:'Enabled'}};case'GetObjectCommand':return {VersionId:overrides.version??'v1',ContentLength:bytes.length,Body:Readable.from([bytes])};case'GetObjectRetentionCommand':return {Retention:{Mode:overrides.mode??'COMPLIANCE',RetainUntilDate:new Date(now.getTime()+2*86400000)}};default:throw Error('Unexpected AWS operation');}}} as unknown as Pick<S3Client,'send'>;
 const identity={send:async()=>({Account:overrides.owner??'123456789012'})} as unknown as Pick<STSClient,'send'>;
 return {store:new ProtectedCheckpointStore({accountId:'123456789012',region:'us-east-1',bucket:'flockletter-retention',prefix:'retention/test/',minimumRetentionMs:86400000,maxAgeMs:300000,publicKeys:{seal:publicPem},client,identity,now:()=>now}),document,calls};
}
it('reads latest signed immutable checkpoint with exact account, version and retention proof',async()=>{const f=fixture(),result=await f.store.load(scope,{versionId:'v1',digest:retentionDigest(f.document),sequence:1});expect(result.facts.phase).toBe('quarantined');expect(f.calls.every(c=>c.input.ExpectedBucketOwner==='123456789012')).toBe(true);expect(f.calls.find(c=>c.name==='GetObjectCommand')?.input.VersionId).toBeUndefined();expect(f.calls.find(c=>c.name==='GetObjectRetentionCommand')?.input.VersionId).toBe('v1');});
it('refuses stale checkpoints, changed versions, wrong owners, tampered seals, and governance locks',async()=>{for(const override of [{age:300001},{owner:'999999999999'},{mutate:true},{mode:'GOVERNANCE' as const}])await expect(fixture(override).store.load(scope)).rejects.toThrow();const f=fixture({version:'v2'});await expect(f.store.load(scope,{versionId:'v1',digest:retentionDigest(f.document),sequence:1})).rejects.toThrow();});
it('refuses arbitrary provider endpoints and unprotected bucket/prefix config',()=>{const f=fixture();expect(()=>new ProtectedCheckpointStore({...f.store.options,prefix:'../other/'})).toThrow();expect(()=>new ProtectedCheckpointStore({...f.store.options,bucket:'shared-bucket'})).toThrow();expect(()=>new ProtectedCheckpointStore({...f.store.options,region:'custom-endpoint'})).toThrow();});

it.each([['flockletter_test',1],['flockletter_production',14]] as const)('preserves the remaining lock through the last fresh read for %s',async(databaseName,days)=>{
 const {store,document}=fixture();
 let clock=now;
 let retainUntil:Date|undefined;
 let bytes=Buffer.alloc(0);
 const backend=store.options.client!;
 const client={send:async(command:{constructor:{name:string};input:{ObjectLockRetainUntilDate?:Date;Body?:Uint8Array}})=>{
   switch(command.constructor.name){
     case 'ListObjectVersionsCommand': return {};
     case 'GetObjectCommand': return {VersionId:'v1',ContentLength:bytes.length,Body:Readable.from([bytes])};
     case 'PutObjectCommand': bytes=Buffer.from(command.input.Body!);retainUntil=command.input.ObjectLockRetainUntilDate;return {VersionId:'v1'};
     case 'GetObjectRetentionCommand': return {Retention:{Mode:'COMPLIANCE',RetainUntilDate:retainUntil}};
     default: return backend.send(command as never);
   }
 }} as unknown as Pick<S3Client,'send'>;
 const publisher=new ProtectedCheckpointStore({...store.options,client,now:()=>clock});
 const checkpointScope={...scope,databaseName};
 const signed=signRetentionCheckpoint({...document.payload,scope:checkpointScope},privatePem,'seal');
 await publisher.publish(signed,null);
 expect(retainUntil?.getTime()).toBe(now.getTime()+store.options.maxAgeMs+days*86400000+60000);
 clock=new Date(now.getTime()+store.options.maxAgeMs);
 await expect(publisher.load(checkpointScope)).resolves.toHaveProperty('reference.sequence',1);
 clock=new Date(clock.getTime()+1);
 await expect(publisher.load(checkpointScope)).rejects.toMatchObject({code:'checkpoint_stale'});
});
