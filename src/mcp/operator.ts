import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { platformCommands } from '../shared/platform.js';
export function operatorApiCaller(origin:string,token:string){
 const url=new URL(origin);if(url.origin!==origin||url.username||url.password||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname))))throw Error('Use an exact HTTPS origin or local loopback.');
 if(token.startsWith('flk_')||!/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/.test(token))throw Error('Use a short-lived verified Clerk operator session; customer connection tokens cannot grant operator access.');
 return async(name:string,input:unknown)=>{const response=await fetch(origin+'/api/operator/v1/commands/'+name,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(30000)});const data=await response.json() as {result?:unknown;error?:{message?:string}};if(!response.ok)throw Error(data.error?.message??'Operator action failed.');return data.result;};
}
export function createOperatorMcpServer(call:(name:string,input:unknown)=>Promise<unknown>){
 const server=new McpServer({name:'flockletter-operator',version:'0.1.0'});
 for(const [name,definition] of Object.entries(platformCommands))server.registerTool(name.replace('.','_'),{description:definition.description,inputSchema:definition.schema.shape,annotations:{readOnlyHint:!definition.mutation,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async (input:Record<string,unknown>)=>{try{return {content:[{type:'text' as const,text:JSON.stringify(await call(name,definition.schema.parse(input)))}]};}catch{return {isError:true,content:[{type:'text' as const,text:'Operator action was rejected. Refresh your MFA session and review the exact case before retrying.'}]};}});
 return server;
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){const origin=process.env.FLOCKLETTER_API_ORIGIN,token=process.env.FLOCKLETTER_OPERATOR_SESSION_TOKEN;if(!origin||!token)throw Error('Configure an exact API origin and short-lived Clerk operator session.');await createOperatorMcpServer(operatorApiCaller(origin,token)).connect(new StdioServerTransport());}
