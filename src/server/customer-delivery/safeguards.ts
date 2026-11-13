import {z} from 'zod';
import type {Sql,Database} from '../db.js';
import {boundedJson} from '../customer-support/writer.js';
import {sendingReasons,type SendingTrustStatus} from '../../shared/sending-safeguards.js';

const count=z.number().int().nonnegative();
const quota=z.object({used:count,limit:count.nullable(),resets_at:z.iso.datetime({offset:true})});
export const resendUsage=z.object({object:z.literal('usage'),emails:z.object({daily:quota,monthly:quota.extend({limit:count.positive()})})});
export class SendingSafeguards {
 private refresh?:{until:number;value:Promise<boolean>};
 constructor(private db:Database,private retrieveKey?:string,private send:typeof fetch=fetch,private approvedMonthlyLimit=50000){if(!Number.isSafeInteger(approvedMonthlyLimit)||approvedMonthlyLimit<1||approvedMonthlyLimit>1000000)throw Error('Configure the reviewed provider email allowance.');}
 async refreshUsage(){
  if(!this.retrieveKey)return false;
  if(this.refresh&&Date.now()<this.refresh.until)return this.refresh.value;
  const run=async()=>{
   const started=new Date();
   try{
    const response=await this.send('https://api.resend.com/usage',{redirect:'error',signal:AbortSignal.timeout(8000),headers:{authorization:'Bearer '+this.retrieveKey}});
    if(!response.ok){await response.body?.cancel();return false;}
    const usage=resendUsage.parse(await boundedJson(response,16384)),month=usage.emails.monthly,day=usage.emails.daily;
    await this.db.pool.query('SELECT flockletter_customer_jobs.sending_usage($1,$2,$3,$4,$5,$6,$7)',[month.used,Math.min(month.limit,this.approvedMonthlyLimit),month.resets_at,day.used,day.limit,day.resets_at,started]);
    return true;
   }catch{return false;}
  };
  this.refresh={until:Date.now()+60000,value:run()};return this.refresh.value;
 }
 async status(sql:Sql,workspace:string):Promise<SendingTrustStatus>{
  const raw=(await sql.query<{status:Omit<SendingTrustStatus,'reasons'>}>('SELECT flockletter_customer_jobs.sending_status($1) status',[workspace])).rows[0]!.status;
  return {...raw,reasons:raw.codes.map(code=>sendingReasons[code]??'Sending requires operator review.')};
 }
 async admit(sql:Sql,workspace:string,recipient:string):Promise<{allowed:boolean;reason:string|null;retryAt:string|null}>{
  return (await sql.query('SELECT flockletter_customer_jobs.sending_admit($1,$2) admission',[workspace,recipient])).rows[0]!.admission;
 }
 async cooldown(sql:Sql,workspace:string,recipient:string,seconds:number){await sql.query('SELECT flockletter_customer_jobs.sending_cooldown($1,$2,$3)',[workspace,recipient,seconds]);}
 async outcome(sql:Sql,workspace:string,recipient:string,kind:string){await sql.query('SELECT flockletter_customer_jobs.sending_outcome($1,$2,$3)',[workspace,recipient,kind]);}
}
