import {z} from 'zod';
import {commandDefinition as command} from './command-definition.js';
import type {DeliveryView} from './customer-delivery.js';
const id=z.uuid(),operationKey=z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const customerTestSendCommands={
 'delivery.reviewTest':command('Freeze one confirmed brand contact and the saved campaign as a separate immediate test; never approves a broadcast.','campaign:send',true,{operationKey,brandId:id,campaignId:id,expectedVersion:z.number().int().positive(),subscriberId:id}),
 'delivery.approveTest':command('Approve exactly this one-recipient test review. Uses one of five approved test requests per workspace UTC day, including cancelled or rejected tests.','campaign:send',true,{operationKey,brandId:id,id,expectedVersion:z.number().int().positive(),subscriberId:id}),
 'delivery.testDetails':command('Restore the exact test review and current recipient eligibility in the owner session. Not available to delegated connections.','owner',false,{brandId:id,id}),
};
export type TestBudget={day:string;limit:5;used:number;remaining:number};
/** Echoes only the opaque subscriber ID already supplied by this reviewing actor. */
export type TestDeliveryReview=DeliveryView&{purpose:'test';testSubscriberId:string};
export type TestDeliveryDetails={review:TestDeliveryReview;recipient:{id:string;email:string|null;eligible:boolean};canApprove:boolean};
