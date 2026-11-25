import { fixtureLot } from './helpers/gift-retention.js';
import { entry, put } from '../src/server/workspace-gifts/store.js';
import { giftRetentionArchive } from '../src/server/workspace-gifts/retention.js';
import {spawnSync} from 'node:child_process';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {Readable} from 'node:stream';
import pg from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {S3Client} from '@aws-sdk/client-s3';
import type {STSClient} from '@aws-sdk/client-sts';
import {startDatabase} from '../scripts/database-fixture.js';
import {Database} from '../src/server/db.js';
import {CommandService,type Actor} from '../src/server/service.js';
import {CustomerRetention,retentionManifestDigest} from '../src/server/customer-retention/index.js';
import {signRetentionApproval,signRetentionCheckpoint,signExternalInventory,canonicalRetention} from '../src/server/customer-retention/approval.js';
import {ProtectedCheckpointStore} from '../src/server/customer-retention/protected-store.js';
import {verifiedExternalInventory,planHostedRetention} from '../src/server/customer-retention/hosted.js';
import {S3ExternalCopyStore} from '../src/server/customer-retention/external-store.js';
import {executeHostedRetention} from '../src/server/customer-retention/operator.js';
let fixture:Awaited<ReturnType<typeof startDatabase>>,db:Database,admin:pg.Client;
beforeAll(async()=>{fixture=await startDatabase();db=new Database(fixture.url);admin=new pg.Client({connectionString:fixture.adminUrl});await admin.connect();});afterAll(async()=>{await db?.close();await admin?.end();await fixture?.stop();});
async function owner(){const actor:Actor={workspaceId:'org_'+randomUUID().replaceAll('-',''),userId:'user_'+randomUUID().replaceAll('-',''),actorId:'test',owner:true,kind:'session',scopes:['read'],brandIds:null};await new CommandService(db).execute('workspace.initialize',{operationKey:randomUUID(),name:'Synthetic retention',brandName:'Fixture'},actor);return actor;}
it('runs the complete signed hosted protocol only against an isolated synthetic database and preserves another workspace',async()=>{
 const actor=await owner(),other=await owner(),now=new Date(),fact={source:'stripe' as const,status:'canceled',effectiveEnd:new Date(now.getTime()-91*86400000).toISOString(),version:'synthetic-stripe-version'};
 const giftException = await db.tenant(actor.workspaceId,async sql => {
   const w = actor.workspaceId, brand = (await sql.query('SELECT id FROM brands')).rows[0].id;
   const lot = fixtureLot(brand,now,{state:'refunded',returned:1100,refundId:'re_fixture'});
   await put(sql,w,'lot',lot.id,lot);
   for (const [kind,amount] of [['purchased',1000],['refunded',1100]] as const)
     await entry(sql,w,kind+':'+lot.id,{kind,amount,brand,at:now.toISOString(),ref:lot.id});
   return (await giftRetentionArchive(sql,w,now)).exception!;
 });
 // This fixture supplies a synthetic billing fact. It is not live Stripe verification.
 const retention=new CustomerRetention(db,{mode:'capture',isOwner:async()=>true,serviceEnd:async()=>fact,serviceEndSql:async()=>fact,now:()=>now});const inspected=await retention.execute('retention.inspect',{operationKey:randomUUID()},actor) as Awaited<ReturnType<CustomerRetention['status']>>,c=inspected.cases[0]!;
 const requested=await retention.execute('retention.request',{operationKey:randomUUID(),id:c.id,expectedVersion:c.version,inventoryDigest:c.inventoryDigest},actor) as typeof inspected,job=requested.jobs[0]!;
 const planner='flockletter_plan_'+randomUUID().replaceAll('-','').slice(0,8),executor='flockletter_erase_'+randomUUID().replaceAll('-','').slice(0,8);for(const role of [planner,executor])await admin.query('CREATE ROLE '+pg.escapeIdentifier(role)+' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS');const grants=spawnSync(process.execPath,['--import','tsx','scripts/retention-operator-grants.ts'],{encoding:'utf8',env:{...process.env,FLOCKLETTER_RETENTION_DATABASE_NAME:'flockletter_test',FLOCKLETTER_RETENTION_RUNTIME_ROLE:'flockletter_runtime',FLOCKLETTER_RETENTION_PLANNER_ROLE:planner,FLOCKLETTER_RETENTION_EXECUTOR_ROLE:executor}});expect(grants.status).toBe(0);await admin.query(grants.stdout);
 const key=generateKeyPairSync('ed25519'),privatePem=key.privateKey.export({type:'pkcs8',format:'pem'}).toString(),publicPem=key.publicKey.export({type:'spki',format:'pem'}).toString(),keys={test:publicPem},scope={databaseName:'flockletter_test',workspaceId:actor.workspaceId,jobId:job.id,sourceVersion:fact.version,manifestDigest:retentionManifestDigest()};
 const checkpointDoc=signRetentionCheckpoint({version:1,mode:'live',sequence:1,phase:'quarantined',scope,createdAt:now.toISOString(),erasedWorkspaces:[],suppressions:[]},privatePem,'test'),bytes=Buffer.from(canonicalRetention(checkpointDoc));
 const client={send:async(command:{constructor:{name:string}})=>{switch(command.constructor.name){case'GetBucketVersioningCommand':return {Status:'Enabled'};case'GetObjectLockConfigurationCommand':return {ObjectLockConfiguration:{ObjectLockEnabled:'Enabled'}};case'GetObjectCommand':return {VersionId:'v1',ContentLength:bytes.length,Body:Readable.from([bytes])};case'GetObjectRetentionCommand':return {Retention:{Mode:'COMPLIANCE',RetainUntilDate:new Date(now.getTime()+2*86400000)}};case'ListObjectVersionsCommand':return {Versions:[],DeleteMarkers:[],IsTruncated:false};default:throw Error('Unexpected provider mutation');}}} as unknown as Pick<S3Client,'send'>,identity={send:async()=>({Account:'123456789012'})} as unknown as Pick<STSClient,'send'>;
 const checkpointStore=new ProtectedCheckpointStore({accountId:'123456789012',region:'us-east-1',bucket:'flockletter-retention',prefix:'retention/test/',minimumRetentionMs:86400000,maxAgeMs:300000,publicKeys:keys,client,identity,now:()=>now}),externalDoc=signExternalInventory({version:1,mode:'live',scope,revision:1,createdAt:now.toISOString(),copies:[],exceptions:[giftException]},privatePem,'test'),inventory=verifiedExternalInventory(externalDoc,keys,scope,'live',now);
 await admin.query('SET ROLE '+pg.escapeIdentifier(planner));let plan;try{
  await expect(admin.query("INSERT INTO flockletter_retention_control.gift_accounting(event_day,kind,face_minor,fee_minor,currency) VALUES(current_date,'claimed',1,0,'USD')")).rejects.toMatchObject({code:'42501'});
  const missing = verifiedExternalInventory(signExternalInventory({...externalDoc.payload,exceptions:[]},privatePem,'test'),keys,scope,'live',now);
  await expect(planHostedRetention(admin,{databaseName:'flockletter_test',serviceEnd:async()=>fact,now:()=>now},
    {workspaceId:actor.workspaceId,jobId:job.id},{checkpoint:await checkpointStore.load(scope),inventory:missing})).rejects.toMatchObject({code:'private_exception_review_required'});
  plan=await planHostedRetention(admin,{databaseName:'flockletter_test',serviceEnd:async()=>fact,now:()=>now},{workspaceId:actor.workspaceId,jobId:job.id},{checkpoint:await checkpointStore.load(scope),inventory});}finally{await admin.query('RESET ROLE');}
 await expect(db.pool.query('SELECT * FROM flockletter_retention_control.gift_accounting')).rejects.toMatchObject({code:'42501'});
 const receiptPayload={version:1,scope,checkpoint:plan.checkpoint,instanceId:'synthetic_host',bootId:randomUUID(),createdAt:now.toISOString(),quiesced:true,processStopped:true,ownedDirectoriesRemoved:true},engineReceipts=[{keyId:'test',payload:receiptPayload,signature:sign(null,Buffer.from('flockletter.retention.engine-disposal.v1\0'+canonicalRetention(receiptPayload)),key.privateKey).toString('base64url')}];
 const options={databaseName:'flockletter_test',executorRole:executor,enabled:true,serviceEnd:async()=>fact,now:()=>now,approvalKeys:keys,inventoryKeys:keys,engineKeys:keys,expectedEngineInstances:['synthetic_host'],checkpointStore,stores:{media:new S3ExternalCopyStore({name:'media',accountId:'123456789012',region:'us-east-1',bucket:'flockletter-content',prefix:'customer-copies/test/',client,identity},scope)}};
 const payload={...plan,version:1 as const,mode:'live' as const,nonce:randomUUID(),operatorId:'user_operator',issuedAt:now.toISOString(),expiresAt:new Date(now.getTime()+600000).toISOString()};await admin.query('SET ROLE '+pg.escapeIdentifier(executor));try{
  await expect(executeHostedRetention(admin,options,{approval:signRetentionApproval({...payload,mode:'capture'},privatePem,'test'),externalInventory:externalDoc,engineReceipts})).rejects.toMatchObject({code:'approval_mode_invalid'});
  const rights = (await admin.query(`SELECT has_table_privilege(current_user,'flockletter_retention_control.gift_accounting','INSERT') append,
   has_table_privilege(current_user,'flockletter_retention_control.gift_accounting','DELETE') remove`)).rows[0];
 expect(rights).toEqual({append:true,remove:false});
 const input={approval:signRetentionApproval(payload,privatePem,'test'),externalInventory:externalDoc,engineReceipts};expect(await executeHostedRetention(admin,options,input)).toMatchObject({erased:true,replayed:false});expect(await executeHostedRetention(admin,options,input)).toMatchObject({erased:true,replayed:true});
 }finally{await admin.query('RESET ROLE');}
 const archived = (await admin.query('SELECT * FROM flockletter_retention_control.gift_accounting ORDER BY kind')).rows;
 expect(archived).toHaveLength(2);
 expect(Object.keys(archived[0]).sort()).toEqual(['currency','event_day','expires_on','face_minor','fee_minor','kind']);
 expect(archived.map(r=>[r.kind,r.face_minor,r.fee_minor,r.currency])).toEqual([
   ['purchased','1000','100','USD'],['refunded','1000','100','USD']]);
 await admin.query("INSERT INTO flockletter_retention_control.gift_accounting(event_day,kind,face_minor,fee_minor,currency) VALUES(CURRENT_DATE-interval '8 years','claimed',100,0,'USD')");
 await admin.query('SET ROLE '+pg.escapeIdentifier(executor));
 try { expect((await admin.query('SELECT flockletter_retention_control.expire_gift_accounting() n')).rows[0].n).toBe('1'); }
 finally { await admin.query('RESET ROLE'); }
 expect((await admin.query('SELECT count(*) n FROM flockletter_retention_control.gift_accounting')).rows[0].n).toBe('2');
 await expect(new CommandService(db).execute('workspace.get',{},actor)).rejects.toMatchObject({code:'workspace_retention_blocked'});expect(await new CommandService(db).execute('workspace.get',{},other)).toHaveProperty('name','Synthetic retention');expect((await admin.query('SELECT count(*) n FROM workspaces WHERE workspace_id=$1',[actor.workspaceId])).rows[0].n).toBe('0');
});
