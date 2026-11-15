import process from 'node:process';
import {setTimeout,clearTimeout} from 'node:timers';
// Fixed dispatch and owner-private files replace interactive credential pasting.
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {releaseOperations,releaseInputPreflight} from './release-input.mjs';
import {createReleasePlan,releaseRoot,releaseSourceFingerprint,releasePlanGaps,releasePlanDigest,privateEnvelopeGaps,readProtectedReleaseFile} from './release-plan.mjs';

const safeFileErrors=new Set(['protected_file_required','protected_file_symlink','protected_directory_permissions','protected_ancestor_permissions','protected_file_permissions','protected_file_size','release_source_invalid']);
const failure=(stage,codes)=>({ok:false,stage,codes});
function parsePrivateJson(text){try{return JSON.parse(text);}catch{throw Error('private_json_invalid');}}

/** Child output is never forwarded; fixed scripts receive only validated stdin. */
async function runReleaseChild(plan,input){
 const selected=releaseOperations[plan.operation];
 const args=selected.mode==='migrate'?[`scripts/migrate-${selected.environment}.mjs`,'release-'+plan.operationId,'--pair-stdin']:
  [`scripts/provision-${selected.environment}.mjs`,selected.mode];
 return await new Promise(resolve=>{
  let finished=false;
  const child=spawn(process.execPath,args,{cwd:releaseRoot,shell:false,env:{APP_ENV:selected.environment},stdio:['pipe','ignore','ignore']});
  const timer=setTimeout(()=>{child.kill('SIGTERM');finish(null);},180000);
  function finish(code){if(finished)return;finished=true;clearTimeout(timer);resolve(code);}
  child.once('error',()=>finish(null));
  child.once('close',code=>finish(code));
  child.stdin.on('error',()=>{});
  child.stdin.end(JSON.stringify(selected.mode==='migrate'?{...input,compatibility:plan.compatibility}:input)+'\n');
 });
}

export async function executeReleaseFiles(planFile,privateInputFile){
 try{
  const bundle=parsePrivateJson(await readProtectedReleaseFile(planFile,16384));
  if(!bundle||bundle.ok!==true||!bundle.plan||Object.keys(bundle).sort().join(',')!=='ok,plan,planDigest')return failure('plan',['plan_bundle_invalid']);
  const plan=bundle.plan,gaps=releasePlanGaps(plan,await releaseSourceFingerprint());
  if(gaps.length)return failure('plan',gaps);
  if(bundle.planDigest!==releasePlanDigest(plan))return failure('plan',['plan_digest_mismatch']);
  // No private input file is opened until scope, target and exact source pass.
  const envelope=parsePrivateJson(await readProtectedReleaseFile(privateInputFile));
  const codes=[...privateEnvelopeGaps(envelope,plan),...releaseInputPreflight(plan.operation,envelope?.input,plan.environment)];
  if(codes.length)return failure('preflight',[...new Set(codes)]);
  if(plan.sourceFingerprint!==await releaseSourceFingerprint())return failure('plan',['source_fingerprint_mismatch']);
  const code=await runReleaseChild(plan,envelope.input);
  if(code===78)return failure('preflight',['release_preflight_refused','recheck_serving_revisions_and_rehearse']);
  return code===0?{ok:true,stage:'completed',operation:plan.operation,sourceFingerprint:plan.sourceFingerprint,targetFingerprint:plan.targetFingerprint}:
   failure('child',['release_child_failed','reconciliation_required']);
 }catch(error){return failure('input',[safeFileErrors.has(error?.message)?error.message:'protected_input_unavailable']);}
}

async function main(){
 const [mode,...args]=process.argv.slice(2);
 if(mode==='plan'&&(args.length===1||args.length===2)){
  const spec=parsePrivateJson(await readProtectedReleaseFile(args[0],16384));
  const compatibility=args[1]?parsePrivateJson(await readProtectedReleaseFile(args[1],4096)):undefined;
  const result=await createReleasePlan(spec,new Date(),compatibility);
  return result.codes?failure('plan',result.codes):{ok:true,plan:result.plan,planDigest:releasePlanDigest(result.plan)};
 }
 if(mode==='execute'&&args.length===2)return await executeReleaseFiles(args[0],args[1]);
 return failure('arguments',['release_arguments_invalid']);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let result;
 try{result=await main();}catch(error){result=failure('input',[safeFileErrors.has(error?.message)?error.message:'protected_input_unavailable']);}
 process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.ok?0:1;
}
