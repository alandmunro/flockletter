import { z } from 'zod';
import type { ConfirmationEnvelope,CustomerConfirmationPort } from './service.js';

export class CustomerConfirmationProvider implements CustomerConfirmationPort {
  constructor(private key:string,private sender:string,private origin:string,private send:typeof fetch=fetch) {
    z.email().parse(sender);
    if(!key.trim()||new URL(origin).protocol!=='https:')throw Error('Configure the dedicated customer confirmation sender.');
  }
  async submit(message:ConfirmationEnvelope):ReturnType<CustomerConfirmationPort['submit']> {
    if(!message.routeToken||!/^[A-Za-z0-9_-]{43}$/.test(message.routeToken)||!z.email().safeParse(message.to).success||![message.confirmUrl,message.unsubscribeUrl].every(value=>{
      try{const u=new URL(value);return u.origin===this.origin && !u.username && !u.password;}catch{return false;}
    }))return {state:'rejected'};
    try {
      const response=await this.send('https://api.resend.com/emails',{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
        headers:{authorization:'Bearer '+this.key,'content-type':'application/json','Idempotency-Key':'flockletter-confirmation/'+message.operationKey},
        body:JSON.stringify({from:this.sender,to:[message.to],subject:'Confirm your newsletter subscription',
          text:`You requested ${message.brandName} emails. Confirm your subscription:\n\n${message.confirmUrl}\n\nIf you did not request this, ignore this message or opt out:\n\n${message.unsubscribeUrl}`,
          tags:[{name:'fl_confirmation',value:message.operationKey},{name:'fl_confirmation_route',value:message.routeToken}]}),
      });
      if(!response.ok){await response.body?.cancel();return {state:response.status>=500||[408,409,429].includes(response.status)?'unknown':'rejected'};}
      const parsed=z.object({id:z.uuid()}).safeParse(await response.json());
      return parsed.success?{state:'accepted',providerId:parsed.data.id}:{state:'unknown'};
    }catch{return {state:'unknown'};}
  }
  async lookup(_operation:string):ReturnType<CustomerConfirmationPort['lookup']> {
    // Absence from a provider list is not proof of nonacceptance. Preserve the durable unknown.
    return {state:'unknown'};
  }
}
