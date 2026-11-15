// Loaded only by the migration subprocess integration tests; no outbound requests.
import {URL} from 'node:url';
globalThis.fetch=async function (request,options){
  const {origin,pathname}=new URL(request);
  const environment=origin==='https://flockletter-staging.onrender.com'?'staging':
    origin==='https://flockletter-production.onrender.com'?'production':undefined;
  if(!environment||options?.redirect!=='error')throw Error('Unexpected migration identity request');
  if(pathname==='/api/health/version')return globalThis.Response.json({appId:'flockletter',environment,buildSha:'a'.repeat(40)});
  if(pathname==='/readyz')return globalThis.Response.json({ready:true,gaps:[]});
  throw Error('Unexpected identity path');
};
