import {checkOnce} from './verify-release.mjs';

// These are the Flockletter services, independent of any URL or credential in the private input.
const origins={staging:'https://flockletter-staging.onrender.com',production:'https://flockletter-production.onrender.com'};
export async function checkMigrationIdentity(environment,revision) {
 const origin=Object.hasOwn(origins,environment)?origins[environment]:undefined;
 if(!origin||typeof revision!=='string'||!/^[a-f0-9]{40}$/.test(revision))return ['serving_revision_unverified'];
 const failures=await checkOnce({urls:[origin],environment,expectedSha:revision,fetchImpl:(url,options)=>
   globalThis.fetch(url,{...options,redirect:'error',cache:'no-store'})});
 return failures.length?['serving_revision_or_readiness_changed']:[];
}
