import { z } from 'zod';
import { commandDefinition } from './command-definition.js';
import type { Gap } from './contracts.js';
import type { DeliveryMode } from './customer-delivery.js';
export const customerPreflightCommands={
 'delivery.preflight':commandDefinition('Observe current saved campaign, sender, audience and service gaps without reserving or sending.','campaign:send',false,{
  brandId:z.uuid(),campaignId:z.uuid(),expectedVersion:z.number().int().positive().optional(),segmentId:z.uuid().optional(),dueAt:z.iso.datetime({offset:true}).optional(),
 }),
};
export type CustomerCampaignPreflight={
 campaignId:string;version:number;brandId:string;segmentId:string|null;senderRevision:number|null;observedAt:string;
 mode:DeliveryMode;canSend:false;reviewRequired:true;contentReady:boolean;gaps:Gap[];
 audience:{visibility:'restricted'}|{visibility:'over_limit';confirmed:number}|{visibility:'available';confirmed:number;selected:number;excluded:number};
 allowance?:{period:string;remainingEmails:number;remainingCampaigns:number;recipientLimit:number};
};
