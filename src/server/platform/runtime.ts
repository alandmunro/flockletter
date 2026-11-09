import type { Config } from '../config.js';
import type { Database } from '../db.js';
import type { Authenticator } from '../auth.js';
import { createHostedRetentionPlanner,readProtectedRetentionFile } from '../customer-retention/configuration.js';
import { retentionServiceEndSql } from '../customer-billing/service.js';
import { ResendSupportProvider } from '../customer-support/provider.js';
import { platformAlertsConfiguration } from './alerts-configuration.js';
import type { CustomerWorkflows } from '../customer-runtime.js';
import { OperatorStore } from './store.js';
import { platformIdentity } from './auth.js';
import { PlatformService } from './service.js';
export async function platformRuntime(config:Config,db:Database,auth:Authenticator,customer:CustomerWorkflows,env:NodeJS.ProcessEnv=process.env){
 const mode=env.FLOCKLETTER_PLATFORM_MODE??'off';
 if(mode==='off')return undefined;
 if(!['capture','live'].includes(mode)||mode==='capture'&&config.environment==='production')throw Error('Use explicit platform mode; synthetic controls are forbidden in production.');
 const selected=mode as 'capture'|'live';
 const alertConfiguration=platformAlertsConfiguration(env,selected);
 const store=new OperatorStore(db,selected,env.FLOCKLETTER_OPERATOR_DATABASE_URL);await store.verify();
 const identity=platformIdentity(config,auth,selected,env);
 const files=[env.FLOCKLETTER_RETENTION_PLANNER_CONFIG_FILE,env.FLOCKLETTER_RETENTION_PLANNER_DATABASE_FILE,env.FLOCKLETTER_RETENTION_INVENTORY_DIRECTORY];
 if(files.some(Boolean)&&(!files.every(Boolean)||selected!=='live'))throw Error('Hosted retention planning needs all protected files and verified live operator authority.');
 const planner=files.every(Boolean)?await createHostedRetentionPlanner({configFile:files[0]!,databaseFile:files[1]!,inventoryDirectory:files[2]!,serviceEnd:(sql,w)=>retentionServiceEndSql(sql,w,customer.billing.options)}):undefined;
 let signing:{keyId:string;privateKey:string}|undefined;
 if(env.FLOCKLETTER_RETENTION_SIGNING_ENABLED==='approved'){
  if(selected!=='live'||!planner||!env.FLOCKLETTER_RETENTION_SIGNING_KEY_ID||!env.FLOCKLETTER_RETENTION_SIGNING_PRIVATE_FILE)throw Error('Retention signing requires protected evidence and the separate operator identity.');
  signing={keyId:env.FLOCKLETTER_RETENTION_SIGNING_KEY_ID,privateKey:await readProtectedRetentionFile(env.FLOCKLETTER_RETENTION_SIGNING_PRIVATE_FILE)};
 }
 let alerts;
 if(alertConfiguration){
  alerts={provider:new ResendSupportProvider(alertConfiguration.sending,undefined,alertConfiguration.retrieval),
   from:alertConfiguration.from,to:alertConfiguration.to};
 }
 const platform=new PlatformService(db,store,{mode:selected,identity,support:customer.support,databaseName:new URL(config.databaseUrl!).pathname.slice(1),plan:planner?.plan,signing,alerts,gaps:selected==='capture'?['Workspace-only exercise. Global customer controls require a separate operator organization, restricted database role and recent MFA.','Hosted deletion needs configured protected checkpoint storage, exact external-copy inventory and a separate offline executor.','Live support and platform email notifications remain disabled until separately activated.']:['Hosted retention signing is disabled until protected evidence and the separate planner role are configured.']});
 customer.support.options.operatorAuthorized=(user,workspace,reference)=>platform.supportAuthorized(user,workspace,reference);
 if(customer.support.options.nativeInbound)customer.support.options.nativeInbound.onUnassigned=email=>platform.unassigned(email);
 customer.observe=status=>platform.observe(status.workspaceId,status.status);
 let monitoring=false;const timer=setInterval(()=>{if(monitoring)return;monitoring=true;void platform.monitor().catch(()=>console.error('Platform monitoring requires review.')).finally(()=>{monitoring=false;});},60000);timer.unref();
 const close=platform.close.bind(platform);platform.close=async()=>{clearInterval(timer);planner?.close();await close();};
 return platform;
}
