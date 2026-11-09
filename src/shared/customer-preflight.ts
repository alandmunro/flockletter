import { z } from 'zod';
import { commandDefinition } from './command-definition.js';
import type { Gap } from './contracts.js';
import type {TestBudget} from './customer-test-send.js';
import type { DeliveryMode } from './customer-delivery.js';
const preflight=commandDefinition('Observe current saved campaign, sender, audience and service gaps without reserving or sending.','campaign:send',false,{
  brandId:z.uuid(),campaignId:z.uuid(),expectedVersion:z.number().int().positive().optional(),segmentId:z.uuid().optional(),dueAt:z.iso.datetime({offset:true}).optional(),purpose:z.enum(['broadcast','test']).default('broadcast'),subscriberId:z.uuid().optional(),
});
export const customerPreflightCommands={
 'delivery.preflight':{...preflight,schema:preflight.schema.superRefine((v,ctx)=>{
  if(v.purpose==='test'&&(!v.subscriberId||v.segmentId||v.dueAt))ctx.addIssue({code:'custom',path:['subscriberId'],message:'Choose one existing confirmed contact; tests cannot select groups or schedules.'});
  if(v.purpose==='broadcast'&&v.subscriberId)ctx.addIssue({code:'custom',path:['subscriberId'],message:'A contact-specific test needs purpose test.'});
 })},
};
export type CustomerCampaignPreflight={
 purpose:'broadcast'|'test';testBudget?:TestBudget;
 campaignId:string;version:number;brandId:string;segmentId:string|null;senderRevision:number|null;observedAt:string;
 mode:DeliveryMode;canSend:false;reviewRequired:true;contentReady:boolean;gaps:Gap[];
 audience:{visibility:'restricted'}|{visibility:'over_limit';confirmed:number}|{visibility:'available';confirmed:number;selected:number;excluded:number};
 allowance?:{period:string;remainingEmails:number;remainingCampaigns:number;recipientLimit:number};
};
