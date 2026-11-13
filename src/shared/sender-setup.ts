import {z} from 'zod';
import {commandDefinition} from './command-definition.js';
const brandId=z.uuid(),operationKey=z.uuid();
export const senderSetupCommands={
 'senderSetup.status':commandDefinition('Read this brand’s sender setup, domain proof, provider DNS records and actionable gaps.','sender:configure',false,{brandId}),
 'senderSetup.review':commandDefinition('Prepare an exact server-owned Resend domain setup for the saved sender; creates no provider resource.','sender:configure',true,{operationKey,brandId,senderRevision:z.number().int().positive()}),
 'senderSetup.approve':commandDefinition('Approve the exact reviewed sender setup; never changes a provider plan or enables mailing.','sender:configure',true,{operationKey,brandId,setupId:z.uuid(),senderRevision:z.number().int().positive()}),
 'senderSetup.process':commandDefinition('Process or inspect the existing approved sender setup; never repeats uncertain domain creation.','sender:configure',true,{operationKey,brandId,setupId:z.uuid()}),
};
export type SenderSetupState='reviewed'|'queued'|'creating'|'configuring'|'awaiting_dns'|'verified'|'uncertain'|'held';
export type SenderSetupView={enabled:boolean;captured:boolean;alreadyConfigured:boolean;brandId:string;ownershipVerified:boolean;senderRevision:number|null;setup:null|{id:string;domain:string;fromEmail:string;senderRevision:number;state:SenderSetupState;reason:string|null;dns:{name:string;type:string;value:string;priority?:number}[]};gaps:string[]};
