import {readFileSync} from 'node:fs';
import {pathToFileURL,URL} from 'node:url';
import process from 'node:process';
import console from 'node:console';

/**
 * Service metadata only: refuse to deploy unless the Render service is Flockletter staging.
 * Staging sleeps on Free compute, so an unreachable application (version === null) is accepted;
 * a reachable application that is not Flockletter staging is refused.
 */
export function stagingTargetMatches(input,{repository,stagingUrl,serviceId}) {
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  if(!object(input)||!object(input.web))return false;
  if(input.version!==null&&(!object(input.version)||input.version.appId!=='flockletter'||input.version.environment!=='staging'))return false;
  try {
    const url=new URL(stagingUrl);
    if(url.protocol!=='https:'||url.origin!==stagingUrl||url.username||url.password)return false;
  }catch{return false;}
  if(!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)||!/^srv-[a-z0-9]{20}$/.test(serviceId))return false;
  const {web}=input;
  return web.id===serviceId&&web.type==='web_service'&&web.repo===repository&&web.branch==='main'&&
    web.autoDeploy==='no'&&web.suspended==='not_suspended'&&web.serviceDetails?.url===stagingUrl;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const [repository,stagingUrl,serviceId,...rest]=process.argv.slice(2);
    if(rest.length)throw Error();
    if(!stagingTargetMatches(JSON.parse(readFileSync(0,'utf8')),{repository,stagingUrl,serviceId}))throw Error();
    console.log('Staging web destination verified.');
  }catch {console.error('Staging web destination verification failed.');process.exitCode=1;}
}
