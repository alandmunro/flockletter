import {readFileSync} from 'node:fs';
import {pathToFileURL,URL} from 'node:url';
import process from 'node:process';
import console from 'node:console';

/** Service metadata only. This verifies deployment destinations, never credentials or queue liveness. */
export function productionTargetsMatch(input,{repository,productionUrl,webId,workerId}) {
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  if(!object(input)||!object(input.web)||!object(input.worker)||!object(input.version))return false;
  if(input.version.appId!=='flockletter'||input.version.environment!=='production')return false;
  const {web,worker}=input;
  try {
    const url=new URL(productionUrl);
    if(url.protocol!=='https:'||url.origin!==productionUrl||url.username||url.password)return false;
  }catch{return false;}
  if(!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)||
    !/^srv-[a-z0-9]{20}$/.test(webId)||!/^srv-[a-z0-9]{20}$/.test(workerId)||webId===workerId)return false;
  if(web.id!==webId||worker.id!==workerId||web.type!=='web_service'||worker.type!=='background_worker'||
    web.repo!==repository||worker.repo!==repository||web.branch!=='main'||worker.branch!=='main'||
    web.autoDeploy!=='no'||worker.autoDeploy!=='no'||web.suspended!=='not_suspended'||worker.suspended!=='not_suspended'||
    web.serviceDetails?.numInstances!==1||worker.serviceDetails?.numInstances!==1||
    web.serviceDetails?.url!==productionUrl||
    worker.serviceDetails?.envSpecificDetails?.startCommand!=='node dist/server/server/customer-worker-main.js')return false;
  for(const key of ['ownerId','environmentId'])if(typeof web[key]!=='string'||!web[key].trim()||web[key]!==worker[key])return false;
  const region=web.serviceDetails?.region;
  return typeof region==='string'&&!!region.trim()&&region===worker.serviceDetails?.region;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const [repository,productionUrl,webId,workerId]=process.argv.slice(2);
    if(!productionTargetsMatch(JSON.parse(readFileSync(0,'utf8')),{repository,productionUrl,webId,workerId}))throw Error();
    console.log('Production web and worker destinations verified; live operation and worker liveness remain separate checks.');
  }catch {console.error('Production web and worker destination verification failed.');process.exitCode=1;}
}
