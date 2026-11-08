import {open,stat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {z} from 'zod';
import {verifyRetentionIdentity} from './identity.js';
import {requireRetention,verifyExternalInventory,type RetentionPublicKeys} from './approval.js';
import {ProtectedCheckpointStore} from './protected-store.js';
import {planHostedRetention,verifiedExternalInventory,type HostedPlanOptions} from './hosted.js';
export async function readProtectedRetentionFile(file:string|undefined){
 requireRetention(file&&path.isAbsolute(file),'protected_file_required');requireRetention(await realpath(file)===file,'protected_file_symlink');
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const info=await handle.stat();requireRetention(info.isFile()&&info.size>0&&info.size<=2097152&&(info.mode&0o077)===0&&info.uid===process.getuid?.(),'protected_file_permissions');const buffer=Buffer.alloc(2097153);let length=0;while(length<buffer.length){const read=await handle.read(buffer,length,buffer.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead;}requireRetention(length>0&&length<=2097152,'protected_file_size');return buffer.subarray(0,length).toString('utf8');}finally{await handle.close();}
}
const keys=z.record(z.string(),z.string());
const plannerConfig=z.object({databaseName:z.string(),plannerRole:z.string(),inventoryKeys:keys,checkpoint:z.object({accountId:z.string(),region:z.string(),bucket:z.string(),prefix:z.string(),minimumRetentionMs:z.number(),maxAgeMs:z.number(),publicKeys:keys}).strict()}).strict();
/** Called only by the separate operator process. Its DB identity cannot erase or authorize. */
export async function createHostedRetentionPlanner(options:{configFile:string;databaseFile:string;inventoryDirectory:string;serviceEnd:HostedPlanOptions['serviceEnd'];now?:()=>Date}){
 const config=plannerConfig.parse(JSON.parse(await readProtectedRetentionFile(options.configFile))),connection=(await readProtectedRetentionFile(options.databaseFile)).trim();
 requireRetention(path.isAbsolute(options.inventoryDirectory)&&await realpath(options.inventoryDirectory)===options.inventoryDirectory,'inventory_directory_invalid');const directory=await stat(options.inventoryDirectory);requireRetention(directory.isDirectory()&&(directory.mode&0o077)===0&&directory.uid===process.getuid?.(),'inventory_directory_invalid');
 const store=new ProtectedCheckpointStore({...config.checkpoint,now:options.now});
 return {close:()=>store.close(),plan:async(workspaceId:string,jobId:string)=>{
  const filename=createHash('sha256').update(config.databaseName+'\0'+workspaceId+'\0'+jobId).digest('hex')+'.json';
  const raw:unknown=JSON.parse(await readProtectedRetentionFile(path.join(options.inventoryDirectory,filename))),signed=verifyExternalInventory(raw,config.inventoryKeys as RetentionPublicKeys),scope=signed.payload.scope;
  requireRetention(scope.databaseName===config.databaseName&&scope.workspaceId===workspaceId&&scope.jobId===jobId,'external_scope_mismatch');
  const now=options.now?.()??new Date(),inventory=verifiedExternalInventory(raw,config.inventoryKeys,scope,'live',now),checkpoint=await store.load(scope);
  const db=new pg.Client({connectionString:connection,connectionTimeoutMillis:10000,statement_timeout:60000});
  try{await db.connect();await verifyRetentionIdentity(db,config.databaseName,config.plannerRole,'planner');
   return await planHostedRetention(db,{databaseName:config.databaseName,serviceEnd:options.serviceEnd,now:options.now},{workspaceId,jobId},{checkpoint,inventory});
  }finally{await db.end().catch(()=>{});}
 }};
}
