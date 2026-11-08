/** Separate privileged operator process. Never imported by customer HTTP/MCP. */
import pg from 'pg';
import {z} from 'zod';
import {retentionServiceEndSql} from '../customer-billing/service.js';
import {ProtectedCheckpointStore} from './protected-store.js';
import {S3ExternalCopyStore} from './external-store.js';
import {readProtectedRetentionFile as protectedFile} from './configuration.js';
import {executeHostedRetention} from './operator.js';
import {RetentionIntegrationError,requireRetention} from './approval.js';
const keys=z.record(z.string(),z.string());
const configSchema=z.object({databaseName:z.string(),executorRole:z.string(),approvalKeys:keys,inventoryKeys:keys,engineKeys:keys,expectedEngineInstances:z.array(z.string()).min(1).max(100),checkpoint:z.object({accountId:z.string(),region:z.string(),bucket:z.string(),prefix:z.string(),minimumRetentionMs:z.number(),maxAgeMs:z.number(),publicKeys:keys}).strict(),stores:z.array(z.object({name:z.string(),accountId:z.string(),region:z.string(),bucket:z.string(),prefix:z.string()}).strict()).min(1).max(10)}).strict();
async function main(){
 requireRetention(process.argv.length===2,'arguments_forbidden');requireRetention(process.env.FLOCKLETTER_RETENTION_LIVE==='enabled','hosted_erasure_disabled');
 const config=configSchema.parse(JSON.parse(await protectedFile(process.env.FLOCKLETTER_RETENTION_CONFIG_FILE))),connection=(await protectedFile(process.env.FLOCKLETTER_RETENTION_DATABASE_FILE)).trim();
 const chunks:Buffer[]=[];let size=0;for await(const chunk of process.stdin){size+=Buffer.byteLength(chunk);requireRetention(size<=2097152,'input_too_large');chunks.push(Buffer.from(chunk));}
 const input=z.object({approval:z.unknown(),externalInventory:z.unknown(),engineReceipts:z.unknown()}).strict().parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
 const approval=z.object({payload:z.object({databaseName:z.string(),workspaceId:z.string(),jobId:z.string(),sourceVersion:z.string(),manifestDigest:z.string()})}).parse(input.approval).payload;
 const checkpointStore=new ProtectedCheckpointStore(config.checkpoint),stores=Object.fromEntries(config.stores.map(store=>[store.name,new S3ExternalCopyStore(store,approval)]));
 requireRetention(Object.keys(stores).length===config.stores.length,'duplicate_store_configuration');const db=new pg.Client({connectionString:connection,connectionTimeoutMillis:10000,statement_timeout:60000});
 try{await db.connect();const result=await executeHostedRetention(db,{...config,enabled:true,checkpointStore,stores,serviceEnd:(sql,w)=>retentionServiceEndSql(sql,w,{environment:'production',exerciseEnabled:false})},input);process.stdout.write(JSON.stringify({ok:true,erased:result.erased,replayed:result.replayed})+'\n');}
 finally{await db.end().catch(()=>{});checkpointStore.close();for(const store of Object.values(stores))store.close();}
}
main().catch(error=>{process.stderr.write(JSON.stringify({ok:false,code:error instanceof RetentionIntegrationError?error.code:'operator_verification_failed'})+'\n');process.exitCode=1;});
