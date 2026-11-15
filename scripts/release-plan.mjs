import {URL} from 'node:url';
import {Buffer} from 'node:buffer';
import process from 'node:process';
import {createHash,randomBytes} from 'node:crypto';
import {lstat,readdir,readFile,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isRecord,releaseOperations,sourceMatchesEnvironment,validReleaseHost,parseReleaseConnection} from './release-input.mjs';

export const releaseRoot=fileURLToPath(new URL('../',import.meta.url));
const exactKeys=(value,keys)=>isRecord(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function targetSpecGaps(spec){
 if(!isRecord(spec))return ['target_object_required'];
 const selected=typeof spec.operation==='string'&&Object.hasOwn(releaseOperations,spec.operation)?releaseOperations[spec.operation]:undefined;
 if(!selected)return ['operation_invalid'];
 const keys=['version','operation','host','port','database','migrationRole','runtimeRole',...(selected.mode==='migrate'?[]:['sourceDatabase','administratorRole'])],codes=[];
 if(!exactKeys(spec,keys)||spec.version!==1)codes.push('target_shape_invalid');
 if(!validReleaseHost(spec.host))codes.push('target_host_invalid');
 if(!Number.isInteger(spec.port)||spec.port<1||spec.port>65535)codes.push('target_port_invalid');
 if(spec.database!==selected.database)codes.push('target_database_mismatch');
 if(spec.migrationRole!==selected.migrationRole||spec.runtimeRole!==selected.runtimeRole)codes.push('target_roles_mismatch');
 if(selected.mode!=='migrate'){
  if(!sourceMatchesEnvironment(spec.sourceDatabase,selected.environment)||spec.sourceDatabase===selected.database)codes.push('target_source_invalid');
  if(typeof spec.administratorRole!=='string'||! /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(spec.administratorRole))codes.push('target_administrator_invalid');
 }
 return codes;
}
function canonicalTarget(spec){
 const selected=releaseOperations[spec.operation];
 return {version:1,operation:spec.operation,host:spec.host,port:spec.port,database:spec.database,migrationRole:spec.migrationRole,runtimeRole:spec.runtimeRole,
  ...(selected.mode==='migrate'?{}:{sourceDatabase:spec.sourceDatabase,administratorRole:spec.administratorRole})};
}
export function targetFingerprint(spec){return digest(canonicalTarget(spec));}

async function trustedAncestors(start){
 const uid=process.getuid?.();
 if(uid===undefined)throw Error('protected_ancestor_permissions');
 for(let ancestor=start;;ancestor=path.dirname(ancestor)){
  const info=await lstat(ancestor),trustedSticky=info.uid===0&&(info.mode&0o1000)!==0;
  if(!info.isDirectory()||![0,uid].includes(info.uid)||((info.mode&0o022)!==0&&!trustedSticky))throw Error('protected_ancestor_permissions');
  if(ancestor===path.dirname(ancestor))break;
 }
}
export async function verifyReleaseSourceFile(file){
 try{
  const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||![0,process.getuid?.()].includes(info.uid)||(info.mode&0o022)!==0||info.size>4194304||await realpath(file)!==file)throw Error('release_source_invalid');
  await trustedAncestors(path.dirname(file));
 }catch{throw Error('release_source_invalid');}
}

/** Correlates the exact reviewed release source; not remote identity attestation. */
export const releaseBoundaryFiles=Object.freeze(['package.json','package-lock.json','src/server/runtime-boundary.mjs','src/server/test-send-boundary.mjs','src/shared/runtime-tables.json']);
export async function releaseSourceFingerprint(root=releaseRoot){
 const files=[...releaseBoundaryFiles];
 for(const [directory,suffix] of [['scripts','.mjs'],['migrations','.sql']]){
  for(const name of (await readdir(path.join(root,directory))).sort())if(name.endsWith(suffix))files.push(directory+'/'+name);
 }
 const hash=createHash('sha256');
 for(const name of files.sort()){
  const file=path.join(root,name);await verifyReleaseSourceFile(file);
  const bytes=await readFile(file);hash.update(name+'\0'+bytes.length+'\0').update(bytes).update('\0');
 }
 return hash.digest('hex');
}
export function migrationEvidenceGaps(evidence,environment,source,now=new Date()){
 if(!exactKeys(evidence,['ok','version','environment','webRevision','workerRevision','candidateRevision','sourceFingerprint','checked','checkedAt'])
  ||evidence.ok!==true||evidence.version!==1)return ['compatibility_evidence_required'];
 const codes=[],revisions=[evidence.webRevision,evidence.workerRevision,evidence.candidateRevision];
 if(evidence.environment!==environment)codes.push('compatibility_environment_mismatch');
 if(!revisions.every(value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value))
   ||JSON.stringify(evidence.checked)!==JSON.stringify([...new Set(revisions.slice(0,2))]))codes.push('compatibility_checks_incomplete');
 if(evidence.sourceFingerprint!==source)codes.push('compatibility_source_mismatch');
 const time=typeof evidence.checkedAt==='string'?Date.parse(evidence.checkedAt):NaN;
 if(!Number.isFinite(time)||new Date(time).toISOString()!==evidence.checkedAt||time>now.getTime()+60000||now.getTime()-time>1800000)codes.push('compatibility_evidence_expired');
 return codes;
}
export async function createReleasePlan(spec,now=new Date(),compatibility){
 const codes=targetSpecGaps(spec);if(codes.length)return {codes};
 const target=canonicalTarget(spec),selected=releaseOperations[spec.operation],source=await releaseSourceFingerprint();
 if(selected.mode==='migrate'){
  const missing=migrationEvidenceGaps(compatibility,selected.environment,source,now);if(missing.length)return {codes:missing};
 }else if(compatibility!==undefined)return {codes:['unexpected_compatibility_evidence']};
 return {plan:{version:1,operation:spec.operation,environment:releaseOperations[spec.operation].environment,target,
  targetFingerprint:targetFingerprint(target),sourceFingerprint:source,createdAt:now.toISOString(),operationId:randomBytes(16).toString('hex'),
  ...(selected.mode==='migrate'?{compatibility}:{})}};
}
export function releasePlanGaps(plan,sourceFingerprint,now=new Date()){
 const migration=typeof plan?.operation==='string'&&Object.hasOwn(releaseOperations,plan.operation)&&releaseOperations[plan.operation].mode==='migrate';
 if(!exactKeys(plan,['version','operation','environment','target','targetFingerprint','sourceFingerprint','createdAt','operationId',...(migration?['compatibility']:[])]))return ['plan_shape_invalid'];
 const codes=targetSpecGaps(plan.target),selected=typeof plan.operation==='string'&&Object.hasOwn(releaseOperations,plan.operation)?releaseOperations[plan.operation]:undefined;
 if(plan.version!==1||!selected||plan.target?.operation!==plan.operation||selected.environment!==plan.environment)codes.push('plan_scope_invalid');
 if(typeof plan.operationId!=='string'||!/^[a-f0-9]{32}$/.test(plan.operationId))codes.push('plan_id_invalid');
 const created=typeof plan.createdAt==='string'?Date.parse(plan.createdAt):NaN;
 if(!Number.isFinite(created)||new Date(created).toISOString()!==plan.createdAt||created>now.getTime()+60000||now.getTime()-created>1800000)codes.push('plan_time_invalid');
 if(codes.length===0&&plan.targetFingerprint!==targetFingerprint(plan.target))codes.push('target_fingerprint_mismatch');
 if(plan.sourceFingerprint!==sourceFingerprint)codes.push('source_fingerprint_mismatch');
 if(migration)codes.push(...migrationEvidenceGaps(plan.compatibility,selected.environment,sourceFingerprint,now));
 return codes;
}
export function releasePlanDigest(plan){
 return digest({version:plan.version,operation:plan.operation,environment:plan.environment,target:canonicalTarget(plan.target),targetFingerprint:plan.targetFingerprint,
  sourceFingerprint:plan.sourceFingerprint,createdAt:plan.createdAt,operationId:plan.operationId,...(plan.compatibility?{compatibility:plan.compatibility}:{})});
}
export function privateEnvelopeGaps(envelope,plan){
 if(!exactKeys(envelope,['version','operation','planDigest','input'])||envelope.version!==1)return ['private_envelope_invalid'];
 const codes=[];
 if(envelope.operation!==plan.operation)codes.push('private_operation_mismatch');
 if(envelope.planDigest!==releasePlanDigest(plan))codes.push('private_plan_mismatch');
 const input=envelope.input,target=plan.target,selected=releaseOperations[plan.operation];
 if(!isRecord(input))return [...codes,'input_object_required'];
 for(const field of selected.mode==='migrate'?['migrationUrl','runtimeUrl']:['adminUrl']){
  const url=parseReleaseConnection(input[field]);if(!url)continue; // Canonical preflight reports invalid fields together.
  if(url.hostname!==target.host||Number(url.port||5432)!==target.port)codes.push('private_target_mismatch');
  if(field==='adminUrl'&&(url.pathname!==`/${target.sourceDatabase}`||url.username!==target.administratorRole||input.expectedHost!==target.host||input.expectedSource!==target.sourceDatabase))codes.push('private_source_mismatch');
 }
 return [...new Set(codes)];
}

/** Owner-private immediate directory; trusted system ancestors may be shared/sticky. */
export async function readProtectedReleaseFile(file,limit=65536){
 if(typeof file!=='string'||!path.isAbsolute(file)||typeof process.getuid!=='function')throw Error('protected_file_required');
 if(await realpath(file)!==file)throw Error('protected_file_symlink');
 const parent=path.dirname(file),directory=await lstat(parent),uid=process.getuid();
 if(!directory.isDirectory()||directory.uid!==uid||(directory.mode&0o077)!==0||await realpath(parent)!==parent)throw Error('protected_directory_permissions');
 await trustedAncestors(path.dirname(parent));
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const info=await handle.stat();
  if(!info.isFile()||info.uid!==uid||(info.mode&0o077)!==0||info.nlink!==1)throw Error('protected_file_permissions');
  if(info.size<1||info.size>limit)throw Error('protected_file_size');
  const bytes=Buffer.alloc(limit+1);let length=0;
  while(length<bytes.length){const result=await handle.read(bytes,length,bytes.length-length,null);if(!result.bytesRead)break;length+=result.bytesRead;}
  if(length<1||length>limit)throw Error('protected_file_size');
  return bytes.subarray(0,length).toString('utf8');
 }finally{await handle.close();}
}
