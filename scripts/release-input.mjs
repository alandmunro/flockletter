import {URL} from 'node:url';
import process from 'node:process';
import {hasSupportedProductionConnectionOptions} from './production-connection.mjs';

export const releaseOperations=Object.freeze(Object.fromEntries(['production','staging'].flatMap(environment=>
 ['inspect','prepare','apply','migrate'].map(mode=>[`${environment}.${mode}`,Object.freeze({environment,mode,database:`flockletter_${environment}`,runtimeRole:`flockletter_${environment}_runtime`,migrationRole:`flockletter_${environment}_migrator`})]))));
export const isRecord=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sourcePattern=/^[a-z][a-z0-9_]{0,62}$/;
export function sourceMatchesEnvironment(source,environment){
 return typeof source==='string'&&sourcePattern.test(source)&&
  (environment==='production'?/(?:^|_)(?:prod|production)(?:_|$)/.test(source)&&!/(?:^|_)(?:staging|test|dev|development)(?:_|$)/.test(source):
   /(?:^|_)staging(?:_|$)/.test(source)&&!/(?:^|_)(?:prod|production|test|dev|development)(?:_|$)/.test(source));
}
export const validReleaseHost=host=>typeof host==='string'&&host.length>0&&host.length<=253&&/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])$/.test(host);
export function parseReleaseConnection(value){
 try{
  if(typeof value!=='string')return undefined;
  const url=new URL(value);
  // The driver decodes userinfo later. Reject malformed/control-containing
  // credentials now, especially before a valid migration mutates anything.
  const user=decodeURIComponent(url.username),password=decodeURIComponent(url.password);
  if(!user||!password||[...user+password].some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127))return undefined;
  return ['postgres:','postgresql:'].includes(url.protocol)&&validReleaseHost(url.hostname)&&url.username&&url.password&&hasSupportedProductionConnectionOptions(url)?url:undefined;
 }catch{return undefined;}
}

/** Returns all static input gaps, never supplied values. No network or mutation. */
export function releaseInputPreflight(operation,input,environment){
 const codes=[],selected=typeof operation==='string'&&Object.hasOwn(releaseOperations,operation)?releaseOperations[operation]:undefined;
 if(!selected)return ['operation_invalid'];
 if(environment!==selected.environment)codes.push('environment_mismatch');
 if(!isRecord(input))return [...codes,'input_object_required'];
 const {mode,database}=selected;
 const allowed=mode==='migrate'?['migrationUrl','runtimeUrl']:['adminUrl','expectedHost','expectedSource',selected.environment==='production'?'confirmProduction':'confirmStaging','runtimePassword','migratorPassword'];
 if(Object.keys(input).some(key=>!allowed.includes(key)))codes.push('unexpected_input_fields');
 if(mode==='migrate'){
  const migration=parseReleaseConnection(input.migrationUrl),runtime=parseReleaseConnection(input.runtimeUrl);
  if(!migration)codes.push('migration_url_invalid');
  if(!runtime)codes.push('runtime_url_invalid');
  if(migration&&(migration.pathname!==`/${database}`||migration.username!==selected.migrationRole))codes.push('migration_scope_mismatch');
  if(runtime&&(runtime.pathname!==`/${database}`||runtime.username!==selected.runtimeRole))codes.push('runtime_scope_mismatch');
  if(migration&&runtime&&migration.host!==runtime.host)codes.push('connection_pair_mismatch');
 }else{
  const admin=parseReleaseConnection(input.adminUrl);
  if(!admin)codes.push('admin_url_invalid');
  if(!validReleaseHost(input.expectedHost))codes.push('expected_host_invalid');
  if(!sourceMatchesEnvironment(input.expectedSource,selected.environment)||input.expectedSource===database)codes.push('expected_source_invalid');
  if(input[selected.environment==='production'?'confirmProduction':'confirmStaging']!==true)codes.push('environment_confirmation_required');
  if(admin&&(admin.hostname!==input.expectedHost||admin.pathname!==`/${input.expectedSource}`))codes.push('admin_scope_mismatch');
  for(const name of ['runtimePassword','migratorPassword'])
   if((mode==='apply'||input[name]!==undefined)&&(typeof input[name]!=='string'||!/^[a-f0-9]{64}$/.test(input[name])))codes.push(name==='runtimePassword'?'runtime_password_invalid':'migrator_password_invalid');
  if(input.runtimePassword!==undefined&&input.migratorPassword!==undefined&&input.runtimePassword===input.migratorPassword)codes.push('distinct_role_passwords_required');
 }
 return codes;
}

export function refuseReleaseInput(codes){
 process.stderr.write(JSON.stringify({ok:false,stage:'preflight',codes})+'\n');
 process.exit(1);
}
