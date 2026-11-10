import type { TokenGetter } from './api.js';
import type { PlatformCommand } from '../shared/platform.js';
export function platformClient(getToken:TokenGetter,verify?:(action:()=>Promise<unknown>)=>Promise<unknown>){
 return {async call<T>(name:PlatformCommand,input:unknown):Promise<T>{
  const action=async()=>{const token=await getToken(true);if(!token)throw Error('Sign in and select your workspace or operator organization.');const response=await fetch('/api/operator/v1/commands/'+name,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(input),cache:'no-store',redirect:'error'});const result=await response.json();if(result.clerk_error)return result;if(!response.ok)throw Error(result.error?.message??'Operator request failed.');return result;};
  const data=await (verify?verify(action):action()) as {result:T;clerk_error?:unknown};if(data.clerk_error)throw Error('Recent sign-in verification is required.');return data.result;
 }};
}
export type PlatformApi=ReturnType<typeof platformClient>;
